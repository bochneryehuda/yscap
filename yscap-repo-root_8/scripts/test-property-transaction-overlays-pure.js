'use strict';
/**
 * R5.38 — pure tests for property-type + transaction-type overlays (DRAFT advisory).
 * Proves it (1) returns draft overlays for a canonicalized property/transaction key
 * (aliases resolve), (2) selects the UNION of property + transaction overlays for a
 * context, (3) marks every overlay draft + advisory, (4) returns nothing for unknown
 * types, and (5) never throws.
 */
const assert = require('assert');
const pto = require('../src/lib/underwriting/property-transaction-overlays');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- every overlay is DRAFT + advisory ---
const allOverlays = pto.supportedProperties().flatMap((k) => pto.overlaysForProperty(k))
  .concat(pto.supportedTransactions().flatMap((k) => pto.overlaysForTransaction(k)));
for (const o of allOverlays) {
  assert.strictEqual(o.status, 'draft', `${o.id} draft`);
  assert.strictEqual(o.severity, 'advisory', `${o.id} advisory`);
}
ok('every property/transaction overlay ships as draft + advisory');

// --- property aliases resolve to the canonical catalog ---
assert.ok(pto.overlaysForProperty('condominium').some((o) => /warrantab/i.test(o.label)), 'condominium → condo');
assert.deepStrictEqual(pto.overlaysForProperty('duplex').map((o) => o.id), pto.overlaysForProperty('multi_2_4').map((o) => o.id), 'duplex → multi_2_4');
assert.deepStrictEqual(pto.overlaysForProperty('sfr'), [], 'single-family carries no extra property overlays');
assert.deepStrictEqual(pto.overlaysForProperty('spaceship'), [], 'an unknown property type has none');
ok('property-type aliases (condominium/duplex/sfr) resolve to the canonical catalog');

// --- transaction aliases resolve ---
assert.deepStrictEqual(pto.overlaysForTransaction('refi').map((o) => o.id), pto.overlaysForTransaction('rate_term').map((o) => o.id), 'refi → rate_term');
assert.ok(pto.overlaysForTransaction('cashout').some((o) => /seasoning/i.test(o.id)), 'cashout → cash_out (seasoning)');
ok('transaction-type aliases (refi/cashout) resolve to the canonical catalog');

// --- selectOverlays unions property + transaction ---
let sel = pto.selectOverlays({ propertyType: 'condo', transactionType: 'cash_out' });
assert.ok(sel.some((o) => o.scope === 'property' && /warrantab/i.test(o.label)), 'the condo overlay is selected');
assert.ok(sel.some((o) => o.scope === 'transaction' && /seasoning/i.test(o.id)), 'the cash-out overlay is selected');
assert.ok(sel.length >= 3, 'condo (2) + cash-out (2) overlays union');
ok('selectOverlays returns the union of property + transaction overlays for a context');

// --- a 2-4 unit purchase gets the rent-roll + the purchase-contract reminders ---
sel = pto.selectOverlays({ property_type: 'triplex', transaction: 'purchase' });
assert.ok(sel.some((o) => /rent roll/i.test(o.label)), 'rent-roll reminder for a 2-4 unit');
assert.ok(sel.some((o) => /purchase contract/i.test(o.label)), 'purchase-contract reminder');
ok('a 2-4 unit purchase surfaces both the rent-roll and purchase-contract reminders (snake_case aliases accepted)');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => pto.selectOverlays(null));
assert.deepStrictEqual(pto.selectOverlays(null), []);
assert.deepStrictEqual(pto.selectOverlays({}), [], 'no property/transaction → nothing');
assert.doesNotThrow(() => pto.selectOverlays({ propertyType: {}, transactionType: 42 }));
assert.doesNotThrow(() => pto.selectOverlays({ get propertyType() { throw new Error("boom"); } }));
assert.deepStrictEqual(pto.selectOverlays({ get transactionType() { throw new Error("boom"); } }), []);
assert.doesNotThrow(() => pto.overlaysForProperty(null));
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.38 property-transaction-overlays pure — ${passed} checks passed`);
