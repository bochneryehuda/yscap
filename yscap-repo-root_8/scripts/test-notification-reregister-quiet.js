/**
 * The borrower is emailed a new term sheet ONLY when a headline number actually
 * changed on (re-)registration — an internal re-register for the same stuff sends
 * no nudge (src/lib/product-registration.js borrowerTermsKey; the register routes
 * gate the borrower email on the persist result's `economicsChanged`).
 *
 * Owner-directed 2026-07-20: "Only email them again if any number really changed.
 * If it's just an internal re-register for the same stuff, don't send another
 * nudge email." The decision key is the borrower's headline loan terms — loan
 * amount, rate, cash-to-close, term, program, product — so a genuine change to
 * any of those re-notifies and a no-op re-register stays silent.
 *
 * Pure-function test — no DB needed.
 */
const assert = require('assert');
const { borrowerTermsKey } = require('../src/lib/product-registration');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// A baseline registration.
const base = { program: 'gold', productLabel: 'Gold - Fix & Flip', noteRate: 0.1025, totalLoan: 150000, quote: { cashToClose: 30000, sizing: { initialAdvance: 120000, rehabHoldback: 30000 } }, inputs: { term: 12 } };
const key = (o) => borrowerTermsKey(o);

// Same numbers (even re-computed as new objects) → same key → NO new email.
assert.strictEqual(key(base), key({ ...base, quote: { cashToClose: 30000, sizing: { initialAdvance: 120000, rehabHoldback: 30000 } }, inputs: { term: 12 } }), 'identical headline numbers produce an identical key');
// Cent-level recompute noise on a NON-headline field must not change the key.
assert.strictEqual(key(base), key({ ...base, quote: { cashToClose: 30000, origination: 4321, reserveRequirement: 999, sizing: { initialAdvance: 120000, rehabHoldback: 30000 } } }), 'a non-headline field (origination/reserve) does not change the key');
// A fractional total that floors to the same whole dollars → same key.
assert.strictEqual(key(base), key({ ...base, totalLoan: 150000.49 }), 'sub-dollar rounding of the loan amount does not change the key');
ok('an internal re-register with the same headline numbers yields the SAME key (no new borrower email)');

// Each headline number, when it REALLY changes, flips the key (→ new email).
assert.notStrictEqual(key(base), key({ ...base, totalLoan: 160000 }), 'a changed loan amount changes the key');
assert.notStrictEqual(key(base), key({ ...base, noteRate: 0.1075 }), 'a changed rate changes the key');
assert.notStrictEqual(key(base), key({ ...base, quote: { cashToClose: 34000 } }), 'a changed cash-to-close changes the key');
assert.notStrictEqual(key(base), key({ ...base, inputs: { term: 18 } }), 'a changed term changes the key');
assert.notStrictEqual(key(base), key({ ...base, program: 'standard' }), 'a changed program changes the key');
assert.notStrictEqual(key(base), key({ ...base, productLabel: 'Gold - Ground Up' }), 'a changed product changes the key');
// A SPLIT-ONLY change: same total loan / rate / term / cash-to-close, but the
// money advanced at closing vs. held back moves — a real borrower-facing change.
assert.notStrictEqual(key(base), key({ ...base, quote: { cashToClose: 30000, sizing: { initialAdvance: 110000, rehabHoldback: 40000 } } }), 'a changed advance/holdback split changes the key even when the total + cash-to-close are identical');
ok('any real change to a headline number (amount/rate/cash-to-close/term/program/product/advance split) flips the key (a new email fires)');

// The register routes' gate: first registration (no previous key) always notifies.
const economicsChanged = (prevKey, newKey) => prevKey == null || prevKey !== newKey;
assert.strictEqual(economicsChanged(null, key(base)), true, 'the FIRST registration always notifies the borrower');
assert.strictEqual(economicsChanged(key(base), key(base)), false, 'a same-numbers re-register does NOT notify');
assert.strictEqual(economicsChanged(key(base), key({ ...base, totalLoan: 160000 })), true, 'a changed-numbers re-register DOES notify');
ok('the gate: first register notifies; same-numbers re-register is silent; changed-numbers re-register notifies');

console.log(`\nAll ${n} re-register-quiet checks passed.`);
