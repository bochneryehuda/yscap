#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE LAYER-COMPILER EQUIVALENCE PROOF (PPE item #47, the scalable foundation).
 *
 * WHAT IT PROVES. Layer 2 (eligibility) and Layer 3 (PPP) are now expressible as DATA plus a pure
 * compiler that emits the canonical rule objects `rules.evaluateRules` already runs. This suite drives
 * the COMPILED form and the HAND-WRITTEN modules — which stay in place and are the ORACLE — with the
 * SAME facts across an exhaustive sweep and demands a BYTE-IDENTICAL verdict: the eligible flag, every
 * decline code, every reason string, every citation, the resolved max-LTV bound, the resolved grid cell,
 * the grid status and the unverifiable catalog. Any difference at all is a failure.
 *
 * WHY THE COMPARISON IS STRICT AND NOT "deep-equal-ish". `strictEq` compares own-key SETS as well as
 * values, because the hand-written `pppResult` genuinely returns three DIFFERENT shapes (a state with no
 * rule table carries no `terms`/`note` keys at all) and a comparison that ignored key presence would be
 * checking less than it claims.
 *
 * AND IT PROVES THE HARNESS BITES. Section 6 perturbs ONE thing in a compiled program at a time — a cap,
 * a reason, a rule's presence, a priority, a threshold, a numeric guard, a PPP result, a first-match
 * exclusion — and asserts the sweep goes RED, with an unmutated control green on either side. An
 * equivalence test nobody has seen fail is decoration.
 *
 * OFFLINE. No DB, no network, no clock. LT-only.
 */

const ruleBuilder = require('../src/longterm/ppe/rule-builder');
const { evaluateRules } = require('../src/longterm/ppe/rules');
const layerFacts = require('../src/longterm/ppe/layer-facts');
const { compileEligibility, buildEvaluator, LayerCompileError } = require('../src/longterm/ppe/layer-compile-eligibility');
const { compilePpp, buildPppEvaluators } = require('../src/longterm/ppe/layer-compile-ppp');
const registry = require('../src/longterm/ppe/layer-data-registry');
const { runProgram } = require('../src/longterm/ppe/program-engine');

// ---- the ORACLES (hand-written, unchanged, still in production) ---------------------------------
const oracleMatrix = require('../src/longterm/ppe/deephaven-matrix');
const oraclePpp = require('../src/longterm/ppe/deephaven-ppp-matrix');
const oracleProgram = require('../src/longterm/ppe/program-deephaven-dscr');

const ELIG_DOC = require('../src/longterm/ppe/investor-data/deephaven-dscr.eligibility.v2026-08-04.json');
const PPP_DOC = require('../src/longterm/ppe/investor-data/deephaven-dscr.ppp.v2026-03.json');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

// ---- strict structural comparison ---------------------------------------------------------------

function strictEq(a, b, path = '$', diffs = []) {
  if (a === b) return diffs;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { diffs.push(`${path}: type ${ta} vs ${tb}`); return diffs; }
  if (ta === 'array') {
    if (a.length !== b.length) { diffs.push(`${path}: length ${a.length} vs ${b.length}`); return diffs; }
    for (let i = 0; i < a.length; i++) strictEq(a[i], b[i], `${path}[${i}]`, diffs);
    return diffs;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    if (ka.join('\u0000') !== kb.join('\u0000')) { diffs.push(`${path}: keys [${ka}] vs [${kb}]`); return diffs; }
    for (const k of ka) strictEq(a[k], b[k], `${path}.${k}`, diffs);
    return diffs;
  }
  if (ta === 'number' && Number.isNaN(a) && Number.isNaN(b)) return diffs;
  diffs.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  return diffs;
}

// A deterministic PRNG, so a fuzz failure is always reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('LT PPE — Layer 2/3 DATA + PURE COMPILERS: equivalence against the hand-written oracles\n');

// =================================================================================================
// 1. THE COMPILED ARTEFACT IS CANONICAL
// =================================================================================================
console.log('1. the compiled rules are canonical (rule-builder is the ONE validator)');

const elig = registry.compiledLayer('Deephaven', 'eligibility', '2026-08-04');
const ppp = registry.compiledLayer('Deephaven', 'ppp', '2026-03');

