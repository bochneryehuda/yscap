#!/usr/bin/env node
'use strict';
/**
 * LT PPE disqualify → rule-predicate crosswalk (Part 3 P4, disqualify slice) — pure offline test.
 * Grounded in the REAL Lender Price disqualify key wording (from the committed vendor-shape fixture):
 *   "FICO - below 660" (FicoRateAdjustment), "Max LTV exceeded / CLTV > 80.0 %" (CapAdjustment),
 *   "Interest Only not available in NY" (StatesRateAdjustment).
 * Proves each maps to the right predicate, that unknown keys are REFUSED (never guessed), and that the
 * produced predicates actually DECLINE the scenario they target through rules.evaluateRules.
 *
 *   node scripts/test-lt-ppe-disqualify-crosswalk.js
 */
const { keyToPredicate, ADJTYPE_FACT } = require('../src/longterm/ppe/disqualify-crosswalk');
const { evaluateRules } = require('../src/longterm/ppe/rules');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const J = (x) => JSON.stringify(x);

console.log('LT PPE disqualify crosswalk — offline\n');

// 1) The three REAL fixture keys map to the right predicate at strong confidence.
{
  const fico = keyToPredicate({ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' });
  ok(fico.ok && fico.fact === 'fico' && J(fico.predicate) === J({ fact: 'fico', op: 'lt', value: 660 }), 'FICO - below 660 → fico < 660');
  ok(fico.confidence === 'strong' && fico.matchedBy === 'adjType', 'FICO mapped strong by adjType');

  const cltv = keyToPredicate({ rule: 'Max LTV exceeded / CLTV > 80.0 %', adjType: 'CapAdjustment' });
  ok(cltv.ok && cltv.fact === 'cltv' && J(cltv.predicate) === J({ fact: 'cltv', op: 'gt', value: 80000 }), 'CapAdjustment CLTV > 80.0% → cltv > 80000 (milli-percent)');

  const st = keyToPredicate({ rule: 'Interest Only not available in NY', adjType: 'StatesRateAdjustment' });
  ok(st.ok && st.fact === 'state' && J(st.predicate) === J({ all: [{ fact: 'interest_only', op: 'eq', value: true }, { fact: 'state', op: 'eq', value: 'NY' }] }),
    'IO not available in NY → (io=true AND state=NY)');
}

// 2) DSCR / loan amount / a plain state / a bare "Max LTV 80%" cap.
{
  const dscr = keyToPredicate({ rule: 'DSCR below 1.00', adjType: 'DscrRateAdjustment' });
  ok(dscr.ok && J(dscr.predicate) === J({ fact: 'dscr', op: 'lt', value: 1000 }), 'DSCR below 1.00 → dscr < 1000 (milli)');

  const amt = keyToPredicate({ rule: 'Loan amount below $150,000', adjType: 'LoanAmountRateAdjustment' });
  ok(amt.ok && J(amt.predicate) === J({ fact: 'loan_amount', op: 'lt', value: 150000 }), 'loan amount below $150,000 → loan_amount < 150000 (dollars, comma stripped)');

  const plainState = keyToPredicate({ rule: 'Program not available in TX', adjType: 'StatesRateAdjustment' });
  ok(plainState.ok && J(plainState.predicate) === J({ fact: 'state', op: 'eq', value: 'TX' }), 'plain state restriction → state = TX');

  const cap = keyToPredicate({ rule: 'Max LTV 80.0 %', adjType: 'CapAdjustment' });
  ok(cap.ok && J(cap.predicate) === J({ fact: 'ltv', op: 'gt', value: 80000 }), 'a bare "Max LTV 80%" cap (no direction word) → ltv > 80000');
}

// 3) UNKNOWN is REFUSED and flagged for a human — never guessed.
{
  const unknownType = keyToPredicate({ rule: 'Something we have never seen', adjType: 'MysteryAdjustment' });
  ok(!unknownType.ok && unknownType.needsHumanCrosswalk && /unmapped_adjType/.test(unknownType.why), 'an unmapped adjType is refused + names itself');

  const noThreshold = keyToPredicate({ rule: 'FICO requirement not met', adjType: 'FicoRateAdjustment' });
  ok(!noThreshold.ok && noThreshold.needsHumanCrosswalk, 'a FICO rule with no readable number is refused (never a fabricated threshold)');

  const empty = keyToPredicate({ rule: '', adjType: 'FicoRateAdjustment' });
  ok(!empty.ok && empty.why === 'empty_reason', 'an empty reason is refused');
}

// 4) Text-only fallback (no adjType) is 'possible', for the unmistakable shapes only.
{
  const t = keyToPredicate({ rule: 'Minimum FICO 680 required', adjType: null });
  ok(t.ok && t.fact === 'fico' && t.confidence === 'possible' && t.matchedBy === 'text', 'text-only "Minimum FICO 680" → fico predicate at possible confidence');
  const junk = keyToPredicate({ rule: 'Investor overlay applies', adjType: null });
  ok(!junk.ok && junk.needsHumanCrosswalk, 'text with no recognizable fact is refused');
}

// 5) The produced predicates actually DECLINE the scenario they target (end-to-end through the engine).
{
  const rules = ['FICO - below 660', 'Max LTV exceeded / CLTV > 80.0 %', 'Interest Only not available in NY'].map((rule, i) => {
    const adjType = ['FicoRateAdjustment', 'CapAdjustment', 'StatesRateAdjustment'][i];
    const c = keyToPredicate({ rule, adjType });
    return { code: `r${i}`, kind: 'eligibility', when: c.predicate, declineReason: rule };
  });

  const badFico = evaluateRules(rules, { fico: 640, cltv: 70000, interest_only: false, state: 'TX' });
  ok(!badFico.eligible && badFico.declines.some((d) => d.reason === 'FICO - below 660'), 'a 640-FICO loan is declined by the imported FICO rule');

  const badLtv = evaluateRules(rules, { fico: 720, cltv: 85000, interest_only: false, state: 'TX' });
  ok(!badLtv.eligible && badLtv.declines.some((d) => d.reason === 'Max LTV exceeded / CLTV > 80.0 %'), 'an 85% CLTV loan is declined by the imported cap rule');

  const ioNy = evaluateRules(rules, { fico: 720, cltv: 70000, interest_only: true, state: 'NY' });
  ok(!ioNy.eligible && ioNy.declines.some((d) => /Interest Only not available in NY/.test(d.reason)), 'an IO loan in NY is declined; ');

  const ioTx = evaluateRules(rules, { fico: 720, cltv: 70000, interest_only: true, state: 'TX' });
  ok(ioTx.eligible, 'an IO loan in TX is NOT declined by the NY rule (the AND matters)');

  const clean = evaluateRules(rules, { fico: 720, cltv: 70000, interest_only: false, state: 'TX' });
  ok(clean.eligible, 'a clean loan passes all three imported rules');
}

// 6) The adjType map covers the fixture types.
ok(ADJTYPE_FACT.FicoRateAdjustment === 'fico' && ADJTYPE_FACT.StatesRateAdjustment === 'state' && ADJTYPE_FACT.CapAdjustment === 'ltv_cap',
  'the adjType→dimension map covers the real fixture types');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
