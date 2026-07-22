'use strict';
/**
 * R5.11 — pure tests for the document family + version resolver.
 * Proves it groups a file's documents into families (same logical document) and
 * assigns each the right version state — current / superseded / draft / amendment
 * / duplicate — so exactly ONE current version drives the decision, an older copy
 * is superseded (and its id is the supersededSourceIds the downstream reopen /
 * evidence-invalidation machinery consumes), a draft never becomes authoritative,
 * an amendment modifies rather than replaces, and a re-upload is a duplicate.
 */
const assert = require('assert');
const dv = require('../src/lib/underwriting/document-version-resolver');
const { STATE } = dv;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const byId = (res, id) => res.documents.find((d) => d.id === id);

// --- two dated versions of the same document → newer current, older superseded ---
let r = dv.resolveVersions([
  { id: 'A1', docType: 'appraisal', subject: '12 Oak St', effectiveDate: '2026-01-10' },
  { id: 'A2', docType: 'appraisal', subject: '12 Oak St', effectiveDate: '2026-03-05' }, // newer
]);
assert.strictEqual(byId(r, 'A2').state, STATE.CURRENT, 'the newer-dated appraisal is current');
assert.strictEqual(byId(r, 'A1').state, STATE.SUPERSEDED, 'the older appraisal is superseded');
assert.deepStrictEqual(byId(r, 'A2').supersedes, ['A1'], 'current supersedes the older id (the reopen signal)');
const fam = r.families[0];
assert.strictEqual(fam.currentId, 'A2');
assert.strictEqual(fam.incompleteCurrent, false);
ok('two dated versions → newer is current, older superseded, current.supersedes carries the reopen signal');

// --- a DRAFT never becomes current while a real version exists — even if newer ---
r = dv.resolveVersions([
  { id: 'F', docType: 'appraisal', subject: '5 Elm', effectiveDate: '2026-02-01', filename: 'appraisal_final.pdf' },
  { id: 'D', docType: 'appraisal', subject: '5 Elm', effectiveDate: '2026-02-20', filename: 'appraisal_DRAFT.pdf' }, // newer but draft
]);
assert.strictEqual(byId(r, 'F').state, STATE.CURRENT, 'the non-draft is current even though the draft is newer');
assert.strictEqual(byId(r, 'D').state, STATE.DRAFT, 'the newer draft stays a draft, never authoritative');
assert.ok(!byId(r, 'F').supersedes.includes('D'), 'a draft is not "superseded" — it was never a real version');
ok('a draft never becomes current while a real version exists (even if the draft is newer)');

// --- an AMENDMENT modifies the current — it does not replace/supersede it ---
r = dv.resolveVersions([
  { id: 'OA', docType: 'operating_agreement', subject: 'ABC LLC', effectiveDate: '2025-06-01' },
  { id: 'OAA', docType: 'operating_agreement', subject: 'ABC LLC', effectiveDate: '2026-01-15', filename: 'OA_amendment_1.pdf' },
]);
assert.strictEqual(byId(r, 'OAA').state, STATE.AMENDMENT, 'the addendum is an amendment');
assert.strictEqual(byId(r, 'OA').state, STATE.CURRENT, 'the base operating agreement stays current');
assert.deepStrictEqual(byId(r, 'OA').supersedes, [], 'an amendment never supersedes the base document');
ok('an amendment modifies the current document rather than superseding it');

// --- a byte-identical re-upload is a DUPLICATE, not a new version ---
r = dv.resolveVersions([
  { id: 'B1', docType: 'bank_statement', subject: 'acct 1234', sha256: 'deadbeef', effectiveDate: '2026-02-28' },
  { id: 'B2', docType: 'bank_statement', subject: 'acct 1234', sha256: 'deadbeef', effectiveDate: '2026-02-28' }, // same bytes
]);
const dup = r.documents.find((d) => d.state === STATE.DUPLICATE);
assert.ok(dup, 'the re-upload is flagged duplicate');
assert.ok(dup.duplicateOf && dup.duplicateOf !== dup.id, 'the duplicate points at its canonical original');
assert.strictEqual(r.documents.filter((d) => d.state === STATE.CURRENT).length, 1, 'exactly one current remains');
ok('a byte-identical re-upload is a duplicate (points at the original), leaving one current');

