'use strict';
// Thin client for the CRM sandbox API.
const { API_URL, CRM_TOKEN } = require('./config');

class CrmError extends Error {
  constructor(msg, status, body) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, body) {
  if (!CRM_TOKEN) throw new Error('CRM_TOKEN is not set (put it in .env or the environment)');
  const res = await fetch(API_URL + path, {
    method,
    headers: { Authorization: `Bearer ${CRM_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new CrmError(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, json);
  return json;
}

async function listAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await request('GET', `${path}${sep}page=${page}&page_size=50`);
    const rows = r.data || [];
    out.push(...rows);
    if (!rows.length || out.length >= (r.total ?? Infinity)) break;
  }
  return out;
}

/** Some APIs wrap the created/updated object; unwrap defensively. */
function unwrap(r) {
  if (r && typeof r === 'object' && r.data && !Array.isArray(r.data)) return r.data;
  return r;
}

module.exports = {
  CrmError,
  listAccounts: () => listAll('/accounts'),
  listContacts: () => listAll('/contacts'),
  getAccount: async (id) => unwrap(await request('GET', `/accounts/${encodeURIComponent(id)}`)),
  updateAccount: async (id, fields) => unwrap(await request('PATCH', `/accounts/${encodeURIComponent(id)}`, fields)),
  createAccount: async (fields) => unwrap(await request('POST', '/accounts', fields)),
};
