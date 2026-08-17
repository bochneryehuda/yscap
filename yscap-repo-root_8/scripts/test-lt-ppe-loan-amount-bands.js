#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE THREE LOAN-AMOUNT BANDS, END TO END THROUGH THE REAL PROGRAM.
 *
 * The owner's rule (2026-08-17), given when the rate sheet's $100,000 minimum appeared to contradict
 * the matrix's $75,000: *"anything below $100,000 is an internal exception, but you can do ... $75,000
 * on this program. It is eligible, but under $100,000, it's a manual product and it needs an
 * exception. You can price it regularly out of their rate sheet and out of the Lender Price pricer,
 * but you just need to mark that it's a manual exceptional product."*
 *
 *   < $75,000            INELIGIBLE — below the program floor.
 *   $75,000 – $99,999    ELIGIBLE, priced normally, but STAMPED a manual/super-admin exception.
 *   >= $100,000          ordinary — eligible with NO exception stamp.
 *
 * WHY THIS SUITE EXISTS EVEN THOUGH THE BEHAVIOUR ALREADY WORKED. Verified on 2026-08-17 that the
 * composed program already produces all three bands (the floor from Layer 2, the stamp from the D34
 * `delegate_only_exception` informational rule). NOTHING WAS CHANGED. What was missing was a guard:
 * the rule is produced by TWO independent layers that know nothing about each other, so either could
 * move — the floor with a matrix refresh, the threshold with a rate-sheet refresh — and the band would
 * silently close, invert, or open a gap where a sub-$100k loan is quoted with NO exception stamp.
 * That is a money error (a loan delivered on a channel it is not eligible for), and it would be
 * invisible: both layers would still pass their own tests.
 *
 * The band edges are asserted against the SOURCE DOCUMENTS, not against numbers retyped here, so a
 * document change fails this suite rather than drifting past it. Companion:
 * test-lt-ppe-ratesheet-matrix-reconcile.js, which guards the two documents against each other.
 *
 * PURE: no network, no DB, no live Lender Price.
 */
const fs = require('fs');
const path = require('path');
const { evaluateProgram } = require('../src/longterm/ppe/program-deephaven-dscr');

const SHEET = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json'), 'utf8'));
const MATRIX = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs/longterm/ppe-research/matrices/deephaven-dscr-matrix.json'), 'utf8'));

// The edges come from the documents themselves — never retyped.
const FLOOR = Number((JSON.stringify(MATRIX).match(/"minLoanDscrGe1":\s*(\d+)/) || [])[1]);
const EXCEPTION_BELOW = SHEET.otherProgramRequirements.minimumLoanAmount;

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }

// A strong, ordinary DSCR loan — so nothing BUT the loan amount can decide the outcome. The LTV is
// held at 70% and the value derived from the loan, so every case sits in the same pricing cell.
function evalAt(loan, extra = {}) {
  return evaluateProgram({
    fico: 760, ltv: 70000, dscr: 1200, purpose: 'purchase', property_type: 'SingleFamily',
    units: 1, state: 'NJ', interest_only: false,
    loan_amount: loan, value: Math.round(loan / 0.7), ...extra,
  });
}
const exceptionCodes = (r) => (r.exceptions || []).map((e) => e.code);
const hasDelegateException = (r) => exceptionCodes(r).includes('delegate_only_exception');

// ---- the edges are the documents' own numbers -------------------------------------------------
ok(FLOOR === 75000, `the program FLOOR comes from the matrix ($${FLOOR})`);
ok(EXCEPTION_BELOW === 100000, `the EXCEPTION threshold comes from the rate sheet ($${EXCEPTION_BELOW})`);
ok(FLOOR < EXCEPTION_BELOW, 'the band is non-empty — there is a real "priced but needs an exception" range');

// ---- band 1: below the floor → INELIGIBLE ------------------------------------------------------
for (const loan of [50000, FLOOR - 1]) {
  const r = evalAt(loan);
  ok(r.eligible === false, `$${loan} (below the $${FLOOR} floor) is INELIGIBLE`);
}

// ---- band 2: floor .. threshold-1 → ELIGIBLE **and stamped an exception** ----------------------
for (const loan of [FLOOR, 80000, EXCEPTION_BELOW - 1]) {
  const r = evalAt(loan);
  ok(r.eligible === true, `$${loan} is ELIGIBLE (priced normally, not refused)`);
  ok(hasDelegateException(r), `$${loan} is STAMPED a manual exception (delegate_only_exception)`);
  const ex = (r.exceptions || []).find((e) => e.code === 'delegate_only_exception');
  ok(!!ex && ex.requiresException === true, `$${loan} — the stamp says an exception is REQUIRED`);
  ok(!!ex && ex.superAdminOnly === true, `$${loan} — the stamp says SUPER-ADMIN only`);
}

// ---- band 3: at/above the threshold → ordinary, NO stamp ---------------------------------------
for (const loan of [EXCEPTION_BELOW, 150000, 900000]) {
  const r = evalAt(loan);
  ok(r.eligible === true, `$${loan} is ELIGIBLE`);
  ok(!hasDelegateException(r), `$${loan} carries NO exception stamp — it is an ordinary loan`);
}

// ---- the stamp must never be the thing that makes a loan ineligible ---------------------------
// The owner's rule is explicit that these loans still PRICE. A future change that turned the stamp
// into a decline would satisfy "we flagged it" while quietly killing the product.
const mid = evalAt(80000);
ok(mid.eligible === true && hasDelegateException(mid),
  'the exception stamp COEXISTS with eligibility — it flags, it never declines');
ok(!(mid.reasons || []).some((x) => /delegate|exception/i.test(x.code || x.reason || '')),
  'the exception is not emitted as an eligibility decline reason');

// ---- the band is DSCR-dependent, and that is deliberate ---------------------------------------
// Below DSCR 1.00 the matrix's floor is $200,000 — ABOVE the $100k threshold — so the band cannot
// exist there. Asserted so nobody "fixes" the weak-DSCR case into existence by lowering that floor.
const weak = evalAt(80000, { dscr: 900 });
ok(weak.eligible === false, 'at DSCR < 1.00 an $80,000 loan is INELIGIBLE (that floor is $200,000, above the band)');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
