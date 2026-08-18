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
 * pppResult(input) → { result:'standard'|'prohibited'|'restricted'|'unknown', basis, resolved, terms,
 *   note, needs[], state, borrowerType, borrowerTypeSource, matched, source }
 * pppDisqualifier(input) → null | { code, dimension:'prepay_state', declineReason, citation } — non-null
 *   ONLY when a PPP is requested AND the state/combo PROVABLY prohibits it.
 * pppUnresolved(input) → null | { code, dimension:'prepay_state', state, needs[], reason, citation } —
 *   non-null ONLY when a PPP is requested AND the state's table could not answer.
 *
 * A LOOKUP HAS EXACTLY THREE OUTCOMES, AND THE ANSWER ALWAYS SAYS WHICH ONE IT WAS (`basis`). Two of
 * them used to be the SAME word — 'standard' — which is how a confident permission came to be printed
 * at the exact moment the engine admitted it had not found a rule (defect A8.1, 2026-08-18):
 *
 *   basis:'state_not_in_matrix' → ALLOWED, WITH NO LIMITS. Owner-authorized 2026-08-18, in their own
 *     words: "If there's any state that was not mentioned in the prepayment penalty matrix, like New
 *     York or Connecticut, that should automatically be allowed. Unlimited restrictions. Any kind of
 *     prepayment penalty." So an unlisted state is a real authorization, not a fallback — the matrix
 *     document lists the states that RESTRICT, and silence there means no restriction on penalty type
 *     and none on term. `terms` is null because there are none to state, not because we do not know.
 *
 *   basis:'rule' → a rule in that state's table matched and its answer governs (standard / prohibited /
 *     restricted, with the state's capped terms where the matrix caps them). Unchanged.
 *
 *   basis:'unevaluable' → the state IS in the matrix, we consulted its table, and NO rule could be
 *     evaluated because the scenario does not carry a fact those rules read (Illinois with no APR is
 *     the live example). That is `result:'unknown'` / `resolved:false` — NEITHER a permission NOR a
 *     prohibition — and it FAILS CLOSED: no caller may coerce it to allowed. Every caller is forced to
 *     handle it: `program-engine` requires a `pppUnresolved` slot (a wiring-time throw) and the
 *     agreement leg requires the caller to declare a policy. WHAT to do about it — refuse to quote, or
 *     quote and flag it for a human — is the OPEN OWNER QUESTION recorded in
 *     docs/longterm/LENDER-PRICE-PARITY-STATUS.md §2.54, and nothing here answers it.
 *
 * NEVER COLLAPSE THE FIRST AND THE THIRD. They are both "no rule matched" mechanically and they are
 * opposites in meaning: one is an owner's authorization, the other is a gap in what we know about a
 * state's law. LT-only. Pure: no DB/network/clock.
 */

