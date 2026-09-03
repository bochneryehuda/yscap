'use strict';
/**
 * LONG-TERM — PRICE AND POINTS ARE ONE NUMBER SAID TWO WAYS.
 *
 * ── THE IDENTITY, AND WHY IT NEEDED A HOME ─────────────────────────────────
 * `points = 100 − price`. Lender Price states a programme's base in POINTS;
 * LoanNEX states it in PRICE. Every screen shows both, so somewhere the one has
 * to be derived from the other — and it was being derived in EIGHT places across
 * FOUR files, each with its own rounding helper.
 *
 * Those helpers had already drifted, which is the whole reason this module
 * exists. Measured on 2026-09-03:
 *
 *   parse.js `round3`        null → null,  non-finite → NaN
 *   breakdown.js `round3`    null → null,  non-finite → null
 *   quote-shape.js `round3`  null → null,  non-finite → null
 *   vendor-margin.js `r3`    null → NaN,   non-finite → NaN
 *
 * So the same missing figure came back as `null` from one file and `NaN` from
 * the next — and NaN is the worse answer at every single one of these sites: it
 * survives `!= null`, prints as "NaN" on a rate board, and loses every numeric
 * comparison silently rather than reading as "the sheet did not state this".
 *
 * ⛔ THE ANSWER HERE IS ALWAYS `null` FOR ANYTHING THAT IS NOT A REAL NUMBER.
 * A price we cannot read is a price we do not have, and every reader downstream
 * already knows how to say so.
 *
 * ── THREE DECIMALS, BECAUSE THAT IS WHAT THE SHEETS PUBLISH ────────────────
 * Both vendors quote to the thousandth, so that is the precision the identity
 * keeps, and it is deliberately the SAME rounding in both directions: a figure
 * ALREADY AT THAT PRECISION comes back to itself through the pair (proven over
 * every thousandth from 90 to 110 — 20,005 of them, none lost).
 *
 * A figure carrying a FOURTH decimal cannot, by arithmetic rather than by
 * defect: 104.1762 goes out as 104.176. That is precisely why `priceExact`
 * below must never be round-tripped through here.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * ⛔ IT IS NOT A WAY TO RECOMPUTE A FIGURE THAT HAS AN ANCHOR. `vendor-margin`'s
 * rule stands and is the more important one: when a holdback moves a price, the
 * points are SHIFTED by the same amount, never re-derived from the rounded price
 * — `100 − round(price)` can land a thousandth from the points the parser took
 * off the unrounded one, and a board whose price and points disagree by 0.001 is
 * a board somebody will spend an afternoon on. This module is for the case where
 * there is no anchor to shift: the sheet stated one side and not the other.
 *
 * ⛔ AND IT IS NOT `priceExact`. The vendor's own price to the last decimal is
 * kept unrounded and unshifted so LoanNEX can still recognise a quote we hand
 * back to it (`loannex/parse` carries that measurement). Never round-trip that
 * figure through here.
 *
 * ── THE BROWSER KEEPS ITS OWN COPY, ON PURPOSE ─────────────────────────────
 * `app-v2/src/longterm/priceBuild.js baseOf` states the same identity and must
 * stay there: a browser cannot require server code (the `lib/payoff.js`
 * arrangement this repo uses throughout). That mirror is not an eleventh drift
 * — it is guarded, and guarded the right way: `test-lt-base-price-parity-pure`
 * runs BOTH over one battery and fails the moment they disagree. Do not delete
 * it and import this module into the front end; do not change one half without
 * the other.
 *
 * PURE: no requires, no network, no database, no RTL import — so every rule
 * above is unit-testable and no caller is surprised by what it drags in.
 */

/** Par. Both sheets quote against it; it is not a tunable. */
const PAR = 100;

/** The precision both vendors publish to. */
const DECIMALS = 3;
const SCALE = 10 ** DECIMALS;

/**
 * A real number, or null. `Number(null)` is 0 and `Number('')` is 0, so both are
 * refused BY TYPE before the coercion rather than after it — reading a blank
 * field as par is exactly the confident wrong answer this module exists to stop.
 */
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const round = (n) => Math.round(n * SCALE) / SCALE;

/** The points a stated price implies. Null for anything that is not a real number. */
function pointsFromPrice(price) {
  const p = num(price);
  return p == null ? null : round(PAR - p);
}

/** The price a stated points figure implies. Same rule, the other way round. */
function priceFromPoints(points) {
  const p = num(points);
  return p == null ? null : round(PAR - p);
}

module.exports = { pointsFromPrice, priceFromPoints, PAR, DECIMALS, _internals: { num, round } };
