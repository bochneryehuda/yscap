'use strict';
/**
 * Shared comparison helpers for the underwriting document-check modules (id-checks,
 * purchase-contract-checks, …). Pure + dependency-free. Kept in one place so every
 * document type compares names/addresses/money/dates the SAME way and the engines
 * never drift — the same reason the appraisal engine centralizes its tolerances.
 */

function norm(s) {
  // Fold diacritics (José -> jose) so an accented name/entity matches its plain-ASCII OCR form and
  // grounding doesn't false-flag it as "unconfirmed". Every name/entity/address comparison routes
  // through norm, so folding here fixes them all at once.
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function num(v) {
  if (v == null || v === '') return null;
  // Accounting notation: a parenthesized figure is negative ("($1,234.00)" -> -1234), so an
  // overdrawn/negative balance parses instead of silently dropping out of a reconciliation.
  const raw = String(v).trim();
  const neg = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[()$,\s]/g, '');
  // blank-after-strip ('$', '  ', '()') is null, never 0 (fix 2026-07-23: a
  // whitespace extraction became a false FATAL "$0" tie-out discrepancy)
  if (cleaned === '') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Money "close enough" — a small absolute tolerance absorbs rounding/extraction noise
// without hiding a real difference. Returns true/false, or null when uncomparable.
function withinMoney(a, b, absTol = 1) {
  const x = num(a), y = num(b);
  if (x == null || y == null) return null;
  return Math.abs(x - y) <= absTol;
}

// Two names refer to the same party — normalized equality OR containment (handles
// "Maple Grove Holdings LLC" vs "Maple Grove Holdings"). Returns true/false or null.
function namesMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return null;
  if (x === y) return true;
  return x.includes(y) || y.includes(x);
}

// --- PERSON name matching (from the audit: avoid false fatals) --------------
// Tolerates middle names/initials, "LAST, FIRST" order, and Jr/Sr/III suffixes, while
// still catching a real spelling difference. Returns true/false or null (uncomparable).
const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v)$/;
function nameTokens(s) {
  if (s == null || s === '') return [];
  let t = String(s);
  // "Smith, John" -> "John Smith" (comma is dropped by norm, so reorder on the raw string)
  if (t.includes(',')) {
    const parts = t.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2) t = `${parts[1]} ${parts[0]}`;
  }
  return norm(t).split(/\s+/).filter((w) => w && !NAME_SUFFIX.test(w));
}
function namesMatchLoose(a, b) {
  const A = nameTokens(a), B = nameTokens(b);
  if (!A.length || !B.length) return null;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  // Every token of the shorter name must appear in the longer one, allowing an
  // initial to match a full first/middle name (J ~ John). A real typo (Jon vs John)
  // still fails, so genuine mismatches are still caught.
  return short.every((ts) => long.some((tl) =>
    tl === ts || (ts.length === 1 && tl[0] === ts) || (tl.length === 1 && ts[0] === tl)));
}

// --- ENTITY name matching (from the audit: "L.L.C." must equal "LLC") --------
// Canonicalizes spaced/abbreviated entity suffixes, then compares core + full forms.
function canonEntity(s) {
  let t = norm(s)                                   // lowercases; strips . , # to spaces
    .replace(/\bl\s+l\s+c\b/g, 'llc')
    .replace(/\bl\s+l\s+p\b/g, 'llp')
    .replace(/\bl\s+p\b/g, 'lp')
    .replace(/\bincorporated\b/g, 'inc')
    .replace(/\bcorporation\b/g, 'corp')
    .replace(/\bcompany\b/g, 'co')
    .replace(/\blimited\b/g, 'ltd');
  return t.replace(/\s+/g, ' ').trim();
}
const ENTITY_SUFFIX = /\b(llc|llp|lp|inc|corp|co|ltd)\b/g;
function entityMatch(a, b) {
  const ca = canonEntity(a), cb = canonEntity(b);
  if (!ca || !cb) return null;
  if (ca === cb) return true;
  const core = (x) => x.replace(ENTITY_SUFFIX, '').replace(/\s+/g, ' ').trim();
  const ka = core(ca), kb = core(cb);
  if (ka && kb && ka === kb) return true;           // same name, differing only by suffix punctuation/type
  return ca.includes(cb) || cb.includes(ca);
}

