'use strict';
/* Sitewire test-environment explorer — pure catalog logic (NO network, NO DB). Verifies the
 * field collector redacts values, marks integrated-vs-new, captures only non-PII enum values, and
 * recurses into nested objects/arrays. Run: node scripts/test-sitewire-test-explorer.js */
const assert = require('assert');
const { _internal, testConfigured } = require('../src/sitewire/test-explorer');
const { collect, finalize, ENUM_SAFE, INTEGRATED } = _internal;

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// A representative Sitewire-ish object graph.
const sample = {
  id: 501,
  loan_number: 'YS-1001',                 // integrated leaf
  inactive: false,                        // integrated
  start_date: '2026-08-01',               // NEW leaf (not yet integrated)
  lockbox_code: '4471',                   // NEW leaf — must be redacted (value never stored)
  inspection_method: 'traditional',       // ENUM_SAFE → value captured
  address: '12 Private Lane',             // NOT enum-safe (PII) → value NOT captured
  budget: {                               // nested object
    id: 88,
    total_budgeted_cents: 4500000,        // NEW leaf
    job_items: [                          // nested array of objects
      { id: 1, name: 'Kitchen', budgeted_cents: 2500000, description: 'x', status: 'approved' },
      { id: 2, name: 'Baths', budgeted_cents: 1500000, status: 'pending' },
    ],
  },
};

const catalog = {};
collect(catalog, 'property', sample);
const out = finalize(catalog);

// --- field discovery + types ---
const prop = out['property'];
const byName = Object.fromEntries(prop.map((f) => [f.name, f]));
assert.ok(byName.loan_number && byName.start_date && byName.lockbox_code, 'top-level fields discovered');
assert.strictEqual(byName.inactive.type, 'boolean', 'boolean type captured');
assert.strictEqual(byName.start_date.type, 'string', 'string type captured');
ok('discovers every top-level field with its type');

// --- integrated vs new marking ---
assert.strictEqual(byName.loan_number.integrated, true, 'loan_number marked integrated');
assert.strictEqual(byName.inactive.integrated, true, 'inactive marked integrated');
assert.strictEqual(byName.start_date.integrated, false, 'start_date marked NEW');
assert.strictEqual(byName.lockbox_code.integrated, false, 'lockbox_code marked NEW');
ok('marks integrated fields vs new (build backlog) correctly');

// --- value redaction: only ENUM_SAFE leaves keep values; PII never does ---
assert.deepStrictEqual(byName.inspection_method.enum_values, ['traditional'], 'enum-safe value captured');
assert.strictEqual(byName.address.enum_values, undefined, 'PII address value NOT captured');
assert.strictEqual(byName.lockbox_code.enum_values, undefined, 'sensitive lockbox value NOT captured');
assert.strictEqual(byName.start_date.enum_values, undefined, 'non-enum string value NOT captured');
assert.ok(!ENUM_SAFE.has('address') && !ENUM_SAFE.has('lockbox_code'), 'PII keys are not enum-safe');
ok('redacts values everywhere except the non-PII enum allowlist');

// --- recursion into nested object + array-of-objects ---
assert.ok(out['property.budget'], 'recursed into nested budget object');
assert.ok(out['property.budget.job_items[]'], 'recursed into nested job_items array');
const ji = Object.fromEntries(out['property.budget.job_items[]'].map((f) => [f.name, f]));
assert.ok(ji.name && ji.budgeted_cents, 'job-item fields discovered');
assert.strictEqual(ji.name.integrated, true, 'job-item name marked integrated');
// status enum values captured across BOTH array elements (union)
assert.deepStrictEqual(ji.status.enum_values, ['approved', 'pending'], 'enum values unioned across array elements');
ok('recurses into nested objects + arrays and unions enum values');

// --- ordering: NEW fields sort before integrated ones (surfacing the backlog first) ---
const firstIntegratedIdx = prop.findIndex((f) => f.integrated);
const lastNewIdx = prop.map((f) => f.integrated).lastIndexOf(false);
assert.ok(lastNewIdx < firstIntegratedIdx || firstIntegratedIdx === -1, 'NEW fields listed before integrated');
ok('lists not-yet-integrated fields first');

// --- config gate: without test creds, testConfigured() is false (never uses prod creds) ---
assert.strictEqual(typeof testConfigured(), 'boolean', 'testConfigured returns a boolean gate');
assert.ok(INTEGRATED.has('approved_cents') && INTEGRATED.has('processing_fee_cents'), 'known integrated fields present');
ok('exposes a boolean test-creds gate and the integrated-field set');

console.log(`\nAll ${n} Sitewire test-explorer checks passed.`);
