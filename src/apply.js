'use strict';
// Executes an APPROVED proposal against the CRM. Only ever called from the review app's approve action.
//
// Safety:
//  * preconditions: before each PATCH we re-read the account and check the fields we are about to change
//    still hold the values the reviewer saw. If someone edited the record since, we stop (status "failed")
//    and ask for a re-run instead of overwriting their change.
//  * resumable: multi-step proposals (CHOW = create + patch) record progress after every step, so a retry
//    after a partial failure never creates a second account.

function sameValue(a, b) {
  return String(a ?? '') === String(b ?? '');
}

async function applyProposal(p, client, { now = () => new Date().toISOString() } = {}) {
  p.progress ||= { refs: {}, done: [] };
  const log = [];
  for (let i = 0; i < p.ops.length; i++) {
    if (p.progress.done.includes(i)) { log.push(`step ${i + 1}: already done`); continue; }
    const op = p.ops[i];
    const fields = {};
    for (const [k, v] of Object.entries(op.fields)) {
      fields[k] = typeof v === 'string' && v.startsWith('$') ? p.progress.refs[v.slice(1)] : v;
      if (fields[k] === undefined) throw new Error(`Unresolved reference ${v} in step ${i + 1}`);
    }
    if (op.op === 'create') {
      const created = await client.createAccount(fields);
      const id = created && (created.account_id || created.id);
      if (!id) throw new Error(`Create returned no account_id: ${JSON.stringify(created).slice(0, 300)}`);
      p.progress.refs[op.ref] = id;
      log.push(`step ${i + 1}: created account ${id} "${fields.name}"`);
    } else if (op.op === 'patch') {
      const current = await client.getAccount(op.account_id);
      const drift = Object.entries(op.expect || {}).filter(([k, v]) => !sameValue(current[k], v));
      if (drift.length) {
        const d = drift.map(([k, v]) => `${k}: expected "${v}", found "${current[k]}"`).join('; ');
        const err = new Error(`Account ${op.account_id} changed since this proposal was generated (${d}). Re-run the pipeline.`);
        err.stale = true;
        throw err;
      }
      await client.updateAccount(op.account_id, fields);
      log.push(`step ${i + 1}: updated ${op.account_id} ${JSON.stringify(Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'note')))}`);
    } else {
      throw new Error(`Unknown op ${op.op}`);
    }
    p.progress.done.push(i);
  }
  p.applied_at = now();
  return log;
}

module.exports = { applyProposal };
