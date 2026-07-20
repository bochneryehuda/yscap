'use strict';
/**
 * Unit tests for the completeness / stipulations engine (completeness.js). Pure — no AI/DB.
 * Verifies the required-doc matrix adapts to deal flags, per-item status, the completeness %,
 * and the prior-to-funding clear-to-close blockers.
 */
const assert = require('assert');
const { assessCompleteness, REQUIREMENTS } = require('../src/lib/underwriting/completeness');

const exts = (arr) => arr.map(([doc_type, status = 'analyzed', confidence = 'analyzed']) => ({ doc_type, status, confidence }));

// ---- Conditional requirements adapt to the deal flags ----
{
  const base = assessCompleteness({ isEntity: false, isAssignment: false }, [], []);
  const entity = assessCompleteness({ isEntity: true, isAssignment: false }, [], []);
  const assign = assessCompleteness({ isEntity: true, isAssignment: true }, [], []);
  assert.ok(entity.counts.total > base.counts.total, 'entity loans require the LLC stack');
  assert.ok(assign.counts.total > entity.counts.total, 'assignment deals require the assignment doc');
  assert.ok(entity.stipulations.some((s) => s.docType === 'operating_agreement'));
  assert.ok(!base.stipulations.some((s) => s.docType === 'operating_agreement'), 'no LLC docs on a non-entity file');
  assert.ok(assign.stipulations.some((s) => s.docType === 'assignment'));
}

// ---- Per-item status: missing / insufficient / received / cleared ----
{
  const findings = [
    { source: 'title', severity: 'fatal', status: 'open' },       // title present but blocked
    { source: 'insurance', severity: 'warning', status: 'open' }, // insurance present, under review
  ];
  const r = assessCompleteness({ isEntity: false, isAssignment: false }, exts([
    ['government_id'],            // clean → cleared
    ['purchase_contract'],       // clean → cleared
    ['title'],                   // fatal → insufficient
    ['insurance'],               // warning → received
    ['appraisal', 'error'],      // errored read → insufficient
    // bank_statement, credit_report, background_report, flood, settlement missing
  ]), findings);
  const byType = Object.fromEntries(r.stipulations.map((s) => [s.docType, s.status]));
  assert.strictEqual(byType.government_id, 'cleared');
  assert.strictEqual(byType.title, 'insufficient', 'a fatal finding makes it insufficient');
  assert.strictEqual(byType.insurance, 'received', 'a warning leaves it received (present, review)');
  assert.strictEqual(byType.appraisal, 'insufficient', 'an errored read is insufficient');
  assert.strictEqual(byType.bank_statement, 'missing');
}

// ---- Completeness % + PTF clear-to-close blockers ----
{
  // Everything cleared → 100% and no blockers.
  const all = REQUIREMENTS.filter((r) => r.required === 'always').map((r) => [r.docType, 'analyzed', 'analyzed']);
  const full = assessCompleteness({ isEntity: false, isAssignment: false }, exts(all), []);
  assert.strictEqual(full.completenessPct, 100);
  assert.strictEqual(full.ctcBlockers.length, 0);
  assert.ok(full.docsComplete);

  // Drop title (a PTF item) → below 100 and a PTF blocker appears.
  const noTitle = assessCompleteness({ isEntity: false, isAssignment: false },
    exts(all.filter(([t]) => t !== 'title')), []);
  assert.ok(noTitle.completenessPct < 100);
  assert.ok(noTitle.ctcBlockers.some((b) => b.docType === 'title'), 'missing title (PTF) blocks CTC');
  assert.ok(!noTitle.docsComplete);
}

// ---- REGRESSION (audit): a finding whose source isn't a docType (a PDF tampering scan filed
//      under 'fraud_scan') but carries the document_id must still count against that document ----
{
  const extractions = [
    { doc_type: 'bank_statement', status: 'analyzed', confidence: 'analyzed', document_id: 'doc-bank-1' },
  ];
  const findings = [
    { source: 'fraud_scan', severity: 'warning', status: 'open', document_id: 'doc-bank-1' }, // tampering on the bank doc
  ];
  const r = assessCompleteness({ isEntity: false, isAssignment: false }, extractions, findings);
  const bank = r.stipulations.find((s) => s.docType === 'bank_statement');
  assert.strictEqual(bank.status, 'received', 'a tampering warning on the doc → received, not cleared');
}

