'use strict';
// node --test   (no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { load } = require('./fixture');
const { match } = require('../src/matcher');
const store = require('../src/state');
const { applyProposal } = require('../src/apply');
const { parseCommunity } = require('../src/scraper');

const today = '2026-11-22';
const byType = (ps, t) => ps.filter((p) => p.type === t);
const patchOf = (p, id) => p.ops.find((o) => o.op === 'patch' && o.account_id === id);

/** In-memory CRM with the same surface as src/crm.js */
function fakeCrm(accounts) {
  const db = new Map(accounts.map((a) => [a.account_id, { ...a }]));
  let n = 0;
  return {
    db,
    getAccount: async (id) => ({ ...db.get(id) }),
    updateAccount: async (id, f) => { Object.assign(db.get(id), f); return db.get(id); },
    createAccount: async (f) => {
      const id = `001TESTNEW${String(++n).padStart(8, '0')}`;
      const a = { account_id: id, chow_current_account: '', duplicate_of_account: '', note: '', lifetime_revenue: 0, outstanding_ar: 0, ...f };
      db.set(id, a);
      return a;
    },
    all: () => [...db.values()],
  };
}

test('classifies every website community', () => {
  const d = load();
  const r = match({ ...d, today });
  const outcome = Object.fromEntries(r.matched.map((m) => [m.slug, m.outcome]));
  assert.equal(r.matched.length, 35);
  assert.equal(outcome['bellhaven-of-maplewood'], 'CONFIRMED');
  assert.equal(outcome['bellhaven-of-tiffin'], 'CHOW');
  assert.equal(outcome['bellhaven-of-marietta'], 'CHOW');
  assert.equal(outcome['bellhaven-crossings-of-lima'], 'REPARENT');
  assert.equal(outcome['bellhaven-meadows-of-findlay'], 'REPARENT');
  assert.equal(outcome['bellhaven-of-zanesville'], 'REPARENT');
  assert.equal(outcome['bellhaven-of-kettering'], 'REPARENT');
  for (const s of ['bellhaven-of-batavia', 'bellhaven-of-carlisle', 'bellhaven-at-union-square', 'amberly-manor']) assert.equal(outcome[s], 'NEW', s);
});

test('billing SOP: revenue AND AR > 0 -> CHOW (old account untouched except pointer)', () => {
  const r = match({ ...load(), today });
  for (const id of ['001U6RW32TY0WSXZZB', '001A34WFSUYHCRBLFT']) { // Tiffin, Marietta
    const p = r.proposals.find((x) => x.type === 'CHOW_NEW_ACCOUNT' && patchOf(x, id));
    assert.ok(p, id);
    assert.deepEqual(patchOf(p, id).fields, { chow_current_account: '$new' });
    assert.equal(p.ops[0].op, 'create');
    assert.equal(p.ops[0].fields.parent_id, r.operator.account_id);
  }
  // Lima has revenue but AR = 0, Findlay revenue but AR = 0 -> re-parent directly
  for (const id of ['001LGFPBJY4N9MB6KL', '001UKEFGADQ8YCZ4YM']) {
    const p = byType(r.proposals, 'REPARENT').find((x) => patchOf(x, id));
    assert.equal(patchOf(p, id).fields.parent_id, r.operator.account_id);
  }
  // Sandusky sold to Millstone; has AR -> point at existing Millstone account, don't touch anything else
  const s = byType(r.proposals, 'CHOW_EXISTING')[0];
  assert.deepEqual(s.ops, [{ op: 'patch', account_id: '001SXSF4ELF0Z2LGDM', fields: { chow_current_account: '0017JP8Z1UQ763BVK3' }, expect: s.ops[0].expect }]);
});

