#!/usr/bin/env node
'use strict';
/**
 * LT PPE scenario review composer (ties P1 + P3 + P-DQ) — pure offline test.
 * Proves one call turns a priced scenario into its differences vs Lender Price AND the suggested
 * per-investor rules — the manual-review record. Uses the REAL LP parser output (parseFull /
 * parseDisqualified) and the REAL engine quote (quoteProgram).
 *
 *   node scripts/test-lt-ppe-parity-review.js
 */
const lp = require('../src/longterm/lenderprice/client');
const { reviewScenario } = require('../src/longterm/ppe/parity-review');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const settings = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const has = (r, c) => r.differences.some((d) => d.category === c);
const S = settings.resolveAll().values;

console.log('LT PPE parity review — offline\n');

// Build a matching LP qualified result: Deephaven DSCR 30, coupon 7.125, base points -3.75, LLPA 0.9,
// margin 0.25 → adjustedPoints -2.85 → price 102.85.
function rawQualified(margin) {
  return { results: {
    lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Deephaven Mortgage', shortName: 'DHVN' }] },
    qualifiedNonQMData: { key: [], keyLabel: 'ROOT', childs: [{
      type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed', childs: [{
        type: 'RateKey', keyLabel: '7.125', childs: [{
          type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"', childs: [],
          leafs: [{
            companyName: 'Deephaven Mortgage', programName: 'DSCR 30 Yr Fixed', rate: 7.125,
            baseRates: 7.125, basePoints: -3.75, adjustmentPoints: 0.9, adjustedPoints: -2.85,
            groupAdjustmentProperties: [{ name: 'LTV/FICO', adjustments: [{ key: 'CLTV/FICO', adjType: 'FicoLtvRateAdjustment', type: 'LLPA', valueType: 'Points', adj: 0.9 }] }],
            holdBackResult: { lender: { adjustments: [{ key: 'NDC Margin', type: 'Margin', valueType: 'Points', adj: margin }] } },
          }],
        }],
      }],
    }] },
  } };
}

// Our program prices the same coupon; base price 103.75 (= 100 − (−3.75) base points), one LLPA +0.9,
// margin 0.25, rounding off → final = 103.75 − 0.9 − 0.25 = 102.60. (LP prices 102.85 — a real gap.)
const program = {
  code: 'DHVN_DSCR30', name: 'DSCR 30 Yr Fixed', investorCode: 'DHVN',
  baseGrid: [{ rate: 7125, lockDays: 30, basePriceMilli: 103750 }],
  rules: [{ code: 'llpa', kind: 'pricing', when: null, adjustment: { code: 'CLTV/FICO', category: 'llpa', adjMilli: 900 } }],
};
const scenario = { fico: 740, ltv: 70000, cltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 };
const ours = quoteProgram({ scenario, program, settings: { ...S, 'pricing.rounding_mode': 'none', 'pricing.correspondent_margin_milli': 250 } });

// 1) A priced comparison with a real final-price gap (our 102.60 vs LP 102.85).
{
  const rev = reviewScenario({ ours, lpFull: lp.parseFull(rawQualified(0.25)), lpDisq: null, filter: { program: 'DSCR 30 Yr Fixed', investor: 'Deephaven Mortgage' }, settings: S });
  ok(rev.verdict === 'disagree', 'a real final-price gap is a disagreement');
  ok(has(rev, 'final_price'), 'the final-price difference is reported (our 102.60 vs LP 102.85)');
  ok(rev.lp.eligible && rev.lp.programsMatched === 1, 'the LP side matched one program');
  ok(rev.suggestions.length === 0, 'no disqualification → no rule suggestions on a priced comparison');
}

// 2) A margin gap: LP margin 0.50, ours 0.25.
{
  const rev = reviewScenario({ ours, lpFull: lp.parseFull(rawQualified(0.5)), lpDisq: null, filter: { program: 'DSCR 30 Yr Fixed' }, settings: S });
  ok(has(rev, 'margin'), 'a margin gap (0.25 vs 0.50) is reported');
}

// 3) The DISQUALIFY path: LP declined this program, we priced it → missing disqualification + a SUGGESTED RULE.
{
  const rawDisq = { results: {
    lenderDtos: { lenderDtoDisq: [{ id: 'L1', name: 'Deephaven Mortgage', shortName: 'DHVN' }] },
    disqualifiedData: { key: [], keyLabel: 'ROOT', childs: [{
      type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed', childs: [{
        type: 'RateKey', keyLabel: '6.5', childs: [{
          type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"', childs: [],
          leafs: [{ companyName: 'Deephaven Mortgage', programName: 'DSCR 30 Yr Fixed', rate: 6.5, disqualified: true,
            groupAdjustmentProperties: [{ disqualifyAdjustments: [{ key: 'FICO - below 660', adjType: 'FicoRateAdjustment', type: 'LLPA', valueType: 'Points' }] }] }],
        }],
      }],
    }] },
  } };
  // LP returns NO qualified programs (all declined), our engine prices it.
  const emptyQual = { results: { qualifiedNonQMData: { key: [], keyLabel: 'ROOT', childs: [], leafs: [] } } };
  const rev = reviewScenario({ ours, lpFull: lp.parseFull(emptyQual), lpDisq: lp.parseDisqualified(rawDisq), filter: { program: 'DSCR 30 Yr Fixed', investor: 'Deephaven Mortgage' }, settings: S });
  ok(has(rev, 'disqualification_missing'), 'we priced a program LP declined → disqualification_missing');
  ok(rev.suggestions.length === 1 && rev.suggestions[0].declineReason === 'FICO - below 660', 'a rule is SUGGESTED from the LP decline reason');
  ok(rev.suggestions[0].investor === 'Deephaven Mortgage' && rev.suggestions[0].kind === 'eligibility' && rev.suggestions[0].source === 'overlay', 'the suggestion is a per-investor overlay eligibility rule');
  ok(JSON.stringify(rev.suggestions[0].when) === JSON.stringify({ fact: 'fico', op: 'lt', value: 660 }), 'the suggested predicate is fico < 660');
}

// 4) An identical price → agree, no suggestions.
{
  const identical = { code: 'DHVN_DSCR30', name: 'DSCR 30 Yr Fixed', investorCode: 'DHVN',
    baseGrid: [{ rate: 7125, lockDays: 30, basePriceMilli: 103750 }],
    rules: [{ code: 'llpa', kind: 'pricing', when: null, adjustment: { code: 'CLTV/FICO', category: 'llpa', adjMilli: 900 } }] };
  // margin 0 so final = 103.75 − 0.9 = 102.85 exactly matching LP
  const oursMatch = quoteProgram({ scenario, program: identical, settings: { ...S, 'pricing.rounding_mode': 'none', 'pricing.correspondent_margin_milli': 0 } });
  const lpNoMargin = rawQualified(0); // LP margin 0 too
  const rev = reviewScenario({ ours: oursMatch, lpFull: lp.parseFull(lpNoMargin), lpDisq: null, filter: { program: 'DSCR 30 Yr Fixed' }, settings: S });
  ok(rev.verdict === 'agree' && rev.differences.length === 0, 'a byte-matching price → agree, no differences');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
