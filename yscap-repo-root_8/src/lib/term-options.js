'use strict';

/**
 * Term-sheet options (owner-directed 2026-07-22).
 *
 * A set of DISPLAY / record-only term-sheet attributes that sit ON TOP of the
 * frozen pricing engines — none of them change any sized number, rate, cap, fee
 * or the cash-to-close / liquidity the engine returns. Everything here is either
 * a label the term sheet prints, a flag saved for downstream use, or a date
 * derived from the estimated closing date.
 *
 *   • 3-month minimum earned interest — OFF by default on Standard & Gold (an
 *     admin may add it per program); ON by default on a MANUAL / custom product
 *     (an admin may turn it off). This SUPERSEDES the 2026-07-14 "always on for
 *     every term sheet" rule. It is a minimum earned-interest (interest floor)
 *     provision and must NEVER be worded as a prepayment penalty.
 *   • accrual type — Non-Dutch / As-Drawn by default (interest on funds actually
 *     drawn); an admin may switch to Dutch / Full-Boat (interest on the entire
 *     committed amount from closing). Saved + printed only — no interest math is
 *     recomputed here (the frozen engine's payment figures are untouched).
 *   • deferred origination fee — a % of the loan paid at EXIT (payoff), NEVER in
 *     cash-to-close or the liquidity to show. Default 0.
 *   • estimated key dates — from the estimated CLOSING date we derive the first
 *     payment date and the maturity date (interest-only fix & flip convention),
 *     so the term sheet prints them; they re-derive whenever closing moves.
 */

const MIN_INTEREST_ROW =
  '3 months (minimum earned interest — not a prepayment penalty)';
const MIN_INTEREST_DETAIL =
  'This loan carries a 3-month minimum earned interest provision: if the loan pays off before three full months of interest have accrued, the remainder of that minimum is due at payoff. This is an interest floor / minimum earned-interest provision, not a prepayment penalty.';

/* ---------------- 3-month minimum earned interest ---------------- */
// Default by program: ON for a manual/custom product, OFF for Standard/Gold.
function defaultMinInterest(program) {
  return String(program || '').toLowerCase() === 'manual';
}
// Resolve the effective flag: an explicit boolean/string wins; otherwise the
// program default. Accepts true/false, 'on'/'off', 'true'/'false', 1/0.
function resolveMinInterest(program, explicit) {
  if (explicit === true || explicit === false) return explicit;
  if (explicit === 1 || explicit === '1' || explicit === 'on' || explicit === 'true') return true;
  if (explicit === 0 || explicit === '0' || explicit === 'off' || explicit === 'false') return false;
  return defaultMinInterest(program);
}

/* ---------------- accrual type ---------------- */
const ACCRUAL_DEFAULT = 'non_dutch';
function resolveAccrual(v) {
  return String(v == null ? '' : v).toLowerCase().indexOf('dutch') === 0 ? 'dutch' : 'non_dutch';
}
function accrualLabel(t) {
  return resolveAccrual(t) === 'dutch' ? 'Dutch / Full-Boat' : 'Non-Dutch / Drawn';
}
function accrualDetail(t) {
  return resolveAccrual(t) === 'dutch'
    ? 'Dutch / Full-Boat interest: interest accrues on the entire committed loan amount from closing, including construction funds that have not yet been drawn.'
    : 'Non-Dutch / As-Drawn interest: interest accrues only on the amount actually advanced and outstanding. The interest-bearing balance increases each time an additional construction draw is released.';
}

/* ---------------- deferred origination fee ---------------- */
// A percentage (e.g. 1 => 1%). 0/absent/negative => none. Never > 100.
function resolveDeferredOrigPct(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0;
}

/* ---------------- draw fee (program default) ---------------- */
function drawFeeLines(program) {
  return String(program || '').toLowerCase() === 'gold'
    ? ['$250 per draw — physical inspection only (no virtual inspections)']
    : ['$299 per draw — hybrid inspection', '$499 per draw — physical inspection'];
}

/* ---------------- estimated key dates ----------------
   All dates are calendar 'YYYY-MM-DD' STRINGS end-to-end (never a JS Date /
   epoch mid-pipeline) per the repo's date-safety rules — component math only,
   so there is never a timezone off-by-one. */
function parseYMD(s) {
  if (s && typeof s === 'object' && s.y != null) return { y: +s.y, mo: +s.mo, d: +s.d };
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return { y, mo, d };
}
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }   // mo is 1-12
function addMonths(o, add) {
  const t = (o.y * 12 + (o.mo - 1)) + add;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return { y: ny, mo: nm, d: Math.min(o.d, daysInMonth(ny, nm)) };
}
function fmtYMD(o) { return o ? `${o.y}-${String(o.mo).padStart(2, '0')}-${String(o.d).padStart(2, '0')}` : null; }

// First payment: the 1st of the SECOND month after closing (close anytime in
// July -> the first regular payment is September 1). The partial (stub / per
// diem) interest from closing through the end of the closing month is collected
// at closing, so the first monthly payment is a full period.
function firstPaymentDate(closing) {
  const c = parseYMD(closing);
  if (!c) return null;
  return fmtYMD(addMonths({ y: c.y, mo: c.mo, d: 1 }, 2));
}
// Maturity: count the scheduled monthly payments FROM the first payment. A
// 12-payment loan with the first payment on Sept 1 matures on the 12th payment
// = Aug 1 the following year — i.e. first payment + (term - 1) months. We do NOT
// add a full term to the first payment (that would create an extra 13th payment).
function maturityDate(firstPayment, termMonths) {
  const fp = parseYMD(firstPayment);
  if (!fp) return null;
  const t = Number(termMonths);
  const n = Number.isFinite(t) && t >= 1 && t <= 60 ? Math.round(t) : 12;
  return fmtYMD(addMonths(fp, n - 1));
}
// One call: from an estimated closing date + term, the derived key dates.
// Returns null fields when no closing date is set.
function keyDates(closing, termMonths) {
  const c = parseYMD(closing);
  const first = c ? firstPaymentDate(c) : null;
  return {
    estClosing: fmtYMD(c),
    firstPayment: first,
    maturity: first ? maturityDate(first, termMonths) : null,
  };
}

module.exports = {
  MIN_INTEREST_ROW, MIN_INTEREST_DETAIL,
  defaultMinInterest, resolveMinInterest,
  ACCRUAL_DEFAULT, resolveAccrual, accrualLabel, accrualDetail,
  resolveDeferredOrigPct,
  drawFeeLines,
  parseYMD, fmtYMD, firstPaymentDate, maturityDate, keyDates,
};
