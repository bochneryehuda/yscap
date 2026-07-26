'use strict';
/**
 * Pure unit test for the `pull_credit` capability (no DB, no network).
 * Credit import is gated on pull_credit (NOT sign_off_conditions) so a loan
 * officer can pull credit at point of sale without gaining the processor's
 * sign-off power. Everyone who could import before (sign_off_conditions holders)
 * must still be able to. Run: node scripts/test-permissions-pull-credit-pure.js
 */
const assert = require('assert');
const p = require('../src/lib/permissions');
const has = (role, cap, ov = null) => p.effectivePermissions(role, ov).has(cap);

// pull_credit is a real, registered capability (so it shows on the Team screen).
assert.ok(p.CAP_KEYS.includes('pull_credit'), 'pull_credit is a registered capability');
assert.ok(p.CAPABILITIES.some((c) => c.key === 'pull_credit' && c.label && c.hint), 'pull_credit has a label + hint');

// The loan officer GAINS credit-pull but NOT the sign-off power (separation of duties).
assert.strictEqual(has('loan_officer', 'pull_credit'), true, 'loan_officer can pull credit');
assert.strictEqual(has('loan_officer', 'sign_off_conditions'), false, 'loan_officer still cannot sign off conditions');
assert.strictEqual(has('loan_officer', 'review_conditions'), true, 'loan_officer keeps the lighter review stamp');

// Everyone who could import credit BEFORE (they held sign_off_conditions) must
// still be able to AFTER — pull_credit is granted to every such role.
for (const role of ['admin', 'underwriter', 'loan_coordinator', 'processor', 'closer']) {
  assert.strictEqual(has(role, 'sign_off_conditions'), true, `${role} still signs off`);
  assert.strictEqual(has(role, 'pull_credit'), true, `${role} still pulls credit`);
}
// super_admin implicitly has everything.
assert.strictEqual(has('super_admin', 'pull_credit'), true, 'super_admin pulls credit');

// Roles that never had credit import do not silently gain it by default.
assert.strictEqual(has('draw_coordinator', 'pull_credit'), false, 'draw_coordinator: no pull_credit by default');
assert.strictEqual(has('software_setup', 'pull_credit'), false, 'software_setup: no pull_credit by default');

// An admin can still grant OR revoke it per-person from the Team screen.
assert.strictEqual(has('draw_coordinator', 'pull_credit', { pull_credit: true }), true, 'per-person grant works');
assert.strictEqual(has('loan_officer', 'pull_credit', { pull_credit: false }), false, 'per-person revoke works');

console.log('OK  permissions-pull-credit: LO gains credit-pull without sign-off; prior importers keep it; grantable/revocable — all passed');
