#!/usr/bin/env node
'use strict';
/**
 * LT PPE universal rule/condition BUILDER — pure offline test (PPE item #48).
 * Proves the authoring layer: the four result kinds (LLPA points / margin+holdback /
 * eligibility disqualify / min-max price), createRule / duplicateRule / editRule,
 * scope + rescope to a dimension, immutability (new-out, input untouched, output frozen),
 * every VALIDATION REFUSAL (fail-closed on an unknown kind / dimension / value / cross-kind
 * field / bad predicate), and — the point of "reuse the existing shape" — that an authored
 * rule runs correctly through the REAL interpreter `rules.evaluateRules`.
 *
 *   node scripts/test-lt-ppe-rule-builder.js
 */
const assert = require('assert');
const B = require('../src/longterm/ppe/rule-builder');
const { evaluateRules } = require('../src/longterm/ppe/rules');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
// A refusal must throw a RuleBuilderError (never return a silently-malformed rule).
function refuses(fn, label) {
  let threw = false; let isBuilderErr = false;
  try { fn(); } catch (e) { threw = true; isBuilderErr = e && e.name === 'RuleBuilderError'; }
  ok(threw && isBuilderErr, `REFUSE: ${label}`);
}
function frozenDeep(x) {
  if (x && typeof x === 'object') {
    if (!Object.isFrozen(x)) return false;
    return Object.keys(x).every((k) => frozenDeep(x[k]));
  }
  return true;
}

console.log('LT PPE rule builder — offline\n');

// ============================================================================
// 1) The four RESULT KINDS build valid, frozen, canonical rules.
// ============================================================================

// (a) eligibility disqualify
{
  const r = B.addEligibility({ code: 'no_ny', declineReason: 'New York not eligible', when: { fact: 'state', op: 'eq', value: 'NY' } });
  ok(r.kind === 'eligibility' && r.declineReason === 'New York not eligible', 'addEligibility → eligibility rule with reason');
  ok(frozenDeep(r), 'addEligibility output is deep-frozen');
}

// (b) add-LLPA points
{
  const r = B.addLlpa({ code: 'llpa_lowfico', adjMilli: 250, dimension: 'fico', reason: 'FICO 640-659', when: { fact: 'fico', op: 'between', value: [640, 660] } });
  ok(r.kind === 'pricing' && r.adjustment.unit === 'points' && r.adjustment.adjMilli === 250, 'addLlpa → pricing points rule, adjMilli passthrough');
  ok(r.adjustment.category === 'fico' && r.adjustment.dimension === 'fico', 'addLlpa carries dimension/category');
}

// (c) margin & holdback
{
  const m = B.addMarginHoldback({ code: 'mrg_state', knob: 'margin', milli: 375, when: { fact: 'state', op: 'eq', value: 'TX' } });
  const h = B.addMarginHoldback({ code: 'hb_dscr', knob: 'holdback', milli: 125, when: { fact: 'dscr', op: 'lt', value: 1100 } });
  ok(m.kind === 'pricing' && m.adjustment.unit === 'margin' && m.adjustment.adjMilli === 375, 'addMarginHoldback margin → unit margin');
  ok(h.kind === 'pricing' && h.adjustment.unit === 'holdback' && h.adjustment.adjMilli === 125, 'addMarginHoldback holdback → unit holdback');
}

// (d) min / max price
{
  const floor = B.addPriceBound({ code: 'floor98', bound: 'min', priceMilli: 98000 });
  const cap = B.addPriceBound({ code: 'cap103', bound: 'max', priceMilli: 103000 });
  ok(floor.kind === 'bound' && floor.target === 'price' && floor.op === 'min' && floor.value === 98000, 'addPriceBound min → price floor bound');
  ok(cap.op === 'max' && cap.value === 103000, 'addPriceBound max → price ceiling bound');
}

