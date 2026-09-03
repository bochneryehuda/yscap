/**
 * WHICH WAY A PRICING FIGURE IS CUT — the browser's copy of the server's rule.
 *
 * ── THE OWNER'S RULE ───────────────────────────────────────────────────────
 * 2026-08-30: *"The DSCR should always be rounded down, and the LTV should always
 * be rounded up, so we should never see better."*
 *
 * ⛔ WHY A MIRROR AT ALL. The rule's home is `src/longterm/pricing/tier-rounding.js`,
 * and a browser module cannot require server code (the `lib/payoff.js` arrangement).
 * So this is a mirror, and `scripts/test-lt-dscr-round-down-pure.js` runs BOTH copies
 * over one battery and fails the moment they disagree — the discipline every other
 * mirror in this repo is held to.
 *
 * ⛔ AND THE MIRROR TEST IS NOT THE WHOLE GUARD. Two copies of one MISTAKE agree
 * perfectly (CLAUDE.md, the feasibility-fee bridge case: a consistency check passed for
 * two years while both copies were wrong the same way). So that suite asserts the RULE
 * as well — a DSCR is never rounded UP, whatever the two copies happen to agree on.
 *
 * ── WHY THE CALCULATOR NEEDED IT ───────────────────────────────────────────
 * The screen's DSCR was `Math.round(x * 100) / 100` — to NEAREST — while every search
 * sent to a rate sheet cuts the same figure DOWN. So a loan computing 1.2449 was shown
 * as 1.24 and priced at 1.24 (agreeing), but one computing 1.2451 was SHOWN as 1.25 and
 * PRICED at 1.24: the officer read a DSCR band the loan had not earned, off the very
 * screen that decides whether to send it. That is the exact harm the server rule exists
 * to prevent, arriving one layer above it.
 *
 * ── THE FLOAT GUARD IS LOAD-BEARING, NOT TIDINESS ──────────────────────────
 * `1.15 * 100` is `114.99999999999999` in floating point, so a plain `Math.floor` would
 * cut a typed 1.15 to 1.14 — moving a figure somebody entered exactly, by a whole cent,
 * in the direction this module exists to prevent going unnoticed. A scaled value within
 * noise of a whole number IS that whole number; only a genuine fraction is cut. The
 * tolerance is RELATIVE with an absolute floor, because the callers work at very
 * different scales.
 *
 * PURE: no imports, so every rule here is unit-testable.
 */

/** Which way each figure is cut. The same table as the server's. */
export const DIRECTION = Object.freeze({ dscr: 'down', ltv: 'up' });

/** The scaled tolerance: float noise at this magnitude, never a real fraction. */
function slack(x) { return Math.max(1e-9, Math.abs(x) * 1e-12); }

/** `n` cut DOWN to `dp` decimals — never up. */
export function cutDown(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  const x = n * f;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < slack(x) ? whole : Math.floor(x)) / f;
}

/** `n` lifted UP to `dp` decimals — never down. */
export function liftUp(n, dp) {
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, dp);
  const x = n * f;
  const whole = Math.round(x);
  return (Math.abs(x - whole) < slack(x) ? whole : Math.ceil(x)) / f;
}

/**
 * The rule applied by NAME. Taking the FIELD rather than a direction is what makes it
 * impossible to get backwards at a call site. An unknown field THROWS rather than
 * guessing — a silent default would be a figure cut the wrong way.
 */
export function sendAs(field, n, dp) {
  const dir = DIRECTION[field];
  if (!dir) throw new Error(`tierRounding: no rule for '${field}' — add its direction to DIRECTION rather than defaulting one.`);
  return dir === 'down' ? cutDown(n, dp) : liftUp(n, dp);
}
