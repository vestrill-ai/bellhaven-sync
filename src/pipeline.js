'use strict';
// Daily job: scrape website -> read CRM -> match -> merge proposals into the review queue.
// It NEVER writes to the CRM. Writes only happen when a reviewer approves in the review app.
const fs = require('fs');
const path = require('path');
const { scrape } = require('./scraper');
const crm = require('./crm');
const { match } = require('./matcher');
const store = require('./state');
const cfg = require('./config');

async function run({ log = console.log } = {}) {
  const started = new Date().toISOString();
  const [locations, accounts, contacts] = await Promise.all([scrape({ log }), crm.listAccounts(), crm.listContacts()]);
  log(`crm: ${accounts.length} accounts, ${contacts.length} contacts`);
  if (locations.length < 5) throw new Error(`Only ${locations.length} communities scraped — refusing to continue (site change?)`);

  const result = match({ locations, accounts, contacts, today: started.slice(0, 10) });
  const state = store.load();
  const counts = store.merge(state, result.proposals, started);
  const outcomes = {};
  for (const m of result.matched) outcomes[m.outcome] = (outcomes[m.outcome] || 0) + 1;
  state.runs.push({ at: started, locations: locations.length, accounts: accounts.length, outcomes, queue: counts });
  state.runs = state.runs.slice(-60);
  state.last_matched = result.matched;
  // id -> name, so the review app can show "Bellhaven Senior Living" instead of a raw account id.
  state.account_names = Object.fromEntries(accounts.map((a) => [a.account_id, a.name]));
  store.save(state);

  // Keep the raw inputs of the latest run for audit/debugging.
  const snapDir = path.join(cfg.ROOT, 'data', 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });
  fs.writeFileSync(path.join(snapDir, 'latest.json'), JSON.stringify({ at: started, locations, accounts, contacts }, null, 2));

  log(`match: ${JSON.stringify(outcomes)}`);
  log(`queue: ${counts.new} new, ${counts.refreshed} still pending, ${counts.skipped_decided} already decided (skipped), ${counts.obsoleted} obsoleted`);
  return { outcomes, counts };
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
