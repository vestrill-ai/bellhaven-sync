'use strict';
// Pure matching/classification logic: (website locations, CRM accounts, CRM contacts) -> proposals.
// No I/O here, so it is fully unit-testable against a snapshot.
const crypto = require('crypto');
const N = require('./normalize');
const cfg = require('./config');

const BRAND_STOP = ['bellhaven'];

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;
const hasBillingHold = (a) => Number(a.lifetime_revenue) > 0 && Number(a.outstanding_ar) > 0;
const isSuperseded = (a) => Boolean(a.chow_current_account || a.duplicate_of_account);

function stableKey(obj) {
  // Notes contain dates, so they are excluded from identity: re-running tomorrow must produce the same key.
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) if (k !== 'note' && k !== 'expect') o[k] = strip(v[k]);
      return o;
    }
    return v;
  };
  return crypto.createHash('sha1').update(JSON.stringify(strip(obj))).digest('hex').slice(0, 16);
}

function noteWith(existing, text, today) {
  const line = `[${cfg.NOTE_TAG} ${today}] ${text}`;
  return existing ? `${existing}\n${line}` : line;
}

function pick(a, fields) {
  const o = {};
  for (const f of fields) o[f] = a[f] ?? '';
  return o;
}

const SNAPSHOT_FIELDS = ['account_id', 'name', 'parent_id', 'parent_name', 'billing_street', 'billing_city', 'billing_state',
  'billing_zip', 'care_type', 'status', 'phone', 'lifetime_revenue', 'outstanding_ar', 'chow_current_account',
  'duplicate_of_account', 'note', 'updated_at'];

// ---------------------------------------------------------------------------------------------
// location <-> account comparison
// ---------------------------------------------------------------------------------------------
function compare(loc, acc, contactsByAccount) {
  const sameZip = N.normZip(loc.zip) && N.normZip(loc.zip) === N.normZip(acc.billing_zip);
  const sameCity = N.clean(loc.city) === N.clean(acc.billing_city) && loc.state === acc.billing_state;
  const sameStreet = N.normStreet(loc.street) === N.normStreet(acc.billing_street);
  const sameNumber = N.streetNumber(loc.street) && N.streetNumber(loc.street) === N.streetNumber(acc.billing_street);
  const streetTokSim = N.jaccard(N.normStreet(loc.street).split(' ').slice(1), N.normStreet(acc.billing_street).split(' ').slice(1));
  const nameEqual = N.canonicalName(loc.name) === N.canonicalName(acc.name);
  const nameSim = N.jaccard(N.nameTokens(loc.name, BRAND_STOP), N.nameTokens(acc.name, BRAND_STOP));
  const admin = N.clean(loc.administrator);
  const adminMatch = Boolean(admin) && (contactsByAccount[acc.account_id] || []).some((c) => N.clean(c.name) === admin);

  const addressMatch = sameStreet && (sameZip || sameCity);
  const addressNear = !addressMatch && sameNumber && streetTokSim >= 0.5 && (sameZip || sameCity);

  const reasons = [];
  let match = false;
  if (addressMatch) { match = true; reasons.push('same street address'); }
  else if (addressNear) { match = true; reasons.push('same street number and street (minor formatting difference)'); }
  if (nameEqual && sameCity) { match = true; reasons.push('same name in the same city'); }
  else if (nameEqual) reasons.push('same name');
  if (adminMatch && sameCity) { match = true; reasons.push(`administrator "${loc.administrator}" is a contact on this account`); }
  if (sameZip) reasons.push('same ZIP');
  if (sameCity && !reasons.includes('same name in the same city')) reasons.push('same city');

  // A "near miss" is something a reviewer should see but which is NOT enough to auto-link.
  const nearMiss = !match && ((nameEqual) || (nameSim >= 0.5 && sameCity) || (sameCity && sameNumber));
  if (nearMiss) {
    if (!sameCity) reasons.push(`different city/state (${acc.billing_city}, ${acc.billing_state})`);
    else if (!sameStreet) reasons.push(`different street (${acc.billing_street})`);
  }
  return { match, nearMiss, addressMatch, sameCity, nameEqual, nameSim, adminMatch, reasons,
    rawAddressExact: N.clean(loc.street) === N.clean(acc.billing_street) };
}