const {
  PPP_UNKNOWN, UNRESOLVED_NOTE, UNLISTED_STATE_NOTE, WHEN_INPUT_FIELD, missingFacts, unresolvedReason,
} = require('./ppp-unresolved');

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
  //
  // THE THIRD RULE CARRIES `aprLe: 8` AND THAT IS THE WHOLE FIX FOR DEFECT A8.2 (2026-08-18). It used
  // to be `{ borrowerType:'natural_person', unitsMax:4 }` with NO apr test, so an Illinois natural
  // person on a scenario carrying NO APR AT ALL fell into it and the engine answered
  // `standard` + "IL: natural person, APR 8% or less" — an APR-based CLAIM made where there is no APR.
  // Measured: not one of the 299 canonical battery scenarios carries an apr, and `lpScenarioToFacts`
  // is a pure pass-through by design (APR is derived from rate + fees and is never invented). With the
  // guard, an IL 1-4 natural person with no APR matches NOTHING and the answer is `unknown` — we could
  // not tell — which is the honest answer and the one the owner question is about. DO NOT "restore"
  // the unguarded rule to make the state resolve again; the APR is what must arrive, not the claim.
  IL: [
    { when: { borrowerType: 'business_entity', unitsMax: 4 }, result: 'standard' },
    { when: { borrowerType: 'natural_person', unitsMax: 4, aprGt: 8 }, result: 'prohibited', note: 'IL high-cost: natural person, APR > 8%' },
    { when: { borrowerType: 'natural_person', unitsMax: 4, aprLe: 8 }, result: 'standard', note: 'IL: natural person, APR 8% or less' },
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

// The needle lists, UNCHANGED from the substring version — not one word was added or removed. Only HOW
// they are matched changed (defects A8.3 + A8.4, 2026-08-18): they are now WHOLE WORDS.
//
// WHY. The old test was `/…|inc/.test(name.replace(/[^a-z]/g,''))` — no word boundary, and the strip
// deleted the spaces that could have provided one. Measured on the unfixed module: "Vincent Vance",
// "Vince", "Prince Holdings" and "Quincy Adams" ALL read as `business_entity`, so an ordinary
// natural-person borrower whose name contains the letters i-n-c was classified as a corporation — and
// in New Jersey that turns a PROHIBITED prepayment penalty into an allowed one. Adding a needle would
// be inventing a rule; matching the ones we have as words is a matching fix with one right answer.
const NATURAL_PERSON_WORDS = Object.freeze(['individual', 'naturalperson', 'person', 'consumer']);
const BUSINESS_ENTITY_WORDS = Object.freeze(['llc', 'corp', 'corporation', 'partnership', 'trust', 'entity', 'business', 'company', 'inc']);

/**
 * LP / scenario borrower-type string → the matrix's two classes.
 *   'LLC' / 'Smith Family Trust' / 'Acme Inc'  → 'business_entity'
 *   'Individual' / 'Natural Person'            → 'natural_person'
 *   a value we do not recognise ('Non-Profit') → 'unclassified'
 *   nothing stated at all                      → null
 *
 * 'unclassified' IS THE FIX FOR DEFECT A8.4. The old function returned null for anything it did not
 * recognise and the module's own comment called that null a "wildcard" — and it behaved like one: an
 * LP-menu borrower type we genuinely do not have a rule for ('Non-Profit' is one of Lender Price's six)
 * matched no borrower-keyed rule, fell out of the table, and the unmatched lookup then answered
 * ALLOWED. A borrower type we cannot classify is not a wildcard and is not a permission — it is a fact
 * we do not have, so it now says so and the lookup lands on `unknown`. Classifying 'Non-Profit' into
 * one of the two classes would be inventing a legal reading of the matrix; we do not have one.
 */
function normBorrowerType(v) {
  const s = String(v == null ? '' : v).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!s) return null;
  const padded = ` ${s} `;
  const hasWord = (n) => padded.includes(` ${n} `);
  if (NATURAL_PERSON_WORDS.some(hasWord)) return 'natural_person';
  if (BUSINESS_ENTITY_WORDS.some(hasWord)) return 'business_entity';
  return 'unclassified';
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
  // The MIRROR of aprGt, and it is what makes the IL "APR 8% or less" rule state a fact instead of a
  // claim: like every other handler it requires the fact to be READABLE (`isNum`), so a scenario with
  // no APR cannot satisfy it and the state resolves to `unknown` rather than to a permission.
  aprLe:         (w, i) => w.aprLe == null || (isNum(i.apr) && i.apr <= w.aprLe),
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

// Every `when` key a state's rule list uses — the facts that state's table READS. Derived from
// STATE_RULES, never hand-kept, so a rule added tomorrow names its own facts in an unresolved answer.
const STATE_WHEN_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(STATE_RULES).map(([st, list]) => [st, Object.freeze([...new Set(list.flatMap((r) => Object.keys(r.when || {})))])]),
));

// A when-key this module can evaluate but `ppp-unresolved.WHEN_INPUT_FIELD` cannot name would make an
// unresolved answer under-report which fact is missing. Same class as the unsupported-when-key check
// above, same treatment: a developer error caught at boot, not a quiet gap in a sentence a human reads.
{
  const unnamed = [...SUPPORTED_WHEN_KEYS].filter((k) => !WHEN_INPUT_FIELD[k]);
  if (unnamed.length) {
    throw new Error(`deephaven-ppp-matrix: when-key(s) with no input field in ppp-unresolved.WHEN_INPUT_FIELD: ${unnamed.join(', ')}`);
  }
}

/**
 * The PPP status for a scenario. `lien` defaults to 'first' (a DSCR loan is a first lien).
 *
 * Returns the SAME KEY SET in all three cases — deliberately, so nothing downstream has to test for the
 * presence of a key to work out which answer it got. `basis` is what says which answer it got (see the
 * module header), and it is the only field that may be used to tell an owner-authorized allowance for
 * an UNLISTED state from a rule we actually evaluated.
 *
 * The answer also SAYS WHAT IT USED for the borrower type: `borrowerType` is the class it resolved (or
 * 'unclassified' / null), and `borrowerTypeSource` is 'stated' when the scenario said so, 'assumed'
 * when the caller substituted the product default, 'absent' when there was nothing at all (defect A8.5).
 */
