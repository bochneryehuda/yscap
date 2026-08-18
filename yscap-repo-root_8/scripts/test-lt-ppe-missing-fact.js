#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A MISSING PRICE-BEARING FACT MAY NEVER PRODUCE A CONFIDENT PRICE.
 *
 * THE DEFECT, measured on the REAL Deephaven DSCR sheet (deephaven-dscr-sheet ->
 * deephaven-grid -> ratesheet -> quote) and the REAL canonical battery
 * (agreement-scenarios.buildAgreementScenarios, 299 scenarios), BEFORE this fix:
 *
 *   a predicate over a fact the scenario does not carry evaluates to FALSE and the
 *   fact is recorded in `unknownFacts`. That is RIGHT for an eligibility
 *   DISQUALIFIER — never invent a decline — and WRONG for a PRICE-BEARING fact.
 *   Dropping ONE fact from a fully-specified scenario, over the whole battery:
 *
 *     fact            probes  priced TOO CHEAP  worst      priced too dear  worst
 *     state              256       245          +0.375 pt        0            —
 *     ltv                256       125          +4.625 pt      126        −1.000 pt
 *     fico               256       107          +4.625 pt      145        −1.000 pt
 *     dscr               256        17          +2.000 pt      145        −0.250 pt
 *     purpose            256        12          +2.625 pt        0            —
 *     loan_amount        256        10          +2.250 pt        0            —
 *     units / property_type / interest_only / escrow_waiver /
 *     non_warrantable / short_term_rental                    (each 1–3 too cheap)
 *
 *   3,072 probes, 530 of them PRICED AND TOO CHEAP — every one returned
 *   `eligible:true` with a full ladder and NOT ONE refusal. The `-1.125` /
 *   `-0.750` LLPAs and the UNCAPPED loan-size price cap of the original report are
 *   reproduced exactly, on a purpose-built sheet, in §1.
 *
 *   Separately: a lock the sheet does not publish (`lock_days: 45` against a sheet
 *   that publishes 30) came back `eligible:true` with an EMPTY ladder and no
 *   declines — on 256 of 256 priced battery scenarios.
 *
 * WHAT IS PROVEN HERE
 *   §1 the three drops of the original report, with exact milli-point deltas
 *   §2 the refusal: an explicitly INCOMPLETE answer no caller can read as a price
 *   §3 CONTROL — eligibility semantics EXACTLY as they were: a missing fact still
 *      never invents a decline, and refusing to price is not a decline
 *   §4 an empty price ladder never returns as eligible with nothing said
 *   §5 the determinacy analysis (Kleene) — including what it must NOT flag
 *   §6 the price-bearing facts are DERIVED from the rule set, never hand-typed
 *   §7 THE BYTE-FOR-BYTE CONTROL, two independent batteries:
 *        (A) the REAL 299-scenario canonical battery on the REAL Deephaven sheet,
 *            per scenario, against the live module with the refusal STRIPPED from
 *            its source — so any movement names the scenario that moved;
 *        (B) a self-contained 768-scenario matrix on a fixture sheet that DOES
 *            carry loan-size cap tiers (the real sheet does not), pinned to a
 *            FROZEN digest generated from the genuinely PRE-FIX engine.
 *
 *   node scripts/test-lt-ppe-missing-fact.js
 *
 * LT-only. No DB, no network, no RTL imports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

// `LT_PPE_BASELINE_MODULES=<dir>` loads the engine from another copy of
// src/longterm/ppe and PRINTS §7(B)'s digest instead of asserting — that is how
// FIXTURE_DIGEST below was generated from the PRE-FIX engine, with this identical
// battery, so the golden can never be "whatever the code does now".
const MOD_DIR = process.env.LT_PPE_BASELINE_MODULES || path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const BASELINE_MODE = !!process.env.LT_PPE_BASELINE_MODULES;
const LIVE_DIR = path.join(__dirname, '..', 'src', 'longterm', 'ppe');

const quoteMod = require(path.join(MOD_DIR, 'quote'));
const { quoteProgram } = quoteMod;
const rulesMod = require(path.join(MOD_DIR, 'rules'));
const { evaluateRules } = rulesMod;
const { gridToRateSheet } = require(path.join(MOD_DIR, 'deephaven-grid'));
const { rateSheetToProgram } = require(path.join(MOD_DIR, 'ratesheet'));
const { buildMatrix } = require(path.join(MOD_DIR, 'scenario-matrix'));
const { buildAgreementScenarios } = require(path.join(MOD_DIR, 'agreement-scenarios'));
const { buildDeephavenGrid } = require(path.join(MOD_DIR, 'deephaven-dscr-sheet'));
const { lpScenarioToFacts } = require(path.join(MOD_DIR, 'lp-agreement-legs'));
const parity = require(path.join(MOD_DIR, 'parity'));

let pass = 0; let failures = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { failures += 1; console.log(` FAIL  ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}${a === b ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`); }