/** Rank duplicate candidates to choose the survivor. Order is documented in the README. */
function survivorOrder(operatorId) {
  return (x, y) => {
    const a = x.acc, b = y.acc, ca = x.cmp, cb = y.cmp;
    const keys = [
      [a.parent_id === operatorId, b.parent_id === operatorId],
      [ca.adminMatch, cb.adminMatch],
      [ca.nameEqual, cb.nameEqual],
      [Number(a.lifetime_revenue) > 0, Number(b.lifetime_revenue) > 0],
      [a.status === 'Active', b.status === 'Active'],
      [ca.rawAddressExact, cb.rawAddressExact],
      [Boolean(a.parent_id), Boolean(b.parent_id)],
    ];
    for (const [p, q] of keys) if (p !== q) return p ? -1 : 1;
    return a.account_id.localeCompare(b.account_id);
  };
}

function fieldDiffs(loc, acc) {
  const f = {};
  const why = [];
  if (loc.name && loc.name.trim() !== String(acc.name || '').trim()) {
    f.name = loc.name;
    why.push(N.canonicalName(loc.name) === N.canonicalName(acc.name)
      ? `name formatting: "${acc.name}" → "${loc.name}"`
      : `outdated name: "${acc.name}" → "${loc.name}"`);
  }
  if (N.normStreet(loc.street) !== N.normStreet(acc.billing_street)) {
    f.billing_street = loc.street;
    why.push(`street: "${acc.billing_street}" → "${loc.street}"${N.isPoBox(acc.billing_street) ? ' (CRM had a PO Box, not the facility address)' : ''}`);
  }
  if (N.clean(loc.city) !== N.clean(acc.billing_city)) { f.billing_city = loc.city; why.push(`city: "${acc.billing_city}" → "${loc.city}"`); }
  if (loc.state && loc.state !== acc.billing_state) { f.billing_state = loc.state; why.push(`state: "${acc.billing_state}" → "${loc.state}"`); }
  if (loc.zip && N.normZip(loc.zip) !== N.normZip(acc.billing_zip)) { f.billing_zip = loc.zip; why.push(`zip: "${acc.billing_zip}" → "${loc.zip}"`); }
  // care_type is a single picklist value; the website can list several offerings. Only change it if the
  // current value is not one of the offerings at all.
  if (loc.care_types.length && !loc.care_types.includes(acc.care_type)) {
    f.care_type = loc.care_types[0];
    why.push(`care type: "${acc.care_type || '(blank)'}" → "${loc.care_types[0]}" (website: ${loc.care_offerings.join(', ')})`);
  }
  if (acc.status === 'Inactive') { f.status = 'Active'; why.push('account was Inactive but the community is live on the website'); }
  return { fields: f, why };
}

function newAccountFields(loc, operatorId) {
  return {
    name: loc.name,
    parent_id: operatorId,
    billing_street: loc.street,
    billing_city: loc.city,
    billing_state: loc.state,
    billing_zip: loc.zip,
    care_type: loc.care_types[0] || '',
    phone: loc.phone,
    status: 'Active',
  };
}