// --- DATE normalization (from the audit: DOB compared as raw text) -----------
// Coerce common formats to 'YYYY-MM-DD'; return null if unparseable/implausible.
function toISODate(s) {
  if (s == null) return null;
  const t = String(s).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(t);      // YYYY-MM-DD or YYYY/M/D
  if (!m) {
    const mdy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t); // MM/DD/YYYY
    if (mdy) m = [t, mdy[3], mdy[1], mdy[2]];
  }
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Street-suffix + directional normalization so "St"=="Street", "Ave"=="Avenue", etc. and a
// leading/trailing directional (N/S/E/W) doesn't break a match.
const STREET_SUFFIX = {
  st: 'st', street: 'st', ave: 'ave', avenue: 'ave', av: 'ave', rd: 'rd', road: 'rd',
  blvd: 'blvd', boulevard: 'blvd', dr: 'dr', drive: 'dr', ln: 'ln', lane: 'ln', ct: 'ct',
  court: 'ct', pl: 'pl', place: 'pl', ter: 'ter', terrace: 'ter', way: 'way', cir: 'cir',
  circle: 'cir', hwy: 'hwy', highway: 'hwy', pkwy: 'pkwy', parkway: 'pkwy', sq: 'sq', square: 'sq',
  trl: 'trl', trail: 'trl', pt: 'pt', point: 'pt', xing: 'xing', crossing: 'xing',
};
const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
// The street's core tokens (house number dropped, suffix/directionals normalized, unit stripped).
function streetCore(line1) {
  let t = norm(line1 || '');
  t = t.replace(/\b(apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|no)\b.*$/, '').trim();
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length && /^\d/.test(toks[0])) toks.shift(); // drop the leading house number
  return toks.map((x) => STREET_SUFFIX[x] || x).filter((x) => x && !DIRECTIONALS.has(x));
}

// Address compared on house-number + STREET NAME + 5-digit zip. Requiring the street (not just the
// house number + zip) stops a false match between two different streets that share a house number
// in the same zip (e.g. "45 Elm St 07030" vs "45 Oak Ave 07030"). Tolerant of suffix/format
// differences; falls back to whole-line containment when nothing structured parses.
function addrKey(a) {
  if (!a) return null;
  const line1 = norm(a.line1 || a.line || '');
  const zip = digitsOnly(a.zip).slice(0, 5);
  if (!line1 && !zip) return null;
  return { houseNo: (line1.match(/^\d+/) || [''])[0], zip, line1, core: streetCore(line1) };
}
function coresMatch(a, b) {
  if (!a.length || !b.length) return null; // one side has no parseable street → can't decide on street
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(long);
  return short.every((t) => set.has(t));
}
function addrMatches(a1, a2) {
  const a = addrKey(a1), b = addrKey(a2);
  if (!a || !b) return null;
  // Any DEFINITE difference → not the same place.
  if (a.zip && b.zip && a.zip !== b.zip) return false;
  if (a.houseNo && b.houseNo && a.houseNo !== b.houseNo) return false;
  const street = coresMatch(a.core, b.core);
  if (street === false) return false;
  // Positive match needs the street to agree PLUS a corroborating house number or zip.
  const houseSame = a.houseNo && b.houseNo && a.houseNo === b.houseNo;
  const zipSame = a.zip && b.zip && a.zip === b.zip;
  if (street === true && (houseSame || zipSame)) return true;
  // No parseable street on one side: fall back to the old house+zip signal, then containment.
  if (street === null) {
    if (houseSame && zipSame) return true;
    if (a.line1 && b.line1 && (a.line1.includes(b.line1) || b.line1.includes(a.line1))) return true;
  }
  return null;
}
function addrLine(a) {
  if (!a) return null;
  return [a.line1, a.city, a.state, a.zip].filter(Boolean).join(', ') || null;
}

// Whole-day difference between two 'YYYY-MM-DD' strings (no Date-of-now dependence,
// matching the appraisal engine's date discipline).
function daysBetween(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a), pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!pa || !pb) return null;
  const da = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]), db = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((db - da) / 86400000);
}

module.exports = {
  norm, digitsOnly, num, withinMoney,
  namesMatch, namesMatchLoose, nameTokens,
  canonEntity, entityMatch,
  toISODate,
  addrKey, addrMatches, addrLine, daysBetween,
};
