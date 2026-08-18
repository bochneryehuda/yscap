#!/usr/bin/env node
'use strict';
/**
 * LT PPE — "WE COULD NOT TELL" IS A REAL ANSWER: the A8 prepayment-penalty defect set (2026-08-18).
 *
 * WHAT WAS WRONG, ALL FIVE OF IT, REPRODUCED HERE BEFORE IT IS FIXED. Section 1 runs a VERBATIM copy of
 * the pre-fix implementation beside the live one on the same input, so every claim below is a
 * measurement rather than a description:
 *
 *   A8.1 an UNMATCHED lookup answered 'standard' — ALLOWED — carrying `matched:false` and a note that
 *        read "treated as allowed". A confident permission about a STATE-LAW PROHIBITION, printed at
 *        the exact moment the engine admitted it had not found a rule.
 *   A8.2 Illinois claimed "natural person, APR 8% or less" on a scenario carrying NO APR AT ALL. Not
 *        one of the 299 canonical battery scenarios carries an apr, and the fact converter is a pure
 *        pass-through by design, so that claim was made on every Illinois natural-person loan.
 *   A8.3 the borrower-type classifier tested `/inc/` with no word boundary, over a string whose spaces
 *        had already been deleted — so "Vincent Vance", "Vince", "Prince Holdings" and "Quincy Adams"
 *        all read as CORPORATIONS. In New Jersey that turns a prohibited penalty into an allowed one.
 *   A8.4 'Non-Profit' — one of Lender Price's own six borrower types — classified as null, which the
 *        module's own comment called a "wildcard": it matched no borrower-keyed rule, fell out of the
 *        table, and the unmatched lookup then answered ALLOWED.
 *   A8.5 an ASSUMED LLC (the product default, substituted when the scenario said nothing) was
 *        byte-identical to an LLC the scenario actually STATED. A guess travelled as a fact.
 *
 * WHAT IS TRUE NOW. A lookup has exactly THREE outcomes and the answer always says which (`basis`):
 * `state_not_in_matrix` (owner-authorized 2026-08-18 — allowed, no limits), `rule` (a rule matched),
 * `unevaluable` (the state IS in the matrix and nothing could be evaluated → `unknown`, fails closed).
 * The first and the third are mechanically the same "no rule matched" and are OPPOSITE in meaning; §3
 * and §4 hold them apart. WHAT TO DO about the third is an OPEN OWNER QUESTION (§2.54) and nothing here
 * answers it.
 *
 * AND IT IS PROVEN TO BITE. §7 mutates the production modules one thing at a time and asserts the named
 * check goes red — asserting on the CHECKER'S OWN SENTENCE, never merely that something threw, because
 * a crashing test also "fails" and looks like proof. An unmutated control runs green either side.
 *
 * OFFLINE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const SRC = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const MATRIX_FILE = path.join(SRC, 'deephaven-ppp-matrix.js');
const ENGINE_FILE = path.join(SRC, 'program-engine.js');
const LEGS_FILE = path.join(SRC, 'lp-agreement-legs.js');

const realMatrix = require(SRC + '/deephaven-ppp-matrix');
const realEngine = require(SRC + '/program-engine');
const realLegs = require(SRC + '/lp-agreement-legs');
const dh = require(SRC + '/program-deephaven-dscr');
const { buildAgreementScenarios } = require(SRC + '/agreement-scenarios');
const { buildDeephavenGrid } = require(SRC + '/deephaven-dscr-sheet');
const { gridToRateSheet } = require(SRC + '/deephaven-grid');
const { rateSheetToProgram } = require(SRC + '/ratesheet');
const settingsMod = require(SRC + '/settings');

let pass = 0; let fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

// ---- loading a MUTATED copy of a production module ----------------------------------------------
// A textual mutation that does not apply EXACTLY ONCE is refused: a mutation that silently matched
// nothing would report "the suite went red" about code that never changed, which is the false-confidence
// this file exists to avoid.
function loadMutated(file, mutations) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of mutations) {
    const parts = src.split(from);
    if (parts.length !== 2) throw new Error(`mutation did not apply exactly once (${parts.length - 1} hits) in ${path.basename(file)}: ${from}`);
    src = parts.join(to);
  }
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports;
}

// =================================================================================================
// THE PRE-FIX IMPLEMENTATION, VERBATIM — the baseline every "before" figure in this file comes from.
// =================================================================================================
// Copied from the module as it stood before 2026-08-18. The thresholds are NOT re-typed: the rule
// table is cloned from the live one and the ONE rule the fix changed is reverted, so this baseline can
// never drift from the real table on a number, only on the thing under test.
const CITE = 'Deephaven Operational Prepayment Penalty Matrix, eff March 2026';
const OLD_STATE_RULES = JSON.parse(JSON.stringify(realMatrix.STATE_RULES));
delete OLD_STATE_RULES.IL[2].when.aprLe; // A8.2: the Illinois "APR 8% or less" rule with NO apr test

function oldNormBorrowerType(v) {
  const k = String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  if (/individual|naturalperson|person|consumer/.test(k)) return 'natural_person';
  if (/llc|corp|corporation|partnership|trust|entity|business|company|inc/.test(k)) return 'business_entity';
  return null;
}
function oldPppResult(input) {
  const inp = input || {};
  const state = String(inp.state || '').toUpperCase();
  const bt = inp.borrowerType && (inp.borrowerType === 'natural_person' || inp.borrowerType === 'business_entity')
    ? inp.borrowerType : oldNormBorrowerType(inp.borrowerType);
  const norm = { ...inp, state, borrowerType: bt, lien: String(inp.lien || 'first').toLowerCase() };
  const rules = OLD_STATE_RULES[state];
  if (!rules) return { result: 'standard', state, matched: true, source: CITE };
  for (const r of rules) {
    if (realMatrix._internals.whenMatches(r.when, norm)) {
      return { result: r.result, terms: r.terms || null, note: r.note || null, state, matched: true, source: CITE };
    }
  }
  return { result: 'standard', state, matched: false, source: CITE, note: 'no restriction rule matched (missing fact) — treated as allowed' };
}
function oldPppDisqualifier(input) {
  const inp = input || {};
  if (!inp.prepayRequested) return null;
  const res = oldPppResult(inp);
  return res.result === 'prohibited' ? { code: `dhvn_ppp_prohibited_${res.state.toLowerCase()}` } : null;
}
// The pre-fix fact→input mapping: the product default collapsed straight into `borrowerType`, with
// nothing anywhere recording that it was a default (A8.5).
function oldPppInputFromFacts(f) {
  const sc = f || {};
  return {
    state: sc.state,
    borrowerType: sc.borrower_type || 'LLC',
    units: sc.units,
    lien: 'first',
    loanAmount: sc.loan_amount,
    apr: sc.apr,
    ruralProperty: !!sc.rural_property,
    prepayRequested: Number(sc.prepay_months) > 0,
  };
}

// The permission question, in one word, from either implementation's result.
const verdictOf = (r) => (r.result === 'unknown' ? 'unknown'
  : r.result === 'prohibited' ? 'prohibited'
    : r.result === 'restricted' ? 'restricted' : 'allowed');

// The canonical battery + the sheet, built ONCE (both are deterministic and pure).
const BATTERY = buildAgreementScenarios().scenarios;
const SHEET = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30' });
const SETTINGS = settingsMod.resolveAll().values;

// Named scenarios used throughout. Each one is a real shape the pricer can produce.
const NJ_NONPROFIT = { state: 'NJ', borrowerType: 'Non-Profit', units: 2, lien: 'first', loanAmount: 400000, prepayRequested: true };
const NJ_VINCENT = { ...NJ_NONPROFIT, borrowerType: 'Vincent Vance' };
const NJ_ABSENT = { state: 'NJ', units: 2, lien: 'first', loanAmount: 400000, prepayRequested: true };
const NJ_INDIVIDUAL = { ...NJ_NONPROFIT, borrowerType: 'Individual' };
const NJ_LLC = { ...NJ_NONPROFIT, borrowerType: 'LLC' };
const IL_NO_APR = { state: 'IL', borrowerType: 'Individual', units: 2, lien: 'first', loanAmount: 400000, prepayRequested: true };
const IL_APR_7 = { ...IL_NO_APR, apr: 7 };
const IL_APR_9 = { ...IL_NO_APR, apr: 9 };
const NY_ANY = { state: 'NY', borrowerType: 'LLC', units: 2, lien: 'first', loanAmount: 400000, prepayRequested: true };
const CT_ANY = { ...NY_ANY, state: 'CT' };

console.log('LT PPE — A8: an unmatched prepayment lookup is "we could not tell", never "allowed"\n');

// =================================================================================================
// 1. REPRODUCTION — the five defects, measured on the pre-fix implementation
// =================================================================================================
console.log('1. REPRODUCTION — the pre-fix implementation, on the same inputs');
{
  const before1 = oldPppResult(NJ_NONPROFIT);
  ok(before1.result === 'standard' && before1.matched === false,
    `A8.1 REPRODUCED: an UNMATCHED NJ lookup answered "${before1.result}" (ALLOWED) while reporting matched:false — "${before1.note}"`);

  const before2 = oldPppResult(IL_NO_APR);
  ok(before2.result === 'standard' && /APR 8% or less/.test(before2.note || ''),
    `A8.2 REPRODUCED: Illinois with NO apr answered "${before2.result}" and claimed "${before2.note}"`);
  ok(BATTERY.every((s) => s.apr == null) && realLegs.lpScenarioToFacts(BATTERY[0]).apr === null,
    `A8.2 REPRODUCED: not one of the ${BATTERY.length} canonical battery scenarios carries an APR, so that claim had no source at all`);

  ok(oldNormBorrowerType('Vincent Vance') === 'business_entity'
    && oldNormBorrowerType('Vince') === 'business_entity'
    && oldNormBorrowerType('Prince Holdings') === 'business_entity'
    && oldNormBorrowerType('Quincy Adams') === 'business_entity',
    'A8.3 REPRODUCED: "Vincent Vance" / "Vince" / "Prince Holdings" / "Quincy Adams" all read as a CORPORATION (the unbounded /inc/)');
  ok(oldPppResult(NJ_VINCENT).result === 'standard' && oldPppDisqualifier(NJ_VINCENT) === null,
    'A8.3 REPRODUCED: …so a New Jersey natural person named "Vincent Vance" was ALLOWED a prepayment penalty New Jersey prohibits');

  ok(oldNormBorrowerType('Non-Profit') === null && oldPppResult(NJ_NONPROFIT).result === 'standard',
    'A8.4 REPRODUCED: "Non-Profit" classified as null — the module\'s own "wildcard" — and slid past every borrower-keyed NJ rule into ALLOWED');

  const fStated = realLegs.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'LLC' });
  const fAssumed = realLegs.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60 });
  ok(JSON.stringify(oldPppResult(oldPppInputFromFacts(fStated))) === JSON.stringify(oldPppResult(oldPppInputFromFacts(fAssumed))),
    'A8.5 REPRODUCED: a STATED LLC and an ASSUMED LLC produced a byte-identical answer — nothing recorded that one of them was a guess');
}

// =================================================================================================
// 2. THE FIX — the same inputs, through the live module
// =================================================================================================
console.log('\n2. THE FIX — the same inputs now');

// Every check below is a NAMED probe so a mutation can be asserted against the checker's own sentence
// (§7). `probeMatrix` takes the module under test, so it runs against a mutated copy unchanged.
function probeMatrix(M, L) {
  const out = [];
  const chk = (label, cond) => out.push({ label, pass: !!cond });

  // ---- A8.1 / A8.2 / A8.4: an unevaluable listed state is UNKNOWN, and it fails closed -----------
  const r1 = M.pppResult(NJ_NONPROFIT);
  chk('A8.1 an unevaluable NJ lookup answers "unknown", resolved:false, basis "unevaluable"',
    r1.result === 'unknown' && r1.resolved === false && r1.basis === 'unevaluable' && r1.matched === false);
  chk('A8.1 …and it is NOT a prohibition either — pppDisqualifier stays null, so nothing declined the loan on a guess',
    M.pppDisqualifier(NJ_NONPROFIT) === null);
  chk('A8.1 …and it raises the THIRD channel: pppUnresolved names the state, the missing fact and a plain reason',
    (() => {
      const u = M.pppUnresolved(NJ_NONPROFIT);
      return !!u && u.code === 'dhvn_ppp_unresolved_nj' && u.dimension === 'prepay_state'
        && Array.isArray(u.needs) && u.needs.includes('borrowerType')
        && /neither a permission nor a prohibition/.test(u.reason) && u.declineReason === undefined;
    })());
  chk('A8.1 a No-PPP loan raises nothing at all — an unanswerable state is only a question when a penalty is asked for',
    M.pppUnresolved({ ...NJ_NONPROFIT, prepayRequested: false }) === null);

  const r2 = M.pppResult(IL_NO_APR);
  chk('A8.2 Illinois with NO apr answers "unknown" and names `apr` as what it needed — no APR claim is made',
    r2.result === 'unknown' && r2.basis === 'unevaluable' && r2.needs.join(',') === 'apr' && !/APR 8% or less/.test(r2.note || ''));
  chk('A8.2 an Illinois natural person WITH an apr of 7 still resolves to allowed, on the rule, with the APR wording',
    (() => { const r = M.pppResult(IL_APR_7); return r.result === 'standard' && r.basis === 'rule' && /APR 8% or less/.test(r.note || ''); })());
  chk('A8.2 an Illinois natural person WITH an apr of 9 is still PROHIBITED — the high-cost rule is untouched',
    (() => { const r = M.pppResult(IL_APR_9); return r.result === 'prohibited' && r.basis === 'rule' && !!M.pppDisqualifier(IL_APR_9); })());

  // ---- A8.3: word boundaries --------------------------------------------------------------------
  chk('A8.3 "Vincent Vance" / "Vince" / "Prince Holdings" / "Quincy Adams" are no longer corporations',
    ['Vincent Vance', 'Vince', 'Prince Holdings', 'Quincy Adams'].every((n) => M.normBorrowerType(n) === 'unclassified'));
  chk('A8.3 the nine entity words still match as WHOLE words (LLC / Acme Corp / Smith Family Trust / Acme Inc / a partnership)',
    ['LLC', 'Acme Corp', 'Acme Corporation', 'Smith Family Trust', 'Acme Inc.', 'Smith & Sons Partnership', 'A Business', 'Holdings Company', 'An Entity']
      .every((n) => M.normBorrowerType(n) === 'business_entity'));
  chk('A8.3 the four natural-person words still match (Individual / Natural Person / consumer)',
    ['Individual', 'Natural Person', 'A Consumer', 'natural_person'].every((n) => M.normBorrowerType(n) === 'natural_person'));
  chk('A8.3 a NJ natural person named "Vincent Vance" is no longer handed a New-Jersey-prohibited penalty',
    M.pppResult(NJ_VINCENT).result === 'unknown' && M.pppDisqualifier(NJ_VINCENT) === null);

  // ---- A8.4: no wildcard ------------------------------------------------------------------------
  chk('A8.4 "Non-Profit" is "unclassified" — a fact we do not have, never a wildcard and never a class',
    M.normBorrowerType('Non-Profit') === 'unclassified');
  chk('A8.4 "stated but unrecognised" and "nothing stated" stay APART in the answer',
    M.pppResult(NJ_NONPROFIT).borrowerType === 'unclassified'
    && M.pppResult(NJ_NONPROFIT).borrowerTypeSource === 'stated'
    && M.pppResult(NJ_ABSENT).borrowerType === null
    && M.pppResult(NJ_ABSENT).borrowerTypeSource === 'absent');

  // ---- the owner's NJ example, unchanged in both directions -------------------------------------
  chk('the owner\'s NJ example is unchanged: an individual is prohibited, an LLC is not',
    M.pppDisqualifier(NJ_INDIVIDUAL) !== null && M.pppDisqualifier(NJ_LLC) === null
    && M.pppResult(NJ_INDIVIDUAL).basis === 'rule' && M.pppResult(NJ_LLC).basis === 'rule');

  // ---- A8.5: the assumption says it is one -------------------------------------------------------
  const stated = M.pppResult({ ...NJ_LLC, borrowerTypeAssumed: false });
  const assumed = M.pppResult({ ...NJ_LLC, borrowerTypeAssumed: true });
  chk('A8.5 a STATED LLC and an ASSUMED LLC no longer produce the same answer — borrowerTypeSource tells them apart',
    stated.borrowerTypeSource === 'stated' && assumed.borrowerTypeSource === 'assumed'
    && JSON.stringify(stated) !== JSON.stringify(assumed));
  chk('A8.5 …and the ASSUMPTION and the ASSERTION are kept apart in the FACTS too, not merged before the layer sees them',
    (() => {
      const a = L.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60 });
      const s = L.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'LLC' });
      return a.borrower_type === 'LLC' && a.borrower_type_stated === null && a.borrower_type_assumed === true
        && s.borrower_type === 'LLC' && s.borrower_type_stated === 'LLC' && s.borrower_type_assumed === false;
    })());
  chk('A8.5 …and the descriptor carries that through, so the ANSWER on a real scenario says which it used',
    (() => {
      const a = dh._internals.pppInputFromFacts(L.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60 }));
      const s = dh._internals.pppInputFromFacts(L.lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'LLC' }));
      return a.borrowerTypeAssumed === true && s.borrowerTypeAssumed === false
        && M.pppResult(a).borrowerTypeSource === 'assumed' && M.pppResult(s).borrowerTypeSource === 'stated';
    })());

  // ---- the owner's 2026-08-18 authorization: an UNLISTED state -----------------------------------
  chk('OWNER 2026-08-18: a state NOT in the matrix (NY, CT) is ALLOWED, basis "state_not_in_matrix", resolved',
    ['NY', 'CT'].every((st) => {
      const r = M.pppResult({ ...NY_ANY, state: st });
      return r.result === 'standard' && r.basis === 'state_not_in_matrix' && r.resolved === true && r.matched === true;
    }));
  chk('OWNER 2026-08-18: …with NO limits — no capped terms, and the note says the allowance is unrestricted and authorized',
    (() => {
      const r = M.pppResult(CT_ANY);
      return r.terms === null && /NO restriction on type/.test(r.note || '') && /NO restriction on term/.test(r.note || '') && /owner-authorized 2026-08-18/.test(r.note || '');
    })());
  chk('OWNER 2026-08-18: …and it raises NO question — an unlisted state is an answer, not a gap',
    M.pppUnresolved(NY_ANY) === null && M.pppUnresolved(CT_ANY) === null);
  chk('THE TWO "no rule matched" CASES ARE HELD APART: an unlisted state and an unevaluable one share no basis, no result and no note',
    (() => {
      const unlisted = M.pppResult(NY_ANY);
      const unevaluable = M.pppResult(NJ_NONPROFIT);
      return unlisted.basis !== unevaluable.basis && unlisted.result !== unevaluable.result
        && unlisted.note !== unevaluable.note && unlisted.resolved !== unevaluable.resolved;
    })());
  chk('every answer states its basis, and it is one of exactly three',
    [NY_ANY, NJ_INDIVIDUAL, NJ_NONPROFIT, IL_NO_APR, IL_APR_7, CT_ANY]
      .every((i) => ['state_not_in_matrix', 'rule', 'unevaluable'].includes(M.pppResult(i).basis)));

  return out;
}
for (const r of probeMatrix(realMatrix, realLegs)) ok(r.pass, r.label);

// =================================================================================================
// 3. THE FORCING FUNCTIONS — a caller cannot silently coerce "we could not tell" to "allowed"
// =================================================================================================
console.log('\n3. THE FORCING FUNCTIONS — no caller can quietly read "unknown" as "allowed"');

function probeCallers(M, E, L) {
  const out = [];
  const chk = (label, cond) => out.push({ label, pass: !!cond });

  const slots = {
    investor: 'Probe', programName: 'Probe',
    evaluateEligibility: () => ({ reasons: [], maxLtvMilli: 70000, cell: null, unverifiable: [] }),
    pppInputFromFacts: dh._internals.pppInputFromFacts,
    pppResult: M.pppResult, pppDisqualifier: M.pppDisqualifier, pppUnresolved: M.pppUnresolved,
    evaluateOverlay: () => ({ declines: [], enforced: [], stillFlagged: [] }),
    evaluateInformational: () => ({ reserves: null, informational: [], exceptions: [] }),
  };

  let threw = '';
  try { E.assertDescriptor({ ...slots, pppUnresolved: undefined }); } catch (e) { threw = e.message; }
  chk('program-engine REFUSES a program with no pppUnresolved slot, at WIRING time, naming the slot',
    /pppUnresolved/.test(threw));

  const DESC = E.assertDescriptor(slots);
  const factsUnknown = { state: 'NJ', borrower_type: 'Non-Profit', units: 2, loan_amount: 400000, prepay_months: 60 };
  const factsClean = { state: 'NY', borrower_type: 'LLC', units: 2, loan_amount: 400000, prepay_months: 60 };
  const vUnknown = E.runProgram(DESC, factsUnknown);
  const vClean = E.runProgram(DESC, factsClean);

  chk('runProgram reports an unanswerable state as NOT DECIDABLE and lists it, labelled to the ppp_matrix layer',
    vUnknown.decidable === false && vUnknown.unresolved.length === 1
    && vUnknown.unresolved[0].layer === 'ppp_matrix' && vUnknown.unresolved[0].code === 'dhvn_ppp_unresolved_nj');
  chk('runProgram does NOT turn it into a decline — answering the owner question by refusing is not this layer\'s call',
    vUnknown.reasons.length === 0 && vUnknown.eligible === true);
  chk('runProgram carries the PPP basis and the borrower-type provenance onto the verdict',
    vUnknown.ppp.resolved === false && vUnknown.ppp.borrowerType === 'unclassified'
    && vClean.ppp.resolved === true && vClean.ppp.borrowerTypeSource === 'stated');
  chk('a decidable scenario is decidable, with an empty unresolved list (the control on the two above)',
    vClean.decidable === true && vClean.unresolved.length === 0 && vClean.ppp.unresolved === null);

  let threwPolicy = '';
  try { L.buildOursLeg(SHEET, SETTINGS, { factsFromLp: true, pppDescriptor: DESC }); } catch (e) { threwPolicy = e.message; }
  chk('the agreement leg REFUSES a PPP descriptor with no declared unresolved-state policy — there is no silent default',
    /onUnresolvedPpp/.test(threwPolicy));

  let threwSlot = '';
  try { L.buildOursLeg(SHEET, SETTINGS, { pppDescriptor: { pppInputFromFacts: () => ({}), pppDisqualifier: () => null }, onUnresolvedPpp: 'flag' }); } catch (e) { threwSlot = e.message; }
  chk('the agreement leg REFUSES a PPP layer that cannot say "we could not tell"',
    /pppUnresolved/.test(threwSlot));

  const scUnknown = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'Non-Profit' };
  const flagLeg = L.buildOursLeg(SHEET, SETTINGS, { factsFromLp: true, pppDescriptor: DESC, onUnresolvedPpp: 'flag' });
  const declineLeg = L.buildOursLeg(SHEET, SETTINGS, { factsFromLp: true, pppDescriptor: DESC, onUnresolvedPpp: 'decline' });
  const flagged = flagLeg(scUnknown);
  const declined = declineLeg(scUnknown);
  chk('policy "flag": the quote is still priced AND carries the unresolved marker — never a silent pass',
    flagged.eligible === true && !!flagged.pppUnresolved && flagged.pppUnresolved.source === 'ppp_matrix'
    && flagged.pppUnresolved.code === 'dhvn_ppp_unresolved_nj');
  chk('policy "decline": the same scenario is refused, with an unresolved-stamped decline, on the SAME facts',
    declined.eligible === false && (declined.declines || []).some((d) => d.code === 'dhvn_ppp_unresolved_nj' && d.unresolved === true && d.source === 'ppp_matrix'));
  chk('the two policies genuinely differ on that scenario — the caller\'s choice is what decides, not the layer',
    flagged.eligible !== declined.eligible);
  chk('a resolvable scenario is untouched by either policy (the control)',
    (() => {
      const scOk = { ...scUnknown, borrowerType: 'LLC' };
      return flagLeg(scOk).eligible === true && flagLeg(scOk).pppUnresolved === undefined
        && declineLeg(scOk).eligible === true && declineLeg(scOk).pppUnresolved === undefined;
    })());

  return out;
}
for (const r of probeCallers(realMatrix, realEngine, realLegs)) ok(r.pass, r.label);

// =================================================================================================
// 4. THE CONTROL — the whole canonical battery, before vs after, split by REASON
// =================================================================================================
console.log('\n4. CONTROL — every scenario in the canonical battery (buildAgreementScenarios)');

// UNSAFE means one thing only: an answer that used to withhold permission now GRANTS it. Everything
// else — a permission becoming a question, or becoming a prohibition — is the safe direction.
function battery(M, L) {
  const rows = [];
  for (const sc of BATTERY) {
    const facts = L.lpScenarioToFacts(sc);
    const before = verdictOf(oldPppResult(oldPppInputFromFacts(facts)));
    const after = M.pppResult(dh._internals.pppInputFromFacts(facts));
    rows.push({ sc, before, after: verdictOf(after), basis: after.basis, source: after.borrowerTypeSource });
  }
  return rows;
}
function probeControl(M, L) {
  const out = [];
  const chk = (label, cond) => out.push({ label, pass: !!cond });
  const rows = battery(M, L);
  const moved = rows.filter((r) => r.before !== r.after);
  const unsafe = moved.filter((r) => r.after === 'allowed' && r.before !== 'allowed');
  // The owner's authorization and the bug fixes are DIFFERENT reasons and are counted separately.
  const byOwnerAuthorization = moved.filter((r) => r.basis === 'state_not_in_matrix');
  const byBugFix = moved.filter((r) => r.basis !== 'state_not_in_matrix');

  chk(`CONTROL the battery is the real canonical one (${rows.length} scenarios)`, rows.length === BATTERY.length && rows.length > 200);
  chk(`CONTROL NOT ONE scenario moved in the UNSAFE direction (a withheld permission becoming a granted one): ${unsafe.length}`,
    unsafe.length === 0);
  chk(`CONTROL moves attributable to the OWNER'S 2026-08-18 authorization (unlisted state ⇒ allowed): ${byOwnerAuthorization.length} — it CONFIRMS what the engine already answered for those states, so no verdict moves`,
    byOwnerAuthorization.length === 0);
  chk(`CONTROL moves attributable to the five BUG FIXES: ${byBugFix.length} — the canonical battery never exercises an unclassifiable borrower type, an Illinois loan or an APR`,
    byBugFix.length === 0);
  chk('CONTROL and that is checked, not assumed: the battery carries no APR, no unlisted borrower type and no Illinois property',
    BATTERY.every((s) => s.apr == null && s.state !== 'IL')
    && BATTERY.every((s) => s.borrowerType == null || ['LLC', 'Individual'].includes(s.borrowerType)));

  // What DID change on the canonical battery is what the answers now SAY.
  const unlisted = rows.filter((r) => r.basis === 'state_not_in_matrix').length;
  const byRule = rows.filter((r) => r.basis === 'rule').length;
  const assumed = rows.filter((r) => r.source === 'assumed').length;
  chk(`CONTROL every answer now states its basis — ${unlisted} unlisted-state allowances (owner-authorized), ${byRule} decided by a rule, 0 unevaluable`,
    unlisted + byRule === rows.length && unlisted > 0 && byRule > 0);
  chk(`CONTROL and ${assumed} of ${rows.length} answers now say the borrower type was ASSUMED rather than stated (A8.5) — the same figure was invisible before`,
    assumed > 0 && assumed < rows.length);

  // THE DERIVED PROBE BATTERY. The canonical battery cannot move because it never carries the inputs
  // the defects need, which is a finding in itself — so the same 299 scenarios are re-run with the
  // borrower type and the state varied. Everything that moves here moved for a bug fix, and every
  // single one moves from a granted permission to an open question.
  const BT = ['LLC', 'Individual', 'Non-Profit', 'Vincent Vance', null];
  const ST = ['NJ', 'IL', 'NY', 'VT'];
  let n = 0; let mv = 0; let uns = 0; let owner = 0; let bug = 0; let toUnknown = 0;
  for (const sc of BATTERY) for (const bt of BT) for (const st of ST) {
    const v = { ...sc, state: st };
    if (bt) v.borrowerType = bt; else delete v.borrowerType;
    const facts = L.lpScenarioToFacts(v);
    const before = verdictOf(oldPppResult(oldPppInputFromFacts(facts)));
    const res = M.pppResult(dh._internals.pppInputFromFacts(facts));
    const after = verdictOf(res);
    n += 1;
    if (before === after) continue;
    mv += 1;
    if (res.basis === 'state_not_in_matrix') owner += 1; else bug += 1;
    if (after === 'allowed' && before !== 'allowed') uns += 1;
    if (before === 'allowed' && after === 'unknown') toUnknown += 1;
  }
  chk(`DERIVED the battery re-run over every borrower type × restriction state (${n} scenarios) MOVES ${mv} of them — the canonical battery's 0 is coverage, not correctness`,
    n > 5000 && mv > 1000);
  chk(`DERIVED every one of those ${mv} moves is a granted permission becoming an open question (${toUnknown}); UNSAFE moves: ${uns}`,
    uns === 0 && toUnknown === mv);
  chk(`DERIVED and not one of them is attributable to the owner's unlisted-state authorization (${owner}) — that authorization moves nothing, it only names what was already answered`,
    owner === 0 && bug === mv);
  return out;
}
for (const r of probeControl(realMatrix, realLegs)) ok(r.pass, r.label);

// =================================================================================================
// 5. THE TWO IMPLEMENTATIONS AGREE — the data-compiled Layer 3 answers identically
// =================================================================================================
console.log('\n5. the DATA-COMPILED layer answers the same three ways (one definition, two engines)');
{
  const compiled = require(SRC + '/layer-data-registry').programFor('Deephaven');
  ok(!!compiled && typeof compiled.pppUnresolved === 'function',
    'the compiled-from-data program carries the third answer too (it could not be registered without it)');
  const cases = [NJ_NONPROFIT, NJ_VINCENT, NJ_ABSENT, NJ_INDIVIDUAL, NJ_LLC, IL_NO_APR, IL_APR_7, IL_APR_9, NY_ANY, CT_ANY];
  const same = cases.every((i) => JSON.stringify(compiled.pppResult(i)) === JSON.stringify(realMatrix.pppResult(i))
    && JSON.stringify(compiled.pppUnresolved(i) || null) === JSON.stringify(realMatrix.pppUnresolved(i) || null));
  ok(same, `the hand-written and the data-compiled Layer 3 give byte-identical answers on all ${cases.length} A8 cases, including the third one`);
}

// =================================================================================================
// 6. THE LOAD-TIME GUARDS still bite
// =================================================================================================
console.log('\n6. the load-time guards');
{
  ok(realMatrix._internals.SUPPORTED_WHEN_KEYS.has('aprLe'),
    'the new `aprLe` when-key is a first-class member of the derived supported set (not a special case)');
  ok(realMatrix._internals.unsupportedWhenKeys(realMatrix.STATE_RULES).length === 0,
    'every when-key in the committed table is still one the matcher can evaluate');
  const keys = Object.keys(realMatrix.STATE_WHEN_KEYS);
  ok(keys.length === Object.keys(realMatrix.STATE_RULES).length && realMatrix.STATE_WHEN_KEYS.IL.includes('aprLe'),
    'STATE_WHEN_KEYS is derived from the rule table (a rule added tomorrow names its own facts in an unresolved answer)');
}

// =================================================================================================
// 7. MUTATION — every check above is proven to go RED, on its own sentence
// =================================================================================================
console.log('\n7. MUTATION — break one thing at a time and demand the named check goes red');

// A mutation "counts" only when the EXPECTED sentence is among the failures. A probe that crashed, or
// that went red somewhere unrelated, proves nothing about the check being claimed.
function expectRed(name, probeFn, expectSubstring) {
  let results;
  try { results = probeFn(); } catch (e) {
    ok(false, `${name} — the probe CRASHED (${e.message}); a crash is not proof that the check bites`);
    return;
  }
  const reds = results.filter((r) => !r.pass).map((r) => r.label);
  const hit = reds.find((l) => l.includes(expectSubstring));
  ok(!!hit, `${name} → RED on "${(hit || expectSubstring).slice(0, 96)}"${hit ? '' : ` (reds: ${reds.length ? reds.map((l) => l.slice(0, 40)).join(' | ') : 'NONE'})`}`);
}

// CONTROL, before the mutations.
ok(probeMatrix(realMatrix, realLegs).every((r) => r.pass)
  && probeCallers(realMatrix, realEngine, realLegs).every((r) => r.pass)
  && probeControl(realMatrix, realLegs).every((r) => r.pass),
  'CONTROL (before): the unmutated modules are GREEN on every probe');

// M1 — the unevaluable answer goes back to being a PERMISSION (the defect itself).
expectRed('M1 an unevaluable lookup answers "standard" again',
  () => probeMatrix(loadMutated(MATRIX_FILE, [['    result: PPP_UNKNOWN,', "    result: 'standard',"]]), realLegs),
  'A8.1 an unevaluable NJ lookup answers "unknown"');

// M2 — the Illinois APR guard is removed, so the "APR 8% or less" claim returns.
expectRed('M2 the Illinois rule loses its `aprLe` guard',
  () => probeMatrix(loadMutated(MATRIX_FILE, [["{ borrowerType: 'natural_person', unitsMax: 4, aprLe: 8 }", "{ borrowerType: 'natural_person', unitsMax: 4 }"]]), realLegs),
  'A8.2 Illinois with NO apr answers "unknown"');

// M3 — the borrower-type match loses its word boundary (back to a substring test).
expectRed('M3 the borrower-type classifier matches substrings again',
  () => probeMatrix(loadMutated(MATRIX_FILE, [['const hasWord = (n) => padded.includes(` ${n} `);', 'const hasWord = (n) => padded.includes(n);']]), realLegs),
  'A8.3 "Vincent Vance" / "Vince" / "Prince Holdings" / "Quincy Adams" are no longer corporations');

// M4 — an unrecognised borrower type goes back to being indistinguishable from an absent one.
expectRed('M4 an unrecognised borrower type reads as "nothing was stated" again',
  () => probeMatrix(loadMutated(MATRIX_FILE, [["  return 'unclassified';\n}", '  return null;\n}']]), realLegs),
  'A8.4 "Non-Profit" is "unclassified"');

// M5 — the owner's unlisted-state allowance is worded as the unevaluable gap (the two collapsed).
expectRed('M5 an unlisted state and an unevaluable one carry the SAME note',
  () => probeMatrix(loadMutated(MATRIX_FILE, [["note: UNLISTED_STATE_NOTE, needs: []", 'note: UNRESOLVED_NOTE, needs: []']]), realLegs),
  'OWNER 2026-08-18: …with NO limits');

// M6 — an unlisted state claims a rule was evaluated.
expectRed('M6 an unlisted state claims basis "rule"',
  () => probeMatrix(loadMutated(MATRIX_FILE, [["basis: 'state_not_in_matrix'", "basis: 'rule'"]]), realLegs),
  'OWNER 2026-08-18: a state NOT in the matrix (NY, CT) is ALLOWED');

// M7 — a guess is recorded as an assertion again.
expectRed('M7 an ASSUMED borrower type is reported as STATED',
  () => probeMatrix(loadMutated(MATRIX_FILE, [["inp.borrowerTypeAssumed === true ? 'assumed' :", 'false ?  \'assumed\' :']]), realLegs),
  'A8.5 a STATED LLC and an ASSUMED LLC no longer produce the same answer');

// M8 — the assumption and the assertion are merged back together in the FACTS.
expectRed('M8 the fact converter merges the assumption back into the stated value',
  () => probeMatrix(realMatrix, loadMutated(LEGS_FILE, [['borrower_type_assumed: !(sc.borrowerType || sc.borrower_type),', 'borrower_type_assumed: false,']])),
  'A8.5 …and the ASSUMPTION and the ASSERTION are kept apart in the FACTS too');

// M9 — the prohibition itself is weakened, so the CONTROL must catch an unsafe move on the battery.
expectRed('M9 New Jersey stops prohibiting an individual borrower (an UNSAFE move on the real battery)',
  () => probeControl(loadMutated(MATRIX_FILE, [["{ when: { borrowerType: 'natural_person', unitsMax: 4 }, result: 'prohibited', note: 'business decision — individual borrower' }", "{ when: { borrowerType: 'natural_person', unitsMax: 4 }, result: 'standard', note: 'business decision — individual borrower' }"]]), realLegs),
  'CONTROL NOT ONE scenario moved in the UNSAFE direction');

// M10 — the required descriptor slot is dropped, so a program with no third answer wires cleanly.
expectRed('M10 program-engine stops requiring the pppUnresolved slot',
  () => probeCallers(realMatrix, loadMutated(ENGINE_FILE, [["'pppDisqualifier', 'pppUnresolved',", "'pppDisqualifier',"]]), realLegs),
  'program-engine REFUSES a program with no pppUnresolved slot');

// M11 — runProgram swallows the third answer and reports the file as decidable.
expectRed('M11 runProgram reports every verdict as decidable',
  () => probeCallers(realMatrix, loadMutated(ENGINE_FILE, [['decidable: unresolved.length === 0,', 'decidable: true,']]), realLegs),
  'runProgram reports an unanswerable state as NOT DECIDABLE');

// M12 — runProgram turns the third answer into a decline, answering the owner question by itself.
expectRed('M12 runProgram declines an unanswerable state on its own authority',
  () => probeCallers(realMatrix, loadMutated(ENGINE_FILE, [['  const unresolved = pppUnres ? [{ layer: \'ppp_matrix\', ...pppUnres }] : [];',
    '  const unresolved = pppUnres ? [{ layer: \'ppp_matrix\', ...pppUnres }] : [];\n  if (pppUnres) reasons.push({ layer: \'ppp_matrix\', ...pppUnres });']]), realLegs),
  'runProgram does NOT turn it into a decline');

// M13 — the leg accepts a descriptor with no declared policy again.
expectRed('M13 the agreement leg accepts a PPP descriptor with no unresolved-state policy',
  () => probeCallers(realMatrix, realEngine, loadMutated(LEGS_FILE, [['if (desc && !UNRESOLVED_PPP_POLICIES.includes(unresolvedPolicy)) {', 'if (false) {']])),
  'the agreement leg REFUSES a PPP descriptor with no declared unresolved-state policy');

// M14 — "flag" stops attaching the marker, so an unanswerable state prices silently.
expectRed('M14 the "flag" policy stops marking the quote',
  () => probeCallers(realMatrix, realEngine, loadMutated(LEGS_FILE, [['  return { ...quote, pppUnresolved: { ...unres, source: \'ppp_matrix\' } };', '  return quote;']])),
  'policy "flag": the quote is still priced AND carries the unresolved marker');

// M15 — the leg stops asking the third channel at all.
expectRed('M15 the agreement leg never asks the third channel',
  () => probeCallers(realMatrix, realEngine, loadMutated(LEGS_FILE, [['    const unres = desc.pppUnresolved(pppInput);', '    const unres = null;']])),
  'policy "decline": the same scenario is refused');

// CONTROL, after the mutations — the real modules were never touched.
ok(probeMatrix(realMatrix, realLegs).every((r) => r.pass)
  && probeCallers(realMatrix, realEngine, realLegs).every((r) => r.pass)
  && probeControl(realMatrix, realLegs).every((r) => r.pass),
  'CONTROL (after): the unmutated modules are STILL GREEN on every probe');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