{
  const bad = [];
  for (const r of [...elig.rules, ...ppp.rules]) {
    const v = ruleBuilder.validateRule(r);
    if (!v.ok) bad.push(`${r.code}: ${v.errors.join('; ')}`);
  }
  ok(bad.length === 0, `every one of the ${elig.rules.length + ppp.rules.length} compiled rules passes rule-builder.validateRule${bad.length ? ' — ' + bad.slice(0, 3).join(' | ') : ''}`);
}
{
  const kinds = new Set([...elig.rules, ...ppp.rules].map((r) => r.kind));
  ok([...kinds].every((k) => ruleBuilder.RULE_KINDS.includes(k)), `compiled rules use ONLY the canonical kinds (${[...kinds].sort().join(', ')})`);
  ok([...elig.rules, ...ppp.rules].every((r) => Object.isFrozen(r)), 'every compiled rule is deep-frozen (a caller cannot mutate an authored rule)');
  const codes = [...elig.rules, ...ppp.rules].map((r) => r.code);
  ok(new Set(codes).size === codes.length, 'every compiled rule carries a UNIQUE internal code (the catalog key)');
}
{
  // Every eligibility rule must have a catalog entry naming its public decline code / dimension /
  // citation — a rule with no catalog entry would decline a loan with no wording anyone can read.
  const missing = elig.rules.filter((r) => r.kind === 'eligibility' && !elig.catalog[r.code]).map((r) => r.code);
  ok(missing.length === 0, `every eligibility rule has a presentation catalog entry${missing.length ? ' — missing ' + missing.join(', ') : ''}`);
  const pubCodes = new Set(Object.values(elig.catalog).filter((c) => c.code).map((c) => c.code));
  const oracleCodes = ['dhvn_max_loan', 'dhvn_min_loan_ge1', 'dhvn_min_loan_lt1', 'dhvn_min_dscr', 'dhvn_min_fico_tier', 'dhvn_grid_na', 'dhvn_grid_ltv', 'dhvn_cashout_le65', 'dhvn_cashout_gt65', 'dhvn_small_loan_ltv', 'dhvn_io_max_ltv', 'dhvn_io_min_dscr', 'dhvn_subordinate', 'dhvn_units_5plus', 'dhvn_row_home'];
  ok(oracleCodes.every((c) => pubCodes.has(c)) && pubCodes.size === oracleCodes.length, `the compiled catalog emits EXACTLY the hand-written module's ${oracleCodes.length} decline codes`);
}
{
  // The derived-fact stage is the only place normalization happens, and its vocabulary is closed.
  ok(layerFacts.unsupportedDerivationKinds(elig.derivedFacts).length === 0 && layerFacts.unsupportedDerivationKinds(ppp.derivedFacts).length === 0,
    'every derived fact both layers declare uses a KNOWN derivation kind (an unknown kind is refused at compile time)');
  ok(layerFacts.derivationProblems({ x: { kind: 'regex', from: 'y' } }).length > 0, 'an unknown derivation kind is REFUSED (fail-closed)');
  ok(layerFacts.derivationProblems({ x: { kind: 'string', from: 'y', strip: 'nonalnum' } }).length > 0,
    'a strip without a lower-case fold is REFUSED (it would silently delete every capital letter)');
}
{
  // A compiler that half-compiles a broken matrix is worse than one that refuses.
  const broken = JSON.parse(JSON.stringify(ELIG_DOC));
  broken.grid.tiers[0].rows[1].fico = 999; // no longer strictly descending
  let threw = false;
  try { compileEligibility(broken); } catch (e) { threw = e instanceof LayerCompileError; }
  ok(threw, 'a grid whose FICO rows are not strictly descending is REFUSED at compile time');

  const broken2 = JSON.parse(JSON.stringify(ELIG_DOC));
  broken2.grid.tiers[0].minFico = 600; // disagrees with the lowest row
  let threw2 = false;
  try { compileEligibility(broken2); } catch (e) { threw2 = e instanceof LayerCompileError; }
  ok(threw2, 'a tier whose declared minFico disagrees with its lowest row floor is REFUSED');

  const broken3 = JSON.parse(JSON.stringify(PPP_DOC));
  broken3.states.NJ[0].when = { unitsMaximum: 4 }; // a typo'd when-key
  let threw3 = false;
  try { compilePpp(broken3); } catch (e) { threw3 = e instanceof LayerCompileError; }
  ok(threw3, 'a PPP rule carrying an unsupported when-key is REFUSED (an un-taught key would silently drop a prohibition)');

  const broken4 = JSON.parse(JSON.stringify(PPP_DOC));
  broken4.states.AK = [{ when: {}, result: 'standard' }, { when: { unitsMax: 4 }, result: 'prohibited' }];
  let threw4 = false;
  try { compilePpp(broken4); } catch (e) { threw4 = e instanceof LayerCompileError; }
  ok(threw4, 'an always-matches PPP clause that is not last is REFUSED (every rule after it is unreachable)');
}

