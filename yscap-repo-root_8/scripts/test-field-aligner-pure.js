'use strict';
/**
 * R5.16 — pure tests for the field-to-span aligner. Guarantees: exact + money +
 * token matches align to the right line, and a value with no good match returns
 * null (never a false alignment — a wrong span is worse than none).
 */
const assert = require('assert');
const { align, alignToSpan } = require('../src/lib/underwriting/field-aligner');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const lines = [
  { text: 'RESIDENTIAL PURCHASE AGREEMENT', page: 1, polygon: [{ x: 0, y: 0 }], id: 'L1' },
  { text: 'Purchase Price: $850,000.00', page: 3, polygon: [{ x: 0.1, y: 0.4 }], id: 'L2' },
  { text: 'Buyer: ABC Property Holdings LLC', page: 1, polygon: [{ x: 0.1, y: 0.2 }], id: 'L3' },
  { text: 'Seller: John Q Smith', page: 1, polygon: [{ x: 0.1, y: 0.25 }], id: 'L4' },
];

// money: "$850,000" aligns to the price line regardless of formatting.
let m = align('$850,000', lines);
assert.strictEqual(m.id, 'L2', 'money value aligns to the price line');
assert.strictEqual(m.page, 3);
assert.ok(m.confidence >= 0.9);
ok('a money value aligns to the correct line (format-insensitive)');

// entity name aligns to the buyer line via token overlap.
m = align('ABC Property Holdings LLC', lines);
assert.strictEqual(m.id, 'L3', 'entity name aligns to the buyer line');
assert.strictEqual(m.confidence, 1, 'exact substring is full confidence');
ok('an entity name aligns to the correct line');

// a partial name still aligns (token coverage).
m = align('ABC Property Holdings', lines);
assert.strictEqual(m.id, 'L3');
ok('a partial entity name still aligns via token coverage');

// a value with NO good match returns null (never a false alignment).
m = align('1600 Pennsylvania Avenue', lines);
assert.strictEqual(m, null, 'an unrelated value does not falsely align');
ok('a value with no good match returns null (no false alignment)');

// empty / missing inputs are safe.
assert.strictEqual(align('', lines), null);
assert.strictEqual(align('x', []), null);
assert.strictEqual(align(null, lines), null);
ok('empty / missing inputs return null');

// alignToSpan shapes a recordSpan payload.
const span = alignToSpan('$850,000', lines);
assert.strictEqual(span.pageNumber, 3);
assert.strictEqual(span.spanType, 'line');
assert.ok(span.quote.includes('850,000'));
assert.ok(span.extractorConfidence >= 0.9);
ok('alignToSpan shapes an evidence-ledger recordSpan payload');

// the confidence floor is honored (a weak overlap below floor → null).
m = align('Seller Financing Addendum', lines, { minConfidence: 0.7 });
assert.strictEqual(m, null, 'a weak match below the floor is rejected');
ok('the confidence floor is honored');

console.log(`\nR5.16 field-aligner pure — ${passed} checks passed`);
