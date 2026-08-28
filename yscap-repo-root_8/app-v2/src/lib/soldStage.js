/* SOLD IS A STAGE ON TOP OF FUNDED — the browser twin of `src/lib/sold-status.js`.
 *
 * Owner-directed 2026-08-21: *"The files that are being sold should have a status of 'Sold'."*
 * The stored `applications.status` stays `funded` (139 places read it — draws, investor delivery,
 * the data tapes, the purchase-advice sweep — and moving it would switch all of that off silently),
 * so the stage rides on `sold_at` and every screen that shows a status shows the stage instead.
 *
 * WHY THIS FILE EXISTS RATHER THAN THE RULE BEING INLINED TWICE. Two screens need the answer — the
 * file header and the pipeline list — and before 2026-08-23 each was going to spell it out for
 * itself. Two copies of a rule drift, and the one that drifts is the one that leaks: a pipeline
 * that says Funded next to a file header that says Sold is exactly the confusion this whole change
 * exists to remove.
 *
 * IT IS STILL A MIRROR, AND THE REPO'S RULE FOR A MIRROR APPLIES: a test must fail the moment the
 * two disagree. `scripts/test-sold-stage-twin-pure.js` runs this file and the server's
 * `displayStatus` over the same table of rows and fails on the first difference.
 *
 * THE TABLE-FUNDED EXCLUSION IS NOT HERE, DELIBERATELY. Which loans never get the stage is decided
 * server-side (`lib/sold-status.decideSold`, which asks `release-party` how the loan funded) and a
 * table-funded file simply never receives a `sold_at`. Re-testing it here would be a second,
 * weaker copy of a rule that needs a database to answer.
 */

/** Does this file carry the Sold stage? */
export const isSoldStage = (a) => !!(a && a.sold_at && a.status === 'funded');

/**
 * The status word to SHOW for a file — the twin of `sold-status.displayStatus`.
 * Returns the stored status untouched for every file that is not a sold, funded one, so a caller
 * can use it unconditionally.
 */
export function displayStatus(a) {
  if (isSoldStage(a)) return 'sold';
  return (a && a.status) || null;
}

/** The label, given the caller's own map of stored-status → words. */
export function statusLabel(a, labels) {
  if (isSoldStage(a)) return 'Sold';
  const s = a && a.status;
  return (labels && labels[s]) || s || '—';
}

/** The pill variant, given the caller's own map. A sold file reads as an `ok` pill, like funded. */
export function statusPill(a, pills) {
  if (isSoldStage(a)) return (pills && pills.funded) || 'ok';
  return (pills && pills[a && a.status]) || 'mut';
}
