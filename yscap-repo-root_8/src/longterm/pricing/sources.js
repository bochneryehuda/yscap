'use strict';
/**
 * LONG-TERM — WHAT WE CALL A RATE SHEET, AND WHY A BREAKDOWN IS MISSING.
 *
 * Two small vocabularies that were each written out in half a dozen places, and
 * had already drifted in both.
 *
 * ── 1. THE SOURCE LABEL, AND THE ONE ANSWER THAT MATTERS ───────────────────
 * `merge.js` answered `src === 'loannex' ? 'LoanNEX' : 'Lender Price'` — so ANY
 * source that is not LoanNEX was called Lender Price, including one nobody has
 * heard of. `investor-routing.js` answered the raw string for the same input.
 * Four more spellings sat in the front end, two of them the merge version.
 *
 * ⛔ AN UNKNOWN SOURCE IS NAMED, NEVER GUESSED. The whole point of this
 * integration is that a second rate sheet exists, so a third one is not
 * hypothetical — and the expensive failure is a board that says "Lender Price"
 * over a price Lender Price never quoted. The raw key is ugly and honest;
 * a confident wrong vendor name on a rate board is neither.
 *
 * ⛔ AND A SOURCE NAME IS INTERNAL. This is what WE call a rate sheet on OUR
 * screens. It is not a white label and it is not a client-facing name — rule 10
 * (the investor name never reaches a client) is enforced by
 * `investor-routing.stripSource` and `audience.js`, not here, and nothing in this
 * module makes a name safe to show a borrower or a broker.
 *
 * ── 2. WHY THERE IS NO BREAKDOWN ───────────────────────────────────────────
 * The server has seven reasons; the browser's fallback had four, worded
 * differently, and was missing the two that describe a sheet that answered
 * badly. The browser prefers the vendor's own sentence and only reaches for a
 * reason when there is none — so a missing code fell through to the generic
 * "no breakdown could be read", losing the one thing the reader needed.
 *
 * The browser cannot require server code (the `lib/payoff.js` arrangement), so
 * `app-v2/src/longterm/sourceLabel.js` mirrors both vocabularies and
 * `test-lt-source-vocabulary-pure` runs BOTH and fails the moment they disagree
 * or the server grows a code the browser cannot word.
 *
 * PURE: no requires, no network, no database, no RTL import.
 */

/** The rate sheets this engine prices from. */
const SOURCE_KEYS = ['lenderprice', 'loannex'];

/** What we call each of them, on our own screens. */
const SOURCE_LABELS = {
  lenderprice: 'Lender Price',
  loannex: 'LoanNEX',
};

/**
 * A source key as a readable name — and the raw key back for anything else.
 * Never a guess, never a default vendor: see the header.
 */
function sourceLabel(src) {
  const k = src == null ? '' : String(src);
  return SOURCE_LABELS[k] || k;
}

/** True only for a sheet this engine actually prices from. */
function isKnownSource(src) {
  return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, String(src == null ? '' : src));
}

/**
 * WHY A PRICE HAS NO ITEMISED BREAKDOWN, in plain words.
 *
 * `not_requested` is the ONLY one that means we never asked. `quote_incomplete`
 * is OURS to fix and is worded so nobody reads it as the sheet refusing — that
 * mistake is what the reason exists to end. Everything else is something that
 * happened after we asked.
 */
const NO_BREAKDOWN = {
  not_requested: 'Nobody has asked this rate sheet to explain this price yet.',
  quote_incomplete: 'This price reached the breakdown without everything needed to identify it, so the rate sheet was not asked. This one is ours to fix, not the sheet\'s.',
  vendor_returned_no_evidence: 'The rate sheet accepted the question and returned no breakdown for this quote.',
  unrecognised_answer_shape: 'The rate sheet answered in a shape this system does not recognise, so nothing is shown rather than a guess.',
  no_answer: 'The rate sheet was asked and nothing came back.',
  evidence_is_for_a_different_rate_or_lock: 'The breakdown that came back is for a different rate or lock, so it is not shown against this one.',
  unknown: 'No breakdown could be read for this price.',
};

/** The sentence for a reason code, falling back to the honest generic one. */
function noBreakdownReason(code) {
  const k = code == null ? '' : String(code);
  return NO_BREAKDOWN[k] || NO_BREAKDOWN.unknown;
}

module.exports = {
  SOURCE_KEYS, SOURCE_LABELS, sourceLabel, isKnownSource,
  NO_BREAKDOWN, noBreakdownReason,
};
