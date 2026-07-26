'use strict';
/**
 * R5.66 — pure tests for predictive underwriting. Guarantees: too little
 * history yields "insufficient_history" (never an invented number), a strong
 * peer set yields a high signal, and no hard funding "probability" is ever
 * asserted (funded-only survivorship honesty).
 */
const assert = require('assert');
const { forecast, headline, MIN_PEERS_FOR_SIGNAL } = require('../src/lib/underwriting/predictive');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// too few peers → insufficient_history, no signal invented.
let f = forecast({ count: 2, avgConditions: 6, bestMatchPct: 90 });
assert.strictEqual(f.hasEnoughHistory, false);
assert.strictEqual(f.fundabilitySignal, 'insufficient_history');
assert.strictEqual(f.confidence, 'low');
ok('too few peers → insufficient_history (no invented signal)');

// zero peers.
f = forecast(null);
assert.strictEqual(f.peerCount, 0);
assert.strictEqual(f.fundabilitySignal, 'insufficient_history');
assert.ok(/No similar funded deals/.test(f.basis));
ok('null summary → zero peers, insufficient history');

// a strong peer set → high signal + high confidence + expected conditions.
f = forecast({ count: 14, avgConditions: 6.3, bestMatchPct: 88, topInvestor: { label: 'deephaven', count: 9 } }, { avgClosingDays: 18 });
assert.strictEqual(f.hasEnoughHistory, true);
assert.strictEqual(f.fundabilitySignal, 'high');
assert.strictEqual(f.confidence, 'high');
assert.strictEqual(f.expectedConditions, 6.3);
assert.strictEqual(f.expectedClosingDays, 18);
assert.ok(/deephaven/.test(f.basis));
ok('a strong peer set → high signal + expected conditions + closing days');

// a moderate peer set.
f = forecast({ count: 6, avgConditions: 8, bestMatchPct: 60 });
assert.strictEqual(f.hasEnoughHistory, true);
assert.strictEqual(f.fundabilitySignal, 'moderate');
ok('a middling peer set → moderate signal');

// NEVER asserts a hard probability (survivorship honesty): no numeric percent
// field, signal is a category never 'low' from funded peers.
f = forecast({ count: 20, avgConditions: 5, bestMatchPct: 95 });
assert.ok(['high', 'moderate'].includes(f.fundabilitySignal), 'signal is a category, never a probability');
assert.strictEqual(f.fundingProbability, undefined, 'no hard funding-probability field is emitted');
ok('no hard funding probability is asserted (survivorship honesty)');

// headline is plain language.
assert.ok(/conditions expected/.test(headline(forecast({ count: 14, avgConditions: 6, bestMatchPct: 88 }, { avgClosingDays: 20 }))));
assert.ok(/Not enough/.test(headline(forecast({ count: 1 }))));
ok('headline renders plain-language summaries');

assert.strictEqual(MIN_PEERS_FOR_SIGNAL, 5);
ok('signal threshold is 5 peers');

console.log(`\nR5.66 predictive pure — ${passed} checks passed`);
