'use strict';
/**
 * P4 — pure tests for the independent-verification RECONCILER.
 * Proves it compares a DOCUMENT-claimed value against an INDEPENDENT source's
 * value and returns confirmed / conflict / unverifiable per verification type,
 * raising an advisory finding ONLY on a real conflict — and that an unavailable
 * or empty source is UNVERIFIABLE, never a conflict (absence of an outside
 * answer is not a disagreement). Advisory: nothing here changes a decision.
 */
const assert = require('assert');
const rc = require('../src/lib/verification/reconciler');
const { STATUS } = rc;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- NAME / ownership: entity-suffix tolerant equality ---
let r = rc.reconcile({ type: 'name', value: 'ABC LLC', field: 'account_owner' }, { value: 'ABC, L.L.C.', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFIRMED, 'ABC LLC == ABC, L.L.C. after suffix normalization');
assert.ok(!r.finding, 'a confirmation carries no finding');
ok('name match is entity-suffix tolerant (ABC LLC == ABC, L.L.C.)');

r = rc.reconcile({ type: 'name', value: 'ABC Holdings LLC', field: 'account_owner' }, { value: 'XYZ Capital LLC', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'genuinely different owners conflict');
assert.strictEqual(r.finding.code, 'verify_ownership_mismatch');
assert.strictEqual(r.finding.severity, 'fatal');
assert.strictEqual(r.finding.docValue, 'ABC Holdings LLC');
assert.strictEqual(r.finding.sourceValue, 'XYZ Capital LLC');
assert.strictEqual(r.finding.provider, 'plaid');
assert.strictEqual(r.finding.status, 'open');
ok('a different owner name is a FATAL ownership-mismatch finding');

// "Limited Liability Company" spelled out matches "LLC"
r = rc.reconcile({ type: 'name', value: 'Maple Grove Limited Liability Company' }, { value: 'Maple Grove LLC', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"Limited Liability Company" == "LLC"');
ok('spelled-out "Limited Liability Company" matches "LLC"');

// --- AMOUNT: tolerance (a slightly different "as of" day should not false-conflict) ---
r = rc.reconcile({ type: 'amount', value: '42318.55', field: 'ending_balance' }, { value: '42318.90', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '$0.35 apart is within the 1% / $1 tolerance');
ok('amount within tolerance confirms (a small balance drift is not a conflict)');

r = rc.reconcile({ type: 'amount', value: '42318.55', field: 'ending_balance' }, { value: '12000.00', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'a materially different balance conflicts');
assert.strictEqual(r.finding.code, 'verify_amount_mismatch');
assert.strictEqual(r.finding.severity, 'warning');
ok('a materially different amount is a WARNING amount-mismatch finding');

// custom tolerances are honored
r = rc.reconcile({ type: 'amount', value: '100000' }, { value: '104000', provider: 'plaid' }, { pctTolerance: 0.05 });
assert.strictEqual(r.status, STATUS.CONFIRMED, '$4k on $100k is within a 5% custom tolerance');
ok('a custom percent tolerance is honored');

// a non-numeric amount is unverifiable, never a conflict
r = rc.reconcile({ type: 'amount', value: 'n/a' }, { value: '5000', provider: 'plaid' });
assert.strictEqual(r.status, STATUS.UNVERIFIABLE, 'a non-numeric claimed amount cannot be reconciled');
assert.ok(!r.finding);
ok('a non-numeric amount is unverifiable (never a false conflict)');

// --- ENTITY STATUS: source registry must be a good-standing value ---
r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'Active', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"Active" is good standing');
ok('an ACTIVE registry status confirms the entity');

r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'Administratively Dissolved', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'a dissolved entity is not in good standing');
assert.strictEqual(r.finding.code, 'verify_entity_not_active');
assert.strictEqual(r.finding.severity, 'fatal');
ok('a dissolved entity is a FATAL not-in-good-standing finding');

r = rc.reconcile({ type: 'entity_status', value: 'ABC LLC' }, { value: 'In Good Standing', provider: 'middesk' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"In Good Standing" (spaced) normalizes to good standing');
ok('"In Good Standing" normalizes to a good-standing value');

// --- PROPERTY VALUE: AVM within a variance band of the claimed appraisal ---
r = rc.reconcile({ type: 'property_value', value: '500000', field: 'appraised_value' }, { value: '520000', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '4% AVM variance is inside the ±10% band');
ok('an AVM within the variance band supports the appraised value');

r = rc.reconcile({ type: 'property_value', value: '500000', field: 'appraised_value' }, { value: '380000', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFLICT, '24% under is outside the band');
assert.strictEqual(r.finding.code, 'verify_value_unsupported');
assert.strictEqual(r.finding.severity, 'warning');
ok('an AVM far below the claimed value is a value-unsupported finding');

r = rc.reconcile({ type: 'property_value', value: '500000' }, { value: '470000', provider: 'housecanary' }, { varianceBand: 0.05 });
assert.strictEqual(r.status, STATUS.CONFLICT, '6% variance breaches a tightened 5% band');
ok('a tightened variance band is honored');

// --- EXISTS / boolean ---
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: true, provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, 'source confirms existence (true)');
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: 'found', provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFIRMED, '"found" also confirms existence');
r = rc.reconcile({ type: 'exists', value: 'lien' }, { value: false, provider: 'attom' });
assert.strictEqual(r.status, STATUS.CONFLICT, 'source cannot confirm → conflict');
assert.strictEqual(r.finding.code, 'verify_not_found');
ok('exists/boolean confirms on true/"found" and conflicts on false');

// --- UNVERIFIABLE: no source, unavailable source, empty value ---
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, null).status, STATUS.UNVERIFIABLE, 'no source at all');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { available: false, value: 'ABC LLC', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'source not available/configured');
assert.strictEqual(rc.reconcile({ type: 'name', value: 'ABC LLC' }, { value: '', provider: 'plaid' }).status, STATUS.UNVERIFIABLE, 'source has no value');
let u = rc.reconcile({ type: 'name', value: 'ABC LLC' }, null);
assert.ok(!u.finding, 'unverifiable never carries a finding');
ok('an unavailable / empty / missing source is UNVERIFIABLE, never a conflict');

// an unknown verification type is unverifiable, not a crash
assert.strictEqual(rc.reconcile({ type: 'mystery', value: 'x' }, { value: 'y', provider: 'p' }).status, STATUS.UNVERIFIABLE);
ok('an unknown verification type is unverifiable (never throws)');

// --- reconcileAll: rollup, findings, coverage ---
const batch = rc.reconcileAll([
  { claim: { type: 'name', value: 'ABC LLC', field: 'owner' }, source: { value: 'ABC LLC', provider: 'plaid' } },          // confirmed
  { claim: { type: 'amount', value: '42318.55', field: 'bal' }, source: { value: '9000', provider: 'plaid' } },              // conflict
  { claim: { type: 'entity_status', value: 'ABC LLC' }, source: { value: 'Active', provider: 'middesk' } },                  // confirmed
  { claim: { type: 'property_value', value: '500000' }, source: { available: false, provider: 'attom' } },                   // unverifiable
]);
assert.strictEqual(batch.summary.total, 4);
assert.strictEqual(batch.summary.confirmed, 2);
assert.strictEqual(batch.summary.conflict, 1);
assert.strictEqual(batch.summary.unverifiable, 1);
assert.strictEqual(batch.findings.length, 1, 'exactly one conflict finding surfaced');
assert.strictEqual(batch.findings[0].code, 'verify_amount_mismatch');
// coverage = share an outside source actually spoke to = (confirmed + conflict) / total = 3/4
assert.strictEqual(batch.summary.coverage, 0.75, 'independent coverage is 3 of 4 claims');
ok('reconcileAll rolls up counts, collects conflict findings, and reports independent coverage');

// empty / junk input is safe
assert.doesNotThrow(() => rc.reconcile(null, null));
assert.strictEqual(rc.reconcile(null, null).status, STATUS.UNVERIFIABLE);
assert.strictEqual(rc.reconcileAll(null).summary.total, 0);
assert.strictEqual(rc.reconcileAll([]).summary.coverage, 0);
ok('empty / null input is safe (never throws)');

console.log(`\nP4 verification-reconciler pure — ${passed} checks passed`);
