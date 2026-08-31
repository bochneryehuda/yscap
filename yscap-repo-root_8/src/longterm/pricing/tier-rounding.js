'use strict';
/**
 * LONG-TERM — WHICH WAY A PRICING FIGURE IS CUT WHEN IT GOES TO A VENDOR.
 *
 * ── THE OWNER'S RULE, IN ONE PLACE ─────────────────────────────────────────
 * 2026-08-30: *"The DSCR should always be rounded down, and the LTV should always
 * be rounded up, so we should never see better."*
 *
 * ⛔ WHY IT IS A RULE AND NOT ARITHMETIC. Both figures are used by every rate
 * sheet as a BAND, and the two bands run in opposite directions:
 *
 *   a HIGHER DSCR prices BETTER  → so rounding a DSCR UP asks for a band the
 *                                  loan has not earned
 *   a HIGHER LTV  prices WORSE   → so rounding an LTV DOWN does the same thing
 *
 * Either way the quote comes back missing an add-on the investor applies at
 * lock, and the borrower is shown a price nobody will honour. Cutting each one
 * the way this module cuts it can only ever land the loan in the band it has
 * actually earned or a worse one, so the error either can still make is the safe
 * one. That is the whole rule, and it is why the direction lives HERE rather
 * than being retyped in each vendor's own mapping: two connectors that each kept
 * their own copy would eventually be asked a different question about one loan.
 *
 * ── THE FLOAT GUARD IS LOAD-BEARING, NOT TIDINESS ──────────────────────────
 * An ordinary `0.7 * 100` is `70.00000000000001` in floating point and
 * `1.15 * 100` is `114.99999999999999`. Without the guard, `liftUp` would push a
 * plain 70% loan to 70.01% and `cutDown` would drop a typed 1.15 DSCR to 1.14 —
 * each moving a figure somebody entered exactly, by a whole cent, in the very
 * direction this module exists to prevent going unnoticed. So a scaled value
 * within noise of a whole number IS that whole number, and only a genuine
 * fraction is cut.
 *
 * The tolerance is RELATIVE with an absolute floor, because these two callers
 * work at very different scales: LoanNEX takes a 2dp percentage (scaled ~8,000)
 * and Lender Price a 6dp fraction (scaled ~800,000). A single absolute epsilon
 * that suits one is either useless or far too loose for the other.
 *
 * PURE: no network, no database, no config, no requires — so every rule here is
 * unit-testable and no caller is surprised by what it drags in.
 */

/** Which way each figure is cut. Read by both connectors; never retyped. */
const DIRECTION = Object.freeze({ dscr: 'down', ltv: 'up' });

/** Why, in the words a screen or a comment can quote. */
const WHY = Object.freeze({
  dscr: 'A higher DSCR prices better, so a DSCR is never rounded up — that would ask for a band the loan has not earned.',
  ltv: 'A higher LTV prices worse, so an LTV is never rounded down — that would ask for a band the loan has not earned.',
});

/** The scaled tolerance: float noise at this magnitude, never a real fraction. */
function slack(x) { return Math.max(1e-9, Math.abs(x) * 1e-12); }

/** `n` cut DOWN to `dp` decimals — never up. */
function cutDown(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  const x = n * f;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < slack(x) ? whole : Math.floor(x)) / f;
}

/** `n` lifted UP to `dp` decimals — never down. */
function liftUp(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  const x = n * f;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < slack(x) ? whole : Math.ceil(x)) / f;
}

/**
 * The rule applied by NAME — the door both connectors are meant to use.
 *
 * Taking the FIELD rather than a direction is what makes the rule impossible to
 * get backwards at a call site: a connector asks "cut this DSCR" and cannot
 * accidentally ask for the other direction, and a test that mutates `DIRECTION`
 * fails every caller at once rather than one of them.
 *
 * An unknown field THROWS rather than guessing a direction — a silent default
 * here would be a figure cut the wrong way on a vendor request, which is the one
 * outcome this module exists to prevent.
 */
function sendAs(field, n, dp) {
  const dir = DIRECTION[field];
  if (!dir) throw new Error(`tier-rounding: no rule for '${field}' — add its direction to DIRECTION rather than defaulting one.`);
  return dir === 'down' ? cutDown(n, dp) : liftUp(n, dp);
}

module.exports = { DIRECTION, WHY, cutDown, liftUp, sendAs, _internals: { slack } };
