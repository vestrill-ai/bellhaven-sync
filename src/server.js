'use strict';
// Local review app. Nothing is written to the CRM unless a reviewer clicks Approve.
//   node src/server.js   ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const store = require('./state');
const crm = require('./crm');
const { applyProposal } = require('./apply');
const pipeline = require('./pipeline');

const UI = path.join(__dirname, 'ui.html');
let busy = false; // serialise writes: one approval / run at a time

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// Node's fetch reports network problems as a bare "fetch failed"; include the underlying cause.
const errText = (e) => (e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message);

async function exclusive(res, fn) {
  if (busy) return send(res, 409, { error: 'Another action is in progress, try again in a moment.' });
  busy = true;
  try { await fn(); } catch (e) { send(res, 500, { error: errText(e) }); } finally { busy = false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const s = store.load();
      const crmBrowser = cfg.CRM_TOKEN ? `${cfg.SITE_URL}/crm/${cfg.CRM_TOKEN}/accounts` : '';
      return send(res, 200, { proposals: Object.values(s.proposals), runs: s.runs.slice(-10).reverse(), matched: s.last_matched || [], names: s.account_names || {}, crmBrowser });
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      return exclusive(res, async () => {
        const lines = [];
        await pipeline.run({ log: (m) => lines.push(m) });
        send(res, 200, { ok: true, log: lines });
      });
    }

    const m = url.pathname.match(/^\/api\/proposals\/([a-f0-9]+)\/(approve|reject|reopen)$/);
    if (req.method === 'POST' && m) {
      const [, key, action] = m;
      const body = await readBody(req);
      const reviewer = body.reviewer || process.env.REVIEWER || 'reviewer';
      return exclusive(res, async () => {
        const s = store.load();
        const p = s.proposals[key];
        if (!p) return send(res, 404, { error: 'Unknown proposal' });
        const at = new Date().toISOString();
        if (action === 'reopen') {
          // A reviewer can change their mind about a REJECTION. Approved items can't be reopened:
          // they are already written to the CRM, and the next run proposes whatever is still needed.
          if (p.status !== 'rejected') return send(res, 409, { error: `Only rejected items can be reopened (this one is ${p.status})` });
          p.status = 'pending';
          p.history.push({ at, event: 'reopened', by: reviewer, comment: body.comment || '' });
          store.save(s);
          return send(res, 200, { ok: true, status: p.status });
        }
        if (store.DECIDED.has(p.status)) return send(res, 409, { error: `Already ${p.status}` });
        if (action === 'reject') {
          p.status = 'rejected';
          p.history.push({ at, event: 'rejected', by: reviewer, comment: body.comment || '' });
          store.save(s);
          return send(res, 200, { ok: true, status: p.status });
        }
        try {
          const log = await applyProposal(p, crm);
          p.status = 'approved';
          p.history.push({ at, event: 'approved+applied', by: reviewer, comment: body.comment || '', log });
          store.save(s);
          send(res, 200, { ok: true, status: p.status, log, created: p.progress.refs });
        } catch (e) {
          p.status = 'failed';
          p.history.push({ at, event: 'apply_failed', by: reviewer, error: errText(e), stale: Boolean(e.stale) });
          store.save(s); // progress is saved too, so a retry resumes instead of duplicating
          send(res, 502, { error: errText(e), stale: Boolean(e.stale) });
        }
      });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(cfg.PORT, () => console.log(`Review app: http://localhost:${cfg.PORT}`));
}
module.exports = { server };
