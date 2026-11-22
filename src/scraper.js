'use strict';
// Crawls the operator website and returns every community it can find.
//
// Why a crawler rather than "read pages 1..N of the directory":
//  - the directory pager is not trustworthy (asking for a page past the end returns the last page again),
//  - at least one community is linked from the homepage but missing from the directory
//    (homepage says 35 communities, directory lists 34).
// So we do a bounded breadth-first crawl of the site's own links, keyed by URL, and collect every
// /communities/<slug> detail page we reach. Duplicates are impossible because we key by slug.
const { SITE_URL, CARE_TYPE_MAP } = require('./config');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&larr;': '←', '&rarr;': '→', '&nbsp;': ' ' };
const decode = (s) => s.replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e);
const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const DETAIL_RE = /^\/communities\/([a-z0-9-]+)\/?$/;
const LISTING_RE = /^\/communities\/?(\?page=\d+)?$/;
const MAX_PAGES = 300;

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'bellhaven-sync/1.0 (CRM hygiene bot)' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

function extractLinks(html) {
  const links = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+)"/gi)) {
    let href = decode(m[1]);
    if (href.startsWith(SITE_URL)) href = href.slice(SITE_URL.length);
    if (href.startsWith('/')) links.push(href.replace(/#.*$/, ''));
  }
  return links;
}

function dd(html, label) {
  const re = new RegExp(`<dt>\\s*${label}\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`, 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

/** Parse one community detail page. Exported for tests. */
function parseCommunity(html, slug) {
  const name = text((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const addrHtml = dd(html, 'Address');
  const [streetHtml, cityLineHtml = ''] = addrHtml.split(/<br\s*\/?>/i);
  const street = text(streetHtml || '');
  const cityLine = text(cityLineHtml);
  const m = cityLine.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
  const careHtml = dd(html, 'Care Offerings');
  const care_offerings = [...careHtml.matchAll(/<span[^>]*class="badge"[^>]*>([\s\S]*?)<\/span>/gi)].map((x) => text(x[1]));
  const loc = {
    slug,
    url: `${SITE_URL}/communities/${slug}`,
    name,
    street,
    city: m ? m[1].trim() : cityLine,
    state: m ? m[2] : '',
    zip: m ? m[3] : '',
    care_offerings,
    care_types: [...new Set(care_offerings.map((c) => CARE_TYPE_MAP[c.toLowerCase()] || c))],
    administrator: text(dd(html, 'Administrator')),
    phone: text(dd(html, 'Phone')),
    parse_warnings: [],
  };
  if (!loc.name) loc.parse_warnings.push('missing name');
  if (!m) loc.parse_warnings.push(`could not parse city/state/zip from "${cityLine}"`);
  for (const c of care_offerings) if (!CARE_TYPE_MAP[c.toLowerCase()]) loc.parse_warnings.push(`unmapped care offering "${c}"`);
  return loc;
}

async function scrape({ log = console.log } = {}) {
  const queue = ['/', '/communities', '/about'];
  const seen = new Set();
  const found = new Map(); // slug -> { discoveredOn: Set }
  while (queue.length && seen.size < MAX_PAGES) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const detail = path.match(DETAIL_RE);
    if (detail) continue; // detail pages are fetched below
    const html = await fetchHtml(SITE_URL + path);
    for (const link of extractLinks(html)) {
      const d = link.match(DETAIL_RE);
      if (d) {
        if (!found.has(d[1])) found.set(d[1], new Set());
        found.get(d[1]).add(path);
      } else if (LISTING_RE.test(link) && !seen.has(link)) {
        queue.push(link);
      }
    }
  }
  const locations = [];
  for (const [slug, from] of found) {
    const html = await fetchHtml(`${SITE_URL}/communities/${slug}`);
    const loc = parseCommunity(html, slug);
    loc.discovered_on = [...from].sort();
    loc.in_directory = loc.discovered_on.some((p) => p.startsWith('/communities'));
    locations.push(loc);
  }
  locations.sort((a, b) => a.slug.localeCompare(b.slug));
  const hidden = locations.filter((l) => !l.in_directory).map((l) => l.name);
  log(`scraper: crawled ${seen.size} listing pages, found ${locations.length} communities` +
    (hidden.length ? ` (${hidden.length} not in directory: ${hidden.join(', ')})` : ''));
  return locations;
}

module.exports = { scrape, parseCommunity };
