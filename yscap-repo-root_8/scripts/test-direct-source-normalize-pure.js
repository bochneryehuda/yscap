'use strict';
/**
 * R5.50-53 — pure tests for the direct-source response normalizers.
 * Proves each provider's RAW payload reduces to the canonical
 * { available, provider, value, field, ... } shape the reconciler consumes, that
 * `toReconcilable` produces a pair `reconcile()` confirms/conflicts on, and that
 * a garbage / hostile (throwing-getter) payload degrades to { available:false }
 * rather than throwing.
 */
const assert = require('assert');
const dsn = require('../src/lib/underwriting/direct-source-normalize');
const { reconcile } = require('../src/lib/verification/reconciler');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- R5.50 Plaid: owner name + balance from a realistic identity+balances payload ---
let p = dsn.normalizePlaid({
  accounts: [{
    mask: '5555',
    balances: { available: 40950.12, current: 41000 },
    owners: [{ names: ['CHASE ADAMS', 'C. ADAMS'] }],
  }, { mask: '0001', balances: { available: 5 }, owners: [{ names: ['Someone Else'] }] }],
}, { accountMask: '5555' });
assert.strictEqual(p.available, true);
assert.strictEqual(p.provider, 'plaid');
assert.strictEqual(p.value, 'CHASE ADAMS', 'primary owner name is the default reconcile value');
assert.strictEqual(p.balance, 40950.12, 'available balance preferred over current');
assert.deepStrictEqual(p.ownerNames, ['CHASE ADAMS', 'C. ADAMS']);
assert.strictEqual(p.accountMask, '5555', 'the masked account was selected by last-4');
ok('Plaid: owner names + available balance normalize; the right account is picked by mask');

// the balance path reconciles as an amount within tolerance
let rc = dsn.toReconcilable('plaid_balance', { accounts: [{ mask: '5555', balances: { available: 40950.12 } }] }, { value: 40950 });
assert.strictEqual(rc.claim.type, 'amount');
assert.strictEqual(rc.source.value, 40950.12);
assert.strictEqual(reconcile(rc.claim, rc.source).status, 'confirmed', '$40,950 doc vs $40,950.12 source is within tolerance');
ok('Plaid balance pairs into an amount reconcile that confirms within tolerance');

// the Plaid NAME path is the fatal ownership check — confirm AND conflict end-to-end
const nameOk = dsn.toReconcilable('plaid', { owners: [{ names: ['Chase Adams'] }] }, { value: 'Chase Adams' });
assert.strictEqual(nameOk.claim.type, 'name');
assert.strictEqual(reconcile(nameOk.claim, nameOk.source).status, 'confirmed', 'a matching account owner confirms');
const nameBad = dsn.toReconcilable('plaid', { owners: [{ names: ['Someone Else'] }] }, { value: 'Chase Adams' });
const nameBadR = reconcile(nameBad.claim, nameBad.source);
assert.strictEqual(nameBadR.status, 'conflict', 'a different account owner is a conflict');
assert.strictEqual(nameBadR.finding.severity, 'fatal', 'an ownership mismatch is FATAL');
assert.strictEqual(nameBadR.finding.code, 'verify_ownership_mismatch');
ok('Plaid account-owner name reconciles: a match confirms and a mismatch is a FATAL ownership conflict');

// --- R5.51 SoS: entity status + name; good standing confirms, dissolved conflicts ---
let s = dsn.normalizeSos({ legal_name: 'Oak Street Holdings LLC', status: 'Active', formation_date: '2021-03-04', jurisdiction: 'NY' });
assert.strictEqual(s.value, 'Active');
assert.strictEqual(s.entityName, 'Oak Street Holdings LLC');
assert.strictEqual(s.formationDate, '2021-03-04');
const good = dsn.toReconcilable('sos', { status: 'Active' }, { value: 'Oak Street Holdings LLC' });
assert.strictEqual(reconcile(good.claim, good.source).status, 'confirmed', 'active entity confirms good standing');
const dead = dsn.toReconcilable('sos', { status: 'Dissolved' }, { value: 'Oak Street Holdings LLC' });
const deadR = reconcile(dead.claim, dead.source);
assert.strictEqual(deadR.status, 'conflict', 'a dissolved entity conflicts');
assert.strictEqual(deadR.finding.severity, 'fatal');
ok('SoS: good-standing confirms and a dissolved entity raises a fatal not-active conflict');

// a good_standing flag (boolean OR string) maps to an active/inactive status
assert.strictEqual(dsn.normalizeSos({ name: 'X LLC', good_standing: false }).value, 'inactive');
assert.strictEqual(dsn.normalizeSos({ name: 'X LLC', good_standing: true }).value, 'active');
assert.strictEqual(dsn.normalizeSos({ name: 'X LLC', good_standing: 'active' }).value, 'active', 'a string good_standing resolves too');
assert.strictEqual(dsn.normalizeSos({ name: 'X LLC', good_standing: 'false' }).value, 'inactive');
ok('SoS: a good_standing flag (boolean or string) maps to active/inactive');

// the entity-NAME path reconciles as a name match too (sos_name)
const sn = dsn.toReconcilable('sos_name', { legal_name: 'Oak Street Holdings LLC', status: 'Active' }, { value: 'Oak Street Holdings, LLC' });
assert.strictEqual(sn.claim.type, 'name');
assert.strictEqual(reconcile(sn.claim, sn.source).status, 'confirmed', 'entity name matches (suffix/punctuation tolerant)');
ok('SoS entity name reconciles as a suffix-tolerant name match (sos_name kind)');