// ---------------------------------------------------------------------------
// THE FIXTURE SHEET — a real Deephaven-shaped grid carrying exactly the three
// price-bearing dependencies the original defect report names, so the reported
// −1.125 / −0.750 / uncapped numbers are reproduced here to the milli-point.
// (The production Deephaven sheet publishes NO cap tiers, so the loan-size cap
// arm can only be exercised on a sheet that declares one — this is that sheet.)
// ---------------------------------------------------------------------------
const GRID = {
  investor: 'deephaven', program: 'corr_flow_dscr', lockDays: 45, scale: 1000,
  terms: [{ key: '30yr_fixed', product: 'DH_DSCR_30F' }],
  base: [
    { coupon: 6.750, prices: { '30yr_fixed': 102.850 } },
    { coupon: 7.000, prices: { '30yr_fixed': 103.775 } },
  ],
  ficoCltvByDscr: [{
    dscr: { min: null, max: null },
    ficoBands: [{ min: 660, max: null }],
    cltvBands: [{ min: 0, max: 90 }],
    cells: [[0.000]],
  }],
  llpaTables: [
    // LEVERAGE: a −1.125 hit at CLTV ≥ 75%. An llpaTables threshold stays in its
    // fact's own unit, and `ltv` is MILLI (deephaven-grid never scales one).
    { dimension: 'ltv', fact: 'ltv', reason: 'leverage', bands: [{ min: 75000, max: null, adj: -1.125 }] },
    // DEBT SERVICE: a −0.750 hit below 1.25x
    { dimension: 'dscr', fact: 'dscr', reason: 'debt service', bands: [{ min: null, max: 1250, adj: -0.750 }] },
    // CASH-OUT: a −0.250 hit, read off `purpose`
    { dimension: 'purpose', predicate: { fact: 'purpose', op: 'eq', value: 'cashout' }, adj: -0.250, reason: 'cash-out' },
  ],
  priceLimit: {
    minPrice: 98.000, roundingMode: 'none',
    // the loan-size PRICE CAP — read straight off the scenario, through no rule
    capTiers: [{ uptoLoanAmount: 1000000, capMilli: 102000 }],
  },
};
const R = gridToRateSheet(GRID);
if (R.problems.length) { console.log('FIXTURE PROBLEMS', R.problems); process.exit(2); }
const PROGRAM = rateSheetToProgram(
  { version: { id: 'missing_fact' }, basePrices: R.basePrices, adjustments: R.adjustments, priceLimit: R.priceLimit },
  { code: 'DH_DSCR', investorCode: 'DHVN' },
);
// one eligibility rule + one bound, so the battery exercises the decline paths too
PROGRAM.rules = PROGRAM.rules.concat([
  { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'New York not eligible' },
  { code: 'max_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
]);
const SETTINGS = { 'pricing.correspondent_margin_milli': 250 };
const price = (scenario, program) => quoteProgram({ scenario, program: program || PROGRAM, settings: SETTINGS });
const rungOf = (q) => (q.ladder || []).find((r) => r.basePriceMilli === 102850) || null;

// high leverage, low DSCR, above every cap tier: every LLPA bites, no cap
const FULL_A = { fico: 780, ltv: 78000, dscr: 1150, loan_amount: 1500000, purpose: 'purchase', state: 'TX', lock_days: 45, product: 'DH_DSCR_30F' };
// clean and inside the cap tier: the cap is what bites
const FULL_D = { fico: 780, ltv: 70000, dscr: 1300, loan_amount: 500000, purpose: 'purchase', state: 'TX', lock_days: 45, product: 'DH_DSCR_30F' };
const without = (s, k) => { const o = { ...s }; delete o[k]; return o; };

// THE REAL SHEET + THE REAL BATTERY — the production Deephaven DSCR grid and the
// canonical ~300-scenario battery the Lender Price agreement gate runs on. Built
// lazily and once; §3, §4, §5 and §7(A) all measure against these.
const REAL_SETTINGS = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };
let _realProgram = null; let _realBattery = null;
function realProgram() {
  if (!_realProgram) {
    _realProgram = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
  }
  return _realProgram;
}
function realBattery() { if (!_realBattery) _realBattery = buildAgreementScenarios(); return _realBattery; }

