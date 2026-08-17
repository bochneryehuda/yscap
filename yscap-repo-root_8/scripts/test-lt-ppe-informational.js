#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the INFORMATIONAL PRODUCT LAYER (informational.js). Proves the non-blocking notes a chosen,
 * eligible product carries: reserves (months + computable dollar), cash-out-toward-reserves, the
 * small-loan LTV cut, and the D34 delegate-only EXCEPTION — every value transcribed from the published
 * matrix, nothing guessed. Also proves it enriches evaluateProgram WITHOUT changing the eligible verdict.
 * LT-only, pure, offline.
 */
const { evaluateInformational, _internals } = require('../src/longterm/ppe/informational');
const { evaluateProgram } = require('../src/longterm/ppe/program-deephaven-dscr');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — informational product layer\n');

// ── reserves: 3 months <= $1M, 6 months > $1M (matrix literal) ────────────────────────────────────
ok(evaluateInformational({ loan_amount: 800000 }).reserves.months === 3, 'loan $800k → 3 months PITIA reserves');
ok(evaluateInformational({ loan_amount: 1000000 }).reserves.months === 3, 'loan $1.0M (boundary) → 3 months (<= $1M)');
ok(evaluateInformational({ loan_amount: 1000001 }).reserves.months === 6, 'loan just over $1M → 6 months');
ok(evaluateInformational({ loan_amount: 1500000 }).reserves.months === 6, 'loan $1.5M → 6 months PITIA reserves');

// reserve DOLLAR is computed from the priced PITIA; absent → months only.
const withPitia = evaluateInformational({ loan_amount: 800000 }, { monthlyPitia: 3000 });
ok(withPitia.reserves.amountDollars === 9000 && /\$9,000/.test(withPitia.reserves.message), '3 months × $3,000 PITIA → $9,000 reserve dollar');
ok(evaluateInformational({ loan_amount: 800000 }).reserves.amountDollars === null, 'no PITIA → months only (amountDollars null)');

// ── cash-out may be applied toward reserves (matrix literal) ──────────────────────────────────────
ok(evaluateInformational({ loan_amount: 5e5, cashout_amount: 100000 }).informational.some((n) => n.code === 'cashout_toward_reserves'),
  'a cash-out loan carries the "cash-out toward reserves" note');
ok(!evaluateInformational({ loan_amount: 5e5, cashout_amount: 0 }).informational.some((n) => n.code === 'cashout_toward_reserves'),
  'no cash-out → no cash-out-toward-reserves note');

// ── small-loan LTV cut (< $125k → 75%) ───────────────────────────────────────────────────────────
ok(evaluateInformational({ loan_amount: 120000 }).informational.some((n) => n.code === 'small_loan_ltv_cut'), 'loan < $125k → small-loan LTV-cut note');
ok(!evaluateInformational({ loan_amount: 130000 }).informational.some((n) => n.code === 'small_loan_ltv_cut'), 'loan >= $125k → no small-loan note');

// ── D34: the DELEGATE-ONLY EXCEPTION (< $100k) is surfaced LOUD, in a separate exceptions[] array ──
{
  const r = evaluateInformational({ loan_amount: 90000 });
  ok(r.exceptions.length === 1 && r.exceptions[0].code === 'delegate_only_exception', 'loan < $100k → a delegate-only exception');
  ok(r.exceptions[0].severity === 'exception' && r.exceptions[0].channel === 'delegate'
    && r.exceptions[0].requiresException === true && r.exceptions[0].superAdminOnly === true,
    'the delegate exception is loud: severity=exception, channel=delegate, requires a super-admin exception');
  // it is NOT mixed into the ordinary informational notes.
  ok(!r.informational.some((n) => n.code === 'delegate_only_exception'), 'the exception rides exceptions[], not informational[]');
  ok(evaluateInformational({ loan_amount: 100000 }).exceptions.length === 0, 'loan $100k (boundary) → no delegate exception (< $100k)');
}

// ── NEVER GUESS: the unverified second-appraisal note is DISABLED and never fires ────────────────
ok(_internals.NOTES.some((n) => n.code === 'second_appraisal' && n.enabled === false && n.provenance === 'unverified'),
  'the second-appraisal note is carried DISABLED (threshold not in the matrix — never fired on a guess)');
for (const loan of [50000, 500000, 2000000, 2500000, 3000000]) {
  const r = evaluateInformational({ loan_amount: loan, cashout_amount: loan });
  if (r.informational.some((n) => n.code === 'second_appraisal') || r.exceptions.some((n) => n.code === 'second_appraisal')) {
    ok(false, `second_appraisal must NOT fire (loan ${loan})`);
  }
}
ok(true, 'the disabled second-appraisal note never fires at any loan size');

// ── fail-safe: a missing fact never fires a note; never throws ────────────────────────────────────
ok(evaluateInformational({}).reserves === null && evaluateInformational({}).informational.length === 0 && evaluateInformational({}).exceptions.length === 0,
  'empty facts → no reserves, no notes, no exceptions (fail-safe, no throw)');

// ── it enriches evaluateProgram WITHOUT changing the eligible verdict ─────────────────────────────
{
  const facts = { fico: 760, ltv: 60000, dscr: 1250, loan_amount: 800000, value: 1333333, purpose: 'purchase', units: 1, state: 'CA' };
  const p = evaluateProgram(facts, { monthlyPitia: 3200 });
  ok(p.eligible === true, 'a clean scenario is still eligible with the informational layer wired');
  ok(p.reserves && p.reserves.months === 3 && p.reserves.amountDollars === 9600, 'evaluateProgram carries reserves (3mo × $3,200 = $9,600)');
  ok(Array.isArray(p.informational) && Array.isArray(p.exceptions), 'evaluateProgram carries informational[] + exceptions[]');
  // an ineligible scenario still reports its informational notes (they never gate).
  const badFico = evaluateProgram({ fico: 600, ltv: 60000, dscr: 1250, loan_amount: 90000, value: 150000, purpose: 'purchase', units: 1, state: 'CA' });
  ok(badFico.eligible === false && badFico.exceptions.length === 1, 'an INELIGIBLE small loan still reports its delegate exception (informational never gates)');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