// ============================================================================
// 2) createRule / duplicateRule / editRule — pure, immutable, validated.
// ============================================================================
{
  const base = B.createRule({ code: 'min_fico', kind: 'eligibility', declineReason: 'FICO below 660', when: { fact: 'fico', op: 'lt', value: 660 } });
  ok(base.source === 'base', 'createRule defaults source=base');

  // duplicate: new code, source untouched
  const dup = B.duplicateRule(base);
  ok(dup.code === 'min_fico_copy' && dup.declineReason === base.declineReason, 'duplicateRule → deterministic new code, copies body');
  const dup2 = B.duplicateRule(base, { code: 'min_fico_620', declineReason: 'FICO below 620', when: { fact: 'fico', op: 'lt', value: 620 } });
  ok(dup2.code === 'min_fico_620' && dup2.when.value === 620, 'duplicateRule with patch overrides code + body');

  // edit: shallow patch, re-validated, immutable
  const edited = B.editRule(base, { declineReason: 'FICO below 680', when: { fact: 'fico', op: 'lt', value: 680 } });
  ok(edited.when.value === 680 && edited.declineReason === 'FICO below 680', 'editRule applies the patch');
  ok(base.when.value === 660 && base !== edited, 'editRule does NOT mutate the input (immutable new-out)');

  // undefined in a patch DELETES a key
  const noWhen = B.editRule(base, { when: undefined });
  ok(!('when' in noWhen), 'editRule with when:undefined removes the key');
}

// ============================================================================
// 3) scope / rescope to ANY dimension.
// ============================================================================
{
  const r0 = B.addLlpa({ code: 'llpa_base', adjMilli: 125, dimension: 'ltv' });
  // scope onto a fresh (no when) rule
  const r1 = B.scopeRule(r0, { dimension: 'ltv', op: 'gte', value: 75000 });
  ok(r1.when && r1.when.fact === 'ltv' && r1.when.op === 'gte' && r1.when.value === 75000, 'scopeRule adds the first leaf as the when');
  // AND a second dimension
  const r2 = B.scopeRule(r1, { dimension: 'state', op: 'eq', value: 'FL' });
  ok(r2.when.all && r2.when.all.length === 2, 'scopeRule ANDs a second dimension into an all-of');
  // band form
  const rb = B.scopeRule(r0, { dimension: 'fico', min: 700, max: 720 });
  ok(rb.when.op === 'between' && rb.when.value[0] === 700 && rb.when.value[1] === 720, 'scopeRule band → between predicate');

  // rescope replaces the same dimension, keeps the other
  const r3 = B.rescopeRule(r2, { dimension: 'ltv', op: 'gte', value: 80000 });
  const ltvLeaf = r3.when.all.find((c) => c.fact === 'ltv');
  const stateLeaf = r3.when.all.find((c) => c.fact === 'state');
  ok(ltvLeaf.value === 80000 && stateLeaf.value === 'FL' && r3.when.all.length === 2, 'rescopeRule replaces the ltv leaf, keeps the state leaf, no duplication');
}

// ============================================================================
// 4) THE POINT — authored rules run through the REAL interpreter unchanged.
// ============================================================================
{
  const rules = [
    B.addEligibility({ code: 'no_ny', declineReason: 'New York not eligible', when: { fact: 'state', op: 'eq', value: 'NY' } }),
    B.scopeRule(B.addLlpa({ code: 'llpa_lowfico', adjMilli: 250, reason: 'low FICO' }), { dimension: 'fico', op: 'lt', value: 680 }),
    B.addPriceBound({ code: 'floor98', bound: 'min', priceMilli: 98000 }),
  ];
  const bad = evaluateRules(rules, { state: 'NY', fico: 640, price: 99000 });
  ok(!bad.eligible && bad.declines.some((d) => /New York/.test(d.reason)), 'authored eligibility rule declines through evaluateRules');
  ok(bad.adjustments.some((a) => a.adjMilli === 250 && a.unit === 'points'), 'authored LLPA accumulates through evaluateRules');
  ok(bad.bounds['price:min'] && bad.bounds['price:min'].value === 98000, 'authored price bound is collected through evaluateRules');

  const clean = evaluateRules(rules, { state: 'TX', fico: 720, price: 101000 });
  ok(clean.eligible && clean.adjustments.length === 0, 'a clean scenario is eligible with no LLPA fired');
}

// ============================================================================
// 5) VALIDATION REFUSALS — fail-closed, never a silently-malformed rule.
// ============================================================================

// missing / bad identity + kind
refuses(() => B.createRule({ kind: 'eligibility', declineReason: 'x' }), 'createRule without a code');
refuses(() => B.createRule({ code: 'x', kind: 'nonsense' }), 'createRule with an unknown kind');