test('duplicates pick the right survivor', () => {
  const r = match({ ...load(), today });
  const dup = Object.fromEntries(byType(r.proposals, 'MARK_DUPLICATE').map((p) => [p.ops[0].account_id, p.ops[0].fields.duplicate_of_account]));
  assert.deepEqual(dup, {
    '001JD2MWRA74LTSN24': '001UELXDAKFRKB8932', // Port Clinton: Harborview copy -> Bellhaven
    '001BLYF02K97SZLZHH': '001CVBBCSDM7YHN220', // Erie
    '001QU150PM4Z15UA71': '001EGU7BMJ942ZTRE6', // Owosso: admin contact decides
    '00159PL81N38KM4FHM': '001U1750VLVJAGG1S5', // Monroe x2
    '0011AB44D05WLA9HTX': '001U1750VLVJAGG1S5',
    '0016KTS1UAWBRXS09J': '001WR41PYNWXCAE2X4', // Kettering x2 -> Harborview lineage survives
    '001B7XZAA3AFALS9GP': '001WR41PYNWXCAE2X4',
  });
  for (const p of byType(r.proposals, 'MARK_DUPLICATE')) assert.equal(p.ops[0].fields.status, 'Inactive');
});

test('decoys are not matched', () => {
  const r = match({ ...load(), today });
  const touched = new Set(r.proposals.flatMap((p) => p.ops.map((o) => o.account_id)).filter(Boolean));
  for (const id of ['0015D74ZLRY810RGY5', /* Amberly Manor, Colorado */ '001GNU41AVXZRLLJ9P', /* Union Square, Juniper */
    '0019M1Z45PGV2DJ971' /* Maplewood Senior Care Center */]) assert.ok(!touched.has(id), id);
  const carlisle = r.proposals.find((p) => p.location_slug === 'bellhaven-of-carlisle');
  assert.equal(carlisle.type, 'CREATE_ACCOUNT'); // not confused with New Carlisle, OH
});

test('field fixes and orphans', () => {
  const r = match({ ...load(), today });
  const f = (id) => r.proposals.map((p) => patchOf(p, id)).find(Boolean).fields;
  assert.equal(f('001NXP9X46CWEPSLSV').billing_street, '3156 W Prospect Rd'); // PO box -> street
  assert.equal(f('001CF3LDWVRGL09P4F').billing_zip, '45662');
  assert.equal(f('001RJU1X4NBWC1Q0G7').name, 'Bellhaven of Chagrin Falls');
  assert.equal(f('0017MN2JYAJBDS8WQZ').name, 'Bellhaven Willow Creek');
  assert.ok(!r.proposals.some((p) => patchOf(p, '0014DHACE6WQU3RMM5')), 'Toledo address formatting is not a change');
  const orphans = byType(r.proposals, 'NOT_ON_WEBSITE').map((p) => p.ops[0].account_id).sort();
  assert.deepEqual(orphans, ['00116ETS45BL7DTQP7', '0016PVXH4B25HWR7QE']); // Alliance, Coldwater
});

test('keys are stable across days (notes excluded)', () => {
  const d = load();
  const a = match({ ...d, today: '2026-11-22' }).proposals.map((p) => p.key).sort();
  const b = match({ ...d, today: '2026-11-23' }).proposals.map((p) => p.key).sort();
  assert.deepEqual(a, b);
});

test('end to end: approve all but one, re-run proposes nothing new and never re-queues decisions', async () => {
  const d = load();
  const crm = fakeCrm(d.accounts);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-')), 'state.json');
  const s = store.load(file);
  store.merge(s, match({ ...d, today }).proposals);
  const pending = Object.values(s.proposals);
  const rejectMe = pending.find((p) => p.type === 'NOT_ON_WEBSITE');
  rejectMe.status = 'rejected';
  for (const p of pending) if (p.status === 'pending') { await applyProposal(p, crm); p.status = 'approved'; }
  store.save(s, file);

  // CHOW end state
  const tiffinOld = crm.db.get('001U6RW32TY0WSXZZB');
  assert.ok(tiffinOld.chow_current_account.startsWith('001TESTNEW'));
  assert.equal(tiffinOld.parent_id, '001FWSQ30SFW6S7604', 'old CHOW account keeps its parent');
  assert.equal(crm.db.get(tiffinOld.chow_current_account).parent_id, '0015QAPLGS3FVYEEEM');

  // Day 2: same website, CRM after approvals
  const s2 = store.load(file);
  const counts = store.merge(s2, match({ ...d, accounts: crm.all(), today: '2026-11-23' }).proposals);
  assert.equal(counts.new, 0, 'nothing new after approvals');
  assert.equal(counts.skipped_decided, 1, 'only the rejected item is regenerated, and it is skipped');
  const r2 = match({ ...d, accounts: crm.all(), today: '2026-11-23' });
  assert.equal(r2.matched.filter((m) => m.outcome === 'CONFIRMED').length, 35, 'every community now confirmed');
});

