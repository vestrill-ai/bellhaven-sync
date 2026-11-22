'use strict';
// Durable review queue. A JSON file is enough at this scale and diffs nicely in git (see README for
// why we'd move to SQLite/Postgres in production).
//
// Idempotency contract:
//  * every proposal has a deterministic key = hash(type, location, operations) (dates/notes excluded)
//  * once a key is APPROVED or REJECTED it is never re-queued, no matter how many times the pipeline runs
//  * pending items that the latest run no longer produces are marked OBSOLETE (the world changed)
const fs = require('fs');
const path = require('path');
const { STATE_FILE } = require('./config');

const DECIDED = new Set(['approved', 'rejected']);

function load(file = STATE_FILE) {
  if (!fs.existsSync(file)) return { version: 1, proposals: {}, runs: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(state, file = STATE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file); // atomic replace
}

/** Merge a fresh set of generated proposals into the queue. Returns counts for the run log. */
function merge(state, generated, now = new Date().toISOString()) {
  const counts = { new: 0, refreshed: 0, skipped_decided: 0, obsoleted: 0 };
  const seen = new Set();
  for (const p of generated) {
    seen.add(p.key);
    const existing = state.proposals[p.key];
    if (existing && DECIDED.has(existing.status)) { counts.skipped_decided++; continue; }
    if (existing) {
      // keep status/history, refresh evidence + ops (expectations reflect current CRM values)
      Object.assign(existing, p, { status: existing.status === 'obsolete' ? 'pending' : existing.status,
        first_seen: existing.first_seen, last_seen: now, history: existing.history, progress: existing.progress });
      counts.refreshed++;
    } else {
      state.proposals[p.key] = { ...p, status: 'pending', first_seen: now, last_seen: now, history: [] };
      counts.new++;
    }
  }
  for (const p of Object.values(state.proposals)) {
    if (!seen.has(p.key) && (p.status === 'pending' || p.status === 'failed')) {
      p.status = 'obsolete';
      p.history.push({ at: now, event: 'obsolete', detail: 'No longer produced by the latest run (CRM or website changed).' });
      counts.obsoleted++;
    }
  }
  return counts;
}

module.exports = { load, save, merge, DECIDED };
