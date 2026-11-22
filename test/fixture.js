'use strict';
// Loads the pipe-separated snapshot fixtures into the same shapes the live API/scraper return.
const fs = require('fs');
const path = require('path');
const { CARE_TYPE_MAP } = require('../src/config');
const P = { BH: '0015QAPLGS3FVYEEEM', SB: '00139TNDS8HNLUZ5A6', JP: '001DAAUWV2J3SHQJ34', CT: '001FWSQ30SFW6S7604', HV: '001FJZYHR7MLFMNPLL', MS: '001YRHHXQ5HJ0TCL2U' };
const rows = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));

function load() {
  const accounts = rows('accounts.psv').map(([account_id, name, p, billing_street, billing_city, billing_state, billing_zip, care_type, status, rev, ar]) => ({
    account_id, name, parent_id: P[p] || '', billing_street, billing_city, billing_state, billing_zip, care_type, status,
    lifetime_revenue: Number(rev), outstanding_ar: Number(ar), chow_current_account: '', duplicate_of_account: '', note: '', phone: '',
  }));
  const names = Object.fromEntries(accounts.map((a) => [a.account_id, a.name]));
  for (const a of accounts) a.parent_name = names[a.parent_id] || '';
  const contacts = rows('contacts.psv').map(([account_id, name, title]) => ({ account_id, name, title, email: '', is_active: true }));
  const locations = rows('locations.psv').map(([slug, name, street, city, state, zip, care, administrator, phone, inDir]) => {
    const care_offerings = care.split(';');
    return { slug, url: `https://example/communities/${slug}`, name, street, city, state, zip, care_offerings,
      care_types: [...new Set(care_offerings.map((c) => CARE_TYPE_MAP[c.toLowerCase()]))], administrator, phone,
      in_directory: inDir === '1', discovered_on: [], parse_warnings: [] };
  });
  return { accounts, contacts, locations, P };
}
module.exports = { load };
