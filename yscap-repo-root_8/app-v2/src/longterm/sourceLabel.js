/**
 * LONG-TERM — THE BROWSER'S COPY of what we call a rate sheet, and why a
 * breakdown is missing.
 *
 * ⛔ A MIRROR, AND IT MUST STAY ONE. A browser cannot require server code (the
 * `lib/payoff.js` / `dealBasis.js` arrangement used throughout this repo), so
 * `src/longterm/pricing/sources.js` and this file each state the same two
 * vocabularies — and `test-lt-source-vocabulary-pure` runs BOTH over one battery
 * and fails the moment they disagree, or the server grows a reason code this
 * file cannot word. Change one, change the other.
 *
 * ⛔ AN UNKNOWN SOURCE IS NAMED, NEVER GUESSED. Four screens used to answer
 * `s === 'loannex' ? 'LoanNEX' : 'Lender Price'`, which puts a vendor's name over
 * a price that vendor never quoted the day a third sheet exists. The raw key is
 * ugly and honest.
 *
 * ⛔ AND THIS IS AN INTERNAL NAME. Not a white label, not client-facing. What a
 * borrower or a broker may see is decided on the server by
 * `investor-routing.stripSource`; nothing here makes a name safe to show.
 *
 * PURE, and deliberately not JSX: a `.jsx` module can only be loaded in a test
 * by bundling it through esbuild, which is not installed on the build server, so
 * every such suite SKIPS there. These rules are checked everywhere.
 */

/** What we call each rate sheet, on our own screens. */
export const SOURCE_LABELS = {
  lenderprice: 'Lender Price',
  loannex: 'LoanNEX',
};

/** A source key as a readable name — and the raw key back for anything else. */
export function sourceLabel(src) {
  const k = src == null ? '' : String(src);
  return SOURCE_LABELS[k] || k;
}

/**
 * WHY A PRICE HAS NO ITEMISED BREAKDOWN — a FALLBACK, never a second opinion.
 *
 * The vendor's own sentence (`evidence.message`) wins wherever the server has
 * one; this is what to say when it does not. It carries EVERY code the server
 * can emit, because a missing one falls through to the generic sentence and
 * loses the single fact the reader opened the panel for.
 */
export const NO_BREAKDOWN = {
  not_requested: 'Nobody has asked this rate sheet to explain this price yet.',
  quote_incomplete: 'This price reached the breakdown without everything needed to identify it, so the rate sheet was not asked. This one is ours to fix, not the sheet\'s.',
  vendor_returned_no_evidence: 'The rate sheet accepted the question and returned no breakdown for this quote.',
  unrecognised_answer_shape: 'The rate sheet answered in a shape this system does not recognise, so nothing is shown rather than a guess.',
  no_answer: 'The rate sheet was asked and nothing came back.',
  evidence_is_for_a_different_rate_or_lock: 'The breakdown that came back is for a different rate or lock, so it is not shown against this one.',
  unknown: 'No breakdown could be read for this price.',
};

/** The sentence for a reason code, falling back to the honest generic one. */
export function noBreakdownReason(code) {
  const k = code == null ? '' : String(code);
  return NO_BREAKDOWN[k] || NO_BREAKDOWN.unknown;
}