// --- R5.52 AVM: value from several vendor shapes; supports / does not support ---
assert.strictEqual(dsn.normalizeAvm({ avm: { amount: { value: 450000 } } }, 'attom').value, 450000);
assert.strictEqual(dsn.normalizeAvm({ value_estimate: 455000 }, 'housecanary').value, 455000);
assert.strictEqual(dsn.normalizeAvm({ result: { value: 460000 } }, 'clearcapital').value, 460000);
// HouseCanary's documented value_report shape (price_mean/lower/upper) is read
let hc = dsn.normalizeAvm({ price_mean: 452000, price_lower: 430000, price_upper: 475000 }, 'housecanary');
assert.strictEqual(hc.value, 452000, 'HouseCanary price_mean is read as the AVM value');
assert.strictEqual(hc.low, 430000); assert.strictEqual(hc.high, 475000);
// ATTOM's array-wrapped property shape is read (numFirstOf skips the object candidate)
assert.strictEqual(dsn.normalizeAvm({ property: [{ avm: { amount: { value: 461000 } } }] }, 'attom').value, 461000, 'ATTOM array-wrapped AVM is read');
// a { value: { amount } } object candidate does not short-circuit and drop a later scalar path
assert.strictEqual(dsn.normalizeAvm({ value: { amount: 1 }, valuation: { value: 462000 } }, 'attom').value, 462000, 'an object candidate is skipped for the next scalar path');
ok('AVM: HouseCanary price_mean, ATTOM array-wrapped, and object-candidate shapes all normalize to the scalar value');
const supp = dsn.toReconcilable('attom', { avm: { amount: { value: 460000 } } }, { value: 450000 });
assert.strictEqual(reconcile(supp.claim, supp.source).status, 'confirmed', '460k AVM supports a 450k claim within ±10%');
const unsupp = dsn.toReconcilable('attom', { avm: { amount: { value: 300000 } } }, { value: 450000 });
const unsuppR = reconcile(unsupp.claim, unsupp.source);
assert.strictEqual(unsuppR.status, 'conflict', 'a 300k AVM does NOT support a 450k claim');
assert.strictEqual(unsuppR.finding.code, 'verify_value_unsupported');
ok('AVM: value normalizes across ATTOM/HouseCanary/ClearCapital shapes; in-band supports, out-of-band conflicts');

// --- R5.53 Xactus: score + fraud flag extraction ---
let x = dsn.normalizeXactus({ score: 712, alerts: ['OFAC/SDN possible match', 'thin file'], frozen: false });
assert.strictEqual(x.available, true);
assert.strictEqual(x.value, 'found', 'a credit file with a score is "found"');
assert.strictEqual(x.score, 712);
assert.ok(x.fraudFlags.some((f) => /ofac/i.test(f.code)), 'the OFAC alert is classed as a fraud flag');
assert.ok(!x.fraudFlags.some((f) => /thin file/i.test(f.code)), 'a benign "thin file" note is NOT a fraud flag');
const cf = dsn.toReconcilable('xactus', { score: 712 }, { value: true });
assert.strictEqual(reconcile(cf.claim, cf.source).status, 'confirmed', 'a found credit file confirms an exists claim');
ok('Xactus: score + fraud flags extract; OFAC is severe, a benign note is not; a found file confirms exists');

// a boolean ofac:true hit becomes a severe flag even without an alerts array
assert.ok(dsn.normalizeXactus({ ofac: true, score: 700 }).fraudFlags.some((f) => /ofac/i.test(f.code)));
ok('Xactus: a boolean OFAC hit surfaces as a severe fraud flag');

// a NOT-FOUND credit file conflicts an exists claim (the credit file was expected)
const nf = dsn.toReconcilable('xactus', { found: false }, { value: true });
const nfR = reconcile(nf.claim, nf.source);
assert.strictEqual(nf.source.value, 'not_found');
assert.strictEqual(nfR.status, 'conflict', 'an expected credit file that is not found is a conflict');
assert.strictEqual(nfR.finding.code, 'verify_not_found');
ok('Xactus: a not-found credit file conflicts an expected-exists claim (verify_not_found)');

// --- an unavailable / missing source never conflicts ---
const noSrc = dsn.toReconcilable('attom', {}, { value: 450000 });
assert.strictEqual(noSrc.source.available, false);
assert.strictEqual(reconcile(noSrc.claim, noSrc.source).status, 'unverifiable', 'no AVM value → unverifiable, never a conflict');
assert.strictEqual(dsn.toReconcilable('nonsense_kind', {}, { value: 1 }), null, 'an unknown kind yields null');
ok('a missing source value reconciles as unverifiable (never a false conflict); an unknown kind is null');

// --- empty / junk / hostile input is safe (never throws) ---
assert.doesNotThrow(() => dsn.normalizePlaid(null));
assert.strictEqual(dsn.normalizePlaid(null).available, false);
assert.doesNotThrow(() => dsn.normalizeSos('junk'));
assert.doesNotThrow(() => dsn.normalizeAvm(12345, 'attom'));
assert.doesNotThrow(() => dsn.normalizeXactus([]));
assert.doesNotThrow(() => dsn.toReconcilable('plaid', null, null));
// a hostile payload with throwing getters degrades to unavailable, never escapes
assert.doesNotThrow(() => dsn.normalizePlaid({ get accounts() { throw new Error('boom'); } }));
assert.strictEqual(dsn.normalizePlaid({ get accounts() { throw new Error('boom'); } }).available, false);
assert.doesNotThrow(() => dsn.normalizeSos({ get status() { throw new Error('boom'); } }));
assert.doesNotThrow(() => dsn.normalizeXactus({ get alerts() { throw new Error('boom'); } }));
assert.strictEqual(dsn.normalizeXactus({ get alerts() { throw new Error('boom'); }, score: 700 }).score, 700, 'a throwing alerts getter does not lose the score');
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR5.50-53 direct-source-normalize pure — ${passed} checks passed`);
