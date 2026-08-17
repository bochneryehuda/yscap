#!/usr/bin/env node
'use strict';
/**
 * LT PPE disqualification analysis → per-investor rule suggestions (Part 3 P5, disqualify slice).
 * Proves the owner's rule (2026-08-17): read Lender Price's disqualifications and suggest importing
 * them as rules FOR THAT INVESTOR. Uses a parseDisqualified-shaped input (the exact shape
 * lenderprice/client.parseDisqualified returns), including the real fixture key wording.
 *
 *   node scripts/test-lt-ppe-disqualify-analysis.js
 */
const { analyzeDisqualifications, suggestionCode } = require('../src/longterm/ppe/disqualify-analysis');
const { evaluateRules } = require('../src/longterm/ppe/rules');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE disqualify analysis — offline\n');

// A parseDisqualified-shaped result: two investors, one with a rule repeated across two programs,
// one carrying an unmappable reason. Reasons carry the real adjType (client.disqualifyRulesOf keeps it).
const parsed = {
  ready: true, lenderCount: 2, itemCount: 3, reasonCount: 5,
  lenders: [
    {
      lender: 'Some Lender', investor: 'Deephaven', lenderId: 'L1',
      items: [
        { program: 'DSCR 30 Yr Fixed', rate: 6.5, reasons: [
          { rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' },
          { rule: 'Max LTV exceeded / CLTV > 80.0 %', adjType: 'CapAdjustment' },
        ] },
        { program: 'DSCR 30 Yr Fixed IO', rate: 6.75, reasons: [
          { rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' },           // same rule, second program
          { rule: 'Interest Only not available in NY', adjType: 'StatesRateAdjustment' },
        ] },
      ],
    },
    {
      lender: 'Other Lender', investor: 'Kiavi', lenderId: 'L2',
      items: [
        { program: 'DSCR 30 Yr', rate: 7.0, reasons: [
          { rule: 'Investor overlay applies', adjType: 'MysteryAdjustment' },   // unmappable → surfaced
        ] },
      ],
    },
  ],
};

const out = analyzeDisqualifications(parsed);

// 1) Grouped PER INVESTOR.
ok(out.ready && out.investors.length === 2, 'two investors analyzed');
const dh = out.investors.find((i) => i.investor === 'Deephaven');
const kv = out.investors.find((i) => i.investor === 'Kiavi');
ok(dh && kv, 'grouped by investor name (Deephaven, Kiavi)');

// 2) Deephaven: 3 DISTINCT suggestions (FICO, CLTV cap, IO-in-NY); FICO deduped across 2 programs.
ok(dh.suggestions.length === 3, 'Deephaven yields 3 distinct suggestions (FICO deduped across programs)');
const fico = dh.suggestions.find((s) => s.fact === 'fico');
ok(fico && fico.occurrences === 2 && fico.programs.length === 2, 'the FICO rule counts 2 occurrences across 2 programs (evidence)');
ok(fico.kind === 'eligibility' && fico.source === 'overlay', 'a suggestion is an overlay eligibility rule');
ok(fico.declineReason === 'FICO - below 660', 'the LP reason is carried verbatim');
ok(fico.code === suggestionCode('fico', 'FICO - below 660') && /^disq_fico_/.test(fico.code), 'a deterministic code is generated');

// 3) The unmappable reason is SURFACED (never dropped, never guessed).
ok(kv.suggestions.length === 0 && kv.unmapped.length === 1, 'Kiavi: no suggestion, one unmapped reason');
ok(kv.unmapped[0].reasonText === 'Investor overlay applies' && /unmapped_adjType|unrecognized/.test(kv.unmapped[0].why),
  'the unmapped reason is surfaced with why, for a human to add to the crosswalk');

// 4) Summary counts.
ok(out.summary.investorCount === 2 && out.summary.suggestionCount === 3 && out.summary.unmappedCount === 1,
  'summary: 2 investors, 3 suggestions, 1 unmapped');

// 5) The suggested rules, applied to Deephaven, decline exactly the loans LP declined.
{
  const rules = dh.suggestions.map((s) => ({ code: s.code, kind: s.kind, when: s.when, declineReason: s.declineReason }));
  const bad = evaluateRules(rules, { fico: 640, cltv: 70000, io: false, state: 'TX' });
  ok(!bad.eligible && bad.declines.some((d) => d.reason === 'FICO - below 660'), 'a 640-FICO loan is declined by the imported Deephaven FICO rule');
  const clean = evaluateRules(rules, { fico: 720, cltv: 70000, io: false, state: 'TX' });
  ok(clean.eligible, 'a clean loan passes all imported Deephaven rules');
}

// 6) An empty / not-ready result yields nothing (never throws).
{
  const none = analyzeDisqualifications({ ready: false });
  ok(none.investors.length === 0 && none.summary.suggestionCount === 0, 'a not-ready result yields no suggestions');
  ok(analyzeDisqualifications(null).ready === false, 'null input is handled');
}

// 7) Re-running is stable — deterministic codes, no duplicate suggestions.
{
  const again = analyzeDisqualifications(parsed);
  const dh2 = again.investors.find((i) => i.investor === 'Deephaven');
  ok(dh2.suggestions.length === 3 && JSON.stringify(dh2.suggestions.map((s) => s.code)) === JSON.stringify(dh.suggestions.map((s) => s.code)),
    're-running produces the identical suggestion set (idempotent)');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
