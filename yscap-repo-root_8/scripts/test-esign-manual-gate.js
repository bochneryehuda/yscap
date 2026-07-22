'use strict';
/**
 * R6.4 — the MANUAL-is-a-stop issuance gate. Proves (with a stub db, no PG) that
 * registrationIssuabilityBlockers blocks a binding term-sheet issuance when the
 * current registration is MANUAL/Manual-Program still awaiting super-admin
 * approval, or is STALE — while an approved/eligible/fresh registration passes.
 * This is the fix for the audit's critical finding (the issuance gate had
 * diverged from the borrower-email gate).
 */
const assert = require('assert');

// Stub the manual-program module BEFORE requiring the gate, so pendingForApp is
// controllable. We reuse the REAL needsSuperAdminApproval (pure).
const Module = require('module');
const realLoad = Module._load;
let pendingResult = null;
Module._load = function (request, parent, isMain) {
  if (request === '../manual-program' || (request && request.endsWith('manual-program'))) {
    const real = realLoad.call(this, request, parent, isMain);
    return { ...real, pendingForApp: async () => pendingResult };
  }
  return realLoad.call(this, request, parent, isMain);
};
let registrationIssuabilityBlockers;
try {
  ({ registrationIssuabilityBlockers } = require('../src/lib/esign/gate'));
} catch (e) {
  // gate.js requires ../../db → pg. When pg isn't installed (local dev without a
  // DB), skip — CI installs pg and runs this. (Same skip pattern as the DB tests.)
  Module._load = realLoad;
  console.log('  ~~  SKIP test-esign-manual-gate (pg/db not available locally):', e.code || e.message);
  process.exit(0);
}
Module._load = realLoad;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// A stub db that returns a chosen registration row.
function stubDb(regRow) {
  return { query: async () => ({ rows: regRow ? [regRow] : [] }) };
}

(async () => {
  // ELIGIBLE + not stale + no pending → issuable (no blockers).
  pendingResult = null;
  let b = await registrationIssuabilityBlockers('app-1', stubDb({ status: 'ELIGIBLE', is_manual: false, stale: false }));
  assert.deepStrictEqual(b, [], 'an eligible fresh registration issues');
  ok('ELIGIBLE + fresh + no pending → issuable');

  // MANUAL status + a pending escalation → blocked.
  pendingResult = { id: 'esc-1' };
  b = await registrationIssuabilityBlockers('app-1', stubDb({ status: 'MANUAL', is_manual: true, stale: false }));
  assert.ok(b.some((x) => x.code === 'manual_approval'), 'MANUAL pending approval blocks issuance');
  ok('MANUAL + pending super-admin approval → BLOCKED (the critical fix)');

  // Manual-Program (is_manual) with a pending escalation → blocked even if status not literally MANUAL.
  pendingResult = { id: 'esc-2' };
  b = await registrationIssuabilityBlockers('app-1', stubDb({ status: 'ELIGIBLE', is_manual: true, stale: false }));
  assert.ok(b.some((x) => x.code === 'manual_approval'), 'a Manual-Program registration awaiting approval blocks');
  ok('Manual-Program + pending approval → BLOCKED');

  // MANUAL that has been APPROVED (no pending escalation) → issuable.
  pendingResult = null;
  b = await registrationIssuabilityBlockers('app-1', stubDb({ status: 'MANUAL', is_manual: true, stale: false }));
  assert.deepStrictEqual(b, [], 'an approved manual registration (no pending escalation) issues');
  ok('MANUAL + approved (no pending escalation) → issuable');

  // STALE registration → blocked regardless of status.
  pendingResult = null;
  b = await registrationIssuabilityBlockers('app-1', stubDb({ status: 'ELIGIBLE', is_manual: false, stale: true, stale_reason: 'Pricing inputs changed' }));
  assert.ok(b.some((x) => x.code === 'registration_stale'), 'a stale registration blocks issuance');
  ok('STALE registration → BLOCKED');

  // No current registration → no blocker here (the P&P condition check covers it).
  pendingResult = null;
  b = await registrationIssuabilityBlockers('app-1', stubDb(null));
  assert.deepStrictEqual(b, [], 'no registration → deferred to the P&P condition check');
  ok('no current registration → no duplicate blocker (P&P check owns it)');

  // Fails CLOSED: a DB read error → treated as not-issuable.
  b = await registrationIssuabilityBlockers('app-1', { query: async () => { throw new Error('db down'); } });
  assert.ok(b.some((x) => x.code === 'registration'), 'a read failure fails closed (not a silent pass)');
  ok('a registration read failure fails CLOSED (never a silent pass)');

  console.log(`\nR6.4 esign MANUAL-gate — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
