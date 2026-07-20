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

console.log('test-underwriting-completeness: required-doc matrix + stipulation status + CTC blockers pass');