// cross-kind field (the hybrid trap)
refuses(() => B.createRule({ code: 'x', kind: 'eligibility', declineReason: 'x', adjustment: { adjMilli: 1 } }), 'eligibility rule carrying an adjustment');
refuses(() => B.createRule({ code: 'x', kind: 'bound', target: 'price', op: 'min', value: 1, declineReason: 'x' }), 'bound carrying a declineReason');

// per-kind required fields
refuses(() => B.addEligibility({ code: 'x' }), 'eligibility without a declineReason');
refuses(() => B.createRule({ code: 'x', kind: 'bound', target: 'ltv', op: 'between', value: 5 }), "bound with op not in {min,max}");
refuses(() => B.createRule({ code: 'x', kind: 'bound', target: 'ltv', op: 'max', value: 'high' }), 'bound with a non-numeric value');
refuses(() => B.createRule({ code: 'x', kind: 'pricing' }), 'pricing without an adjustment');
refuses(() => B.addLlpa({ code: 'x', adjMilli: 12.5 }), 'LLPA with a non-integer adjMilli');
refuses(() => B.createRule({ code: 'x', kind: 'pricing', adjustment: { adjMilli: 1, unit: 'basispoints' } }), 'pricing with an unrecognized unit');

// margin/holdback specifics
refuses(() => B.addMarginHoldback({ code: 'x', knob: 'spread', milli: 100 }), 'margin/holdback with an unknown knob');
refuses(() => B.addMarginHoldback({ code: 'x', knob: 'margin', milli: -50 }), 'margin with a negative milli');

// predicate validity
refuses(() => B.createRule({ code: 'x', kind: 'eligibility', declineReason: 'x', when: { fact: 'fico', op: 'approx', value: 1 } }), 'when with an op outside LEAF_OPS');
refuses(() => B.createRule({ code: 'x', kind: 'eligibility', declineReason: 'x', when: { all: [null] } }), 'when with a null child in an all-of');
refuses(() => B.createRule({ code: 'x', kind: 'eligibility', declineReason: 'x', when: { fact: 'fico', op: 'gt', all: [] } }), 'when node mixing a leaf and a combinator');

// scope / rescope refusals — fail-closed on the dimension + the value kind
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'moon_phase', op: 'eq', value: 1 }), 'scope to an unknown dimension');
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'fico', op: 'weird', value: 1 }), 'scope with an invalid op');
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'state', op: 'eq', value: 'ZZ' }), 'scope state to a non-existent state code');
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'io', op: 'eq', value: 'yes' }), 'scope io to a non-boolean');
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'fico', op: 'eq', value: 700.5 }), 'scope fico to a non-integer');
refuses(() => B.scopeRule(B.addLlpa({ code: 'x', adjMilli: 1 }), { dimension: 'state', min: 1, max: 2 }), 'scope a min/max band on a non-numeric dimension');
refuses(() => B.duplicateRule({ code: 'a', kind: 'eligibility', declineReason: 'x' }, { code: 'a' }), 'duplicate with the same code as the source');

// rescope refuses to touch a dimension buried in a nested predicate
{
  const nested = B.createRule({ code: 'x', kind: 'pricing', adjustment: { adjMilli: 1 }, when: { any: [{ fact: 'fico', op: 'lt', value: 660 }, { fact: 'state', op: 'eq', value: 'NY' }] } });
  refuses(() => B.rescopeRule(nested, { dimension: 'fico', op: 'lt', value: 640 }), 'rescope a dimension nested inside an any-of');
}

// ============================================================================
// 6) validateRule is a pure predicate ({ ok, errors[] }), never throws.
// ============================================================================
{
  const v1 = B.validateRule({ code: 'ok', kind: 'eligibility', declineReason: 'x' });
  ok(v1.ok === true && v1.errors.length === 0, 'validateRule accepts a valid rule');
  const v2 = B.validateRule({ kind: 'pricing' });
  ok(v2.ok === false && v2.errors.length >= 2, 'validateRule reports every problem without throwing');
  ok(B.validateRule(null).ok === false, 'validateRule(null) → not ok, no throw');
}

// A sanity check that assert is wired (keeps the suite honest even if all ok()s pass).
assert.strictEqual(typeof B.validateRule, 'function');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
