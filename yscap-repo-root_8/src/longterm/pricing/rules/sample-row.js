'use strict';
/**
 * LONG-TERM — THE SAMPLE QUOTE A RULE IS TRIED AGAINST.
 *
 * Owner-directed 2026-09-04: the Rule Center's *"try it before you turn it on"*
 * preview must be able to exercise the rule somebody actually wrote.
 *
 * ── WHY THIS IS A MODULE AND NOT A LITERAL IN THE ROUTE ─────────────────────
 *
 * The preview builds a board row out of what a person typed, and the shape of
 * that row is not obvious: the quoted LTV lives at `terms.ltv`, the price at
 * `priceBuild.price`, the points at `priceBuild.borrowerPaidPoints`. The
 * builder has to know which BOX fills which of those, and if it kept its own
 * copy of that mapping the two would drift — the preview would then test a row
 * that is not the one the boxes on screen describe, and answer with total
 * confidence. So the row builder and the box→field map are authored together,
 * here, and the map is published through the catalog.
 *
 * ⛔ THE ROW IS THE BOARD'S OWN SHAPE, deliberately: `overlay.apply` is handed
 * a real row so the preview walks the SAME code path a live board walks. A
 * preview that ran its own simplified evaluation would be a second opinion
 * about what a rule does, and the one that drifts is the one people trust.
 *
 * PURE: no database, no network, no clock.
 */

/**
 * WHICH BOX FILLS WHICH QUOTE FACT — the one definition (see `facts.js`
 * `SCENARIO_INPUT` for the other half, which covers the loan and the property).
 *
 * A fact absent from here cannot be typed: `engine` is the engine the preview
 * is being run for (the builder already asks for that separately), and
 * `investor_key` / `white_label` / `lender` are answered by the values below
 * them. Every one of them is still readable BY a rule — this map is only about
 * which of them a person may set on the sample.
 */
const QUOTE_INPUT = Object.freeze({
  investor: 'investor',
  investor_key: 'investorKey',
  white_label: 'whiteLabel',
  lender: 'lender',
  program_name: 'program',
  product: 'product',
  note_rate: 'noteRate',
  price: 'price',
  points: 'points',
  quoted_term_years: 'quotedTermYears',
  quoted_lock_days: 'quotedLockDays',
  amortization: 'amortization',
  quoted_ltv: 'quotedLtv',
  quoted_dscr: 'quotedDscr',
  margin_holdback: 'marginHoldback',
  source: 'source',
});

/**
 * A number, or null.
 *
 * ⛔ NEVER `Number(x)` ON ITS OWN HERE. `Number(null)` and `Number('')` are both
 * 0, and 0 is finite — so an EMPTY BOX would arrive as a real, quoted zero. The
 * preview's whole job is to say what a rule does to a quote, and a rule reading
 * `note_rate is less than 7` would fire on a rate nobody typed. Blank means NOT
 * STATED, and a fact nobody stated is null, so a rule about it does not match —
 * which is the honest answer.
 *
 * (The route this replaced did use bare `Number()`, so a blank note rate really
 * did read as 0.000%. Deliberate change, and the safe direction.)
 */
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * A SAMPLE ROW IN THE BOARD'S OWN SHAPE.
 *
 * The three defaults are the only opinions here, and each is the value that
 * makes a preview READ correctly rather than the value a real sheet is likeliest
 * to carry: a price of 100 is par, so a holdback rule's effect is the number a
 * person can check in their head; zero points is the same reasoning; and the
 * placeholder names make it obvious on screen that this is a sample and not
 * somebody's live quote.
 */
function sampleRow(quote) {
  const q = quote || {};
  return {
    investorKey: q.investorKey || 'sample',
    whiteLabel: q.whiteLabel || 'Sample program',
    lender: q.lender || null,
    investor: q.investor || null,
    program: q.program || 'Sample',
    product: q.product || null,
    pricedBy: q.source || null,
    priceBuild: {
      noteRate: numOrNull(q.noteRate),
      price: q.price === undefined || q.price === null || q.price === '' ? 100 : numOrNull(q.price),
      borrowerPaidPoints: q.points === undefined || q.points === null || q.points === '' ? 0 : numOrNull(q.points),
    },
    terms: {
      ltv: numOrNull(q.quotedLtv),
      dscr: numOrNull(q.quotedDscr),
      termYears: numOrNull(q.quotedTermYears),
      dayLock: numOrNull(q.quotedLockDays),
      amortizationType: q.amortization || null,
    },
    marginHoldback: numOrNull(q.marginHoldback),
  };
}

module.exports = { QUOTE_INPUT, sampleRow, _internals: { numOrNull } };
