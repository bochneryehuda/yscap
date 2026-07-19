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

module.exports = { norm, digitsOnly, num, withinMoney, namesMatch, addrKey, addrMatches, addrLine, daysBetween };
