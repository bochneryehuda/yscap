'use strict';

/**
 * Standalone test for src/lib/borrower-safe.js (no test runner in this repo).
 * Run with:  node test/borrower-safe.test.js   — exits non-zero on any failure.
 *
 * Covers the partner-name scrub (S5-01/S2-01) and the address-protecting
 * variant used at the notify chokepoint (audit fix: "Churchill"/"Blue Lake"
 * collide with real place names and must survive inside a property address).
 */
const assert = require('assert');
const { scrubText, scrubTextExcept, scrubFields, hasPartnerName, PROGRAM } = require('../src/lib/borrower-safe');

let n = 0;
const eq = (got, exp, msg) => { n++; assert.strictEqual(got, exp, `${msg}\n  got: ${JSON.stringify(got)}\n  exp: ${JSON.stringify(exp)}`); };

// --- scrubText: replaces every partner name + variants ---
eq(scrubText('BlueLake payoff letter'), `${PROGRAM} payoff letter`, 'BlueLake');
eq(scrubText('Blue Lake condition'), `${PROGRAM} condition`, 'Blue Lake (space)');
eq(scrubText('Blue-Lake condition'), `${PROGRAM} condition`, 'Blue-Lake (hyphen)');
eq(scrubText('Temple View'), PROGRAM, 'Temple View');
eq(scrubText('TempleView'), PROGRAM, 'TempleView');
eq(scrubText('the RCN condition'), `the ${PROGRAM} condition`, 'RCN');
eq(scrubText('Churchill / Fidelis'), `${PROGRAM} / ${PROGRAM}`, 'two names');
eq(scrubText('CHURCHILL'), PROGRAM, 'ALLCAPS');
eq(scrubText("Churchill's docs"), `${PROGRAM}'s docs`, 'possessive');
eq(scrubText('BlueLake program'), PROGRAM, 'no "program program" duplication');
eq(scrubText('Two months of bank statements'), 'Two months of bank statements', 'clean text untouched');
eq(scrubText('Gold Standard program'), 'Gold Standard program', 'already-clean untouched');
eq(scrubText(''), '', 'empty');
eq(scrubText(null), null, 'null passthrough');
eq(scrubText(42), 42, 'number passthrough');

// --- hasPartnerName ---
eq(hasPartnerName('BlueLake x'), true, 'hasPartnerName true');
eq(hasPartnerName('clean text'), false, 'hasPartnerName false');

// --- scrubTextExcept: protect legitimate values that collide with names ---
const addr = '12 Churchill Lane, Austin, TX';
const protect = ['YSL-123', addr, 'Blue Lake Holdings LLC'];
eq(scrubTextExcept(`"BlueLake payoff" added on YSL-123 · ${addr}`, protect),
   `"${PROGRAM} payoff" added on YSL-123 · ${addr}`, 'scrub label, keep address');
eq(scrubTextExcept(`Update on ${addr}`, protect), `Update on ${addr}`, 'address survives');
eq(scrubTextExcept(`Temple View review on ${addr}`, protect),
   `${PROGRAM} review on ${addr}`, 'unprotected name still scrubbed');
// digit-collision guard: masking must not corrupt digits already in the text
eq(scrubTextExcept(`Loan 0 1 2 for ${addr}`, [addr]), `Loan 0 1 2 for ${addr}`, 'digits safe');
eq(scrubTextExcept('RCN review', []), `${PROGRAM} review`, 'empty protect = full scrub');
eq(scrubTextExcept(null, protect), null, 'non-string passthrough');

// --- scrubFields: shallow, non-mutating ---
const src = { label: 'BlueLake doc', keep: 'Churchill Lane', n: 5 };
const out = scrubFields(src, ['label']);
eq(out.label, `${PROGRAM} doc`, 'scrubFields scrubs named key');
eq(out.keep, 'Churchill Lane', 'scrubFields leaves other keys');
eq(src.label, 'BlueLake doc', 'scrubFields does not mutate input');

console.log(`ALL ${n} assertions passed`);
