'use strict';
/**
 * PURE test — the shared semantic term reading (src/lib/term-text.js), the fix
 * for the owner-reported 2026-07-24 "Term: 12 → 12 Months" re-register loop.
 * No DB / no deps, always runs.  node scripts/test-term-text-pure.js
 *
 * Keep in sync with the SQL twin pilot_term_norm() (db/288) — every equality
 * asserted here must hold for the SQL function too.
 */
const R = require('path').resolve(__dirname, '..');
const { termKey, termsEquivalent, termWritebackText } = require(R + '/src/lib/term-text');
const freeze = require(R + '/src/lib/inbound-economics-freeze');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---- termKey: months, spellings, years, words, blanks ----
ok(termKey('12') === '12', 'bare "12" → 12');
ok(termKey('12 Months') === '12', '"12 Months" → 12');
ok(termKey('12 months') === '12', 'lower-case months → 12');
ok(termKey(' 12 mo ') === '12', 'whitespace + "mo" → 12');
ok(termKey('12-month') === '12', 'hyphenated → 12');
ok(termKey('18 Months') === '18', '"18 Months" → 18');
ok(termKey(12) === '12', 'numeric 12 → "12"');
ok(termKey('30 year') === '360', '"30 year" → 360 (years ×12, never collides with 30 months)');
ok(termKey('15 Year') === '180', '"15 Year" → 180');
ok(termKey('2 yrs') === '24', '"2 yrs" → 24');
ok(termKey('Interest only') === 'interest only', 'word-only value compares as words');
ok(termKey('Other') === 'other', '"Other" → other');
ok(termKey(null) === null && termKey('') === null && termKey('   ') === null, 'null/blank → null');
ok(termKey('012 Months') === '12' && termKey('06') === '6', 'leading zeros strip (parity with pilot_term_norm ::numeric::text — audit 2026-07-24)');

// ---- termsEquivalent: THE bug case + real changes ----
ok(termsEquivalent('12', '12 Months') === true, 'THE BUG: "12" ≡ "12 Months" (never a pricing change)');
ok(termsEquivalent('12 Months', '12 months') === true, 'case-only difference is not a change');
ok(termsEquivalent('12 Months', '18 Months') === false, 'a REAL term change is still a change');
ok(termsEquivalent('30 year', '12 Months') === false, 'years vs months differ');
ok(termsEquivalent('30 year', '30 Months') === false, '"30 year" is NOT "30 Months"');
ok(termsEquivalent('Interest only', 'Other') === false, 'different word-only values differ');
ok(termsEquivalent(null, '12 Months') === false, 'blank → set is a (real) change for the trigger');

// ---- termWritebackText: registration write-back preserves the spelling ----
ok(termWritebackText('12 Months', 12) === '12 Months', 'same months → the existing "12 Months" spelling is PRESERVED');
ok(termWritebackText('12', 12) === '12', 'same months → the existing bare "12" is also preserved (no churn either way)');
ok(termWritebackText('12 Months', 18) === '18 Months', 'a REAL change writes the new "<n> Months" label');
ok(termWritebackText(null, 12) === '12 Months', 'no prior text → the friendly "<n> Months" label');
ok(termWritebackText('', 12) === '12 Months', 'blank prior text → the friendly label');
ok(termWritebackText('Interest only', 12) === '12 Months', 'a word-only prior text never masquerades as a month count');
ok(termWritebackText('30 year', 12) === '12 Months', 'a year-term prior text is replaced on a real RTL registration');
ok(termWritebackText('12 Months', null) === '12 Months', 'no registered months → leave the file text as-is');

// ---- the inbound economics freeze uses the same semantics for `term` ----
ok(freeze.fieldSame('term', '12 Months', '12') === true, 'freeze: ClickUp "12 Months" over portal "12" is NOT a frozen-economics conflict');
ok(freeze.fieldSame('term', '18 Months', '12 Months') === false, 'freeze: a real term change is still held');
ok(freeze.fieldSame('loan_amount', '500000', '500000.00') === true, 'freeze: numeric compare unchanged for figures');
ok(freeze.fieldSame('program', 'gold', 'standard') === false, 'freeze: text fields other than term keep strict compare');
const changed = freeze.changedFrozenFields({ term: '12 Months' }, { term: '12' });
ok(changed.length === 0, 'freeze end-to-end: a cosmetic term echo produces NO held change');
const changed2 = freeze.changedFrozenFields({ term: '18 Months' }, { term: '12 Months' });
ok(changed2.length === 1 && changed2[0].field === 'term', 'freeze end-to-end: a real term change is held');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
