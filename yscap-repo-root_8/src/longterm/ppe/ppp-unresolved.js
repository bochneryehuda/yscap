'use strict';
/**
 * LT PPE — THE ONE DEFINITION OF "WE COULD NOT TELL" FOR THE LAYER-3 PREPAYMENT-PENALTY MATRIX.
 *
 * WHY THIS FILE EXISTS. A state's prepayment rules are an ORDERED, first-match-wins table. When NO rule
 * matches, the honest answer is not "allowed" and not "prohibited" — it is that we could not tell. That
 * third answer needs two things said the same way by BOTH implementations of Layer 3 (the hand-written
 * `deephaven-ppp-matrix.js` and the data-compiled `layer-compile-ppp.js`, which an equivalence suite
 * holds byte-identical): the WORDING, and WHICH FACTS the state's rules read that the scenario does not
 * supply. Two copies of that would drift, and the copy that drifted would be the one that answered.
 *
 * WHAT "COULD NOT TELL" IS NARROWED TO. A state that is simply NOT IN THE MATRIX is not this case at
 * all — the owner authorized it on 2026-08-18 as ALLOWED with no limits (see UNLISTED_STATE_NOTE). This
 * module is only for a state that IS in the matrix and whose rules could not be evaluated because the
 * scenario does not carry a fact they read.
 *
 * WHAT IT IS NOT. It never decides what to DO about that case. Refusing to quote, or quoting with a
 * flag for a human, is a business decision recorded as an OPEN OWNER QUESTION
 * (docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.54) — this module only names the gap.
 *
 * PURE: no DB, no network, no clock, no config. LT-only. No RTL imports.
 */

/** The third answer. Never a permission, never a prohibition. */
const PPP_UNKNOWN = 'unknown';

/**
 * The `when`-key vocabulary → the PPP INPUT FIELD each key reads. Both Layer-3 implementations name
 * their missing facts through this map, so "the state's rules read `apr`" means the same thing in both.
 * A when-key absent from this map contributes no named fact (it can never invent one).
 */
const WHEN_INPUT_FIELD = Object.freeze({
  borrowerType: 'borrowerType',
  unitsMax: 'units',
  unitsMin: 'units',
  lien: 'lien',
  aprGt: 'apr',
  aprLe: 'apr',
  loanAmountLt: 'loanAmount',
  loanAmountLe: 'loanAmount',
  loanAmountGt: 'loanAmount',
  loanAmountGe: 'loanAmount',
  ruralProperty: 'ruralProperty',
});

// The input fields a rule compares NUMERICALLY. A non-number there is not a value the table can read.
const NUMERIC_FIELDS = Object.freeze(['units', 'loanAmount', 'apr']);

/**
 * Is this PPP input field usable by a rule? PURE.
 *   • a numeric field needs a FINITE NUMBER ('400000' and null are both unusable — the matrix's own
 *     `isNum` guard means a rule can never fire on either);
 *   • `borrowerType` needs to be one of the two CLASSES the table keys on — an unclassified or absent
 *     borrower type is precisely the "we could not tell" case, never a wildcard;
 *   • everything else needs a value at all.
 */
function fieldUsable(field, value) {
  if (NUMERIC_FIELDS.includes(field)) return typeof value === 'number' && Number.isFinite(value);
  if (field === 'borrowerType') return value === 'natural_person' || value === 'business_entity';
  return value != null;
}

/**
 * The facts a state's rules read that this scenario does not usably supply — sorted, de-duplicated,
 * machine-readable. Empty means the table read everything it needed and still matched nothing (the
 * facts are simply outside every rule), which is ALSO "we could not tell".
 *
 *   whenKeys — every `when` key used by that state's rule list (any order, duplicates fine).
 *   normalized — the PPP input AFTER normalization: `{ borrowerType: <class|null>, units, lien,
 *                loanAmount, apr, ruralProperty }`.
 * PURE.
 */
function missingFacts(whenKeys, normalized) {
  const inp = normalized || {};
  const out = new Set();
  for (const k of Array.isArray(whenKeys) ? whenKeys : []) {
    const field = WHEN_INPUT_FIELD[k];
    if (!field) continue;
    if (!fieldUsable(field, inp[field])) out.add(field);
  }
  return [...out].sort();
}

/**
 * The ONE sentence both implementations say when a state's table could not answer. Deliberately states
 * what it is NOT ("neither a permission nor a prohibition") because the whole defect this replaces was a
 * confident "allowed" printed at the exact moment the engine admitted it had not found a rule.
 */
function unresolvedReason(state) {
  return `Could not tell whether ${state} allows a prepayment penalty on this loan — no rule in that `
    + "state's prepayment matrix matched the facts we have. This is neither a permission nor a "
    + 'prohibition: a human must decide before a prepayment penalty is quoted.';
}

/** The note carried on an unresolved `pppResult`. Same reason, said once. */
const UNRESOLVED_NOTE = 'no rule in the state\'s prepayment matrix matched the facts we have — we could NOT tell whether a prepayment penalty is allowed';

/**
 * The note carried when the STATE IS NOT IN THE MATRIX AT ALL. That is an owner authorization, not a
 * fallback, and the note says so in the owner's own words (2026-08-18): "If there's any state that was
 * not mentioned in the prepayment penalty matrix, like New York or Connecticut, that should
 * automatically be allowed. Unlimited restrictions. Any kind of prepayment penalty."
 *
 * It is a SEPARATE constant from UNRESOLVED_NOTE on purpose. Mechanically both cases are "no rule
 * matched"; in meaning they are opposites, and merging the two sentences is exactly how an authorized
 * allowance would later be read as a gap, or a gap as an allowance.
 */
const UNLISTED_STATE_NOTE = 'this state is not listed in the prepayment-penalty matrix — a prepayment penalty is allowed with NO restriction on type and NO restriction on term (owner-authorized 2026-08-18)';

module.exports = {
  PPP_UNKNOWN,
  WHEN_INPUT_FIELD,
  NUMERIC_FIELDS,
  UNRESOLVED_NOTE,
  UNLISTED_STATE_NOTE,
  fieldUsable,
  missingFacts,
  unresolvedReason,
};
