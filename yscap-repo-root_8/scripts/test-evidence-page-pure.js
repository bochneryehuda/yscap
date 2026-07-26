'use strict';
/**
 * R5.3 — pure tests for the source-page locator. No DB, no network.
 */
const assert = require('assert');
const { pageNumberForValue, makeFieldPager, _internals } = require('../src/lib/underwriting/evidence-page');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const pages = [
  { pageNumber: 1, text: 'PURCHASE AND SALE AGREEMENT\nSeller: Acme Holdings LLC' },
  { pageNumber: 2, text: 'Purchase Price: $250,000.00\nClosing Date August 15 2026' },
  { pageNumber: 3, text: 'Buyer: Jane Q. Doe   SSN xxx-xx-4776' },
];

// Exact text match.
assert.strictEqual(pageNumberForValue('Acme Holdings LLC', pages), 1);
ok('locates a name on its page');

// Money value: "$250,000.00" field matches "250000" digits-form on page 2.
assert.strictEqual(pageNumberForValue('$250,000.00', pages), 2);
ok('locates a money value via digits-only form');

// Number field 250000 also finds page 2.
assert.strictEqual(pageNumberForValue(250000, pages), 2);
ok('locates a numeric value');

// A value not present anywhere → null (never a wrong page).
assert.strictEqual(pageNumberForValue('Nonexistent Corp', pages), null);
ok('absent value returns null, not a guess');

// Empty / null inputs never throw.
assert.strictEqual(pageNumberForValue(null, pages), null);
assert.strictEqual(pageNumberForValue('x', pages), null);           // < 3 chars, no digits
assert.strictEqual(pageNumberForValue('anything', null), null);
assert.strictEqual(pageNumberForValue('anything', []), null);
ok('degenerate inputs return null, no throw');

// makeFieldPager caches + resolves per field.
const pager = makeFieldPager({ sellerName: 'Acme Holdings LLC', price: '$250,000.00', missing: 'ZZZ Corp' }, pages);
assert.strictEqual(pager('sellerName'), 1);
assert.strictEqual(pager('price'), 2);
assert.strictEqual(pager('missing'), null);
assert.strictEqual(pager('unknownField'), null);
ok('makeFieldPager resolves each field to its page');

// No pages → the pager is a constant null (safe to pass unconditionally).
const nullPager = makeFieldPager({ a: 'x' }, null);
assert.strictEqual(nullPager('a'), null);
ok('makeFieldPager with no pages is a null closure');

// needlesFor: builds normalized + digits + bare forms.
assert.ok(_internals.needlesFor('$1,234.50').includes('1234'));
assert.ok(_internals.needlesFor('Hello World').includes('hello world'));
assert.deepStrictEqual(_internals.needlesFor(null), []);
ok('needlesFor builds match candidates');

console.log(`\nR5.3 evidence-page pure: ${passed} checks passed`);
