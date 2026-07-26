'use strict';
/**
 * P0 — pure tests for the extraction + finding accuracy aggregator. Proves it
 * scores how accurate each extracted FIELD is (per field + per document type)
 * and how often a human AGREES with each finding CODE, and surfaces the worst
 * offenders (most-corrected fields, noisiest false-positive codes). Advisory.
 */
const assert = require('assert');
const ea = require('../src/lib/ai/extraction-accuracy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- field accuracy: a field corrected 1 of 3 times reads 0.667 accuracy ---
const fa = ea.fieldAccuracy([
  { docType: 'bank_statement', field: 'ending_balance', extracted: '42318.55', confirmed: '42318.55', corrected: false },
  { docType: 'bank_statement', field: 'ending_balance', extracted: '42313.55', confirmed: '42318.55', corrected: true },
  { docType: 'bank_statement', field: 'ending_balance', extracted: '900.00', confirmed: '900.00', corrected: false },
  { docType: 'appraisal', field: 'arv', extracted: '500000', confirmed: '500000', corrected: false },
]);
assert.strictEqual(fa.totals.reviews, 4);
assert.strictEqual(fa.totals.corrections, 1);
const bal = fa.byField['bank_statement.ending_balance'];
assert.strictEqual(bal.reviews, 3);
assert.strictEqual(bal.corrections, 1);
assert.strictEqual(bal.correctionRate, +(1 / 3).toFixed(4));
assert.strictEqual(bal.accuracy, +(1 - 1 / 3).toFixed(4));
assert.strictEqual(fa.byDocType.appraisal.accuracy, 1, 'appraisal.arv never corrected → 100% accurate');
ok('fieldAccuracy scores each field + document type by correction rate');

// --- corrected inferred from a value mismatch when the flag is absent ---
const fa2 = ea.fieldAccuracy([{ docType: 'title', field: 'vesting', extracted: 'ABC LLC', confirmed: 'ABC L.L.C.' }]);
assert.strictEqual(fa2.byField['title.vesting'].corrections, 1, 'a value mismatch counts as a correction');
ok('a correction is inferred from an extracted≠confirmed mismatch when no flag is given');

// --- finding agreement: a code dismissed 2 of 4 times = 50% false positive ---
const fg = ea.findingAgreement([
  { code: 'arv_defensibility', decision: 'accepted' },
  { code: 'arv_defensibility', decision: 'dismissed' },
  { code: 'arv_defensibility', decision: 'dismissed' },
  { code: 'arv_defensibility', decision: 'severity_changed' },
  { code: 'ofac_confirmed_match', decision: 'accepted' },
]);
const arv = fg.byCode.arv_defensibility;
assert.strictEqual(arv.decisions, 4);
assert.strictEqual(arv.dismissed, 2);
assert.strictEqual(arv.falsePositiveRate, 0.5);
assert.strictEqual(arv.agreementRate, 0.5);
assert.strictEqual(fg.byCode.ofac_confirmed_match.agreementRate, 1, 'a never-dismissed code has 100% agreement');
ok('findingAgreement scores each code by human agreement / false-positive rate');

// --- worst offenders: most-corrected field + noisiest false-positive code ---
const wo = ea.worstOffenders(fa, fg, { minReviews: 3 });
assert.ok(wo.fields.some((f) => f.field === 'ending_balance'), 'the corrected field surfaces as a worst offender');
assert.ok(wo.codes.some((c) => c.code === 'arv_defensibility'), 'the noisy code surfaces as a worst offender');
ok('worstOffenders ranks the most-corrected fields + noisiest false-positive codes');

// --- below the min-reviews threshold, nothing is flagged (not enough evidence) ---
const wo2 = ea.worstOffenders(fa, fg, { minReviews: 100 });
assert.deepStrictEqual(wo2.fields, []);
assert.deepStrictEqual(wo2.codes, []);
ok('worstOffenders withholds a verdict until there is enough evidence');

// --- empty / junk input is safe ---
assert.deepStrictEqual(ea.fieldAccuracy([]).totals, { reviews: 0, corrections: 0 });
assert.deepStrictEqual(ea.findingAgreement(null).totals, { decisions: 0, dismissed: 0 });
assert.doesNotThrow(() => ea.worstOffenders(null, null));
ok('empty / null input returns a safe zeroed scoreboard (never throws)');

console.log(`\nP0 extraction-accuracy pure — ${passed} checks passed`);
