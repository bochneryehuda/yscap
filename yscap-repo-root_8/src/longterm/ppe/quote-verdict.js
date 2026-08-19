'use strict';
/**
 * LT PPE — THE ONE READING OF A QUOTE'S VERDICT (§2.124).
 *
 * ITS OWN MODULE, and that is deliberate: `parity-detectors.js` is a PURE module with no requires at
 * all, and making it depend on the pricing engine to ask one three-valued question would drag the
 * whole of `quote.js` into every consumer that only needs to read an answer. A second copy of the
 * predicate is the thing this codebase refuses, so the predicate moves rather than being duplicated.
 * `quote.js` re-exports all three, so every existing caller is unchanged.
 *
 * PURE: no requires, no clock, no database.
 */

/**
 * THE ONE READING OF A QUOTE'S VERDICT (§2.124), and the reason it has to exist.
 *
 * `quoteProgram` answers in THREE states, not two — the third was added by §2.108 and is the whole
 * of that fix: a scenario whose price-bearing facts it cannot read is neither priced nor declined,
 * it is INCOMPLETE, and `incompleteQuote` is deliberately built to say so (`priced:false`,
 * `incomplete:true`, a reason, and NO `ladder` key at all).
 *
 * BUT IT CARRIES `eligible` UNCHANGED, which is also deliberate — refusing to price is not a
 * decline, and inventing one would fabricate a refusal we never made. The consequence is a trap: a
 * consumer that reads `q.eligible` ALONE reads an "I could not tell" as a confident "yes".
 *
 * MEASURED, on a scenario Lender Price ITSELF accepts (an LP scenario carrying no `dscr`, which its
 * own validator passes) against the built-in Deephaven sheet: the quote comes back
 * `eligible:true, priced:false, incomplete:true, reason:'missing_price_bearing_fact'` — and
 * `parity-detectors` then reported, at HIGH severity, **"Lender Price declined this program; our
 * engine priced it"**. Our engine did not price it. That sentence lands in the findings ledger and
 * in the agreement rate the go-live gate reads. The transparency breakdown rendered the same quote
 * as eligible, and the coverage census counted it as eligible.
 *
 * So the verdict is a THREE-VALUED question and every consumer must ask it that way:
 *   'priced'      — a real answer with a ladder behind it.
 *   'declined'    — an eligibility rule refused it, on facts we could read.
 *   'undetermined'— we could not tell. Never a yes, never a no.
 * `pricedAnswer` / `couldNotPrice` are the two tests worth having on their own; `verdictOf` is the
 * full reading. All three are PURE, and all three fail toward 'undetermined' on anything they
 * cannot recognise — an unreadable quote must never be scored as an answer either way.
 */
function couldNotPrice(q) {
  if (!q || typeof q !== 'object') return true;
  return q.priced === false || q.incomplete === true;
}

function pricedAnswer(q) {
  return !couldNotPrice(q) && !!(q && q.eligible === true);
}

function verdictOf(q) {
  if (couldNotPrice(q)) return 'undetermined';
  if (q.eligible === true) return 'priced';
  if (q.eligible === false) return 'declined';
  return 'undetermined';
}

module.exports = { couldNotPrice, pricedAnswer, verdictOf };
