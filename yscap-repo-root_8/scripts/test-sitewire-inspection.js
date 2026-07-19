'use strict';
/* Sitewire inspection-method policy — the coordinator's per-file choice vs. the rule's
   auto/allowed methods + fee. NO DB (resolveInspection is pure). Run:
   node scripts/test-sitewire-inspection.js */
const assert = require('assert');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://unused'; // silence the db warn
const { resolveInspection } = require('../src/sitewire/orchestrator');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// A rule with both methods allowed, default virtual, distinct fees.
const bothRule = { inspection_method: 'mobile', allow_virtual: true, allow_physical: true, fee_cents_virtual: 29900, fee_cents_physical: 49900 };

// 1) No link / no coordinator choice -> the rule's DEFAULT method + its fee.
let r = resolveInspection(null, bothRule);
assert.strictEqual(r.method, 'mobile');
assert.strictEqual(r.feeKind, 'virtual');
assert.strictEqual(r.feeCents, 29900);
assert.strictEqual(r.allowVirtual, true);
assert.strictEqual(r.allowPhysical, true);
ok('default: no choice -> rule default (virtual) + virtual fee');

// 2) Coordinator override to physical (allowed) -> physical + physical fee.
r = resolveInspection({ inspection_method: 'traditional' }, bothRule);
assert.strictEqual(r.method, 'traditional');
assert.strictEqual(r.feeKind, 'physical');
assert.strictEqual(r.feeCents, 49900);
ok('override: coordinator switch to on-site -> on-site fee ($499)');

// 3) A stored choice the rule NO LONGER allows falls back to an allowed method (never forbidden).
const virtualOnly = { inspection_method: 'mobile', allow_virtual: true, allow_physical: false, fee_cents_virtual: 29900, fee_cents_physical: 49900 };
r = resolveInspection({ inspection_method: 'traditional' }, virtualOnly);
assert.strictEqual(r.method, 'mobile', 'physical not allowed -> falls back to the allowed virtual');
assert.strictEqual(r.feeKind, 'virtual');
assert.strictEqual(r.feeCents, 29900);
ok('guard: a forbidden stored method falls back to an allowed one (never a disallowed push)');

// 4) Physical-only rule with default virtual (contradiction) still yields an allowed method.
const physicalOnly = { inspection_method: 'mobile', allow_virtual: false, allow_physical: true, fee_cents_virtual: 29900, fee_cents_physical: 49900 };
r = resolveInspection(null, physicalOnly);
assert.strictEqual(r.method, 'traditional', 'virtual disallowed -> the only allowed method');
assert.strictEqual(r.feeKind, 'physical');
ok('guard: default method disallowed -> resolves to the allowed method');

// 5) Physical fee absent -> falls back to the virtual fee (never null/guessed as $0).
const noPhysFee = { inspection_method: 'traditional', allow_virtual: true, allow_physical: true, fee_cents_virtual: 29900, fee_cents_physical: null };
r = resolveInspection({ inspection_method: 'traditional' }, noPhysFee);
assert.strictEqual(r.method, 'traditional');
assert.strictEqual(r.feeCents, 29900, 'missing physical fee falls back to the virtual fee, not $0');
ok('fee: missing on-site fee falls back to the virtual fee (never $0)');

// 6) No rule at all -> safe default (virtual, $299), both methods notionally allowed.
r = resolveInspection(null, null);
assert.strictEqual(r.method, 'mobile');
assert.strictEqual(r.feeCents, 29900);
assert.strictEqual(r.allowVirtual, true);
assert.strictEqual(r.allowPhysical, true);
ok('default: no rule -> virtual @ $299, both allowed');

// 7) A blank/undefined stored method is treated as "no choice" (uses the default).
r = resolveInspection({ inspection_method: null }, bothRule);
assert.strictEqual(r.method, 'mobile');
ok('null stored method -> rule default');

console.log(`\nAll ${n} Sitewire inspection-policy checks passed.`);