const expectOf = (acc, fields) => {
  const e = {};
  for (const k of Object.keys(fields)) if (k !== 'note') e[k] = acc[k] ?? '';
  e.parent_id = acc.parent_id ?? '';
  return e;
};

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
function match({ locations, accounts, contacts = [], today = new Date().toISOString().slice(0, 10) }) {
  const byId = Object.fromEntries(accounts.map((a) => [a.account_id, a]));
  const parentIds = new Set(accounts.map((a) => a.parent_id).filter(Boolean));
  const isParentAccount = (a) => parentIds.has(a.account_id) || /\(parent account\)/i.test(a.name);
  const operator = accounts.find((a) => isParentAccount(a) && cfg.OPERATOR_PARENT_MATCH.test(a.name));
  if (!operator) throw new Error(`Could not find the ${cfg.OPERATOR_NAME} parent account in the CRM`);
  const OP = operator.account_id;
  const parentName = (id) => (byId[id] ? byId[id].name.replace(/\s*\(parent account\)\s*/i, '') : id ? id : '(no parent)');

  const contactsByAccount = {};
  for (const c of contacts) if (c.is_active !== false) (contactsByAccount[c.account_id] ||= []).push(c);
  const contactsOf = (id) => (contactsByAccount[id] || []).map((c) => pick(c, ['name', 'title', 'email']));
  const snap = (a) => ({ ...pick(a, SNAPSHOT_FIELDS), parent_name: parentName(a.parent_id), contacts: contactsOf(a.account_id) });

  const live = accounts.filter((a) => !isParentAccount(a) && !isSuperseded(a));
  const proposals = [];
  const matchedRows = [];
  const claimed = new Map(); // account_id -> slug (survivor or loser)

  const push = (p) => {
    p.key = stableKey({ type: p.type, slug: p.location_slug || null, ops: p.ops });
    proposals.push(p);
  };

  for (const loc of locations) {
    const cands = live.map((acc) => ({ acc, cmp: compare(loc, acc, contactsByAccount) }));
    const hits = cands.filter((c) => c.cmp.match).sort(survivorOrder(OP));
    const near = cands.filter((c) => c.cmp.nearMiss);
    const evidenceBase = {
      website: loc,
      near_misses: near.map((c) => ({ ...snap(c.acc), why_not: c.cmp.reasons })),
    };

    if (!hits.length) {
      const fields = newAccountFields(loc, OP);
      fields.note = noteWith('', `Created from ${cfg.OPERATOR_NAME} website (${loc.url}).`, today);
      const reasons = ['No CRM account matches this community by address, name+city, or administrator.'];
      if (!loc.in_directory) reasons.push('This community is linked from the homepage but missing from the website directory.');
      for (const c of near) reasons.push(`Considered and rejected "${c.acc.name}" (${parentName(c.acc.parent_id)}): ${c.cmp.reasons.join('; ')}.`);
      push({
        type: 'CREATE_ACCOUNT', location_slug: loc.slug, confidence: near.length ? 'medium' : 'high',
        title: `New account: ${loc.name} (${loc.city}, ${loc.state})`,
        summary: `Create a new account under ${parentName(OP)}.`, reasons,
        evidence: { ...evidenceBase, crm: [] },
        ops: [{ op: 'create', ref: 'new', fields }],
      });
      matchedRows.push({ slug: loc.slug, name: loc.name, outcome: 'NEW' });
      continue;
    }

    const [win, ...losers] = hits;
    const acc = win.acc;
    claimed.set(acc.account_id, loc.slug);
    const crmEvidence = hits.map((h) => ({ ...snap(h.acc), match_reasons: h.cmp.reasons, role: h === win ? 'survivor' : 'duplicate' }));
    const confidence = win.cmp.addressMatch && (win.cmp.nameEqual || win.cmp.adminMatch) ? 'high' : 'medium';

    // --- duplicates -------------------------------------------------------------------------
    for (const l of losers) {
      claimed.set(l.acc.account_id, loc.slug);
      const a = l.acc;
      const reasons = [
        `"${a.name}" (${parentName(a.parent_id)}) matches the same website community as "${acc.name}": ${l.cmp.reasons.join('; ')}.`,
        `Survivor chosen: "${acc.name}" [${acc.account_id}] — ranked by: under ${parentName(OP)} › administrator contact › exact name › revenue history › active › exact address › has a parent.`,
      ];
      if (Number(a.lifetime_revenue) > 0 || Number(a.outstanding_ar) > 0)
        reasons.push(`⚠ This copy has billing history (revenue ${money(a.lifetime_revenue)}, AR ${money(a.outstanding_ar)}). Confirm with billing before deactivating.`);
      if ((contactsByAccount[a.account_id] || []).length)
        reasons.push(`This copy has ${contactsByAccount[a.account_id].length} contact(s); they stay attached to it (no contact moves are made).`);
      const fields = {
        duplicate_of_account: acc.account_id,
        status: 'Inactive',
        note: noteWith(a.note, `Duplicate of ${acc.account_id} ("${loc.name}", ${loc.street}). Inactivated.`, today),
      };
      push({
        type: 'MARK_DUPLICATE', location_slug: loc.slug, confidence: hits.length > 2 ? 'medium' : 'high',
        title: `Duplicate: ${a.name} → ${loc.name}`,
        summary: `Mark [${a.account_id}] as a duplicate of [${acc.account_id}] and set it Inactive.`,
        reasons, evidence: { ...evidenceBase, crm: crmEvidence },
        ops: [{ op: 'patch', account_id: a.account_id, fields, expect: expectOf(a, fields) }],
      });
    }

    // --- survivor ---------------------------------------------------------------------------
    const { fields: diff, why } = fieldDiffs(loc, acc);
    const reasons = [`Matched "${acc.name}" [${acc.account_id}]: ${win.cmp.reasons.join('; ')}.`];
    if (!loc.in_directory) reasons.push('Community is linked from the homepage but missing from the website directory.');

    if (acc.parent_id === OP) {
      if (!Object.keys(diff).length) {
        matchedRows.push({ slug: loc.slug, name: loc.name, outcome: 'CONFIRMED', account_id: acc.account_id });
        continue;
      }
      const fields = { ...diff, note: noteWith(acc.note, `Synced to website: ${why.join('; ')}.`, today) };
      push({
        type: 'UPDATE_FIELDS', location_slug: loc.slug, confidence,
        title: `Update details: ${acc.name}${diff.name ? ` → ${loc.name}` : ''}`,
        summary: why.join(' · '), reasons: [...reasons, ...why],
        evidence: { ...evidenceBase, crm: crmEvidence },
        ops: [{ op: 'patch', account_id: acc.account_id, fields, expect: expectOf(acc, fields) }],
      });
      matchedRows.push({ slug: loc.slug, name: loc.name, outcome: 'UPDATE', account_id: acc.account_id });
      continue;
    }

    // Wrong parent -> apply the billing SOP.
    const from = parentName(acc.parent_id);
    const sop = `Billing check: lifetime revenue ${money(acc.lifetime_revenue)}, outstanding AR ${money(acc.outstanding_ar)}.`;
    if (hasBillingHold(acc)) {
      const fields = newAccountFields(loc, OP);
      fields.note = noteWith('', `Change of ownership: ${loc.name} moved from ${from} to ${parentName(OP)}. ` +
        `Prior account ${acc.account_id} kept intact for billing (revenue ${money(acc.lifetime_revenue)}, AR ${money(acc.outstanding_ar)}).`, today);
      push({
        type: 'CHOW_NEW_ACCOUNT', location_slug: loc.slug, confidence,
        title: `Ownership change: ${loc.name} (${from} → ${parentName(OP)})`,
        summary: `Create a new account under ${parentName(OP)}. The old account [${acc.account_id}] stays as it is for billing and gets a link to the new one.`,
        reasons: [...reasons, `Currently under ${from}; the website lists it as a ${cfg.OPERATOR_NAME} community.`, sop,
          'Billing SOP: has revenue and open AR, so the old account must not be moved. A new account is created and the old one is linked to it (CHOW).'],
        evidence: { ...evidenceBase, crm: crmEvidence },
        ops: [
          { op: 'create', ref: 'new', fields },
          { op: 'patch', account_id: acc.account_id, fields: { chow_current_account: '$new' }, expect: expectOf(acc, { chow_current_account: '' }) },
        ],
      });
      matchedRows.push({ slug: loc.slug, name: loc.name, outcome: 'CHOW', account_id: acc.account_id });
    } else {
      const fields = { parent_id: OP, ...diff };
      fields.note = noteWith(acc.note, `Re-parented from ${from} to ${parentName(OP)} (listed on ${cfg.OPERATOR_NAME} website)` +
        `${why.length ? `; ${why.join('; ')}` : ''}.`, today);
      push({
        type: 'REPARENT', location_slug: loc.slug, confidence,
        title: `Move to ${parentName(OP)}: ${acc.name} (${from} → ${parentName(OP)})${diff.name ? ` + rename to ${loc.name}` : ''}`,
        summary: `Move [${acc.account_id}] under ${parentName(OP)}${why.length ? ` and fix: ${why.join('; ')}` : ''}.`,
        reasons: [...reasons, `Currently under ${from}; the website lists it as a ${cfg.OPERATOR_NAME} community.`, sop,
          'Billing SOP: no revenue-plus-open-AR hold, so the existing account is moved directly.', ...why],
        evidence: { ...evidenceBase, crm: crmEvidence },
        ops: [{ op: 'patch', account_id: acc.account_id, fields, expect: expectOf(acc, fields) }],
      });
      matchedRows.push({ slug: loc.slug, name: loc.name, outcome: 'REPARENT', account_id: acc.account_id });
    }
  }

  // --- operator accounts that are no longer on the website ----------------------------------
  for (const a of live) {
    if (a.parent_id !== OP || claimed.has(a.account_id)) continue;
    // Did the facility change hands? Look for a live account at the same address under another parent.
    const successor = live.find((b) => b.account_id !== a.account_id && b.parent_id && b.parent_id !== OP &&
      N.normStreet(b.billing_street) === N.normStreet(a.billing_street) && N.normZip(b.billing_zip) === N.normZip(a.billing_zip));
    const base = [`"${a.name}" is under ${parentName(OP)} in the CRM but does not appear anywhere on the ${cfg.OPERATOR_NAME} website.`];
    const evidence = { website: null, crm: [snap(a), ...(successor ? [snap(successor)] : [])] };
    if (successor) {
      const to = parentName(successor.parent_id);
      const why = `Another account, "${successor.name}" [${successor.account_id}] under ${to}, is at the same address (${successor.billing_street}, ${successor.billing_city}) → the facility appears to have been sold to ${to}.`;
      const sop = `Billing check: lifetime revenue ${money(a.lifetime_revenue)}, outstanding AR ${money(a.outstanding_ar)}.`;
      if (hasBillingHold(a)) {
        push({
          type: 'CHOW_EXISTING', confidence: 'high',
          title: `Sold to ${to}: ${a.name}`,
          summary: `Keep [${a.account_id}] as it is for billing and link it to the existing ${to} account [${successor.account_id}].`,
          reasons: [...base, why, sop,
            'Billing SOP: has revenue and open AR, so the old account is kept unchanged and only linked to the new owner\'s account (CHOW).',
            `An account for the facility under ${to} already exists, so it is linked instead of creating a second copy.`],
          evidence,
          ops: [{ op: 'patch', account_id: a.account_id, fields: { chow_current_account: successor.account_id }, expect: expectOf(a, { chow_current_account: '' }) }],
        });
      } else {
        const fields = { duplicate_of_account: successor.account_id, status: 'Inactive',
          note: noteWith(a.note, `No longer a ${cfg.OPERATOR_NAME} community; facility now tracked as ${successor.account_id} under ${to}.`, today) };
        push({
          type: 'MARK_DUPLICATE', confidence: 'medium',
          title: `Sold to ${to}: ${a.name} (duplicate)`,
          summary: `No billing hold and ${to} already has an account for this facility, so [${a.account_id}] is marked as a duplicate of [${successor.account_id}] and set Inactive.`,
          reasons: [...base, why, sop], evidence,
          ops: [{ op: 'patch', account_id: a.account_id, fields, expect: expectOf(a, fields) }],
        });
      }
      continue;
    }
    if (a.status === 'Needs Review' && String(a.note).includes(cfg.NOTE_TAG)) continue; // already flagged
    const fields = { status: 'Needs Review',
      note: noteWith(a.note, `Not listed on the ${cfg.OPERATOR_NAME} website and no successor account found at this address. Ownership needs to be confirmed.`, today) };
    push({
      type: 'NOT_ON_WEBSITE', confidence: 'medium',
      title: `Not on website: ${a.name} (${a.billing_city}, ${a.billing_state})`,
      summary: `Flag for follow-up (status Needs Review, with a note). The parent company stays as it is until the new owner is known.`,
      reasons: [...base, 'No other CRM account at this address, so the new owner (or closure) is unknown.',
        'Not deactivated or re-parented automatically: absence from a website is weak evidence on its own.'],
      evidence,
      ops: [{ op: 'patch', account_id: a.account_id, fields, expect: expectOf(a, fields) }],
    });
  }

  return { operator: { account_id: OP, name: operator.name }, proposals, matched: matchedRows };
}

module.exports = { match, compare, stableKey };
