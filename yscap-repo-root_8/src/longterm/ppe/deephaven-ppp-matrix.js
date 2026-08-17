'use strict';
/**
 * LT PPE — LAYER 3: the PREPAYMENT-PENALTY state engine for the Deephaven DSCR program, encoded from the
 * official Deephaven Operational Prepayment Penalty Matrix (docs/longterm/ppe-research/matrices/
 * deephaven-ppp-matrix.json, Confidential, effective March 2026). This is dot #3 of the three the owner
 * requires for every program (rate sheet + eligibility matrix + PPP matrix), keyed by the investor.
 *
 * WHY IT MATTERS AS A DISQUALIFIER (owner 2026-08-17): some states PROHIBIT a prepayment penalty for
 * certain (borrower type × units × lien × loan amount) combinations. NOTE: PPP is NOT APR/high-cost
 * driven for our loans — a DSCR loan is business-purpose, so the consumer high-cost APR rules do NOT
 * apply (owner-directed 2026-08-17). If a loan REQUESTS a PPP where
 * it is prohibited, that is a real disqualifier — the loan can only be offered No-PPP. The owner's
 * example: in New Jersey an INDIVIDUAL (natural-person) borrower on a 1–4 unit is PROHIBITED from a PPP,
 * while a business entity (LLC) is allowed one. A No-PPP loan is NEVER disqualified by this layer.
 *
 * INPUTS (from a scenario / engine facts):
 *   state 2-letter · borrowerType 'natural_person'|'business_entity' (LLC/Corp/… → business_entity) ·
 *   units number · lien 'first'|'junior' (DSCR is first-lien) · loanAmount raw dollars ·
 *   ruralProperty boolean (Louisiana). prepayRequested boolean (a PPP term > 0 months).
 *
 * pppResult(input) → { result:'standard'|'prohibited'|'restricted', terms?, note?, state, source }
 * pppDisqualifier(input) → null | { code, dimension:'prepay_state', declineReason, citation } — non-null
 *   ONLY when a PPP is requested AND the state/combo prohibits it.
 *
 * A missing input FAILS OPEN to 'standard' (we never invent a prohibition on data we do not have) EXCEPT
 * where the matrix's own default for the state is a restriction. LT-only. Pure: no DB/network/clock.
 */

const CITE = 'Deephaven Operational Prepayment Penalty Matrix, eff March 2026';

// Ordered rule lists for the states that restrict PPP. First matching rule wins; a state absent here is
// 'standard' (PPP allowed). 2026 threshold values (this matrix is effective March 2026). Units bands are
// inclusive; loan-amount comparisons: Lt/Le/Gt/Ge. borrowerType absent = any.
const STATE_RULES = {
  AK: [{ when: { unitsMax: 4 }, result: 'prohibited' }, { when: { unitsMin: 5, loanAmountGt: 25000 }, result: 'standard' }, { when: {}, result: 'standard' }],
  // IL — PPP is NOT APR/high-cost driven for our loans (owner-directed 2026-08-17: "we don't care
  // about APR/high-cost-driven because it's business purposes, and PPP is not related to
  // APR/high-cost-driven"). A DSCR loan is a BUSINESS-PURPOSE loan, exempt from the consumer
  // high-cost APR rules the earlier `aprGt` line modeled — so that line (and the whole APR
  // dimension) is removed. IL allows a PPP; verify the exact IL rule against Lender Price live.
  IL: [{ when: {}, result: 'standard' }],
  LA: [{ when: { ruralProperty: true }, result: 'prohibited', note: 'rural property' }, { when: {}, result: 'standard' }],
  MD: [{ when: {}, result: 'restricted', terms: '3-year term MAX; 2mo advance interest on aggregate prepayments >1/3 of original principal in any 12mo' }],
  MI: [
    { when: { unitsMax: 1, lien: 'first' }, result: 'restricted', terms: '3-year term MAX; 1% of amount prepaid' },
    { when: { unitsMax: 1, lien: 'junior' }, result: 'standard' },
    { when: { unitsMin: 2 }, result: 'standard' },
  ],
  MN: [
    { when: { unitsMax: 4, loanAmountLe: 832750 }, result: 'prohibited', note: 'business decision; 2026 threshold $832,750' },
    { when: { unitsMax: 4, loanAmountGt: 832750 }, result: 'standard' },
    { when: { unitsMin: 5 }, result: 'standard' },
  ],
  NJ: [
    { when: { borrowerType: 'natural_person', unitsMax: 4 }, result: 'prohibited', note: 'business decision — individual borrower' },
    { when: { borrowerType: 'business_entity', unitsMax: 4 }, result: 'standard' },
    { when: { unitsMin: 5 }, result: 'prohibited', note: 'business decision' },
  ],
  NM: [{ when: { unitsMax: 4 }, result: 'prohibited' }, { when: { unitsMin: 5 }, result: 'standard' }],
  OH: [
    { when: { unitsMax: 2, loanAmountGe: 116356 }, result: 'restricted', terms: '5-year Max; 1% of original principal balance', note: '2026 threshold $116,356' },
    { when: { unitsMax: 2, lien: 'first', loanAmountLt: 116356 }, result: 'prohibited', note: '2026 threshold $116,356' },
    { when: { unitsMax: 2, lien: 'junior', loanAmountLt: 116356 }, result: 'restricted', terms: '5-year Max; 1% of original principal balance' },
    { when: { unitsMin: 3 }, result: 'standard' },
  ],
  PA: [
    { when: { unitsMax: 2, loanAmountLe: 329411 }, result: 'prohibited', note: '2026 threshold $329,411' },
    { when: { unitsMax: 2, loanAmountGt: 329411 }, result: 'standard' },
    { when: { unitsMin: 3 }, result: 'standard' },
  ],
  RI: [
    { when: { unitsMax: 4 }, result: 'restricted', terms: '1-year Max; 2% of balance due at payoff; only at prepayment in full' },
    { when: { unitsMin: 5 }, result: 'standard' },
  ],
  VT: [{ when: { loanAmountLt: 1000000 }, result: 'prohibited' }, { when: { loanAmountGe: 1000000 }, result: 'standard' }],
  VA: [
    { when: { unitsMax: 4, lien: 'first', loanAmountGe: 75000 }, result: 'standard' },
    { when: { unitsMax: 4, lien: 'first', loanAmountLt: 75000 }, result: 'prohibited', note: 'business decision' },
    { when: { unitsMax: 4, lien: 'junior' }, result: 'prohibited', note: 'business decision' },
    { when: { unitsMin: 5 }, result: 'standard' },
  ],
};

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// LP / scenario borrower-type string → the matrix's two classes. LLC/Corp/Partnership/Trust/entity →
// business_entity; individual/natural person → natural_person; anything else → null (wildcard).
function normBorrowerType(v) {
  const k = String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  if (/individual|naturalperson|person|consumer/.test(k)) return 'natural_person';
  if (/llc|corp|corporation|partnership|trust|entity|business|company|inc/.test(k)) return 'business_entity';
  return null;
}