// ---- Owner + gating buckets are carried through ----
{
  const r = assessCompleteness({ isEntity: true }, [], []);
  const gs = r.stipulations.find((s) => s.docType === 'good_standing');
  assert.strictEqual(gs.owner, 'borrower');
  assert.strictEqual(gs.gating, 'PTF');
  const cr = r.stipulations.find((s) => s.docType === 'credit_report');
  assert.strictEqual(cr.owner, 'internal');
  assert.strictEqual(cr.gating, 'PTD');
}

// ---- ON_FILE: a document uploaded to its condition but NOT yet read is 'on_file', never a false
//      'missing' (owner-reported 2026-07-20: "files that have all the documents still show missing").
{
  // Nothing uploaded, nothing analyzed → truly missing (unchanged behavior).
  const none = assessCompleteness({ isEntity: false, isAssignment: false }, [], []);
  assert.strictEqual(none.stipulations.find((s) => s.docType === 'government_id').status, 'missing', 'no upload, no read → missing');
  assert.ok(none.trulyMissing.some((s) => s.docType === 'government_id'), 'truly-missing list includes it');

  // The SAME file, but the government ID + purchase contract are UPLOADED to their conditions
  // (attached) though not yet analyzed → 'on_file', and OUT of the truly-missing list.
  const attached = new Set(['government_id', 'purchase_contract']);
  const onFile = assessCompleteness({ isEntity: false, isAssignment: false }, [], [], attached);
  assert.strictEqual(onFile.stipulations.find((s) => s.docType === 'government_id').status, 'on_file', 'uploaded but unread → on_file');
  assert.strictEqual(onFile.stipulations.find((s) => s.docType === 'purchase_contract').status, 'on_file');
  assert.ok(!onFile.trulyMissing.some((s) => s.docType === 'government_id'), 'an on_file doc is NOT truly missing');
  assert.strictEqual(onFile.counts.on_file, 2, 'both attached docs counted on_file');
  // Appraisal still not uploaded → still missing (only the attached ones flipped).
  assert.strictEqual(onFile.stipulations.find((s) => s.docType === 'appraisal').status, 'missing');
  // on_file is still "outstanding" (not cleared) — it just isn't a false "missing".
  assert.ok(onFile.outstanding.some((s) => s.docType === 'government_id'));

  // Once READ + clean, it's cleared regardless of the attached set (analysis wins).
  const read = assessCompleteness({ isEntity: false }, [{ doc_type: 'government_id', status: 'analyzed', confidence: 'analyzed', document_id: 'd1' }], [], attached);
  assert.strictEqual(read.stipulations.find((s) => s.docType === 'government_id').status, 'cleared', 'analyzed + clean → cleared');
  // Accepts an array too (not just a Set).
  const arr = assessCompleteness({ isEntity: false }, [], [], ['title']);
  assert.strictEqual(arr.stipulations.find((s) => s.docType === 'title').status, 'on_file', 'attached accepts an array');
}

// ---- condition CODE -> expected docType (the "where to find each document" inverse map) ----
{
  const cm = require('../src/lib/underwriting/condition-map');
  assert.strictEqual(cm.expectedDocTypeForCode('rtl_cond_title'), 'title', 'the title condition holds the title commitment');
  assert.strictEqual(cm.expectedDocTypeForCode('rtl_cond_insurance'), 'insurance', 'the insurance condition holds evidence of insurance');
  assert.ok(cm.docTypesForCode('rtl_p1_llc').length >= 1, 'the entity condition holds one or more entity docs');
  assert.deepStrictEqual(cm.docTypesForCode('nope_not_a_code'), [], 'an unknown code maps to nothing (never guesses)');
}

console.log('test-underwriting-completeness: required-doc matrix + stipulation status + CTC blockers + on_file/linkage pass');
