'use strict';
/**
 * LT PPE — LAYER 3: the PREPAYMENT-PENALTY state engine for the Deephaven DSCR program, encoded from the
 * official Deephaven Operational Prepayment Penalty Matrix (docs/longterm/ppe-research/matrices/
 * deephaven-ppp-matrix.json, Confidential, effective March 2026). This is dot #3 of the three the owner
 * requires for every program (rate sheet + eligibility matrix + PPP matrix), keyed by the investor.
 *
 * WHY IT MATTERS AS A DISQUALIFIER (owner 2026-08-17): some states PROHIBIT a prepayment penalty for
 * certain (borrower type × units × lien × loan amount × APR) combinations. If a loan REQUESTS a PPP where
 * it is prohibited, that is a real disqualifier — the loan can only be offered No-PPP. The owner's
 * example: in New Jersey an INDIVIDUAL (natural-person) borrower on a 1–4 unit is PROHIBITED from a PPP,
 * while a business entity (LLC) is allowed one. A No-PPP loan is NEVER disqualified by this layer.
 *
 * INPUTS (from a scenario / engine facts):
 *   state 2-letter · borrowerType 'natural_person'|'business_entity' (LLC/Corp/… → business_entity) ·
 *   units number · lien 'first'|'junior' (DSCR is first-lien) · loanAmount raw dollars · apr percent ·
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
  // IL — the ONLY state whose PPP rule keys on APR, verbatim from the Deephaven matrix PDF:
  // business entity 1-4 → standard; natural person 1-4 with APR > 8% → PROHIBITED; natural person 1-4
  // with APR 8% or less → standard; 5+ → standard. This is the Illinois high-cost / High-Risk Home
  // Loan Act threshold. DO NOT REMOVE the aprGt rule: the owner confirmed 2026-08-17 it is real ("IL
  // state had such a rule, of below 8% APR and less") after it was briefly removed in error.
  IL: [
    { when: { borrowerType: 'business_entity', unitsMax: 4 }, result: 'standard' },
    { when: { borrowerType: 'natural_person', unitsMax: 4, aprGt: 8 }, result: 'prohibited', note: 'IL high-cost: natural person, APR > 8%' },
    { when: { borrowerType: 'natural_person', unitsMax: 4 }, result: 'standard', note: 'IL: natural person, APR 8% or less' },
    { when: { unitsMin: 5 }, result: 'standard' },
  ],
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

// The `when`-clause VOCABULARY: one handler per supported key, each returning TRUE when the clause is
// satisfied (or is a wildcard) and FALSE when it fails — reproducing the original per-key semantics
// EXACTLY (a falsy/null value is a wildcard, same as before), so whenMatches is byte-identical for the
// committed STATE_RULES. Deriving the supported-key SET from this ONE table (CLAUDE.md build-rule #4:
// generate, don't hand-maintain) is what lets an unknown key be detected instead of silently absorbed.
const WHEN_HANDLERS = {
  borrowerType:  (w, i) => !w.borrowerType || i.borrowerType === w.borrowerType,
  unitsMax:      (w, i) => w.unitsMax == null || (isNum(i.units) && i.units <= w.unitsMax),
  unitsMin:      (w, i) => w.unitsMin == null || (isNum(i.units) && i.units >= w.unitsMin),
  lien:          (w, i) => !w.lien || String(i.lien || 'first').toLowerCase() === w.lien,
  aprGt:         (w, i) => w.aprGt == null || (isNum(i.apr) && i.apr > w.aprGt),
  loanAmountLt:  (w, i) => w.loanAmountLt == null || (isNum(i.loanAmount) && i.loanAmount < w.loanAmountLt),
  loanAmountLe:  (w, i) => w.loanAmountLe == null || (isNum(i.loanAmount) && i.loanAmount <= w.loanAmountLe),
  loanAmountGt:  (w, i) => w.loanAmountGt == null || (isNum(i.loanAmount) && i.loanAmount > w.loanAmountGt),
  loanAmountGe:  (w, i) => w.loanAmountGe == null || (isNum(i.loanAmount) && i.loanAmount >= w.loanAmountGe),
  ruralProperty: (w, i) => w.ruralProperty !== true || i.ruralProperty === true,
};

// The keys whenMatches can evaluate — DERIVED from WHEN_HANDLERS, never a second hand-typed list.
const SUPPORTED_WHEN_KEYS = new Set(Object.keys(WHEN_HANDLERS));

// Does a rule's `when` match the input? An absent key in `when` is a wildcard. A key that needs an input
// the caller did not supply does NOT match (so a rule can never fire on missing data). An UNKNOWN key is
// FAIL-CLOSED: we cannot confirm that restriction applies, so the clause does NOT match. This turns a
// typo'd or newly-added rule key from a SILENT BROADENING (the old fall-through `return true`, which
// over-fires a `prohibited` rule → a false PPP disqualifier → a permanent false E3 disagreement) into a
// rule that visibly stops matching — and validateWhenKeys() below rejects it at load so it never ships.
function whenMatches(when, input) {
  const w = when || {};
  for (const key of Object.keys(w)) {
    const h = WHEN_HANDLERS[key];
    if (!h || !h(w, input)) return false;
  }
  return true;
}

// Every `when`-key across a rule table that whenMatches cannot evaluate. Empty on the committed
// STATE_RULES; non-empty exactly when a rule carries a typo'd or un-taught key. PURE.
function unsupportedWhenKeys(rules) {
  const src = rules || STATE_RULES;
  const bad = [];
  for (const [state, list] of Object.entries(src)) {
    for (const r of (Array.isArray(list) ? list : [])) {
      for (const key of Object.keys((r && r.when) || {})) {
        if (!SUPPORTED_WHEN_KEYS.has(key)) bad.push(`${state}:${key}`);
      }
    }
  }
  return bad;
}

// Fail LOUD at load if the committed STATE_RULES carry a when-key whenMatches cannot evaluate. Because
// whenMatches now fails closed on an unknown key, a bad key would make its rule stop matching — silently
// dropping a real PPP prohibition. A static, committed table that is wrong is a developer error to catch
// at boot, exactly like a syntax error; the test asserts this never fires.
const _badWhenKeys = unsupportedWhenKeys(STATE_RULES);
if (_badWhenKeys.length) {
  throw new Error(`deephaven-ppp-matrix: STATE_RULES use unsupported when-key(s): ${_badWhenKeys.join(', ')} — teach WHEN_HANDLERS or fix the typo`);
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

module.exports = {
  pppResult, pppDisqualifier, normBorrowerType, STATE_RULES,
  _internals: { whenMatches, WHEN_HANDLERS, SUPPORTED_WHEN_KEYS, unsupportedWhenKeys },
};
