/**
 * EXCEPTION STICKINESS — the owner's re-registration truth table (owner-directed
 * 2026-08-05). An approved exception belongs to the ITEM it was granted for, at the
 * VALUE it was granted at. A re-register that carries the same approved item(s) at the
 * same value(s) must NOT open a fresh super-admin approval — only a changed value, a
 * new item, a new guideline reason, or (for a manual program) the loan amount going UP
 * does. PURE (no DB): the whole decision is unit-tested here.
 *
 * Run: node scripts/test-exception-stickiness-pure.js
 */
'use strict';

const REPO = __dirname + '/..';
const mp = require(REPO + '/src/lib/manual-program');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

// The studio's pricingOverridesEngaged() output shape: [{ key, label, unit, value }].
// Labels come straight from pricing-overrides.js so the two never drift.
const L = {
  ltc: 'Manual loan-to-cost',
  origStd: 'Origination points — Standard',
  markupStd: 'Rate markup / YSP — Standard',
};
const changeLtcPct = (pct) => ({ key: 'ovrLTCPct', label: L.ltc, unit: 'pct', value: pct });
const changeLtcFrac = (frac) => ({ key: 'ovrLTC', label: L.ltc, unit: 'frac', value: frac });
const changeOrig = (pct) => ({ key: 'origStdPct', label: L.origStd, unit: 'pct', value: pct });
const changeMarkup = (pct) => ({ key: 'markupStdPct', label: L.markupStd, unit: 'pct', value: pct });

// A stored escalation grant: slim `overrides` map (studio keys → raw value) + summary.
const grant = (overrides, { program = 'standard', loanAmount = null, manualReasons = [] } = {}) =>
  ({ overrides, program, loanAmount, manualReasons });

const covered = (current, g) => mp.exceptionCoveredByGrant(current, g).covered;
const reasonOf = (current, g) => mp.exceptionCoveredByGrant(current, g).reason;

console.log('\nEXCEPTION STICKINESS');

// 0. No approved grant → never covered (a first exception always needs approval).
ok(!covered({ program: 'manual', overrideChanges: [changeLtcFrac(0.9)] }, null),
  'no approved grant → not covered (the first exception needs approval)');

// 1. Manual program approved at 90% LTC — stays covered at 90% LTC even when the loan
//    amount changes, and REGARDLESS of the studio percent vs engine fraction form.
{
  const g = grant({ ovrLTCPct: 90 }, { program: 'manual', loanAmount: 300000 });
  ok(covered({ program: 'manual', status: 'ELIGIBLE', overrideChanges: [changeLtcFrac(0.9)], loanAmount: 280000 }, g),
    '90% LTC re-registered as 0.9 fraction, smaller loan → covered');
  ok(covered({ program: 'manual', status: 'ELIGIBLE', overrideChanges: [changeLtcPct(90)], loanAmount: 300000 }, g),
    '90% LTC re-registered as 90 percent, same loan → covered');
  ok(!covered({ program: 'manual', status: 'ELIGIBLE', overrideChanges: [changeLtcPct(85)], loanAmount: 300000 }, g),
    'a DIFFERENT LTC cap (85%) → NOT covered');
  ok(reasonOf({ program: 'manual', overrideChanges: [changeLtcPct(85)], loanAmount: 300000 }, g) === 'item_changed_or_added',
    'and the reason names a changed item');
}

// 2. THE OWNER'S SPECIAL CASE: a manual program's loan amount going UP needs a fresh
//    approval, even at the same LTC.
{
  const g = grant({ ovrLTCPct: 90 }, { program: 'manual', loanAmount: 300000 });
  ok(!covered({ program: 'manual', overrideChanges: [changeLtcFrac(0.9)], loanAmount: 340000 }, g),
    'same 90% LTC but the loan amount WENT UP → NOT covered (capital / BP structure)');
  ok(reasonOf({ program: 'manual', overrideChanges: [changeLtcFrac(0.9)], loanAmount: 340000 }, g) === 'manual_loan_amount_increased',
    'and the reason says the manual-program loan increased');
  ok(covered({ program: 'manual', overrideChanges: [changeLtcFrac(0.9)], loanAmount: 300000 + 1 }, g),
    'a sub-dollar rounding wobble does NOT count as an increase');
}

