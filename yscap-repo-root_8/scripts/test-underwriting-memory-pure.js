'use strict';
/** R5.55 — pure tests for underwriting-memory similarity + aggregation. */
const assert = require('assert');
const { scoreSimilarity, summarizePeers, _internals } = require('../src/lib/underwriting/underwriting-memory');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const subj = { program: 'DSCR', loan_type: 'Purchase', property_type: 'SFR', loan_amount: 200000, as_is_value: 250000 };

// Identical attributes → full score.
{
  const { score, matched } = scoreSimilarity(subj, { ...subj });
  assert.strictEqual(score, 1, 'identical → 1.0');
  assert.ok(matched.includes('program') && matched.includes('ltv') && matched.includes('loan_size'));
}
ok('identical loan scores 1.0');

// Same program + type but very different size/LTV → partial.
{
  const { score } = scoreSimilarity(subj, { program: 'DSCR', loan_type: 'Purchase', property_type: 'SFR', loan_amount: 900000, as_is_value: 950000 });
  // program(3)+loanType(2)+propertyType(2) = 7/10; LTV differs (0.8 vs 0.95 → >0.10), size differs → 0.7
  assert.ok(score >= 0.69 && score <= 0.71, `partial ~0.7, got ${score}`);
}
ok('program+type match but size/LTV differ → ~0.7');

// Totally different program → low.
{
  const { score } = scoreSimilarity(subj, { program: 'Gold', loan_type: 'Refi', property_type: 'Multi 5+', loan_amount: 50000, as_is_value: 500000 });
  assert.ok(score < 0.2, `dissimilar → low, got ${score}`);
}
ok('dissimilar loan scores low');

// Missing attributes never throw and simply do not match.
{
  const { score } = scoreSimilarity(subj, {});
  assert.strictEqual(score, 0, 'empty peer matches nothing');
  assert.strictEqual(scoreSimilarity({}, {}).score, 0);
}
ok('missing attributes → 0, no throw');

// ltvOf: as-is preferred, ARV fallback, null when no value.
assert.strictEqual(_internals.ltvOf({ loan_amount: 100, as_is_value: 200 }), 0.5);
assert.strictEqual(_internals.ltvOf({ loan_amount: 100, arv: 400 }), 0.25);
assert.strictEqual(_internals.ltvOf({ loan_amount: 100 }), null);
ok('ltvOf prefers as-is, falls back to ARV, null without value');

// summarizePeers aggregates.
{
  const scored = [
    { app: { loan_amount: 200000, as_is_value: 250000, lender: 'Fidelis' }, score: 0.9, conditionCount: 6 },
    { app: { loan_amount: 300000, as_is_value: 400000, lender: 'Fidelis' }, score: 0.7, conditionCount: 8 },
  ];
  const s = summarizePeers(scored);
  assert.strictEqual(s.count, 2);
  assert.strictEqual(s.avgLoanAmount, 250000);
  assert.strictEqual(s.avgConditions, 7);
  assert.strictEqual(s.topInvestor.label, 'fidelis');
  assert.strictEqual(s.topInvestor.count, 2);
  assert.strictEqual(s.bestMatchPct, 90);
}
ok('summarizePeers averages amount/conditions + finds top investor');

assert.strictEqual(summarizePeers([]), null);
assert.strictEqual(summarizePeers(null), null);
ok('empty peer set → null');

console.log(`\nR5.55 underwriting-memory pure: ${passed} checks passed`);