test('apply refuses to overwrite a record that changed after review', async () => {
  const d = load();
  const crm = fakeCrm(d.accounts);
  const p = match({ ...d, today }).proposals.find((x) => x.type === 'REPARENT');
  crm.db.get(p.ops[0].account_id).parent_id = 'SOMEONE_ELSE';
  await assert.rejects(applyProposal(p, crm), /changed since/);
});

test('apply resumes a half-finished CHOW without creating a second account', async () => {
  const d = load();
  const crm = fakeCrm(d.accounts);
  const p = match({ ...d, today }).proposals.find((x) => x.type === 'CHOW_NEW_ACCOUNT');
  const realUpdate = crm.updateAccount;
  crm.updateAccount = async () => { throw new Error('network down'); };
  await assert.rejects(applyProposal(p, crm));
  crm.updateAccount = realUpdate;
  await applyProposal(p, crm);
  assert.equal(crm.all().filter((a) => a.account_id.startsWith('001TESTNEW')).length, 1);
});

test('scraper parses a detail page', () => {
  const html = `<h1>Bellhaven Shores of Erie</h1><dl class="detail"><dt>Address</dt><dd>4930 W Lake Rd<br>Erie, PA 16505</dd>
    <dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span><span class="badge">Memory Support</span></dd>
    <dt>Administrator</dt><dd>Angela Quinn</dd><dt>Phone</dt><dd>(614) 792-9343</dd></dl>`;
  const l = parseCommunity(html, 'bellhaven-shores-of-erie');
  assert.deepEqual([l.street, l.city, l.state, l.zip], ['4930 W Lake Rd', 'Erie', 'PA', '16505']);
  assert.deepEqual(l.care_types, ['Assisted Living', 'Memory Care']);
  assert.equal(l.administrator, 'Angela Quinn');
  assert.deepEqual(l.parse_warnings, []);
});

test('scraper crawl: survives a looping pager and finds homepage-only communities', async () => {
  const { SITE_URL } = require('../src/config');
  const pages = {
    '/': '<a href="/communities">dir</a><a href="/communities/hidden-one">Hidden</a>',
    '/communities': '<a href="/communities/a">A</a><a href="/communities?page=2">next</a>',
    '/communities?page=2': '<a href="/communities/b">B</a><a href="/communities?page=2">next</a><a href="/communities">prev</a>',
    '/about': '',
  };
  const detail = (n) => `<h1>${n}</h1><dt>Address</dt><dd>1 Main St<br>Town, OH 44000</dd><dt>Care Offerings</dt><dd><span class="badge">Assisted Living</span></dd>`;
  const orig = global.fetch;
  global.fetch = async (url) => {
    const p = url.slice(SITE_URL.length);
    const body = p in pages ? pages[p] : p.startsWith('/communities/') ? detail(p.split('/').pop()) : null;
    return { ok: body !== null, status: body === null ? 404 : 200, text: async () => body };
  };
  try {
    const locs = await require('../src/scraper').scrape({ log: () => {} });
    assert.deepEqual(locs.map((l) => l.slug), ['a', 'b', 'hidden-one']);
    assert.equal(locs.find((l) => l.slug === 'hidden-one').in_directory, false);
  } finally { global.fetch = orig; }
});
