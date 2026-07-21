'use strict';

/*
 * Minimum / maximum + manual-review EXCESSION enforcement (owner-directed
 * 2026-07-21). A registration the frozen engine returns as MANUAL is NOT
 * offerable as-is — it is a manual-review exception that must be submitted and
 * then approved by a super-admin before terms are confirmed. This test proves,
 * with NO database:
 *   1. a below-$100k Standard deal is MANUAL (the minimum is enforced by the
 *      frozen engine) and names the $100,000 minimum in its reason;
 *   2. a below-$100k Gold deal is MANUAL and names the $100,000 minimum;
 *   3. a healthy in-range deal is ELIGIBLE;
 *   4. manual-program.needsSuperAdminApproval() gates exactly the registrations
 *      that must escalate (Manual Program OR any MANUAL result), and passes a
 *      clean ELIGIBLE Standard/Gold registration straight through.
 */

const assert = require('assert');
const pricing = require('../src/lib/pricing');
const manualProgram = require('../src/lib/manual-program');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  -', name); }
  catch (e) { failures++; console.error('  FAIL -', name, '\n        ', e.message); }
}

assert(pricing.enginesReady(), 'pricing engines must load');

// A tiny purchase that sizes well below the $100,000 minimum.
const belowMinInputs = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', city: 'Newark',
  propertyType: 'Single Family', units: 1,
  purchasePrice: 80000, asIsValue: 80000, arv: 100000, rehabBudget: 0,
  fico: 740, expFlips: 5, expHolds: 0, expGround: 0, term: 12, irMonths: 0, irAmount: 0,
};

// A healthy in-range deal.
const eligibleInputs = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', city: 'Newark',
  propertyType: 'Single Family', units: 1,
  purchasePrice: 300000, asIsValue: 300000, arv: 420000, rehabBudget: 40000,
  fico: 740, expFlips: 5, expHolds: 0, expGround: 0, term: 12, irMonths: 0, irAmount: 0,
};

console.log('Below-minimum enforcement:');

check('Standard below $100k → MANUAL', () => {
  const q = pricing.quoteProgram('standard', belowMinInputs);
  assert.strictEqual(q.status, 'MANUAL', `expected MANUAL, got ${q.status}`);
  const txt = (q.reasons || []).map((r) => r.msg).join(' | ');
  assert(/100,000/.test(txt), `reason should name the $100,000 minimum: ${txt}`);
});

check('Gold below $100k → MANUAL', () => {
  const q = pricing.quoteProgram('gold', belowMinInputs);
  assert.strictEqual(q.status, 'MANUAL', `expected MANUAL, got ${q.status}`);
  const txt = (q.reasons || []).map((r) => r.msg).join(' | ');
  assert(/100,000/.test(txt), `reason should name the $100,000 minimum: ${txt}`);
});

check('Healthy in-range Standard deal → ELIGIBLE', () => {
  const q = pricing.quoteProgram('standard', eligibleInputs);
  assert.strictEqual(q.status, 'ELIGIBLE', `expected ELIGIBLE, got ${q.status} (${(q.reasons||[]).map(r=>r.msg).join('; ')})`);
  assert(q.sizing.totalLoan >= 100000, 'a healthy deal sizes at/above the minimum');
});

console.log('needsSuperAdminApproval gating:');

check('Manual Program always needs approval', () => {
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'manual', status: 'ELIGIBLE' }), true);
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'manual', status: 'MANUAL' }), true);
});

check('Standard/Gold MANUAL needs approval', () => {
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'standard', status: 'MANUAL' }), true);
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'gold', status: 'MANUAL' }), true);
});

check('Clean ELIGIBLE Standard/Gold does NOT need approval', () => {
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'standard', status: 'ELIGIBLE' }), false);
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'gold', status: 'ELIGIBLE' }), false);
});

console.log('Assignment over-cap registers (eligible, not manual review):');

// An assignment fee over the 15% cap follows the program's normal mechanic: the
// financeable fee is capped, the excess is brought to closing as extra cash, and
// the loan sizes on the effective price. That is ELIGIBLE (registerable) — a
// raise-the-cap ask is a separate exception REQUEST (owner-directed 2026-07-21).
check('Standard assignment over the 15% cap → ELIGIBLE with excess to close', () => {
  const q = pricing.quoteProgram('standard', {
    loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR', units: 1,
    fico: 740, expFlips: 5, term: 12,
    isAssignment: true, sellerPrice: 100000, purchasePrice: 120000, asIsValue: 120000, arv: 200000, rehabBudget: 0,
  });
  assert.strictEqual(q.status, 'ELIGIBLE', `expected ELIGIBLE, got ${q.status} (${(q.reasons||[]).map(r=>r.msg).join('; ')})`);
  assert(q.assignment && q.assignment.overLimit === true, 'assignment is over the 15% cap');
  assert(Number(q.sizing.assignmentExcessOOP) > 0, 'the over-cap excess is brought to closing');
  assert.strictEqual(manualProgram.needsSuperAdminApproval({ program: 'standard', status: q.status }), false,
    'an over-cap assignment registers without super-admin approval');
});

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll pricing exception/escalation checks passed.');
