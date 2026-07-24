'use strict';
/**
 * Pure tests for the ISG guideline DISPOSITION layer (owner-directed 2026-07-24).
 * Proves the overlay stops turning back-office rules into "post this condition":
 *   - file_data (email) surfaces ONLY a known-empty slot, never a condition;
 *   - concern (non-arms-length) is silent unless a concern signal is present;
 *   - appraisal (rural / transferred) is silent until the appraisal is in;
 *   - closing_package (occupancy) is silent until the package is present;
 *   - a real document rule STILL becomes a coverage gap (no regression);
 *   - dispositionOf infers conservatively and never silences a document gap.
 */
const assert = require('assert');
const desk = require('../src/lib/underwriting/investor-guidelines/desk');
const corr = require('../src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec');
const bl = require('../src/lib/underwriting/investor-guidelines/bluelake-rtl-spec');

let n = 0;
const ok = (name) => { n++; console.log('  ok -', name); };
const D = desk.DISPOSITION;
const findCorr = (no) => corr.CONDITIONS.find((c) => c.cond_no === no);
const findBl = (no) => bl.CONDITIONS.find((c) => c.cond_no === no);
const flags = (res) => res.unhappy.map((u) => `${u.cond_no}:${u.flag}`).sort();

console.log('ISG disposition pure tests');

// 1 — dispositionOf: explicit wins; conservative inference; document is the default.
{
  assert.strictEqual(desk.dispositionOf({ disposition: 'concern' }), D.CONCERN, 'explicit wins');
  assert.strictEqual(desk.dispositionOf({ domain: 'non_arms_length' }), D.CONCERN, 'non_arms_length domain → concern');
  assert.strictEqual(desk.dispositionOf({ domain: 'rural' }), D.APPRAISAL, 'rural domain → appraisal');
  assert.strictEqual(desk.dispositionOf({ clears_by: 'internal_verification' }), D.FILE_DATA, 'internal_verification → file_data');
  assert.strictEqual(desk.dispositionOf({ clears_by: 'system_field_check' }), D.SYSTEM, 'system_field_check → system');
  // a genuine document rule (appraisal domain that is a real report) is NOT silenced by inference.
  assert.strictEqual(desk.dispositionOf({ domain: 'appraisal', clears_by: 'third_party_order' }), D.DOCUMENT, 'a real appraisal doc stays document');
  assert.strictEqual(desk.dispositionOf({ domain: 'title', clears_by: 'document_upload' }), D.DOCUMENT, 'default is document');
  // hostile input never throws.
  for (const bad of [null, undefined, 42, 'x', []]) assert.strictEqual(desk.dispositionOf(bad), D.DOCUMENT);
  ok('dispositionOf: explicit wins, conservative inference, document default, null-safe');
}

// 2 — the owner's named conditions carry the RIGHT disposition in the spec.
{
  assert.strictEqual(desk.dispositionOf(findCorr(1009)), D.FILE_DATA, 'email → file_data');
  assert.strictEqual(desk.dispositionOf(findCorr(3333)), D.CONCERN, 'non-arms-length → concern');
  assert.strictEqual(desk.dispositionOf(findCorr(3345)), D.APPRAISAL, 'rural → appraisal');
  assert.strictEqual(desk.dispositionOf(findCorr(3349)), D.APPRAISAL, 'appraisal transfer → appraisal');
  assert.strictEqual(desk.dispositionOf(findCorr(10023)), D.CLOSING_PACKAGE, 'occupancy cert → closing_package');
  assert.strictEqual(desk.dispositionOf(findBl(44)), D.CONCERN, 'Blue Lake non-arms-length → concern');
  assert.strictEqual(desk.dispositionOf(findBl(123)), D.APPRAISAL, 'Blue Lake rural → appraisal');
  ok('the named conditions (email/non-arms-length/rural/transfer/occupancy) carry the right disposition');
}

// 3 — NONE of the back-office rules surface as a coverage gap on a bare file (the owner's bug).
{
  const conds = [findCorr(1009), findCorr(3333), findCorr(3345), findCorr(3349), findCorr(10023)].filter(Boolean);
  const res = desk.assess({ conditions: conds, existingByCode: new Map(), signals: {}, noteBuyerKey: 'corrfirst', noteBuyerName: 'CorrFirst' });
  assert.strictEqual(res.unhappy.length, 0, 'no back-office rule shows as a condition on a bare file');
  assert.strictEqual(res.happy, true, 'the file is happy — nothing to post');
  ok('email / non-arms-length / rural / transfer / occupancy no longer surface as "post this condition"');
}

