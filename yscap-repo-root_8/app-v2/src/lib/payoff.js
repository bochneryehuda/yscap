/* THE PAYOFF, as the portal reads it (owner-directed 2026-07-31).
 *
 * A DELIBERATE MIRROR of the server's `src/lib/payoff.js`, and nothing more. The
 * file screen has to answer two questions BEFORE it fetches anything — should
 * the Payoff section exist at all, and does its header need a "still needed"
 * badge — and both have to agree with the section's own contents, which come
 * from the server. A section that appears and then renders "nothing to pay off",
 * or a green header over an incomplete card, reads as broken.
 *
 * Because it is a mirror it is the drift risk, so it is a mirror of exactly two
 * rules and it is PINNED: `scripts/test-payoff-model-pure.js` runs a battery of
 * loan purposes and file rows through BOTH modules and fails the moment they
 * disagree. Anything richer than these two answers (what the structure implies,
 * why a field matters, how it works) is asked of the server — never re-derived
 * here.
 */

// Mirrors field-registry.normLoanType + payoff.refiKind, in that order.
export function refiKind(loanType) {
  const s = String(loanType == null ? '' : loanType).toLowerCase();
  if (!s) return 'purchase';
  // Delayed purchase financing is a PURCHASE however it is spelled — checked
  // first, exactly as the server does, so a label like "Delayed Purchase
  // Financing (Cash-Out)" can never flip it to a refinance.
  if (/delayed\s+purchase/.test(s)) return 'purchase';
  if (/cash[-\s]?out/.test(s)) return 'cash_out';
  // A refinance is only announced as rate-&-term when the label says so. A bare
  // "Refinance" is UNKNOWN — see the server module for why.
  if (/refi|rate\s*(&|and)?\s*term/.test(s)) return /rate\s*(&|and)?\s*term/.test(s) ? 'rate_term' : 'unknown';
  if (/purchase|acquisition/.test(s)) return 'purchase';
  return /refi/.test(s) ? 'unknown' : 'purchase';
}

// Is there an existing loan to pay off on this file?
export function payoffApplies(loanType) { return refiKind(loanType) !== 'purchase'; }

/* How many of the payoff's own required entries are still blank. WHO holds the
   loan and WHICH loan it is are only asked for once an amount is on the file —
   the owner's rule is "if there is a payoff entered". */
export function payoffMissingKeys(app) {
  const a = app || {};
  if (!payoffApplies(a.loan_type)) return [];
  // Property owned FREE AND CLEAR (db/575) — no loan to pay off, nothing missing.
  if (a.property_free_and_clear === true) return [];
  const amount = Number(a.payoff_amount);
  const hasPayoff = a.payoff_amount != null && a.payoff_amount !== '' && isFinite(amount) && amount > 0;
  const blank = (v) => String(v == null ? '' : v).trim() === '';
  const out = [];
  if (!hasPayoff) out.push('payoffAmount');
  if (hasPayoff && blank(a.payoff_lender)) out.push('payoffLender');
  if (hasPayoff && blank(a.payoff_loan_number)) out.push('payoffLoanNumber');
  return out;
}
