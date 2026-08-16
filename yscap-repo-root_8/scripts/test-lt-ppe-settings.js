#!/usr/bin/env node
'use strict';
/**
 * LT PPE settings/config resolution core — pure offline test (Phase 0).
 * Proves Rule #1's mechanics: product defaults, the tenant→org→default override chain, strict
 * validation, and that an invalid override never wins (falls through to a valid layer / the default).
 *
 *   node scripts/test-lt-ppe-settings.js
 */
const s = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function threws(fn) { try { fn(); return false; } catch { return true; } }

console.log('LT PPE settings — offline\n');

// 1) Product defaults (our seed choices) resolve when no overrides are supplied.
ok(s.resolve('pricing.correspondent_margin_milli').value === 250, 'default correspondent margin = 250 (0.250 pts, verified)');
ok(s.resolve('pricing.correspondent_margin_milli').source === 'product_default', 'default resolves as product_default');
ok(s.resolve('eligibility.result_mode').value === 'show_with_reasons', 'default eligibility mode shows reasons');
ok(s.resolve('pricing.rounding_mode').value === 'nearest_eighth', 'default rounding = nearest eighth');
ok(s.resolve('pricing.price_floor_milli').value === 98000, 'default price floor = 98.000');
ok(s.resolve('validation.price_tolerance_milli').value === 1, 'default price parity tolerance = 0.001');
ok(s.resolve('cutover.clean_weeks_required').value === 8, 'default clean-weeks-to-live = 8 (owner pre-fill)');
ok(s.resolve('program.default_channel').value === 'correspondent', 'default channel = correspondent (owner pre-fill)');
ok(s.resolve('ingestion.default_format').value === 'excel', 'default rate-sheet format = excel (owner pre-fill)');
ok(Array.isArray(s.resolve('lock.days_offered').value), 'default lock days is an array');

// 2) The override chain: tenant wins over org wins over product default (first hit wins).
const layers = {
  tenant: { 'pricing.correspondent_margin_milli': 375 },
  org: { 'pricing.correspondent_margin_milli': 300, 'eligibility.result_mode': 'hard_fail_only' },
};
ok(s.resolve('pricing.correspondent_margin_milli', layers).value === 375, 'tenant override wins over org + default');
ok(s.resolve('pricing.correspondent_margin_milli', layers).source === 'tenant', 'tenant source reported');
ok(s.resolve('eligibility.result_mode', layers).value === 'hard_fail_only', 'org override wins when tenant is silent');
ok(s.resolve('eligibility.result_mode', layers).source === 'org', 'org source reported');
ok(s.resolve('pricing.rounding_mode', layers).value === 'nearest_eighth', 'unset key falls to product default');

// 3) Strict validation.
ok(s.validateValue('pricing.correspondent_margin_milli', 250).ok, 'valid number passes');
ok(!s.validateValue('pricing.correspondent_margin_milli', 9999).ok, 'above-max number rejected');
ok(!s.validateValue('pricing.correspondent_margin_milli', -1).ok, 'below-min number rejected');
ok(!s.validateValue('pricing.correspondent_margin_milli', 12.5).ok, 'non-integer rejected for integer setting');
ok(!s.validateValue('pricing.correspondent_margin_milli', '250').ok, 'string rejected for number setting');
ok(s.validateValue('eligibility.result_mode', 'soft_warn').ok, 'valid enum option passes');
ok(!s.validateValue('eligibility.result_mode', 'whatever').ok, 'out-of-options enum rejected');
ok(s.validateValue('pricing.cumulative_adjustment_cap_milli', null).ok, 'null allowed for a nullable setting');
ok(!s.validateValue('pricing.price_floor_milli', null).ok, 'null rejected for a non-nullable setting');
ok(!s.validateValue('nope.not.a.key', 1).ok, 'unknown setting key rejected by validateValue');
ok(s.validateValue('lock.days_offered', [15, 30]).ok, 'valid json array passes');
ok(!s.validateValue('lock.days_offered', ['x']).ok, 'json array with wrong item type rejected');

// 4) An INVALID override never wins — it falls through to the next valid layer / the default, so a bad
//    config row can never poison pricing.
const bad = { tenant: { 'pricing.correspondent_margin_milli': 999999 }, org: { 'pricing.correspondent_margin_milli': 300 } };
ok(s.resolve('pricing.correspondent_margin_milli', bad).value === 300, 'invalid tenant override skipped → org value used');
const badBoth = { tenant: { 'eligibility.result_mode': 'garbage' } };
ok(s.resolve('eligibility.result_mode', badBoth).value === 'show_with_reasons', 'invalid override falls all the way to the product default');

// 5) resolveAll returns every setting; unknown key throws (a typo can't silently read undefined).
const all = s.resolveAll(layers);
ok(Object.keys(all.values).length === s.allDefinitions().length, 'resolveAll returns every defined setting');
ok(all.values['pricing.correspondent_margin_milli'] === 375 && all.sources['pricing.correspondent_margin_milli'] === 'tenant', 'resolveAll honors the override chain');
ok(threws(() => s.resolve('does.not.exist')), 'resolve throws on an unknown setting key (no silent undefined)');

// 6) Every definition is self-consistent (a default that fails its own validation would be a shipped bug).
for (const d of s.allDefinitions()) {
  const v = s.validateValue(d.key, d.default);
  ok(v.ok, `product default for "${d.key}" passes its own validation`);
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