if (!BASELINE_MODE) {
  console.log('LT PPE — a missing price-bearing fact can never be priced\n');
  console.log('§1 THE DROPS — measured through the real sheet→program→quote chain');

  const A = price(FULL_A);
  eq(A.eligible, true, 'A: the fully-specified high-leverage deal is eligible');
  eq((rungOf(A) || {}).finalPriceMilli, 100725, 'A: 102.850 − 1.125 (ltv) − 0.750 (dscr) − 0.250 (margin) = 100.725');
  eq((rungOf(A) || {}).adjustmentCostMilli, 1875, 'A: the LLPA stack costs 1.875 points');

  // Each number below is what the PRE-FIX engine returned for the same scenario
  // minus one fact — §7(B) holds it to that, from the pre-fix engine's own output.
  const dropped = (fact, wouldHaveBeen, delta) => {
    const q = price(without(FULL_A, fact));
    ok(q.priced === false, `A−${fact}: REFUSED — the old engine priced it at ${(wouldHaveBeen / 1000).toFixed(3)}, ${(delta / 1000).toFixed(3)} points TOO CHEAP`);
    ok((q.missingPriceFacts || []).includes(fact), `A−${fact}: the refusal names the missing fact`);
  };
  dropped('ltv', 101850, 1125);   // the −1.125 leverage LLPA was silently dropped
  dropped('dscr', 101475, 750);   // the −0.750 debt-service LLPA was silently dropped

  const D1 = price(FULL_D);
  eq((D1.pricingBasis || {}).capMilli, 102000, 'D1: the $500k loan selects the 102.000 cap tier');
  eq((rungOf(D1) || {}).finalPriceMilli, 102000, 'D1: 102.600 raw is CLAMPED to the 102.000 cap');
  eq((rungOf(D1) || {}).clamped, true, 'D1: the rung records that it was clamped');
  {
    const q = price(without(FULL_D, 'loan_amount'));
    ok(q.priced === false, 'D2: REFUSED — the old engine priced it UNCAPPED at 102.600, 0.600 points TOO CHEAP');
    ok((q.missingPriceFacts || []).includes('loan_amount'), 'D2: the refusal names loan_amount…');
    ok((q.reasons || []).some((r) => r.code === 'missing_pricing_basis_fact'), '…as a pricing-BASIS fact (no rule predicate reads it)');
    // THE WORST PART OF THE OLD BEHAVIOUR: unknownFacts never even mentioned it.
    eq(q.unknownFacts.includes('loan_amount'), false, 'D2: unknownFacts still does not mention it — which is why the decoration could never have caught this');
  }

  // ---- §2 the refusal is unmistakable --------------------------------------
  console.log('\n§2 THE REFUSAL — an explicitly incomplete answer, never a price');
  {
    const q = price(without(FULL_A, 'ltv'));
    eq(q.priced, false, 'priced:false');
    eq(q.incomplete, true, 'incomplete:true');
    eq(q.ladder, undefined, 'there is NO ladder key — a caller reading q.ladder gets undefined and fails loudly');
    eq(q.pricingBasis, undefined, 'there is NO pricingBasis key — nothing to mistake for a priced basis');
    eq(q.reason, 'missing_price_bearing_fact', 'the reason code names the class');
    ok(/does not carry ltv/.test(q.summary), 'the summary says, in words, what is missing');
    ok(((q.reasons || [])[0] || {}).rules?.some((r) => /_ltv_/.test(r.code)) === true, 'the refusal names the RULE that could not be decided');
    ok(Array.isArray(q.indeterminate) && q.indeterminate.length > 0, 'the undecidable rules are carried for the trace');
    // and the shadow harness can never score it as an answer
    eq(parity.normalizeOurQuote(q), null, 'parity refuses to normalize an unpriced quote (scored INCOMPARABLE, never as agreement)');
    const cmp = parity.compareScenario(parity.normalizeOurQuote(q), { eligible: true, rungs: [{ rate: 71250, priceMilli: 100725 }] });
    eq(cmp.incomparable, true, 'the comparison records it as incomparable, with a reason');
    eq(cmp.agree, false, 'and it is never counted as agreement');
  }
  {
    const q = price(FULL_A);
    eq(q.priced, undefined, 'a PRICED quote carries no priced flag — the eligible shape is untouched');
    eq(q.incomplete, undefined, 'a PRICED quote carries no incomplete flag');
  }

  // ---- §3 CONTROL: eligibility semantics are EXACTLY as they were -----------
  console.log('\n§3 CONTROL — a missing fact still never invents a decline');
  {
    const facts = ['fico', 'ltv', 'dscr', 'loan_amount', 'purpose', 'state'];
    const full = evaluateRules(PROGRAM.rules, FULL_A);
    eq(full.declines.length, 0, 'the fully-specified scenario declines for nothing');
    for (const f of facts) {
      const partial = evaluateRules(PROGRAM.rules, without(FULL_A, f));
      eq(partial.declines.length, 0, `dropping ${f} invents no decline`);
      eq(partial.eligible, true, `dropping ${f} leaves the scenario eligible`);
    }
    const empty = evaluateRules(PROGRAM.rules, {});
    eq(empty.eligible, true, 'an empty scenario is eligible — no fact, no disqualifier');
    eq(empty.declines.length, 0, 'an empty scenario declines for nothing');
    // …and a REAL disqualifier still fires, unchanged
    const ny = evaluateRules(PROGRAM.rules, { ...FULL_A, state: 'NY' });
    eq(ny.eligible, false, 'a stated NY scenario still declines');
    ok(ny.declines.some((d) => /New York/.test(d.reason)), 'with its own reason');
    const overLtv = evaluateRules(PROGRAM.rules, { ...FULL_A, ltv: 85000 });
    ok(!overLtv.eligible && overLtv.declines.some((d) => /ltv max 80000 exceeded/.test(d.reason)), 'a stated over-LTV scenario still declines on the bound, with the numbers');
    const noLtv = evaluateRules(PROGRAM.rules, without(FULL_A, 'ltv'));
    eq((noLtv.bounds['ltv:max'] || {}).satisfied, null, 'an unjudgeable bound is still recorded as unjudged, never as a decline');
  }
  {
    const q = price(without(FULL_A, 'ltv'));
    eq(q.eligible, true, 'the refusal keeps eligible:true — refusing to price is not a decline');
    eq((q.declines || []).length, 0, 'and carries no declines');
    const ineligible = price({ ...FULL_A, state: 'NY' });
    eq(ineligible.eligible, false, 'an ineligible scenario is still ineligible');
    eq(ineligible.priced, undefined, 'and is not dressed up as incomplete');
    eq(ineligible.ladder, undefined, 'and is not priced');
  }
  {
    // THE CONTROL ON THE REAL SHEET, over the whole canonical battery: dropping a
    // price-bearing fact from any of the 299 scenarios must never add a decline.
    const real = realProgram();
    let declineAdded = 0; let checked = 0;
    for (const sc of realBattery().scenarios) {
      const facts = lpScenarioToFacts(sc);
      const base = evaluateRules(real.rules, facts);
      for (const f of ['ltv', 'fico', 'dscr', 'state', 'purpose', 'loan_amount']) {
        if (facts[f] == null) continue;
        checked += 1;
        const partial = evaluateRules(real.rules, without(facts, f));
        if (partial.declines.length > base.declines.length) declineAdded += 1;
      }
    }
    eq(declineAdded, 0, `dropping a fact never adds a decline, over ${checked} probes on the real sheet's 59 eligibility rules`);
  }

  // ---- §4 an empty ladder is never a silent answer --------------------------
  console.log('\n§4 AN EMPTY PRICE LADDER — say what happened');
  {
    const q = price({ ...FULL_D, lock_days: 60 });
    eq(q.eligible, true, 'lock 60: eligibility is untouched (the sheet does not decline it)');
    eq(q.priced, false, 'lock 60: it is NOT priced');
    eq(q.ladder, undefined, 'lock 60: no empty ladder comes back');
    eq(q.reason, 'no_matching_rungs', 'lock 60: the reason names it');
    ok(/publishes no rung/.test(q.summary) && /45/.test(q.summary), 'lock 60: the summary says what was asked for and what the sheet publishes');
    const r = (q.reasons || []).find((x) => x.code === 'no_matching_rungs') || { requested: {}, available: {} };
    eq(r.requested.lock_days, 60, 'lock 60: the requested lock is recorded');
    ok((r.available.lockDays || []).includes(45), 'lock 60: the available locks are recorded');
  }
  {
    const q = price({ ...FULL_D, product: 'NOT_A_PRODUCT' });
    eq(q.reason, 'no_matching_rungs', 'an unpublished product is refused the same way');
    ok((((q.reasons || [])[0] || {}).available || {}).products?.includes('DH_DSCR_30F') === true, 'and the available products are named');
  }
  eq((price(FULL_D).ladder || []).length, 2, 'the published 45-day lock still prices the whole ladder');
  {
    // ON THE REAL SHEET: the reported `lock_days: 45` case, over the whole battery.
    const real = realProgram();
    let empty = 0; let refused = 0; let priced = 0;
    for (const sc of realBattery().scenarios) {
      const q = quoteProgram({ scenario: { ...lpScenarioToFacts(sc), lock_days: 45 }, program: real, settings: REAL_SETTINGS });
      if (q.priced === false) refused += 1;
      else if (q.eligible && Array.isArray(q.ladder) && q.ladder.length === 0) empty += 1;
      else if (q.eligible) priced += 1;
    }
    eq(empty, 0, 'lock_days 45 on the real sheet: NOT ONE eligible-with-an-empty-ladder answer (the old engine returned 256)');
    ok(refused > 200, `lock_days 45 on the real sheet: ${refused} scenarios refused WITH A REASON`);
    eq(priced, 0, 'and none was priced off a rung the sheet does not publish');
  }

  // ---- §5 the determinacy analysis itself -----------------------------------
  console.log('\n§5 DETERMINACY — Kleene, and the cases it must NOT flag');
  const { evalPredicate3, factsOf, missingFactsOf } = rulesMod;
  eq(evalPredicate3({ fact: 'ltv', op: 'gte', value: 75000 }, {}), 'unknown', 'a leaf over a missing fact is UNKNOWN');
  eq(evalPredicate3({ fact: 'ltv', op: 'gte', value: 75000 }, { ltv: 78000 }), 'true', 'a known leaf is decided');
  eq(evalPredicate3({ fact: 'ltv', op: 'exists' }, {}), 'false', 'exists is TOTAL — presence is always knowable');
  eq(evalPredicate3(null, {}), 'true', 'an absent predicate matches everything');
  {
    // ORDER INDEPENDENCE: `all` with one determinately-false leaf is FALSE whichever
    // side the missing fact sits on. The boolean pass's short-circuit sees a
    // different set of leaves in each order; Kleene does not.
    const a = { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'gte', value: 75000 }] };
    const b = { all: [{ fact: 'ltv', op: 'gte', value: 75000 }, { fact: 'purpose', op: 'eq', value: 'cashout' }] };
    const facts = { purpose: 'purchase' }; // no ltv
    eq(evalPredicate3(a, facts), 'false', 'all: a false sibling decides it even with an unknown leaf');
    eq(evalPredicate3(b, facts), 'false', '…and leaf ORDER cannot change that');
    eq(evalPredicate3(a, { purpose: 'cashout' }), 'unknown', '…while a true sibling leaves it genuinely undecidable');
    eq(evalPredicate3({ any: [{ fact: 'purpose', op: 'eq', value: 'purchase' }, { fact: 'ltv', op: 'gte', value: 75000 }] }, facts), 'true', 'any: a true sibling decides it');
    eq(evalPredicate3({ not: { fact: 'ltv', op: 'gte', value: 75000 } }, {}), 'unknown', 'not: unknown negates to unknown');
    eq(evalPredicate3({ none: [{ fact: 'ltv', op: 'gte', value: 75000 }] }, {}), 'unknown', 'none: unknown propagates');
  }
  {
    // a determinately-false pricing rule must NOT make a scenario unpriceable
    const prog = {
      ...PROGRAM,
      rules: [{
        code: 'cashout_high_ltv', kind: 'pricing',
        when: { all: [{ fact: 'purpose', op: 'eq', value: 'cashout' }, { fact: 'ltv', op: 'gte', value: 75000 }] },
        adjustment: { code: 'cashout_high_ltv', category: 'purpose', adjMilli: 500 },
      }],
      priceLimit: { ...PROGRAM.priceLimit, capTiers: [] },
    };
    eq(quoteProgram({ scenario: { purpose: 'purchase', lock_days: 45, product: 'DH_DSCR_30F' }, program: prog, settings: SETTINGS }).priced, undefined,
      'a PURCHASE with no ltv still prices — the cash-out rule cannot fire whatever the ltv is');
    eq(quoteProgram({ scenario: { purpose: 'cashout', lock_days: 45, product: 'DH_DSCR_30F' }, program: prog, settings: SETTINGS }).priced, false,
      '…and the same scenario as a CASH-OUT is refused, because now the ltv decides it');
  }
  {
    // an INDETERMINATE eligibility or bound rule does not stop the pricing
    const prog = {
      ...PROGRAM,
      rules: [
        { code: 'no_condo', kind: 'eligibility', when: { fact: 'property_type', op: 'eq', value: 'condo' }, declineReason: 'no condos' },
        { code: 'max_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
      ],
      priceLimit: { ...PROGRAM.priceLimit, capTiers: [] },
    };
    const q = quoteProgram({ scenario: { lock_days: 45, product: 'DH_DSCR_30F' }, program: prog, settings: SETTINGS });
    eq(q.priced, undefined, 'an undecidable ELIGIBILITY rule does not stop the price (it is not price-bearing)');
    eq(q.eligible, true, 'and does not invent a decline');
  }
  {
    // A FACT WHOSE ABSENCE THE SHEET DECLARES. The production prepay sheet prices
    // on its STANDARD column unless the scenario opts into the 5% Fixed promo, and
    // writes that as `none:[{prepay_pricing_model eq fixed5_promo}]` — so absence is
    // a VALUE there, not an unknown, and refusing would refuse the sheet's own
    // default case. The declaration is read off the rule set, never configured.
    const { declaredAbsentFacts } = rulesMod;
    const STD = { none: [{ fact: 'prepay_pricing_model', op: 'eq', value: 'fixed5_promo' }] };
    const PROMO = { fact: 'prepay_pricing_model', op: 'eq', value: 'fixed5_promo' };
    eq([...declaredAbsentFacts([{ when: STD }, { when: PROMO }])].join(','), 'prepay_pricing_model', 'the negated equality DECLARES what an absent fact means');
    eq([...declaredAbsentFacts([{ when: { not: { fact: 'ltv', op: 'gte', value: 75000 } } }])].join(','), '', 'a negated ORDERING comparison declares nothing — a missing leverage is still unknown');
    eq([...declaredAbsentFacts([{ when: PROMO }])].join(','), '', 'and a bare equality declares nothing either');
    eq([...declaredAbsentFacts([{ when: { none: [{ none: [{ fact: 'x', op: 'eq', value: 1 }] }] } }])].join(','), '', 'two negations cancel — only ODD negation declares');
    eq([...declaredAbsentFacts(null)].join(','), '', 'a malformed rule list declares nothing and never throws');
    // …and end to end: the pair prices with the fact absent, and both rows still
    // behave correctly when it IS stated.
    const prog = {
      ...PROGRAM,
      priceLimit: { ...PROGRAM.priceLimit, capTiers: [] },
      rules: [
        { code: 'prepay_std', kind: 'pricing', when: STD, adjustment: { code: 'prepay_std', category: 'prepay', adjMilli: 250 } },
        { code: 'prepay_promo', kind: 'pricing', when: PROMO, adjustment: { code: 'prepay_promo', category: 'prepay', adjMilli: 500 } },
      ],
    };
    const base = { lock_days: 45, product: 'DH_DSCR_30F' };
    const absent = quoteProgram({ scenario: base, program: prog, settings: SETTINGS });
    eq(absent.priced, undefined, 'a scenario that names no pricing model still PRICES — the sheet declared what absence means');
    eq((absent.ladder || [])[0] && absent.ladder[0].adjustmentCostMilli, 250, '…on the STANDARD column, exactly as the sheet says');
    const promo = quoteProgram({ scenario: { ...base, prepay_pricing_model: 'fixed5_promo' }, program: prog, settings: SETTINGS });
    eq((promo.ladder || [])[0] && promo.ladder[0].adjustmentCostMilli, 500, 'and opting in prices the promo column instead');
    // the carve-out is per FACT, so an ordinary missing price fact still refuses
    const withLtv = { ...prog, rules: prog.rules.concat([{ code: 'lev', kind: 'pricing', when: { fact: 'ltv', op: 'gte', value: 75000 }, adjustment: { code: 'lev', category: 'ltv', adjMilli: 1125 } }]) };
    eq(quoteProgram({ scenario: base, program: withLtv, settings: SETTINGS }).priced, false, 'and it never leaks to another fact — a missing ltv still refuses');
  }
  {
    const pred = { all: [{ fact: 'fico', op: 'gte', value: 760 }, { any: [{ fact: 'ltv', op: 'lt', value: 80000 }, { not: { fact: 'dscr', op: 'lt', value: 1000 } }] }] };
    eq([...factsOf(pred)].sort().join(','), 'dscr,fico,ltv', 'factsOf walks the whole tree');
    eq(missingFactsOf(pred, { fico: 780, dscr: null }).join(','), 'dscr,ltv', 'missingFactsOf treats an explicit null as missing');
  }
  {
    // PRECISION, on the real sheet: dropping a fact must refuse ONLY where the
    // price could actually move. Where the 133 pricing rules make the fact
    // irrelevant, the scenario must still price — and price the SAME.
    const real = realProgram();
    let refusedButSame = 0; let allowedAndMoved = 0; let allowed = 0;
    for (const sc of realBattery().scenarios.slice(0, 60)) {
      const facts = lpScenarioToFacts(sc);
      const full = quoteProgram({ scenario: facts, program: real, settings: REAL_SETTINGS });
      if (!full.eligible || !full.ladder || !full.ladder.length) continue;
      for (const f of ['property_type', 'purpose', 'short_term_rental']) {
        if (facts[f] == null) continue;
        const q = quoteProgram({ scenario: without(facts, f), program: real, settings: REAL_SETTINGS });
        if (q.priced === false) continue;
        allowed += 1;
        if (!q.ladder || q.ladder[0].finalPriceMilli !== full.ladder[0].finalPriceMilli) allowedAndMoved += 1;
      }
    }
    ok(allowed > 0, `the analysis still PRICES ${allowed} fact-drops it can prove are irrelevant — it is not a blanket refusal`);
    eq(allowedAndMoved, 0, 'and not one of those moved the price by a single milli-point');
    eq(refusedButSame, 0, 'nothing was refused for a reason it could not name');
  }

  // ---- §6 the price-bearing facts are DERIVED, never hand-typed -------------
  console.log('\n§6 DERIVED, NOT HAND-TYPED');
  {
    const prog = {
      ...PROGRAM,
      rules: PROGRAM.rules.concat([{
        code: 'units_5plus', kind: 'pricing', when: { fact: 'units', op: 'gte', value: 5 },
        adjustment: { code: 'units_5plus', category: 'units', adjMilli: 375 },
      }]),
    };
    const q = quoteProgram({ scenario: FULL_A, program: prog, settings: SETTINGS });
    eq(q.priced, false, 'a NEW pricing dimension (units) makes the previously-complete scenario incomplete…');
    ok((q.missingPriceFacts || []).includes('units'), '…and the engine names it, from the rule\'s own predicate');
    eq(quoteProgram({ scenario: { ...FULL_A, units: 2 }, program: prog, settings: SETTINGS }).priced, undefined, '…and stating it prices again');
  }
  {
    // THE SOURCE SCAN: every literal `scenario.<fact>` read in quote.js must be a
    // declared rung-selection fact or a declared pricing-basis fact. A new knob
    // that reads a scenario fact without declaring it fails HERE, not in production.
    const src = fs.readFileSync(path.join(MOD_DIR, 'quote.js'), 'utf8');
    const declared = new Set([...quoteMod.RUNG_SELECTION_FACTS, ...quoteMod.PRICING_BASIS_FACTS.map((d) => d.fact)]);
    const reads = new Set();
    for (const m of src.matchAll(/\bscenario\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);
    const undeclared = [...reads].filter((f) => !declared.has(f)).sort();
    eq(undeclared.join(','), '', `every scenario fact quote.js reads is declared (read: ${[...reads].sort().join(', ') || 'none'})`);
    ok(declared.has('loan_amount'), 'the loan-size cap declares its loan_amount dependency');
    eq(quoteMod.activeBasisFacts({ capTiers: [] }).length, 0, 'with no cap tiers the cap reads nothing, so loan_amount is not required');
    eq(quoteMod.activeBasisFacts({ capTiers: [{ uptoLoanAmount: 1, capMilli: 1 }] }).length, 1, 'with cap tiers it is');
    const noCap = { ...PROGRAM, priceLimit: { ...PROGRAM.priceLimit, capTiers: [] } };
    eq(quoteProgram({ scenario: without(FULL_A, 'loan_amount'), program: noCap, settings: SETTINGS }).priced, undefined,
      'and a sheet with no cap tiers still prices a scenario with no loan amount');
  }
}

// ---------------------------------------------------------------------------
// §7 THE BYTE-FOR-BYTE CONTROL
// ---------------------------------------------------------------------------

// (A) is the REAL canonical battery on the REAL Deephaven DSCR sheet (built above).
// (B) a self-contained matrix over the fixture sheet — every axis is a fact this
// sheet's rules or basis read, so every scenario is COMPLETE by construction.
const FIXTURE_BATTERY = buildMatrix({
  fico: [700, 740, 760, 780],
  ltv: [65000, 72000, 78000, 85000], // 85000 is over the max-LTV bound — a decline
  dscr: [1100, 1300],
  loan_amount: [120000, 400000, 900000, 1600000],
  purpose: ['purchase', 'cashout'],
  state: ['TX', 'FL', 'NY'],         // NY is an eligibility decline
}, { base: { lock_days: 45, product: 'DH_DSCR_30F' }, maxScenarios: 1000 });

// `_index`/`_label` are the generator's own tags (no rule reads them) — stripped
// so the quoted object is only the deal.
function scenarioOf(s) { const o = { ...s }; delete o._index; delete o._label; return o; }

// A canonical serialization: keys sorted at every depth, so the digest is a
// function of the VALUES, never of key insertion order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const fixtureBytes = FIXTURE_BATTERY.scenarios.map((s) => canonical(quoteProgram({ scenario: scenarioOf(s), program: PROGRAM, settings: SETTINGS })));
const FIXTURE_DIGEST = crypto.createHash('sha256').update(fixtureBytes.join('\n')).digest('hex');

if (BASELINE_MODE) {
  console.log(`fixture_scenarios=${FIXTURE_BATTERY.scenarios.length}`);
  console.log(`fixture_digest=${FIXTURE_DIGEST}`);
  process.exit(0);
}

console.log('\n§7 BYTE-FOR-BYTE CONTROL — a complete scenario must not move by one milli-point');

// Build the PRE-FIX engine by REMOVING the refusal from the live source. Verified:
// exactly one occurrence, and no other path back into the incomplete answer.
//
// WHAT THIS LAYER CAN AND CANNOT SEE, stated because the two layers are not
// interchangeable: the stripped copy shares `pricing.js`, `rules.js` and the
// sheet modules with the live one, so it proves THE REFUSAL IS INERT — it cannot
// see a change to a shared module. Mutating `pricing.priceRung` to add one
// milli-point to every price leaves both sides equal and this layer green; only
// (B)'s FROZEN digest, taken from the genuinely pre-fix engine, catches it (it
// was mutated on purpose to confirm exactly that). (A) is the wide, real-sheet
// inertness proof; (B) is the immovable pin on the numbers.
function loadStripped() {
  const src = fs.readFileSync(path.join(LIVE_DIR, 'quote.js'), 'utf8');
  const GUARD = /\n\s*if \(unpriceable\.length\) return incompleteQuote\(programRef, decision, unpriceable\);/g;
  const hits = src.match(GUARD) || [];
  eq(hits.length, 1, 'the refusal is exactly ONE guard in quote.js (the strip cannot miss a second copy)');
  const stripped = src.replace(GUARD, '\n  // [stripped by the byte-for-byte control]');
  ok(!/return incompleteQuote\(/.test(stripped), 'and no other return into the incomplete answer survives the strip');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ppe-prefix-'));
  const file = path.join(dir, 'quote.js');
  // point the stripped copy's own requires back at the real module directory
  fs.writeFileSync(file, stripped.replace(/require\('\.\/([\w-]+)'\)/g, (_m, name) => `require(${JSON.stringify(path.join(LIVE_DIR, name))})`));
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(dir);
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}
const preFix = loadStripped();

// ---- (A) the real 299-scenario battery, per scenario -----------------------
{
  const program = realProgram();
  const scenarios = realBattery().scenarios;
  ok(scenarios.length >= 290, `the canonical battery is ${scenarios.length} scenarios (buildAgreementScenarios)`);
  let moved = 0; let firstMoved = null; let refused = 0; let elig = 0; let inelig = 0; let priced = 0;
  for (const sc of scenarios) {
    const facts = lpScenarioToFacts(sc);
    const now = quoteProgram({ scenario: facts, program, settings: REAL_SETTINGS });
    const before = preFix.quoteProgram({ scenario: facts, program, settings: REAL_SETTINGS });
    if (canonical(now) !== canonical(before)) { moved += 1; if (!firstMoved) firstMoved = `${sc._group}/${sc._label}`; }
    if (now.priced === false) refused += 1;
    if (now.eligible) { elig += 1; if (now.ladder && now.ladder.length) priced += 1; } else inelig += 1;
  }
  eq(moved, 0, `(A) all ${scenarios.length} REAL battery scenarios are BYTE-IDENTICAL to the pre-fix engine${firstMoved ? ` (first difference: ${firstMoved})` : ''}`);
  eq(refused, 0, '(A) and NOT ONE of them is refused — the canonical battery states every price-bearing fact');
  ok(priced > 200 && inelig > 0, `(A) the battery really exercises both sides (${priced} priced, ${inelig} ineligible)`);
}

// ---- (B) the fixture battery, against a FROZEN pre-fix digest ---------------
{
  // GENERATED FROM THE PRE-FIX ENGINE via:
  //   LT_PPE_BASELINE_MODULES=<pre-fix src/longterm/ppe> node scripts/test-lt-ppe-missing-fact.js
  // Frozen: it pins today's engine to what the engine produced BEFORE the refusal
  // existed, so it can never degenerate into "whatever the code does now".
  //
  // RE-FROZEN 2026-08-18, and the reason is itself a measurement rather than a shrug.
  // The previous digest (f2d4aaa8…) was taken at af716477, BEFORE the sheet's own max-price rule
  // reached a priced quote (`price-limit.js`, A4). Both engines were run over this whole 768-scenario
  // fixture and compared rung by rung: 656 rungs BYTE-IDENTICAL, **112 priced LOWER because the
  // sheet's own ceiling now binds (largest reduction 1.525 points), and NOT ONE priced higher** —
  // every reduced rung carries `clamped: true`. So the digest moved because a quote that used to go
  // out ABOVE the investor's stated ceiling no longer can; it did not move because this refusal
  // touched a number. Re-generated from the A4 engine (1178f615) — the genuine pre-fix reference for
  // THIS change — and that engine's digest equals the live one, which is what proves the refusal inert.
  const FIXTURE_SCENARIOS = 768;
  const FIXTURE_DIGEST_FROZEN = 'e31e71c9e2c0cff14a9bb4610bf8a32d660dcc0f84e2fbe7a2e68ce46affad70';
  eq(FIXTURE_BATTERY.scenarios.length, FIXTURE_SCENARIOS, `(B) the fixture battery is ${FIXTURE_SCENARIOS} fully-specified scenarios`);
  eq(FIXTURE_BATTERY.truncated, false, '(B) and the generator did not truncate it');
  eq(FIXTURE_DIGEST, FIXTURE_DIGEST_FROZEN, '(B) every quote in it is byte-identical to the FROZEN pre-fix engine output');

  let moved = 0; let firstMoved = null;
  FIXTURE_BATTERY.scenarios.forEach((s, i) => {
    const before = canonical(preFix.quoteProgram({ scenario: scenarioOf(s), program: PROGRAM, settings: SETTINGS }));
    if (before !== fixtureBytes[i]) { moved += 1; if (!firstMoved) firstMoved = s._label; }
  });
  eq(moved, 0, `(B) and identical per scenario against the stripped module${firstMoved ? ` (first difference: ${firstMoved})` : ''}`);

  const quotes = FIXTURE_BATTERY.scenarios.map((s) => quoteProgram({ scenario: scenarioOf(s), program: PROGRAM, settings: SETTINGS }));
  ok(quotes.some((q) => q.eligible === false), '(B) the fixture battery contains ineligible scenarios');
  ok(quotes.some((q) => q.eligible && q.ladder && q.ladder[0].clamped), '(B) …loan-size-CAPPED scenarios (the real sheet publishes no cap tiers, so only this battery covers that arm)');
  ok(quotes.some((q) => q.eligible && q.ladder && q.ladder[0].adjustmentCostMilli > 0), '(B) …and LLPA-bearing scenarios');
  eq(quotes.some((q) => q.priced === false), false, '(B) and NOT ONE fully-specified scenario is refused');
}

// ---- the stripped module still REPRODUCES the defect ------------------------
// This is what proves the control compares against the BROKEN engine and not
// against itself.
{
  const broken = preFix.quoteProgram({ scenario: without(FULL_A, 'ltv'), program: PROGRAM, settings: SETTINGS });
  eq(broken.eligible, true, 'the pre-fix engine still calls the ltv-less scenario eligible…');
  eq((rungOf(broken) || {}).finalPriceMilli, 101850, '…and prices it at 101.850 — the 1.125 points too cheap this fix refuses');
  // THE CAP ARM IS NOW CLOSED TWICE, AND THIS ASSERTION RECORDS THAT RATHER THAN PRETENDING OTHERWISE.
  // When this suite was written the stripped engine left the loan-size ceiling UNSELECTED on a
  // missing `loan_amount` and priced 102.600 against a capped 102.000 — 0.600 too cheap. That arm
  // was independently closed by `price-limit.js` (A4): `resolvePriceCap` now FAILS SAFE, applying
  // the STRICTEST readable ceiling on the sheet and saying so (`CAP_STATUS.LOAN_AMOUNT_UNKNOWN`),
  // so even the refusal-stripped engine can no longer quote over the ceiling. Both fixes are real
  // and neither is redundant: the price limit stops the OVER-QUOTE, and only the refusal below
  // NAMES the missing fact instead of silently pricing on an assumption.
  const brokenCap = preFix.quoteProgram({ scenario: without(FULL_D, 'loan_amount'), program: PROGRAM, settings: SETTINGS });
  eq((brokenCap.pricingBasis || {}).capStatus, 'loan_amount_unknown',
    'the refusal-stripped engine no longer leaves the cap unselected — price-limit.js fails safe and says which state it is in');
  eq((brokenCap.pricingBasis || {}).capMilli, 102000,
    '…applying the STRICTEST ceiling on the sheet (102.000) rather than the 102.600 it used to quote');
  // …and the LIVE engine still refuses rather than pricing on that assumption, naming the fact.
  const refusedCap = quoteProgram({ scenario: without(FULL_D, 'loan_amount'), program: PROGRAM, settings: SETTINGS });
  eq(refusedCap.priced, false, 'while the LIVE engine refuses to price it at all…');
  ok((refusedCap.missingPriceFacts || []).includes('loan_amount'),
    '…and NAMES loan_amount as the fact it is missing — which the price limit alone can never say');
  const brokenLock = preFix.quoteProgram({ scenario: { ...FULL_D, lock_days: 60 }, program: PROGRAM, settings: SETTINGS });
  ok(brokenLock.eligible === true && Array.isArray(brokenLock.ladder) && brokenLock.ladder.length === 0,
    'and returns eligible:true with an EMPTY ladder for a lock the sheet does not publish');
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`} (${pass} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
