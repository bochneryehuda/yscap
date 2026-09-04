'use strict';
/**
 * LONG-TERM — DOES THE PRICE BUILD LAND ON THE PRICE WE ARE SHOWING?
 *
 * ── WHY THIS MODULE EXISTS AT ALL ──────────────────────────────────────────
 *
 * Owner-reported 2026-09-04: our board and LoanNEX's own screen disagreed by
 * 0.875 on a single adjustment line. That one turned out to be two different
 * loans — *"That pricing was not an issue at all. It was perfect. The scenario
 * was different."* — but finding that out took a day, because NOTHING IN THE
 * SYSTEM COULD HAVE TOLD THE TWO APART: a LoanNEX row's PRICE comes from the
 * search call and its ITEMISATION from a separate on-demand call, and nothing
 * compared them.
 *
 * The check needs no vendor cooperation and is true of every row from every
 * sheet: does base + adjustments come to the points behind the price we are
 * showing?
 *
 * ── WHY IT IS ITS OWN FILE ─────────────────────────────────────────────────
 *
 * It was written THREE TIMES in three days — in `breakdown.landingOf` (the
 * panel's answer), in the browser twin inside `LtPricer.jsx` (the panel draws
 * its own totals, so a mirror is unavoidable), and then a third time in
 * `termsheet/snapshot.js` when the same rule started REFUSING an issue. Three
 * copies of one rule drift, and the copy that drifts is the one that stops a
 * document going out — or lets one through. A pre-merge audit named it. The
 * arithmetic lives here now; the browser mirror is held to it by
 * `scripts/test-lt-price-lands-pure.mjs`, which extracts the shipped browser
 * expression and RUNS it against this.
 *
 * ── THE DIRECTION IS THE WHOLE OF IT, AND GETTING IT WRONG REFUSED GOOD ROWS ─
 *
 * `gap = (base + adjustments) − adjusted`, in POINTS, where `price = 100 −
 * points`. So a POSITIVE gap means the build's points are higher than the
 * board's — the build supports a LOWER price than the board is showing, i.e.
 * **the board is claiming a better price than its own itemisation supports.**
 * That is the incident, and that is the direction that reaches a borrower's
 * document as a number nobody can stand behind.
 *
 * A NEGATIVE gap is the opposite and is NOT a defect: the itemisation supports
 * a better price than the board shows. On this engine it is routinely OUR OWN
 * DOING — `vendor-margin` holds back a quarter point, and when the base shift
 * that pairs with it cannot be applied (an unreadable settings store makes
 * `explain-door` fall back to a zero shift) the gap is exactly minus the
 * holdback. A pre-merge audit REPRODUCED that: a perfectly good row refused,
 * with advice — "re-price the scenario" — that could not clear it.
 *
 * So `landsOnPrice` answers "do the two agree" (either direction, for a panel
 * that is reporting) and `overstated` answers "is the board better than the
 * build supports" (the one direction worth stopping a document over). Anything
 * that REFUSES reads `overstated`; anything that merely reports may read
 * either, and must say which.
 *
 * PURE: no requires, no database, no clock — so every rule here is unit-testable
 * by calling it, and the browser can hold the same arithmetic without importing
 * server code.
 */

/** A rounding allowance, not a licence. A tenth of a point is real money. */
const TOLERANCE = 0.0005;

/** The engine's own price precision. */
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

/**
 * A finite number, or null. Deliberately stricter than `!= null`: an unreadable
 * figure used to produce `gap = NaN`, and `Math.abs(NaN) < TOLERANCE` is FALSE —
 * so a hole answered "does not land", which is a refusal built on nothing.
 * Unknown is unknown.
 */
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * @param {number|null} basePoints        the sheet's own base, in points
 * @param {number|null} adjustmentPoints  every adjustment, summed, in points
 * @param {number|null} adjustedPoints    the points behind the price being shown
 * @returns {{checked:boolean, gapPoints:number|null, landsOnPrice:boolean|null, overstated:boolean|null}}
 *   `checked:false` when any half is missing — a hole must never read as a clean
 *   bill of health, and must never read as a fault either.
 */
function landingGap(basePoints, adjustmentPoints, adjustedPoints) {
  const base = num(basePoints);
  const adj = num(adjustmentPoints);
  const landed = num(adjustedPoints);
  const checked = base !== null && adj !== null && landed !== null;
  const gap = checked ? round3((base + adj) - landed) : null;
  return {
    checked,
    gapPoints: gap,
    landsOnPrice: checked ? Math.abs(gap) < TOLERANCE : null,
    overstated: checked ? gap >= TOLERANCE : null,
  };
}

/**
 * THE THREE FIGURES, AND NOTHING ELSE — the shape a landing is RECORDED in.
 *
 * ⛔ WHY THE MODULE THAT OWNS THE ARITHMETIC ALSO OWNS THE SHAPE. The landing now
 * makes a round trip: a quote whose build somebody opened is collected into a
 * comparison, parked, and issued an hour later — so the three figures are stored
 * on the cart member and handed back to the browser, which sends them to the
 * issue. Every hop is a chance for a fourth spelling of "the price build" to
 * appear; there is one, and it is here.
 *
 * It is a PROJECTION, never a validation: anything unreadable becomes null and
 * `landingGap` then answers `checked:false`, which is the module's own
 * "absent is not a failure" rule. A whole landing nobody fetched is `null`, so a
 * row that was never opened records nothing rather than a row of holes.
 */
function projectLanding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = num(raw.basePoints);
  const adj = num(raw.adjustmentPoints);
  const landed = num(raw.adjustedPoints);
  if (base === null && adj === null && landed === null) return null;
  return { basePoints: base, adjustmentPoints: adj, adjustedPoints: landed };
}

module.exports = { landingGap, projectLanding, TOLERANCE, _internals: { num, round3 } };