// Does a rule's `when` match the input? An absent key in `when` is a wildcard. A key that needs an input
// the caller did not supply does NOT match (so a rule can never fire on missing data).
function whenMatches(when, input) {
  const w = when || {};
  if (w.borrowerType && input.borrowerType !== w.borrowerType) return false;
  if (w.unitsMax != null) { if (!isNum(input.units) || input.units > w.unitsMax) return false; }
  if (w.unitsMin != null) { if (!isNum(input.units) || input.units < w.unitsMin) return false; }
  if (w.lien && String(input.lien || 'first').toLowerCase() !== w.lien) return false;
  // NOTE: there is deliberately NO `aprGt` / high-cost dimension. PPP for a business-purpose DSCR loan
  // is not APR-driven (owner-directed 2026-08-17). Do not re-introduce an APR predicate here.
  if (w.loanAmountLt != null) { if (!isNum(input.loanAmount) || !(input.loanAmount < w.loanAmountLt)) return false; }
  if (w.loanAmountLe != null) { if (!isNum(input.loanAmount) || !(input.loanAmount <= w.loanAmountLe)) return false; }
  if (w.loanAmountGt != null) { if (!isNum(input.loanAmount) || !(input.loanAmount > w.loanAmountGt)) return false; }
  if (w.loanAmountGe != null) { if (!isNum(input.loanAmount) || !(input.loanAmount >= w.loanAmountGe)) return false; }
  if (w.ruralProperty === true && input.ruralProperty !== true) return false;
  return true;
}

/**
 * The PPP status for a scenario. state defaults to lien 'first' (DSCR). A state with no restriction rules
 * is 'standard'. If a restriction state's rules do not match (a missing fact), we FAIL OPEN to 'standard'
 * rather than invent a prohibition — with `matched:false` so the caller knows it was not positively
 * resolved.
 */
function pppResult(input) {
  const inp = input || {};
  const state = String(inp.state || '').toUpperCase();
  const bt = inp.borrowerType && (inp.borrowerType === 'natural_person' || inp.borrowerType === 'business_entity')
    ? inp.borrowerType : normBorrowerType(inp.borrowerType);
  const norm = { ...inp, state, borrowerType: bt, lien: String(inp.lien || 'first').toLowerCase() };
  const rules = STATE_RULES[state];
  if (!rules) return { result: 'standard', state, matched: true, source: CITE };
  for (const r of rules) {
    if (whenMatches(r.when, norm)) return { result: r.result, terms: r.terms || null, note: r.note || null, state, matched: true, source: CITE };
  }
  return { result: 'standard', state, matched: false, source: CITE, note: 'no restriction rule matched (missing fact) — treated as allowed' };
}

/**
 * The disqualifier, if any. Returns non-null ONLY when a PPP is requested AND the state/combo prohibits
 * it. A No-PPP loan (prepayRequested false) is never disqualified here.
 */
function pppDisqualifier(input) {
  const inp = input || {};
  if (!inp.prepayRequested) return null;
  const res = pppResult(inp);
  if (res.result !== 'prohibited') return null;
  const btLabel = inp.borrowerType === 'natural_person' || normBorrowerType(inp.borrowerType) === 'natural_person'
    ? 'individual borrower' : (inp.borrowerType === 'business_entity' || normBorrowerType(inp.borrowerType) === 'business_entity' ? 'business entity' : 'this borrower type');
  return {
    code: `dhvn_ppp_prohibited_${res.state.toLowerCase()}`,
    dimension: 'prepay_state',
    declineReason: `Prepayment penalty prohibited in ${res.state} for ${btLabel}${res.note ? ` (${res.note})` : ''} — this loan must be No-PPP`,
    citation: `${CITE} — ${res.state} PPP rule`,
  };
}

module.exports = { pppResult, pppDisqualifier, normBorrowerType, STATE_RULES, _internals: { whenMatches } };
