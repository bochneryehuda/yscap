'use strict';
/**
 * R5.37 — pure tests for state overlays (DRAFT advisory).
 * Proves it (1) returns a state's draft overlays by code or full name, (2) filters
 * by per-loan predicates (CEMA only on a refi, mansion tax only over $1MM, TX
 * 50(a)(6) only on cash-out), (3) marks EVERY overlay draft + advisory (never
 * enforced, no numbers changed), (4) returns nothing for an unknown state, and
 * (5) never throws — including on a hostile context that would break a predicate.
 */
const assert = require('assert');
const so = require('../src/lib/underwriting/state-overlays');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- every overlay is DRAFT + advisory (safety invariant) ---
for (const st of so.supportedStates()) {
  for (const o of so.overlaysForState(st)) {
    assert.strictEqual(o.status, 'draft', `${o.id} must be draft`);
    assert.strictEqual(o.severity, 'advisory', `${o.id} must be advisory`);
    assert.strictEqual(o.scope, 'state');
  }
}
ok('every state overlay ships as draft + advisory (never an enforced rule)');

// --- lookup by code and by full name ---
assert.ok(so.overlaysForState('NY').length >= 1);
assert.deepStrictEqual(so.overlaysForState('new york').map((o) => o.id), so.overlaysForState('NY').map((o) => o.id), 'full name resolves the same as the code');
assert.deepStrictEqual(so.overlaysForState('ZZ'), [], 'an unknown state has no overlays');
assert.deepStrictEqual(so.overlaysForState(null), []);
ok('overlaysForState resolves by 2-letter code or full name and is empty for an unknown state');

// --- NY CEMA applies to a refi, not a purchase ---
let refi = so.selectOverlays({ state: 'NY', transactionType: 'rate_term' });
assert.ok(refi.some((o) => /cema/i.test(o.id)), 'CEMA reminder applies on a NY refinance');
let purch = so.selectOverlays({ state: 'NY', transactionType: 'purchase' });
assert.ok(!purch.some((o) => /cema/i.test(o.id)), 'CEMA does not apply on a NY purchase');
assert.ok(purch.some((o) => o.kind === 'legal'), 'the attorney-closing reminder applies to any NY loan');
ok('NY CEMA reminder is selected on a refinance but not a purchase; the unconditional reminder always applies');

// --- NJ mansion tax only at/over $1MM ---
assert.ok(so.selectOverlays({ state: 'NJ', transactionType: 'purchase', purchasePrice: 1200000 }).some((o) => /mansion/i.test(o.label)), 'mansion tax at $1.2MM');
assert.ok(!so.selectOverlays({ state: 'NJ', transactionType: 'purchase', purchasePrice: 500000 }).some((o) => /mansion/i.test(o.label)), 'no mansion tax at $500k');
ok('NJ mansion-tax reminder is selected only at/over $1,000,000');

// --- TX 50(a)(6) only on cash-out ---
assert.ok(so.selectOverlays({ state: 'TX', transactionType: 'cash_out' }).some((o) => /a6|50\(a\)\(6\)|home-equity/i.test(o.id + o.label)), 'TX 50(a)(6) applies on cash-out');
assert.ok(!so.selectOverlays({ state: 'TX', transactionType: 'purchase' }).some((o) => o.id.includes(':a6')), 'TX 50(a)(6) does not apply on a purchase');
ok('TX home-equity 50(a)(6) caution is selected only on a cash-out');

// --- FL always attaches wind + flood (unconditional) ---
const fl = so.selectOverlays({ state: 'FL' });
assert.ok(fl.some((o) => /wind|hurricane/i.test(o.label)) && fl.some((o) => /flood/i.test(o.label)), 'FL wind + flood always apply');
ok('FL wind and flood reminders attach to any Florida loan');

// --- empty / junk input is safe (a hostile context cannot crash a predicate) ---
assert.doesNotThrow(() => so.selectOverlays(null));
assert.deepStrictEqual(so.selectOverlays(null), []);
assert.doesNotThrow(() => so.selectOverlays({ state: 'NJ', get purchasePrice() { throw new Error('boom'); } }));
assert.doesNotThrow(() => so.selectOverlays({ state: 'TX', transactionType: {} }));
assert.doesNotThrow(() => so.overlaysForState({}));
ok('empty / null / hostile input is safe (a throwing predicate never crashes selection)');

console.log(`\nR5.37 state-overlays pure — ${passed} checks passed`);