// =================================================================================================
// 2. THE VERSIONED REGISTRY
// =================================================================================================
console.log('\n2. the versioned registry — a program NAMES its data version, and two investors coexist');
{
  ok(registry.getData('Deephaven', 'eligibility', '2026-08-04') !== null, 'the Deephaven eligibility matrix is registered under its own version');
  ok(registry.getData('Deephaven', 'ppp', '2026-03') !== null, 'the Deephaven PPP matrix is registered under its own version');
  ok(registry.getData('Deephaven', 'eligibility', '1999-01-01') === null, 'an unknown version resolves to null — the registry never guesses a version');
  const desc = registry.describeProgram('deephaven mortgage');
  ok(desc && desc.layers.eligibility.version === '2026-08-04' && desc.layers.ppp.version === '2026-03',
    'the registered program NAMES the exact data version of each compiled layer');
  ok(desc && desc.layers.overlay.source === 'code' && desc.layers.eligibility.source === 'data',
    'the program states which layers are DATA and which are still CODE (no implied claim)');
  ok(registry.programFor('Nobody Inc') === null, 'an unregistered investor resolves to null (never a silent default program)');

  // A SECOND VERSION of the same investor's matrix coexists with the live one.
  const v2 = JSON.parse(JSON.stringify(ELIG_DOC));
  v2.dataVersion = '2026-99-99-test';
  v2.grid.tiers[0].rows[0].caps.P_RT_ge1 = 70; // a different matrix, deliberately
  registry.registerData(v2);
  const liveCap = registry.compiledLayer('Deephaven', 'eligibility', '2026-08-04').evaluate({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: 78000, purpose: 'purchase' });
  const testCap = registry.compiledLayer('Deephaven', 'eligibility', '2026-99-99-test').evaluate({ loan_amount: 400000, fico: 760, dscr: 1250, ltv: 78000, purpose: 'purchase' });
  ok(liveCap.maxLtvMilli === 80000 && testCap.maxLtvMilli === 70000,
    'TWO VERSIONS of one investor coexist and price differently (80% live vs 70% in the second version)');
  let rejected = false;
  try { registry.registerData({ ...JSON.parse(JSON.stringify(ELIG_DOC)), dataVersion: '2026-99-99-test' }); } catch (e) { rejected = /version_already_registered/.test(e.message); }
  ok(rejected, 're-registering a DIFFERENT document under an existing version is REFUSED (a version is an immutable identity)');

  // A SECOND INVESTOR coexists — same schema, its own key, its own numbers, no shared state.
  const second = JSON.parse(JSON.stringify(ELIG_DOC));
  second.investor = 'Testwood Capital';
  second.program = 'Testwood DSCR';
  second.dataVersion = '2026-01';
  second.citation = 'Testwood test matrix';
  second.grid.tiers = [{ maxLoan: 1000000, minLoanExclusive: null, minFico: 700, rows: [{ fico: 700, caps: { P_RT_ge1: 60, CO_ge1: 60, P_RT_lt1: null, CO_lt1: null } }] }];
  second.rules = second.rules.filter((r) => r.id === 'max_loan');
  registry.registerData(second);
  const secondPpp = JSON.parse(JSON.stringify(PPP_DOC));
  secondPpp.investor = 'Testwood Capital';
  secondPpp.program = 'Testwood DSCR';
  secondPpp.dataVersion = '2026-01';
  secondPpp.states = { NJ: [{ when: {}, result: 'standard' }] };
  registry.registerData(secondPpp);
  registry.registerProgram({
    investor: 'Testwood Capital',
    programName: 'Testwood DSCR',
    dataVersions: { eligibility: '2026-01', ppp: '2026-01' },
    slots: { evaluateOverlay: () => ({ declines: [], enforced: [], stillFlagged: [] }), evaluateInformational: () => ({ reserves: null, informational: [], exceptions: [] }), overlayCoverage: [] },
  });
  const names = registry.listPrograms().map((p) => p.investor).sort();
  ok(names.length === 2 && names[0] === 'Deephaven' && names[1] === 'Testwood Capital', `two investors coexist in the compiled registry (${names.join(', ')})`);
  const tFacts = { loan_amount: 400000, fico: 760, dscr: 1250, ltv: 65000, purpose: 'purchase', state: 'NJ', prepay_months: 60 };
  const dOut = registry.evaluateProgramFor('Deephaven', tFacts);
  const tOut = registry.evaluateProgramFor('Testwood Capital', tFacts);
  ok(dOut.maxLtvMilli === 80000 && tOut.maxLtvMilli === 60000 && dOut.investor === 'Deephaven' && tOut.investor === 'Testwood Capital',
    'the two programs price the SAME scenario against their OWN matrices, with no cross-talk (80% vs 60%)');
}

// =================================================================================================
// 3. LAYER 2 — EXHAUSTIVE EQUIVALENCE SWEEP
// =================================================================================================
console.log('\n3. Layer 2 (eligibility) — exhaustive equivalence against deephaven-matrix.evaluateEligibility');

let ELIG_CASES = 0;
const eligDiffSamples = [];

function compareElig(facts, evaluate, sink) {
  const a = oracleMatrix.evaluateEligibility(facts);
  const b = evaluate(facts);
  const d = strictEq(a, b);
  if (d.length) { if (sink && sink.length < 5) sink.push({ facts: JSON.stringify(facts), diffs: d.slice(0, 3) }); return false; }
  return true;
}

// Sweep A — the envelope + the whole max-LTV grid: every tier/FICO/purpose/DSCR-band boundary.
const A_LOAN = [undefined, null, 0, 74999, 75000, 124999, 125000, 199999, 200000, 400000, 1500000, 1500001, 2000000, 2000001, 2500000, 2500001, 5000000];
const A_FICO = [undefined, 500, 639, 640, 659, 660, 679, 680, 699, 700, 719, 720, 850];
const A_DSCR = [undefined, 0, 749, 750, 999, 1000, 1250];
const A_LTV = [undefined, 60000, 64999, 65000, 65001, 69999, 70000, 75000, 75001, 80000, 80001, 100000];
const A_PURPOSE = [undefined, 'purchase', 'cashout', 'CashOut'];

