'use strict';
// Print what the matcher would propose for the ORIGINAL messy sandbox snapshot (test/fixtures),
// without touching the CRM or the review queue. Handy for trying out a matching change:
//   npm run preview            -> counts by type + one line per proposal
//   npm run preview -- Tiffin  -> full detail (reasons + field changes) for proposals matching "Tiffin"
const { load } = require('../test/fixture');
const { match } = require('./matcher');

const filter = (process.argv[2] || '').toLowerCase();
const d = load();
const names = Object.fromEntries(d.accounts.map((a) => [a.account_id, a.name]));
const named = (t) => String(t).replace(/("[^"]*" )?\[([0-9A-Z]{15,18})\]/g, (_, quoted, id) => `"${names[id] || id}"`);
const r = match({ ...d, today: new Date().toISOString().slice(0, 10) });

const outcomes = {};
for (const m of r.matched) outcomes[m.outcome] = (outcomes[m.outcome] || 0) + 1;
const types = {};
for (const p of r.proposals) types[p.type] = (types[p.type] || 0) + 1;
console.log(`${d.locations.length} website communities -> ${JSON.stringify(outcomes)}`);
console.log(`${r.proposals.length} proposals -> ${JSON.stringify(types)}\n`);

for (const p of r.proposals) {
  if (filter && !p.title.toLowerCase().includes(filter)) continue;
  console.log(`[${p.type}] ${p.title}\n    ${named(p.summary)}`);
  if (!filter) continue;
  for (const why of p.reasons) console.log(`    - ${named(why)}`);
  for (const op of p.ops) {
    const fields = Object.entries(op.fields).filter(([k]) => k !== 'note').map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`    ${op.op} ${op.account_id || '(new account)'}: ${fields}`);
  }
  console.log('');
}
