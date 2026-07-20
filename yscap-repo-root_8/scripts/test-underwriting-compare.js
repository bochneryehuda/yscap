'use strict';
/** Unit tests for the shared comparison helpers (compare.js), esp. the address matcher. Pure. */
const assert = require('assert');
const { addrMatches, namesMatchLoose, entityMatch, withinMoney, toISODate, num, namesMatch } = require('../src/lib/underwriting/compare');

const A = (line1, zip) => ({ line1, city: 'x', state: 'NJ', zip });

// ---- addrMatches must require the STREET, not just house# + zip ----
assert.strictEqual(addrMatches(A('45 Elm St', '07030'), A('45 Elm Street', '07030')), true, 'same street (suffix variant) + house + zip → match');
assert.strictEqual(addrMatches(A('45 Elm St', '07030'), A('45 Oak Ave', '07030')), false, 'DIFFERENT street, same house# + zip → NOT a match (the bug)');
assert.strictEqual(addrMatches(A('45 Elm St', '07030'), A('47 Elm St', '07030')), false, 'different house number → not a match');
assert.strictEqual(addrMatches(A('45 Elm St', '07030'), A('45 Elm St', '07666')), false, 'different zip → not a match');
assert.strictEqual(addrMatches(A('45 N Elm St', '07030'), A('45 Elm Street', '07030')), true, 'a directional prefix does not break the match');
assert.strictEqual(addrMatches(A('45 Elm St Apt 2', '07030'), A('45 Elm St', '07030')), true, 'a unit designator is ignored');
// Missing house number on one side → fall back to street + zip.
assert.strictEqual(addrMatches({ line1: 'Elm St', zip: '07030' }, A('45 Elm St', '07030')), true, 'street + zip match when a house# is missing');

// ---- the other helpers still behave ----
assert.strictEqual(namesMatchLoose('John Smith', 'Smith, John'), true);
assert.strictEqual(namesMatchLoose('Jon Smith', 'John Smith'), false);
assert.strictEqual(entityMatch('Maple Grove Holdings LLC', 'Maple Grove Holdings, L.L.C.'), true);
assert.strictEqual(withinMoney(412000, 412000.4, 1), true);
assert.strictEqual(withinMoney(412000, 430000, 1), false);
assert.strictEqual(toISODate('05/15/1980'), '1980-05-15');

// ---- num: accounting-negative parentheses + diacritic-folded name matching (deep-audit) ----
assert.strictEqual(num('($1,234.00)'), -1234, 'a parenthesized figure is negative');
assert.strictEqual(num('$1,234.00'), 1234, 'a plain figure is positive');
assert.strictEqual(num(''), null); assert.strictEqual(num(null), null); assert.strictEqual(num('abc'), null);
assert.strictEqual(namesMatch('José Ramírez', 'Jose Ramirez'), true, 'diacritics fold so an accented name matches its OCR form');
assert.strictEqual(namesMatchLoose('José Ramírez', 'Jose Ramirez'), true);

console.log('✓ test-underwriting-compare: address street-matching + name/entity/money/date helpers pass');
