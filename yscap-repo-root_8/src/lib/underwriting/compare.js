'use strict';
/**
 * Shared comparison helpers for the underwriting document-check modules (id-checks,
 * purchase-contract-checks, …). Pure + dependency-free. Kept in one place so every
 * document type compares names/addresses/money/dates the SAME way and the engines
 * never drift — the same reason the appraisal engine centralizes its tolerances.
 */

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
}
function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
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

// Address compared on house-number + 5-digit zip (hardest to fake, easiest to match),
// tolerant of formatting; falls back to whole-line containment when a zip is missing.
function addrKey(a) {
  if (!a) return null;
  const line1 = norm(a.line1 || a.line || '');
  const zip = digitsOnly(a.zip).slice(0, 5);
  if (!line1 && !zip) return null;
  return { houseNo: (line1.match(/^\d+/) || [''])[0], zip, line1 };
}
function addrMatches(a1, a2) {
  const a = addrKey(a1), b = addrKey(a2);
  if (!a || !b) return null;
  const zipOk = a.zip && b.zip ? a.zip === b.zip : null;
  const houseOk = a.houseNo && b.houseNo ? a.houseNo === b.houseNo : null;
  if (zipOk === true && houseOk !== false) return true;
  if (zipOk === false) return false;
  if (a.line1 && b.line1) return a.line1.includes(b.line1) || b.line1.includes(a.line1);
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