// --- a NEAR-identical re-upload (no hash) is caught by text similarity ---
const body = 'account holder ABC LLC ending balance 42318 statement period february 2026 deposits withdrawals';
r = dv.resolveVersions([
  { id: 'N1', docType: 'bank_statement', subject: 'acct 9', text: body + ' page 1 of 1', effectiveDate: '2026-02-28' },
  { id: 'N2', docType: 'bank_statement', subject: 'acct 9', text: body + ' page 1 of 1 rescan', effectiveDate: '2026-02-28' },
]);
assert.strictEqual(r.documents.filter((d) => d.state === STATE.DUPLICATE).length, 1, 'the near-identical rescan is a duplicate');
ok('a near-identical rescan (no hash) is caught as a duplicate by text similarity');

// --- different subjects are DIFFERENT families (two properties never mix) ---
r = dv.resolveVersions([
  { id: 'P1', docType: 'appraisal', subject: '1 Main St', effectiveDate: '2026-01-01' },
  { id: 'P2', docType: 'appraisal', subject: '2 Main St', effectiveDate: '2026-01-01' },
]);
assert.strictEqual(r.families.length, 2, 'two subjects → two families');
assert.strictEqual(byId(r, 'P1').state, STATE.CURRENT);
assert.strictEqual(byId(r, 'P2').state, STATE.CURRENT, 'each property has its own current appraisal — neither supersedes the other');
ok('documents for different subjects form separate families (no cross-property supersession)');

// --- a family that is ALL drafts has no authoritative current (incompleteCurrent) ---
r = dv.resolveVersions([
  { id: 'DR1', docType: 'title', subject: '7 Pine', filename: 'title_draft.pdf', effectiveDate: '2026-02-01' },
  { id: 'DR2', docType: 'title', subject: '7 Pine', filename: 'title_preliminary.pdf', effectiveDate: '2026-02-10' },
]);
assert.strictEqual(r.families[0].currentId, null, 'no current when every version is a draft');
assert.strictEqual(r.families[0].incompleteCurrent, true, 'the family is flagged incomplete — chase the final');
assert.ok(r.documents.every((d) => d.state === STATE.DRAFT), 'all members stay drafts (none crowned current)');
ok('a family of only drafts has no current and is flagged incompleteCurrent');

// --- three versions: only the newest is current; both older ones superseded ---
r = dv.resolveVersions([
  { id: 'v1', docType: 'settlement', subject: 'file 100', effectiveDate: '2026-01-01' },
  { id: 'v3', docType: 'settlement', subject: 'file 100', effectiveDate: '2026-01-03' },
  { id: 'v2', docType: 'settlement', subject: 'file 100', effectiveDate: '2026-01-02' },
]);
assert.strictEqual(byId(r, 'v3').state, STATE.CURRENT);
assert.deepStrictEqual(byId(r, 'v3').supersedes.sort(), ['v1', 'v2'], 'the current supersedes BOTH older versions');
assert.strictEqual(byId(r, 'v1').state, STATE.SUPERSEDED);
assert.strictEqual(byId(r, 'v2').state, STATE.SUPERSEDED);
ok('with three versions only the newest is current and it supersedes both older ones');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => dv.resolveVersions(null));
assert.deepStrictEqual(dv.resolveVersions(null).documents, []);
assert.deepStrictEqual(dv.resolveVersions([]).families, []);
assert.doesNotThrow(() => dv.resolveVersions([{ docType: 'x' }, null, { id: 'z' }])); // missing id / null dropped
assert.strictEqual(dv.resolveVersions([{ id: 'only', docType: 'w9' }]).documents[0].state, STATE.CURRENT, 'a lone document is current');
ok('empty / null / id-less input is safe (never throws); a lone document is current');

console.log(`\nR5.11 document-version-resolver pure — ${passed} checks passed`);