function sweepA(evaluate, sink, stopOnFirst) {
  let n = 0; let bad = 0;
  for (const loan_amount of A_LOAN) for (const fico of A_FICO) for (const dscr of A_DSCR) for (const ltv of A_LTV) for (const purpose of A_PURPOSE) {
    const f = {};
    if (loan_amount !== undefined) f.loan_amount = loan_amount;
    if (fico !== undefined) f.fico = fico;
    if (dscr !== undefined) f.dscr = dscr;
    if (ltv !== undefined) f.ltv = ltv;
    if (purpose !== undefined) f.purpose = purpose;
    n++;
    if (!compareElig(f, evaluate, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
  }
  return { n, bad };
}

// Sweep B — the cash-out amount caps, on both sides of the 65% LTV split.
const B_CASHOUT = [undefined, null, 0, 499999, 500000, 500001, 999999, 1000000, 1000001, 3000000];
function sweepB(evaluate, sink, stopOnFirst) {
  let n = 0; let bad = 0;
  for (const purpose of ['cashout', 'CASHOUT', 'purchase', undefined]) for (const ltv of [undefined, 60000, 65000, 65001, 80000]) for (const cashout_amount of B_CASHOUT) for (const loan_amount of [80000, 250000, 1200000, 2400000]) for (const dscr of [900, 1250]) for (const fico of [650, 690, 730]) {
    const f = { loan_amount, dscr, fico };
    if (purpose !== undefined) f.purpose = purpose;
    if (ltv !== undefined) f.ltv = ltv;
    if (cashout_amount !== undefined) f.cashout_amount = cashout_amount;
    n++;
    if (!compareElig(f, evaluate, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
  }
  return { n, bad };
}

// Sweep C — the non-grid overlays: interest-only, units, subordinate financing, property type.
const C_PT = [undefined, null, '', 'SFR', 'Condo', 'Row Home', 'row-home', 'ROWHOUSE', 'Row House', 'Townhome', 'Non-Warrantable Condo', 'Brownstone Rowhome'];
function sweepC(evaluate, sink, stopOnFirst) {
  let n = 0; let bad = 0;
  for (const interest_only of [undefined, true, false, 1, 'true']) for (const units of [undefined, null, 0, 1, 4, 4.5, 5, 20]) for (const subordinate_amount of [undefined, null, -1, 0, 1, 250000]) for (const property_type of C_PT) for (const ltv of [70000, 80000, 80001]) for (const dscr of [900, 1250]) {
      const f = { loan_amount: 400000, fico: 730, dscr, ltv, purpose: 'purchase' };
      if (interest_only !== undefined) f.interest_only = interest_only;
      if (units !== undefined) f.units = units;
      if (subordinate_amount !== undefined) f.subordinate_amount = subordinate_amount;
      if (property_type !== undefined) f.property_type = property_type;
      n++;
      if (!compareElig(f, evaluate, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
    }
  return { n, bad };
}

// Sweep D — randomized FUZZ over every fact, including values that are not numbers at all. This is the
// sweep that proves the compiled numeric guards reproduce the hand-written `isNum(x)` checks: a string
// '80000' compares like a number in JS but is NOT a number to the oracle.
const JUNK = [undefined, null, NaN, Infinity, -Infinity, '80000', '0', 'abc', true, false, {}, [], -1, 0];
function sweepD(evaluate, sink, iters, seed, stopOnFirst) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const numOrJunk = (arr) => (rnd() < 0.3 ? pick(JUNK) : pick(arr));
  let n = 0; let bad = 0;
  for (let i = 0; i < iters; i++) {
    const f = {};
    const put = (k, v) => { if (v !== undefined) f[k] = v; };
    put('loan_amount', numOrJunk(A_LOAN));
    put('fico', numOrJunk(A_FICO));
    put('dscr', numOrJunk(A_DSCR));
    put('ltv', numOrJunk(A_LTV));
    put('purpose', rnd() < 0.3 ? pick(JUNK) : pick(A_PURPOSE));
    put('cashout_amount', numOrJunk(B_CASHOUT));
    put('units', numOrJunk([1, 2, 4, 5, 12]));
    put('subordinate_amount', numOrJunk([0, 1, 100000]));
    put('interest_only', pick([undefined, true, false, 1, 'yes']));
    put('property_type', rnd() < 0.5 ? pick(C_PT) : pick(JUNK));
    n++;
    if (!compareElig(f, evaluate, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
  }
  return { n, bad };
}

{
  const t0 = Date.now();
  const a = sweepA(elig.evaluate, eligDiffSamples);
  const b = sweepB(elig.evaluate, eligDiffSamples);
  const c = sweepC(elig.evaluate, eligDiffSamples);
  const d = sweepD(elig.evaluate, eligDiffSamples, 40000, 20260817);
  ELIG_CASES = a.n + b.n + c.n + d.n;
  const bad = a.bad + b.bad + c.bad + d.bad;
  ok(a.bad === 0, `sweep A — envelope + every grid cell/boundary: ${a.n.toLocaleString()} scenarios, ${a.bad} differences`);
  ok(b.bad === 0, `sweep B — cash-out amount caps either side of the 65% split: ${b.n.toLocaleString()} scenarios, ${b.bad} differences`);
  ok(c.bad === 0, `sweep C — interest-only / units / subordinate / property type: ${c.n.toLocaleString()} scenarios, ${c.bad} differences`);
  ok(d.bad === 0, `sweep D — randomized fuzz incl. non-numeric junk facts (seed 20260817): ${d.n.toLocaleString()} scenarios, ${d.bad} differences`);
  ok(bad === 0, `LAYER 2 TOTAL: ${ELIG_CASES.toLocaleString()} scenarios compared, ${bad} differences (${Date.now() - t0}ms)`);
  if (bad) for (const s of eligDiffSamples) console.log('       · ' + s.facts + ' → ' + s.diffs.join(' | '));
}
{
  // The engine's OWN bound-violation declines are excluded from the presented reasons (a bound exists
  // to produce maxLtvMilli; the matrix's wording lives on the eligibility rule beside it). That is only
  // safe if a violated bound ALWAYS coincides with a real decline — asserted, never assumed.
  let checked = 0; let orphan = 0;
  const rnd = mulberry32(7);
  for (let i = 0; i < 20000; i++) {
    const f = {
      loan_amount: A_LOAN[Math.floor(rnd() * A_LOAN.length)],
      fico: A_FICO[Math.floor(rnd() * A_FICO.length)],
      dscr: A_DSCR[Math.floor(rnd() * A_DSCR.length)],
      ltv: A_LTV[Math.floor(rnd() * A_LTV.length)],
      purpose: A_PURPOSE[Math.floor(rnd() * A_PURPOSE.length)],
    };
    const raw = elig.evaluate.engine(f);
    if (!raw.declines.some((x) => x.bound)) continue;
    checked++;
    if (elig.evaluate(f).reasons.length === 0) orphan++;
  }
  ok(checked > 0 && orphan === 0, `every violated LTV bound is accompanied by a real matrix decline (${checked.toLocaleString()} bound violations checked, ${orphan} orphaned)`);
}

// =================================================================================================
// 4. LAYER 3 — EXHAUSTIVE EQUIVALENCE SWEEP
// =================================================================================================
console.log('\n4. Layer 3 (PPP) — exhaustive equivalence against deephaven-ppp-matrix');

const RESTRICTED = Object.keys(PPP_DOC.states);
const P_STATE = [undefined, null, '', 'CA', 'NY', 'TX', 'nj', 'Md', ...RESTRICTED];
const P_BT = [undefined, null, 0, '', 'LLC', 'Individual', 'natural_person', 'business_entity', 'Trust', 'Consumer', 'Something Else'];
const P_UNITS = [undefined, null, 1, 2, 3, 4, 5, 9, '4'];
const P_LIEN = [undefined, '', 'first', 'junior', 'FIRST'];
const P_LOAN = [undefined, null, 24999, 25000, 25001, 74999, 75000, 116355, 116356, 329411, 329412, 832750, 832751, 999999, 1000000, '500000'];
const P_APR = [undefined, null, 7, 8, 8.001, 12, '9'];
const P_RURAL = [undefined, null, true, false, 1, 'yes'];
const P_PREPAY = [undefined, null, true, false, 0, 1, ''];

let PPP_CASES = 0;
const pppDiffSamples = [];
let OVERLAP = null; let OVERLAP_INPUT = null;
const overlapDisqualifierCount = (c) => c.pppResult.engine(OVERLAP_INPUT).declines.filter((d) => !d.bound).length;

function comparePpp(input, res, dq, sink) {
  const a1 = oraclePpp.pppResult(input); const b1 = res(input);
  const a2 = oraclePpp.pppDisqualifier(input); const b2 = dq(input);
  const d = [...strictEq(a1, b1, '$.pppResult'), ...strictEq(a2, b2, '$.pppDisqualifier')];
  if (d.length) { if (sink && sink.length < 5) sink.push({ input: JSON.stringify(input), diffs: d.slice(0, 3) }); return false; }
  return true;
}

// Sweep E — the full cross product of every dimension the state table keys on, over every restricted
// state plus unrestricted / missing / lower-case states.
function sweepE(res, dq, sink, stopOnFirst) {
  let n = 0; let bad = 0;
  for (const state of P_STATE) for (const borrowerType of P_BT) for (const units of P_UNITS) for (const lien of P_LIEN) {
    for (const loanAmount of [undefined, 75000, 116355, 329411, 832751, 999999]) {
      const input = {};
      if (state !== undefined) input.state = state;
      if (borrowerType !== undefined) input.borrowerType = borrowerType;
      if (units !== undefined) input.units = units;
      if (lien !== undefined) input.lien = lien;
      if (loanAmount !== undefined) input.loanAmount = loanAmount;
      input.prepayRequested = true;
      n++;
      if (!comparePpp(input, res, dq, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
    }
  }
  return { n, bad };
}

// Sweep F — the APR / rural / prepay-requested dimensions, plus every loan-amount threshold.
function sweepF(res, dq, sink, stopOnFirst) {
  let n = 0; let bad = 0;
  for (const state of ['IL', 'LA', 'MN', 'OH', 'PA', 'VT', 'VA', 'MD', 'MI', 'AK', 'RI', 'NM', 'NJ', 'CA']) {
    for (const apr of [undefined, 7, 8, 8.001, 12]) for (const ruralProperty of [undefined, true, false, 1]) for (const prepayRequested of [undefined, true, false, 0, 1]) for (const loanAmount of P_LOAN) for (const borrowerType of ['LLC', 'Individual', undefined]) {
      const input = { state, units: 2, lien: 'first' };
      if (apr !== undefined) input.apr = apr;
      if (ruralProperty !== undefined) input.ruralProperty = ruralProperty;
      if (prepayRequested !== undefined) input.prepayRequested = prepayRequested;
      if (loanAmount !== undefined) input.loanAmount = loanAmount;
      if (borrowerType !== undefined) input.borrowerType = borrowerType;
      n++;
      if (!comparePpp(input, res, dq, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
    }
  }
  return { n, bad };
}

// Sweep G — randomized fuzz across every dimension including junk types.
function sweepG(res, dq, sink, iters, seed, stopOnFirst) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let n = 0; let bad = 0;
  for (let i = 0; i < iters; i++) {
    const input = {};
    const put = (k, v) => { if (v !== undefined) input[k] = v; };
    put('state', rnd() < 0.15 ? pick(JUNK) : pick(P_STATE));
    put('borrowerType', rnd() < 0.15 ? pick(JUNK) : pick(P_BT));
    put('units', rnd() < 0.15 ? pick(JUNK) : pick(P_UNITS));
    put('lien', rnd() < 0.15 ? pick(JUNK) : pick(P_LIEN));
    put('loanAmount', rnd() < 0.15 ? pick(JUNK) : pick(P_LOAN));
    put('apr', rnd() < 0.15 ? pick(JUNK) : pick(P_APR));
    put('ruralProperty', pick(P_RURAL));
    put('prepayRequested', pick(P_PREPAY));
    n++;
    if (!comparePpp(input, res, dq, sink)) { bad++; if (stopOnFirst) return { n, bad }; }
  }
  return { n, bad };
}

{
  const t0 = Date.now();
  const e = sweepE(ppp.pppResult, ppp.pppDisqualifier, pppDiffSamples);
  const f = sweepF(ppp.pppResult, ppp.pppDisqualifier, pppDiffSamples);
  const g = sweepG(ppp.pppResult, ppp.pppDisqualifier, pppDiffSamples, 40000, 20260318);
  PPP_CASES = e.n + f.n + g.n;
  const bad = e.bad + f.bad + g.bad;
  ok(e.bad === 0, `sweep E — state × borrower type × units × lien × loan amount: ${e.n.toLocaleString()} scenarios, ${e.bad} differences`);
  ok(f.bad === 0, `sweep F — APR / rural / prepay-requested / every threshold: ${f.n.toLocaleString()} scenarios, ${f.bad} differences`);
  ok(g.bad === 0, `sweep G — randomized fuzz incl. junk types (seed 20260318): ${g.n.toLocaleString()} scenarios, ${g.bad} differences`);
  ok(bad === 0, `LAYER 3 TOTAL: ${PPP_CASES.toLocaleString()} scenarios compared, ${bad} differences (${Date.now() - t0}ms)`);
  if (bad) for (const s of pppDiffSamples) console.log('       · ' + s.input + ' → ' + s.diffs.join(' | '));
}
{
  // The owner's own NJ example, both directions, through the compiled form.
  const nj = (bt) => ({ state: 'NJ', borrowerType: bt, units: 2, lien: 'first', loanAmount: 400000, prepayRequested: true });
  ok(ppp.pppDisqualifier(nj('Individual')) !== null && ppp.pppDisqualifier(nj('LLC')) === null,
    "OWNER CASE: NJ 1-4 unit — an individual borrower requesting a PPP is disqualified, an LLC is not");
  ok(ppp.pppDisqualifier({ ...nj('Individual'), prepayRequested: false }) === null, 'a No-PPP loan is never disqualified by the PPP layer');
}
{
  // FIRST-MATCH-WINS, PROVEN ON A TABLE THAT ACTUALLY OVERLAPS. Deephaven's own state tables happen to
  // be mutually exclusive already (checked: dropping every `none` exclusion changes no verdict), so
  // they cannot prove the mechanism. This synthetic table overlaps on purpose: rules 0 and 1 both match
  // a 2-unit property and both prohibit, so an engine without the exclusion would fire BOTH.
  const overlapDoc = { ...JSON.parse(JSON.stringify(PPP_DOC)), dataVersion: 'synthetic-overlap' };
  overlapDoc.states = { ZZ: [
    { when: { unitsMax: 4 }, result: 'prohibited', note: 'earlier rule' },
    { when: { unitsMin: 1 }, result: 'prohibited', note: 'later rule' },
  ] };
  OVERLAP = compilePpp(overlapDoc);
  OVERLAP_INPUT = { state: 'ZZ', units: 2, borrowerType: 'LLC', lien: 'first', prepayRequested: true };
  ok(OVERLAP.pppResult(OVERLAP_INPUT).note === 'earlier rule', 'first-match-wins on an OVERLAPPING table: the EARLIER rule wins');
  ok(overlapDisqualifierCount(OVERLAP) === 1, 'an overlapping table fires EXACTLY ONE disqualifier — the `none` exclusion is what makes the compiled rules mutually exclusive');
}

// =================================================================================================
// 5. THE WHOLE PROGRAM
// =================================================================================================
console.log('\n5. the whole PROGRAM — the compiled descriptor vs the hand-written one, through program-engine');

let PROG_CASES = 0;
function sweepProgram(desc, sink, iters, seed, stopOnFirst) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let n = 0; let bad = 0;
  for (let i = 0; i < iters; i++) {
    const f = {
      loan_amount: pick(A_LOAN), fico: pick(A_FICO), dscr: pick(A_DSCR), ltv: pick(A_LTV),
      purpose: pick(A_PURPOSE), cashout_amount: pick(B_CASHOUT), units: pick([undefined, 1, 2, 4, 5]),
      interest_only: pick([undefined, true, false]), property_type: pick(C_PT),
      subordinate_amount: pick([undefined, 0, 50000]),
      state: pick(P_STATE), borrower_type: pick(P_BT), apr: pick(P_APR),
      rural_property: pick(P_RURAL), prepay_months: pick([undefined, 0, 12, 60, '36']),
    };
    for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
    const opts = { monthlyPitia: pick([undefined, 1500, 4200]) };
    const a = runProgram(oracleProgram.DESCRIPTOR, f, opts);
    const b = runProgram(desc, f, opts);
    const d = strictEq(a, b);
    n++;
    if (d.length) { bad++; if (sink && sink.length < 5) sink.push({ facts: JSON.stringify(f), diffs: d.slice(0, 3) }); if (stopOnFirst) return { n, bad }; }
  }
  return { n, bad };
}
{
  const compiledDesc = registry.programFor('Deephaven');
  const sink = [];
  const r = sweepProgram(compiledDesc, sink, 25000, 424242);
  PROG_CASES = r.n;
  ok(r.bad === 0, `the FULL program verdict (eligibility + PPP + overlay + informational + reconciliation) is identical over ${r.n.toLocaleString()} scenarios, ${r.bad} differences`);
  if (r.bad) for (const s of sink) console.log('       · ' + s.facts + ' → ' + s.diffs.join(' | '));
  ok(compiledDesc.dataVersions.eligibility === '2026-08-04' && compiledDesc.dataVersions.ppp === '2026-03',
    'the compiled descriptor carries the data versions it prices on');
}

// =================================================================================================
// 6. MUTATION PROOF — the harness must BITE
// =================================================================================================
console.log('\n6. mutation proof — perturb ONE thing at a time and the sweep must go RED');

function cloneCompiledElig() {
  const src = registry.compiledLayer('Deephaven', 'eligibility', '2026-08-04');
  const c = {
    ...src,
    rules: JSON.parse(JSON.stringify(src.rules)),
    catalog: JSON.parse(JSON.stringify(src.catalog)),
    derivedFacts: JSON.parse(JSON.stringify(src.derivedFacts)),
    unverifiable: JSON.parse(JSON.stringify(src.unverifiable)),
    grid: src.grid ? { ...src.grid } : null,
  };
  c.evaluate = buildEvaluator(c);
  return c;
}
function cloneCompiledPpp() {
  const src = registry.compiledLayer('Deephaven', 'ppp', '2026-03');
  const c = {
    ...src,
    rules: JSON.parse(JSON.stringify(src.rules)),
    catalog: JSON.parse(JSON.stringify(src.catalog)),
    derivedFacts: JSON.parse(JSON.stringify(src.derivedFacts)),
  };
  const built = buildPppEvaluators(c);
  c.pppResult = built.pppResult; c.pppDisqualifier = built.pppDisqualifier;
  return c;
}
const ruleByCode = (c, code) => {
  const r = c.rules.find((x) => x.code === code);
  if (!r) throw new Error(`mutation target rule not found: ${code}`);
  return r;
};
// Rewrite ONE leaf's value inside a compiled predicate tree. Used instead of hand-indexing into the
// tree: the numeric-guard injection nests every comparison leaf, so a hard-coded path would silently
// mutate nothing — and a mutation that mutates nothing would "prove" a green harness.
function setLeafValue(node, fact, op, value) {
  if (!node || typeof node !== 'object') return false;
  if (node.fact === fact && node.op === op) { node.value = value; return true; }
  for (const k of ['all', 'any', 'none']) if (Array.isArray(node[k])) { for (const c of node[k]) if (setLeafValue(c, fact, op, value)) return true; }
  if (node.not) return setLeafValue(node.not, fact, op, value);
  return false;
}

// A FIXED, deterministic probe CORPUS — one pass over ~8,000 diverse scenarios per layer, cheap enough
// to re-run once per mutation. It is not a weaker standard than the full sweep: every mutation below is
// asserted to turn it RED, so a corpus too thin to notice a change fails this suite rather than passing it.
const ELIG_PROBE = (() => {
  const rnd = mulberry32(31337);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const list = [];
  for (let i = 0; i < 8000; i++) {
    const f = {};
    const put = (k, v) => { if (v !== undefined) f[k] = v; };
    put('loan_amount', rnd() < 0.15 ? pick(JUNK) : pick(A_LOAN));
    put('fico', rnd() < 0.1 ? pick(JUNK) : pick(A_FICO));
    put('dscr', rnd() < 0.1 ? pick(JUNK) : pick(A_DSCR));
    put('ltv', rnd() < 0.1 ? pick(JUNK) : pick(A_LTV));
    put('purpose', pick(A_PURPOSE));
    put('cashout_amount', pick(B_CASHOUT));
    put('units', pick([undefined, 1, 2, 4, 5, 12]));
    put('subordinate_amount', pick([undefined, 0, 1, 100000]));
    put('interest_only', pick([undefined, true, false]));
    put('property_type', pick(C_PT));
    list.push(f);
  }
  return list;
})();
const PPP_PROBE = (() => {
  const rnd = mulberry32(13579);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const list = [];
  for (let i = 0; i < 8000; i++) {
    const input = {};
    const put = (k, v) => { if (v !== undefined) input[k] = v; };
    put('state', rnd() < 0.1 ? pick(JUNK) : pick(P_STATE));
    put('borrowerType', pick(P_BT));
    put('units', pick(P_UNITS));
    put('lien', pick(P_LIEN));
    put('loanAmount', pick(P_LOAN));
    put('apr', pick(P_APR));
    put('ruralProperty', pick(P_RURAL));
    put('prepayRequested', pick(P_PREPAY));
    list.push(input);
  }
  return list;
})();

function eligProbe(evaluate) {
  for (const f of ELIG_PROBE) if (!compareElig(f, evaluate, null)) return true;
  return false;
}
function pppProbe(res, dq) {
  for (const input of PPP_PROBE) if (!comparePpp(input, res, dq, null)) return true;
  return false;
}

// CONTROL — an unmutated clone must be GREEN, or a "red" below would prove nothing.
ok(!eligProbe(cloneCompiledElig().evaluate), 'CONTROL (before): an unmutated compiled clone is GREEN on the eligibility probe');
{
  const c = cloneCompiledPpp();
  ok(!pppProbe(c.pppResult, c.pppDisqualifier), 'CONTROL (before): an unmutated compiled clone is GREEN on the PPP probe');
}

const MUTATIONS = [];
MUTATIONS.push(['M1  a single grid cell cap moved 80% → 81% (the max-LTV bound)', () => {
  const c = cloneCompiledElig();
  ruleByCode(c, 'grid_cap:t1500000:f720:P_RT:ge1').value = 81000;
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M2  one decline REASON string reworded in the catalog', () => {
  const c = cloneCompiledElig();
  c.catalog.max_loan.declineReason = 'Maximum Loan Amount $2.5M';
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M3  one decline CITATION altered', () => {
  const c = cloneCompiledElig();
  c.catalog.row_home.citation = 'made up citation';
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M4  a whole rule REMOVED (the row-home ineligibility)', () => {
  const c = cloneCompiledElig();
  c.rules = c.rules.filter((r) => r.code !== 'row_home');
  c.evaluate = buildEvaluator(c);
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M5  two rules\' PRIORITIES swapped (the decline ORDER flips)', () => {
  const c = cloneCompiledElig();
  ruleByCode(c, 'io_max_ltv').priority = 95;
  ruleByCode(c, 'subordinate').priority = 80;
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M6  one envelope THRESHOLD moved ($125,000 small-loan → $124,000)', () => {
  const c = cloneCompiledElig();
  if (!setLeafValue(ruleByCode(c, 'small_loan_ltv').when, 'loan_amount', 'lt', 124000)) throw new Error('M6 mutated nothing');
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M7  a NUMERIC GUARD stripped (max-loan then fires on the STRING "5000000")', () => {
  const c = cloneCompiledElig();
  const r = ruleByCode(c, 'max_loan');
  const bare = r.when.all.find((n) => n.fact === 'loan_amount');
  if (!bare) throw new Error('M7 could not find the guarded leaf');
  r.when = bare; // drop the injected loan_amount__num guard
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M8  a grid N/A cell turned into a priced one', () => {
  const c = cloneCompiledElig();
  c.rules = c.rules.filter((r) => r.code !== 'grid_na:t1500000:f640:P_RT:lt1');
  c.evaluate = buildEvaluator(c);
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M9  the DERIVED row-home matcher loses a needle ("rowhouse")', () => {
  const c = cloneCompiledElig();
  c.derivedFacts.property_type_is_row_home.needles = ['rowhome'];
  c.evaluate = buildEvaluator(c);
  return eligProbe(c.evaluate);
}]);
MUTATIONS.push(['M10 a PPP state RESULT flipped (NJ individual: prohibited → standard)', () => {
  const c = cloneCompiledPpp();
  c.catalog['ppp_match:NJ:0'].result = 'standard';
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M11 a PPP THRESHOLD moved (MN $832,750 → $832,751)', () => {
  const c = cloneCompiledPpp();
  if (!setLeafValue(ruleByCode(c, 'ppp_match:MN:0').when, 'loanAmount', 'lte', 832751)) throw new Error('M11 mutated nothing');
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M12 FIRST-MATCH-WINS broken in BOTH of its encodings at once (AK\'s catch-all `standard` loses its `none` exclusion AND takes a lower match index than the `prohibited` rule)', () => {
  const c = cloneCompiledPpp();
  // The two encodings are mutually redundant by design (see layer-compile-ppp's header), so breaking
  // only one changes no verdict — a mutation that moved only the index, or only the exclusion, would
  // report a FALSE green. Both are broken here so the assertion is about the ordering itself.
  const first = ruleByCode(c, 'ppp_match:AK:0');
  const last = ruleByCode(c, 'ppp_match:AK:2');
  if (!Array.isArray(last.when.all) || !last.when.all.some((x) => x.none)) throw new Error('M12: AK:2 carries no exclusion to drop');
  last.when = { all: last.when.all.filter((x) => !x.none) };
  const tmp = first.value; first.value = last.value; last.value = tmp;
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M13 a PPP disqualifier BORROWER LABEL reworded', () => {
  const c = cloneCompiledPpp();
  c.catalog['ppp_dq:NJ:0:natural_person'].declineReason = 'Prepayment penalty prohibited in NJ for an individual — this loan must be No-PPP';
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M14 a PPP restricted TERMS string altered (MD)', () => {
  const c = cloneCompiledPpp();
  c.catalog['ppp_match:MD:0'].terms = '4-year term MAX';
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M15 the borrower-type CLASSIFIER loses a needle ("consumer")', () => {
  const c = cloneCompiledPpp();
  c.derivedFacts.borrower_type_class.cases[0].needles = ['individual', 'naturalperson', 'person'];
  const b = buildPppEvaluators(c);
  return pppProbe(b.pppResult, b.pppDisqualifier);
}]);
MUTATIONS.push(['M16 the `none` EXCLUSION dropped on an OVERLAPPING table (two prohibitions fire instead of one)', () => {
  const c = { ...OVERLAP, rules: JSON.parse(JSON.stringify(OVERLAP.rules)), catalog: JSON.parse(JSON.stringify(OVERLAP.catalog)), derivedFacts: JSON.parse(JSON.stringify(OVERLAP.derivedFacts)) };
  let dropped = 0;
  for (const r of c.rules) {
    if (!/^ppp_dq:ZZ:1:/.test(r.code)) continue;
    if (r.when && Array.isArray(r.when.all)) { const n = r.when.all.length; r.when = { all: r.when.all.filter((x) => !x.none) }; if (r.when.all.length !== n) dropped++; }
  }
  if (!dropped) throw new Error('M16 mutated nothing');
  const b = buildPppEvaluators(c);
  c.pppResult = b.pppResult;
  return overlapDisqualifierCount(c) !== 1;
}]);

// NOTE a throwing mutation is a FAILURE, never a pass: a mutation that crashed (a bad target, a path
// that no longer exists) has not proved the harness bites — it has only proved the mutation is broken.
for (const [label, run] of MUTATIONS) {
  let red = false; let err = null;
  try { red = run(); } catch (e) { err = e; }
  ok(!err && red, `${label} → the sweep goes RED${err ? ' — MUTATION ITSELF THREW: ' + err.message : ''}`);
}

// CONTROL — after every mutation, an unmutated clone is still GREEN (the mutations did not leak).
ok(!eligProbe(cloneCompiledElig().evaluate), 'CONTROL (after): an unmutated compiled clone is still GREEN on the eligibility probe');
{
  const c = cloneCompiledPpp();
  ok(!pppProbe(c.pppResult, c.pppDisqualifier), 'CONTROL (after): an unmutated compiled clone is still GREEN on the PPP probe');
}

// =================================================================================================
console.log(`\nsweep size — Layer 2: ${ELIG_CASES.toLocaleString()} · Layer 3: ${PPP_CASES.toLocaleString()} · whole program: ${PROG_CASES.toLocaleString()} · TOTAL ${(ELIG_CASES + PPP_CASES + PROG_CASES).toLocaleString()} scenarios compared`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
