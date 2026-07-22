'use strict';
/**
 * R6.5 — pure tests for the stale-registration detector. Guarantees: a change to
 * any priced input flags stale (with the before/after), an unchanged file is
 * not stale, and a key the registration never priced on can't make it stale.
 */
const assert = require('assert');
const { detectStale, PRICING_INPUT_KEYS } = require('../src/lib/underwriting/stale-detector');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const registered = { loan_amount: 500000, arv: 700000, program: 'gold', fico: 720, property_type: 'sfr' };

// unchanged → not stale.
let r = detectStale({ ...registered }, registered);
assert.strictEqual(r.stale, false);
assert.deepStrictEqual(r.changed, []);
ok('an unchanged file is not stale');

// ARV changed → stale, with before/after.
r = detectStale({ ...registered, arv: 750000 }, registered);
assert.strictEqual(r.stale, true);
assert.strictEqual(r.changed.length, 1);
assert.deepStrictEqual(r.changed[0], { key: 'arv', from: 700000, to: 750000 });
ok('a changed ARV flags stale with before/after');

// FICO changed → stale (audit scenario 13).
r = detectStale({ ...registered, fico: 680 }, registered);
assert.ok(r.stale && r.changed.some((c) => c.key === 'fico'));
ok('a changed FICO flags stale');

// program changed → stale.
r = detectStale({ ...registered, program: 'standard' }, registered);
assert.ok(r.stale && r.changed.some((c) => c.key === 'program'));
ok('a changed program flags stale');

// a value CLEARED (present in registered, absent in current) is a change.
r = detectStale({ loan_amount: 500000, arv: 700000, program: 'gold', fico: 720 }, registered); // property_type dropped
assert.ok(r.stale && r.changed.some((c) => c.key === 'property_type' && c.to === null));
ok('a cleared priced value flags stale');

// a cent-level difference does NOT flag stale (rounding tolerance).
r = detectStale({ ...registered, loan_amount: 500000.004 }, registered);
assert.strictEqual(r.stale, false, 'within a cent → not stale');
ok('a sub-cent difference is not stale');

// a key the registration never priced on can't make it stale.
r = detectStale({ ...registered, some_other_field: 'x' }, registered);
assert.strictEqual(r.stale, false);
ok('a key not in the registered snapshot cannot make it stale');

// case-insensitive program comparison.
r = detectStale({ ...registered, program: 'Gold' }, registered);
assert.strictEqual(r.stale, false, '"Gold" == "gold"');
ok('string inputs compare case-insensitively');

// the priced-input key set is complete (the load-bearing set).
for (const k of ['loan_amount', 'arv', 'program', 'fico', 'rehab_budget', 'is_assignment']) {
  assert.ok(PRICING_INPUT_KEYS.includes(k), `priced input ${k}`);
}
ok('the priced-input key set covers the pricing inputs');

console.log(`\nR6.5 stale-detector pure — ${passed} checks passed`);