function pppResult(input) {
  const inp = input || {};
  const state = String(inp.state || '').toUpperCase();
  const bt = inp.borrowerType && (inp.borrowerType === 'natural_person' || inp.borrowerType === 'business_entity')
    ? inp.borrowerType : normBorrowerType(inp.borrowerType);
  // A GUESS IS NEVER STORED AS A FACT. The caller that substituted a default says so with
  // `borrowerTypeAssumed`; the answer repeats it, so a downstream reader can always tell an assumption
  // from an assertion instead of both arriving as the bare string 'LLC'.
  const borrowerTypeSource = inp.borrowerTypeAssumed === true ? 'assumed' : (inp.borrowerType == null ? 'absent' : 'stated');
  const base = { state, source: CITE, borrowerType: bt, borrowerTypeSource };
  const norm = { ...inp, state, borrowerType: bt, lien: String(inp.lien || 'first').toLowerCase() };
  const rules = STATE_RULES[state];
  // (1) THE STATE IS NOT IN THE MATRIX — an owner-authorized allowance with NO limits, not a fallback.
  if (!rules) {
    return { result: 'standard', basis: 'state_not_in_matrix', terms: null, note: UNLISTED_STATE_NOTE, needs: [], matched: true, resolved: true, ...base };
  }
  // (2) A RULE IN THAT STATE'S TABLE MATCHED — its answer governs.
  for (const r of rules) {
    if (whenMatches(r.when, norm)) {
      return { result: r.result, basis: 'rule', terms: r.terms || null, note: r.note || null, needs: [], matched: true, resolved: true, ...base };
    }
  }
  // (3) THE STATE IS IN THE MATRIX AND NOTHING COULD BE EVALUATED — we could not tell. Fails closed.
  return {
    result: PPP_UNKNOWN,
    basis: 'unevaluable',
    terms: null,
    note: UNRESOLVED_NOTE,
    needs: missingFacts(STATE_WHEN_KEYS[state], norm),
    matched: false,
    resolved: false,
    ...base,
  };
}

/**
 * The disqualifier, if any. Returns non-null ONLY when a PPP is requested AND the state/combo PROVABLY
 * prohibits it. A No-PPP loan (prepayRequested false) is never disqualified here, and an UNRESOLVED
 * lookup is never a disqualifier either — that would answer the owner question in the other direction.
 * Ask `pppUnresolved` for that case; the two are mutually exclusive by construction.
 */
function pppDisqualifier(input) {
  const inp = input || {};
  if (!inp.prepayRequested) return null;
  const res = pppResult(inp);
  if (res.result !== 'prohibited') return null;
  const btLabel = res.borrowerType === 'natural_person'
    ? 'individual borrower' : (res.borrowerType === 'business_entity' ? 'business entity' : 'this borrower type');
  return {
    code: `dhvn_ppp_prohibited_${res.state.toLowerCase()}`,
    dimension: 'prepay_state',
    declineReason: `Prepayment penalty prohibited in ${res.state} for ${btLabel}${res.note ? ` (${res.note})` : ''} — this loan must be No-PPP`,
    citation: `${CITE} — ${res.state} PPP rule`,
  };
}

/**
 * THE THIRD CHANNEL. Non-null ONLY when a PPP is REQUESTED and the state's table could not answer.
 *
 * It is gated on `prepayRequested` for the same reason the disqualifier is: a No-PPP loan raises no
 * question about a state's prepayment law, so flagging one would be noise on every loan in the book.
 *
 * IT IS NOT A DECLINE. It carries no `declineReason` on purpose — a caller that wants to treat it as
 * one must say so in its own words, because whether an unresolved state refuses the quote or flags it
 * for a human is the OPEN OWNER QUESTION (LENDER-PRICE-PARITY-STATUS.md §2.54), not this module's call.
 */
function pppUnresolved(input) {
  const inp = input || {};
  if (!inp.prepayRequested) return null;
  const res = pppResult(inp);
  if (res.resolved) return null;
  return {
    code: `dhvn_ppp_unresolved_${res.state.toLowerCase()}`,
    dimension: 'prepay_state',
    state: res.state,
    needs: res.needs,
    borrowerType: res.borrowerType,
    borrowerTypeSource: res.borrowerTypeSource,
    reason: unresolvedReason(res.state),
    citation: `${CITE} — ${res.state} PPP rule`,
  };
}

module.exports = {
  pppResult, pppDisqualifier, pppUnresolved, normBorrowerType, STATE_RULES, STATE_WHEN_KEYS, PPP_UNKNOWN,
  _internals: {
    whenMatches, WHEN_HANDLERS, SUPPORTED_WHEN_KEYS, unsupportedWhenKeys,
    NATURAL_PERSON_WORDS, BUSINESS_ENTITY_WORDS,
  },
};
