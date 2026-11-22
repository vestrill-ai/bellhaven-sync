'use strict';
// Central configuration. Secrets come from the environment or a local .env file (git-ignored).
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (keeps the project dependency-free).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const BASE = process.env.BASE_URL || 'https://analyst-assessment-production.up.railway.app';

module.exports = {
  ROOT,
  SITE_URL: BASE,
  API_URL: process.env.CRM_API_URL || `${BASE}/api/v1`,
  CRM_TOKEN: process.env.CRM_TOKEN || '',
  STATE_FILE: process.env.STATE_FILE || path.join(ROOT, 'data', 'state.json'),
  PORT: Number(process.env.PORT || 3000),

  // The parent company we are reconciling.
  OPERATOR_NAME: 'Bellhaven Senior Living',
  // Name fragment used to find the parent account in the CRM (resolved to an id at runtime).
  OPERATOR_PARENT_MATCH: /^bellhaven senior living\b/i,

  // Website "care offerings" -> CRM care_type picklist.
  CARE_TYPE_MAP: {
    'assisted living': 'Assisted Living',
    'memory support': 'Memory Care',
    'memory care': 'Memory Care',
    'short-term rehabilitation & nursing': 'Skilled Nursing',
    'skilled nursing': 'Skilled Nursing',
    'independent living': 'Independent Living',
  },

  // Tag prefixed to every note we write, so humans can see what the bot did.
  NOTE_TAG: 'bellhaven-sync',
};
