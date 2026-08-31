'use strict';
/**
 * LONG-TERM — the money ARITHMETIC every pricing adapter needs, in one place.
 *
 * ── WHY THIS IS SHARED WHEN THE ENUM TABLES DELIBERATELY ARE NOT ───────────
 * Each vendor adapter keeps its OWN enum tables on purpose: two vendors' tokens
 * that agree today are not one fact, and a shared table mis-maps the day either
 * renames one. None of that applies here. The amount triangle is arithmetic, the
 * rounding DIRECTIONS are owner-directed money rules, and both are facts about
 * the LOAN rather than about any vendor. A second copy of a rounding direction
 * is how one adapter comes to price a band better than another for a loan they
 * were both handed identically — which is the exact failure
 * `scenario-defaults.js` was written to end.
 *
 * ⚠️ TWO OLDER COPIES OF `deriveAmounts` EXIST — `lenderprice/search-model.js`
 * and `loannex/scenario.js` — and they predate this module. They are NOT changed
 * from here: both are load-bearing, both carry their own pure tests, and folding
 * them in is a provable change of its own rather than something to smuggle into
 * an unrelated one. This module is the definition new code reads, and the place
 * those two should converge on. Nothing here is a re-derivation: the rules below
 * are the ones already proven by `test-lt-loannex-scenario-pure.js`.
 *
 * PURE: no network, no database, no RTL import.
 */

class AmountError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; this.name = 'AmountError'; }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Cut a number DOWN to 2 decimals — never up.
 *
 * ⛔ THE BINARY REPRESENTATION HAS TO BE CLEARED FIRST, or this rounds the wrong
 * way on ordinary values. `1.15 * 100` is `114.99999999999999` in floating point,
 * so a bare `Math.floor` returns 1.14 — a value somebody typed exactly, moved by
 * a whole cent, in the very direction this function exists to prevent going
 * unnoticed. So a product within a billionth of a whole number IS that whole
 * number (nothing about a real DSCR or LTV lives at that scale), and only a
 * genuine fraction is cut.
 */
function floor2(n) {
  const x = n * 100;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < 1e-9 ? whole : Math.floor(x)) / 100;
}

/** Lift a number UP to 2 decimals — never down. The mirror of `floor2`, sharing its float guard. */
function ceil2(n) {
  const x = n * 100;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < 1e-9 ? whole : Math.ceil(x)) / 100;
}

/**
 * The amount triangle. `value`, `loan` and `ltv` are three views of two facts;
 * any two determine the third, and ONE alone determines nothing — so one alone
 * is refused rather than completed with a default that would price a different
 * loan. LTV is accepted as 75 or 0.75 and returned as a fraction.
 */
function deriveAmounts(sc) {
  const money = (n) => (n == null ? null : Math.round(n * 100) / 100);
  let value = num(sc && (sc.value != null ? sc.value : sc.appraisedValue));
  let loan = num(sc && sc.loan);
  const ltvRaw = num(sc && sc.ltv);
  let ltv = ltvRaw == null ? null : (ltvRaw > 1 ? ltvRaw / 100 : ltvRaw);
  const known = [value, loan, ltv].filter((x) => x != null).length;
  if (known < 2) {
    throw new AmountError('insufficient_amounts', 'loan',
      'Two of { value, loan, ltv } are required — one alone cannot determine the other two.');
  }
  if (value == null) value = money(loan / ltv);
  else if (loan == null) loan = money(value * ltv);
  else if (ltv == null) ltv = value > 0 ? loan / value : null;
  return { value: money(value), loan: money(loan), ltv, ltvString: ltvString(ltv) };
}

/**
 * The LTV as a 2dp percentage string, LIFTED, never rounded.
 *
 * ⛔ Owner-directed 2026-08-30: *"Round this up."* An LTV sits in a BAND and a
 * higher band prices WORSE, so the dangerous direction is DOWN: a loan at
 * 80.0002% rounded to nearest is sent as "80.00", which on a sheet whose next
 * tier begins above 80 asks the vendor to price a loan one band better than the
 * one we actually have — and the quote comes back missing the add-on the
 * investor applies at lock. Lifting can only ever land the loan in the band it
 * has earned or a worse one, so the error it can still make is the safe one.
 */
function ltvString(ltv) {
  if (ltv == null) return null;
  return ceil2(ltv * 100).toFixed(2);
}

/**
 * The DSCR as a 2dp string, CUT DOWN, never lifted — the exact mirror of the LTV
 * rule, because a HIGHER DSCR prices BETTER.
 *
 * ⛔ A DSCR THAT EXISTS IS NEVER SENT AS "NO DSCR". Cutting down is right at
 * every band edge and wrong at exactly one place: a positive DSCR below 0.01
 * floors to "0.00", and 0.00 does not mean "a very weak ratio" — it means the
 * loan HAS no ratio, which is a different product. So a real ratio under a cent
 * is sent as 0.01: the smallest figure that still says one exists. It cannot
 * change a price (the next band edge is far above it) and it stops the system
 * saying a ratio is absent when it is merely dreadful.
 */
function dscrString(v) {
  const n = num(v);
  if (n == null) return null;
  const cut = floor2(n);
  return (cut === 0 && n > 0 ? 0.01 : cut).toFixed(2);
}

module.exports = { AmountError, num, floor2, ceil2, deriveAmounts, ltvString, dscrString };
