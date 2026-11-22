'use strict';
// Normalisation helpers for fuzzy-but-explainable comparison of names and addresses.

const STREET_SUFFIX = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr', boulevard: 'blvd', blvd: 'blvd', lane: 'ln', ln: 'ln',
  pike: 'pike', pk: 'pike', court: 'ct', ct: 'ct', place: 'pl', pl: 'pl',
  parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', circle: 'cir', cir: 'cir',
  terrace: 'ter', ter: 'ter', way: 'way', square: 'sq', sq: 'sq',
};
const DIRECTION = {
  north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
  northwest: 'nw', nw: 'nw', northeast: 'ne', ne: 'ne', southwest: 'sw', sw: 'sw', southeast: 'se', se: 'se',
};

function clean(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "4850 Northwest Sylvania Avenue" -> "4850 nw sylvania ave" */
function normStreet(s) {
  return clean(s)
    .split(' ')
    .map((t) => STREET_SUFFIX[t] || DIRECTION[t] || t)
    .join(' ');
}

function isPoBox(street) {
  return /^p\s*o\s*box\b/.test(clean(street).replace(/\./g, ''));
}

function streetNumber(s) {
  const m = normStreet(s).match(/^(\d+)\b/);
  return m ? m[1] : '';
}

function normZip(z) {
  return String(z || '').trim().slice(0, 5);
}

// Words that carry no identity in a facility name.
const NAME_STOP = new Set([
  'the', 'of', 'at', 'and', 'a', 'senior', 'living', 'care', 'center', 'centre', 'health', 'healthcare',
  'nursing', 'rehabilitation', 'rehab', 'campus', 'community', 'communities', 'facility',
]);
const NAME_SYNONYM = { centre: 'center', rehab: 'rehabilitation', healthcare: 'health care' };

/** Canonical name used to decide whether two names are *the same name* (cosmetic differences only). */
function canonicalName(s) {
  return clean(s)
    .split(' ')
    .flatMap((t) => (NAME_SYNONYM[t] || t).split(' '))
    .filter((t) => t !== 'the')
    .join(' ');
}

/** Distinctive tokens of a name (operator brand words removed too). */
function nameTokens(s, extraStop = []) {
  const stop = new Set([...NAME_STOP, ...extraStop]);
  return canonicalName(s).split(' ').filter((t) => t && !stop.has(t));
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

module.exports = { clean, normStreet, isPoBox, streetNumber, normZip, canonicalName, nameTokens, jaccard };