// 4 — file_data (email) surfaces ONLY a KNOWN-EMPTY slot — not when present, not when unknown.
{
  const c = [findCorr(1009)];
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: {} }).unhappy.length, 0, 'unknown email → silent');
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: { borrower_email: 'a@b.com' } }).unhappy.length, 0, 'present email → silent');
  const empty = desk.assess({ conditions: c, existingByCode: new Map(), signals: { borrower_email: '  ' } });
  assert.strictEqual(empty.unhappy.length, 1, 'known-empty email → one informational item');
  assert.strictEqual(empty.unhappy[0].flag, 'info_missing');
  assert.strictEqual(empty.unhappy[0].severity, 'warning', 'informational, not fatal — never a condition');
  ok('file_data: surfaces ONLY a known-empty slot (info_missing), silent when present or unknown');
}

// 5 — concern (non-arms-length) is silent until a concern signal exists; then it explains why.
{
  const c = [findCorr(3333)];
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: {} }).unhappy.length, 0, 'no concern → silent');
  const hit = desk.assess({ conditions: c, existingByCode: new Map(), signals: { non_arms_length_concern: true } });
  assert.strictEqual(hit.unhappy.length, 1, 'a concern signal surfaces the item');
  assert.strictEqual(hit.unhappy[0].flag, 'concern');
  assert.ok(hit.unhappy[0].required_evidence, 'the item carries the explanation of what to verify');
  ok('concern: silent without a signal; surfaces WITH an explanation when a relationship signal fires');
}

// 6 — appraisal (rural) is silent until the appraisal is in; then a rural signal escalates.
{
  const c = [findCorr(3345)];
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: { appraisal_rural: true } }).unhappy.length, 0, 'no appraisal yet → silent even if a stray flag is set');
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: { appraisal_present: true } }).unhappy.length, 0, 'appraisal in, not rural → silent');
  const rural = desk.assess({ conditions: c, existingByCode: new Map(), signals: { appraisal_present: true, appraisal_rural: true } });
  assert.strictEqual(rural.unhappy.length, 1, 'appraisal in AND rural → surfaces');
  assert.strictEqual(rural.unhappy[0].flag, 'appraisal_review');
  ok('appraisal: silent until the appraisal is in; a rural finding then surfaces an appraisal review');
}

// 7 — closing_package (occupancy) is silent until the package is present.
{
  const c = [findCorr(10023)];
  assert.strictEqual(desk.assess({ conditions: c, existingByCode: new Map(), signals: {} }).unhappy.length, 0, 'no package yet → silent');
  const pkg = desk.assess({ conditions: c, existingByCode: new Map(), signals: { closing_package_present: true } });
  assert.strictEqual(pkg.unhappy.length, 1, 'once the package is in, a missing occupancy cert is a gap');
  assert.strictEqual(pkg.unhappy[0].flag, 'coverage_gap');
  ok('closing_package: silent until the DocuSign/term-sheet package is present, then a real gap');
}

// 8 — a REAL document rule still becomes a coverage gap (no regression) + a real conflict still fatal.
{
  const feas = corr.CONDITIONS.find((x) => x.cond_no === 2193);   // construction feasibility (document)
  const sc = corr.CONDITIONS.find((x) => x.cond_no === 3035);     // seller concession (evaluator)
  const res = desk.assess({ conditions: [feas, sc], existingByCode: new Map(), signals: { seller_concession_pct: 9, is_renovation: true }, noteBuyerKey: 'corrfirst' });
  assert.ok(res.unhappy.some((u) => u.flag === 'coverage_gap' && u.severity === 'fatal'), 'the feasibility document gap is still a fatal coverage gap');
  assert.ok(res.unhappy.some((u) => u.flag === 'conflict'), 'the over-cap seller concession is still a fatal conflict');
  ok('no regression: a real document rule is still a coverage gap; a real conflict is still surfaced');
}

console.log(`\nISG disposition: ${n} checks passed`);
