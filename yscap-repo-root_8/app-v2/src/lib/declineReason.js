/* WHY a found property is NOT this borrower's — as the workbench reads it
 * (owner-directed 2026-08-10: "no type-in reason box; the system figures out WHY
 * itself"). A DELIBERATE MIRROR of the server's src/lib/track-record/
 * decline-reason.js, and nothing more — the same arrangement, and for the same
 * reason, as lib/dealBasis.js: the review pane has to show the guided reasons
 * (and pre-select the one the system suggests) before it can send a decision,
 * and that choice has to be the one the server will record.
 *
 * It mirrors ONLY the LABELS and the suggest rule; the stored reason TEXT is
 * server-authoritative. PINNED: scripts/test-track-record-decline-reason-pure.js
 * runs both modules over a battery of match bases and fails the moment they
 * disagree on a code or a suggestion.
 */

// Labels only — the plain-language stored TEXT lives on the server.
export const REASON_LABELS = {
  not_our_company: 'A different company with the same name',
  same_name_different_person: 'A different person with the same name',
  wrong_property: 'The property details do not match',
  not_theirs: 'Not this borrower\'s',
};
export const ORDER = ['not_our_company', 'same_name_different_person', 'wrong_property', 'not_theirs'];

// Mirrors decline-reason.suggestFromBasis — the system's best guess at WHY.
export function suggestFromBasis(matchBasis) {
  const mb = matchBasis && typeof matchBasis === 'object' ? matchBasis : null;
  if (mb) {
    if (mb.warn === true && mb.basis === 'entity_only') return 'not_our_company';
    if (mb.personalMatched === true || mb.basis === 'personal' || mb.basis === 'both') return 'same_name_different_person';
    if (mb.entityMatched === true) return 'not_our_company';
  }
  return 'not_theirs';
}

// Mirrors decline-reason.optionsFor — the guided picker's contents.
export function optionsFor(matchBasis) {
  const suggested = suggestFromBasis(matchBasis);
  return {
    suggested,
    options: ORDER.map((code) => ({ code, label: REASON_LABELS[code], suggested: code === suggested })),
  };
}

export default { REASON_LABELS, ORDER, suggestFromBasis, optionsFor };
