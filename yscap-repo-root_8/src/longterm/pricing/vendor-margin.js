'use strict';
/**
 * LONG-TERM — THE MARGIN HOLDBACK WE ADD OURSELVES.
 *
 * ── THE OWNER'S INSTRUCTION, IN WRITING ────────────────────────────────────
 * 2026-08-30, answering a direct question about whether the 0.25 was Button
 * Finance's alone or wider:
 *
 *   *"Every investor from LoanNEX needs to get the 0.25 margin hold back added,
 *   the same way you see in certain programs that Lender Price is adding it
 *   manually. On LoanNEX, everybody, you need to add this manually."*
 *
 * That is the explicit written authorization the standing pricing rule requires.
 * It is recorded here, in the owner's own words, because this module moves a
 * number a borrower is quoted and the authority for it must sit beside the code.
 *
 * ── WHAT IT IS, AND WHY IT IS NOT A PREFERENCE ─────────────────────────────
 * Lender Price's feed already carries our holdback on certain programs — the
 * vendor bakes it in. LoanNEX's feed does NOT: what it returns is the raw
 * investor price. Left alone, the two feeds are not the same measurement, and a
 * LoanNEX quote would read 0.25 better than a Lender Price quote for reasons
 * that have nothing to do with the investor. So this is not a fee being added;
 * it is the second feed being brought onto the same footing as the first.
 *
 * A HIGHER PRICE IS BETTER EXECUTION, so a holdback SUBTRACTS from the price
 * (and adds to the points, which is the same statement). 0.25 in points.
 *
 * ── APPLIED ONCE, AT ONE PLACE, BEFORE ANYTHING READS THE BOARD ────────────
 * It is applied to the parsed BOARD, immediately after the vendor's answer is
 * normalised and before the merge, the comparison, the quote shape or the
 * compensation overlay see it. Every one of those then works on the held-back
 * number automatically. Applying it in two places is how a holdback comes to be
 * taken twice, and `applyToBoard` refuses to run on a board it has already
 * marked — so a second call is a no-op rather than a second 0.25.
 *
 * ⛔ APPLYING IT AFTER THE COMPARISON WOULD BE THE SUBTLE VERSION OF THE SAME
 * BUG: the merge would elect on raw LoanNEX prices and the board would then
 * display held-back ones, so the reason given for an election would not match
 * the numbers beside it.
 *
 * ── THE RAW NUMBER IS NEVER LOST ───────────────────────────────────────────
 * Every rung keeps `vendorPrice` — exactly what the vendor sent — beside the
 * held-back `price`, plus `marginHoldback` saying how much moved. A number we
 * changed must always be reconcilable to the number we were given.
 *
 * PURE: no network, no database, no RTL import.
 */

/**
 * Points held back per source. Lender Price is ZERO here **not because there is
 * no holdback** but because its feed already carries it — taking it again would
 * double it. That distinction is the whole reason this table is keyed by SOURCE
 * rather than being a single constant.
 */
const MARGIN_HOLDBACK_POINTS = {
  loannex: 0.25,
  lenderprice: 0,
};

const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const nn = (v) => Number.isFinite(Number(v));

/** The holdback for a source; an unknown source holds back NOTHING. */
function holdbackFor(source) {
  const h = MARGIN_HOLDBACK_POINTS[String(source || '').toLowerCase()];
  return nn(h) ? Number(h) : 0;
}

/**
 * Apply the holdback to one normalised board, in place of a copy.
 *
 * Returns a NEW board (the input is not mutated) whose every rung carries:
 *   price          — the held-back price, which is what everything downstream reads
 *   points         — 100 − price, kept in step
 *   vendorPrice    — the vendor's own number, untouched
 *   marginHoldback — how much was held back, so the two reconcile
 *
 * A board with nothing to hold back comes back UNCHANGED (same object), so the
 * Lender Price path is provably untouched by this module.
 */
function applyToBoard(board, source) {
  const pts = holdbackFor(source);
  if (!board || !Array.isArray(board.programs)) return board;
  // ALREADY DONE IS DONE. Without this, a caller that applied it and then passed
  // the board through a second helper would hold back 0.50.
  if (board.marginHoldback != null) return board;
  if (!pts) return board;

  const programs = board.programs.map((p) => ({
    ...p,
    rungs: (p.rungs || []).map((r) => {
      if (!r || !nn(r.price)) return r;
      const vendorPrice = nn(r.vendorPrice) ? Number(r.vendorPrice) : Number(r.price);
      const price = r3(vendorPrice - pts);
      // POINTS ARE SHIFTED, NOT RECOMPUTED. `100 − price` off the ROUNDED price
      // can land a thousandth away from the points the parser derived from the
      // unrounded one, and a board whose price and points disagree by 0.001 is a
      // board somebody will spend an afternoon on. A holdback moves the price
      // down and the points up by exactly the same amount, so shift.
      const points = nn(r.points) ? r3(Number(r.points) + pts) : r3(100 - price);
      return { ...r, vendorPrice: r3(vendorPrice), price, points, marginHoldback: pts };
    }),
  }));
  // The board's own summary figures are derived from the rungs, so they move too
  // — a `maxPrice` still quoting the raw number would contradict every row.
  for (const p of programs) {
    p.minPoints = p.rungs.reduce((m, r) => (nn(r.points) && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (nn(r.price) && (m == null || r.price > m) ? r.price : m), null);
  }
  return {
    ...board,
    programs,
    marginHoldback: pts,
    marginHoldbackNote: `${pts} in points is held back on every ${source} quote (owner-directed): Lender Price's feed already carries it and this one does not, so the two are brought onto the same footing before anything compares them.`,
  };
}

module.exports = { MARGIN_HOLDBACK_POINTS, holdbackFor, applyToBoard, _internals: { r3 } };