// 3. Origination approved at 1% — stays covered at 1% (dollar amount is irrelevant),
//    a DIFFERENT rate needs a new exception. Loan amount moving does NOT matter for a
//    pricing-only exception (the loan-up rule is manual-program-only).
{
  const g = grant({ origStdPct: 1 }, { program: 'standard', loanAmount: 500000 });
  ok(covered({ program: 'standard', overrideChanges: [changeOrig(1)], loanAmount: 400000 }, g),
    '1% origination, loan reduced (fee $ changes) → covered');
  ok(covered({ program: 'standard', overrideChanges: [changeOrig(1)], loanAmount: 900000 }, g),
    '1% origination, loan INCREASED → still covered (loan-up rule is manual-program only)');
  ok(!covered({ program: 'standard', overrideChanges: [changeOrig(0.9)], loanAmount: 500000 }, g),
    '1% → 0.9% origination → NOT covered');
}

// 4. Markup approved at 0.2 — stays covered at 0.2, 0.1 needs a new exception.
{
  const g = grant({ markupStdPct: 0.2 }, { program: 'standard', loanAmount: 500000 });
  ok(covered({ program: 'standard', overrideChanges: [changeMarkup(0.2)], loanAmount: 500000 }, g),
    '0.2 markup re-registered at 0.2 → covered');
  ok(!covered({ program: 'standard', overrideChanges: [changeMarkup(0.1)], loanAmount: 500000 }, g),
    '0.2 → 0.1 markup → NOT covered');
}

// 5. Adding / dropping items.
{
  const g = grant({ origStdPct: 1 }, { program: 'standard' });
  ok(!covered({ program: 'standard', overrideChanges: [changeOrig(1), changeMarkup(0.2)] }, g),
    'a NEW item (markup) alongside the approved origination → NOT covered');
  const g2 = grant({ origStdPct: 1, markupStdPct: 0.2 }, { program: 'standard' });
  ok(covered({ program: 'standard', overrideChanges: [changeOrig(1)] }, g2),
    'DROPPING an approved item (asking for less) → still covered');
}

// 6. A manual program can only be covered by a grant that was itself a manual program.
{
  const g = grant({ origStdPct: 1 }, { program: 'standard' });   // pricing-only grant
  ok(!covered({ program: 'manual', overrideChanges: [changeLtcFrac(0.9)] }, g),
    'a manual program is not covered by a pricing-only grant');
}

// 7. MANUAL-review scenarios: covered only while no NEW guideline reason has appeared.
{
  const g = grant({}, { program: 'standard', manualReasons: ['Below the $100,000 minimum'] });
  ok(covered({ program: 'standard', status: 'MANUAL', overrideChanges: [], manualReasons: ['Below the $100,000 minimum'] }, g),
    'the same manual-review reason → covered (already approved for exactly this)');
  ok(!covered({ program: 'standard', status: 'MANUAL', overrideChanges: [], manualReasons: ['Below the $100,000 minimum', 'Over the program maximum'] }, g),
    'a NEW manual-review reason → NOT covered');
  ok(reasonOf({ program: 'standard', status: 'MANUAL', overrideChanges: [], manualReasons: ['x'] }, g) === 'new_manual_reason',
    'and the reason says a new manual reason appeared');
}

// 8. Canonicalisation primitives.
{
  const c = mp._internals.canonValue;
  ok(c('pct', 90) === 0.9, 'pct → fraction');
  ok(c('frac', 0.9) === 0.9, 'frac stays a fraction');
  ok(c('money', 500000) === 500000, 'money stays as-is');
  ok(c('flag', true) === 1 && c('flag', false) === null, 'an engaged flag → 1, a disengaged flag → null');
  // origStdPct is a PERCENT knob, so 1 (point) canonicalises to the fraction 0.01 — the
  // same canonical value the current register's percent-form change produces, so the two
  // always compare equal. LTC comes in as a percent here too (studio key ovrLTCPct).
  const fromSlim = mp._internals.itemsFromSlim({ ovrLTCPct: 90, origStdPct: 1 });
  ok(fromSlim.get(L.ltc) === 0.9 && Math.abs(fromSlim.get(L.origStd) - 0.01) < 1e-9,
    'the slim grant map canonicalises both key forms to (label → value)');
}

console.log(`\nexception-stickiness-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
