'use strict';
/**
 * #215 — pure tests for committee PROVIDER assignment. Proves: with no second
 * provider every specialist runs on the primary (byte-identical to before); with a
 * second provider the panel is a deterministic MIX of both (real independence); and
 * nothing throws.
 */
const assert = require('assert');
const p = require('../src/lib/ai/committee-providers');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const KEYS = ['identity', 'entity', 'credit', 'fraud'];

// 1. No second provider → every specialist on the primary (unchanged behavior).
{
  const a = p.assignProviders(KEYS, { secondAvailable: false });
  assert.ok(KEYS.every((k) => a[k] === p.PRIMARY), 'all primary when no second provider');
  ok('with no second provider, every specialist runs on the primary (unchanged)');
}

// 2. Second provider available → a deterministic MIX of both providers.
{
  const a = p.assignProviders(KEYS, { secondAvailable: true });
  const used = new Set(Object.values(a));
  assert.ok(used.has(p.PRIMARY) && used.has(p.SECOND), 'the panel spans BOTH providers');
  // deterministic: odd index → second
  assert.strictEqual(a.identity, p.PRIMARY);
  assert.strictEqual(a.entity, p.SECOND);
  assert.strictEqual(a.credit, p.PRIMARY);
  assert.strictEqual(a.fraud, p.SECOND);
  // stable across calls
  assert.deepStrictEqual(p.assignProviders(KEYS, { secondAvailable: true }), a);
  ok('with a second provider, the panel is a deterministic mix of both models');
}

// 3. A single-specialist panel still runs (index 0 → primary), so it never routes the
//    only reviewer to a possibly-unavailable second provider by itself.
{
  const a = p.assignProviders(['fraud'], { secondAvailable: true });
  assert.strictEqual(a.fraud, p.PRIMARY, 'the sole specialist uses the primary');
  ok('a single-specialist panel keeps the primary provider');
}

// 4. clientFor resolves modules with the expected interface.
{
  const prim = p.clientFor(p.PRIMARY);
  const sec = p.clientFor(p.SECOND);
  assert.strictEqual(typeof prim.available, 'function');
  assert.strictEqual(typeof prim.complete, 'function');
  assert.strictEqual(typeof sec.available, 'function');
  assert.strictEqual(typeof sec.complete, 'function');
  // unknown → primary (never undefined)
  assert.strictEqual(typeof p.clientFor('nope').complete, 'function');
  ok('clientFor resolves both provider modules (available + complete)');
}

// 5. Hostile input never throws.
{
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.doesNotThrow(() => p.assignProviders(bad, { secondAvailable: true }));
    assert.doesNotThrow(() => p.assignProviders(bad, bad));
  }
  assert.deepStrictEqual(p.assignProviders(null, {}), {});
  ok('assignProviders never throws on hostile input');
}

console.log(`\ncommittee-providers pure — ${passed} checks passed`);
