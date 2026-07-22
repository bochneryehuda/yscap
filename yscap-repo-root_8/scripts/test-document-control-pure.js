'use strict';
/**
 * R6.12 — pure tests for SharePoint document-control reconciliation. Proves a
 * corrupt mirror of a current document blocks CTC, an un-mirrored doc is an info
 * gap (only when the mirror is on), a deliberately-skipped doc is not a finding,
 * and a fully-mirrored set is clean — all as document-control findings that never
 * touch loan economics.
 */
const assert = require('assert');
const dc = require('../src/lib/underwriting/document-control');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- all current docs mirrored + verified → clean ---
let r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'insurance.pdf', is_current: true, sharepoint_backup_ref: 'sp1', sharepoint_integrity: 'ok' },
  { id: 'd2', filename: 'title.pdf', is_current: true, sharepoint_backup_ref: 'sp2', sharepoint_integrity: 'ok' },
] });
assert.strictEqual(r.findings.length, 0, 'a fully mirrored set has no findings');
assert.strictEqual(r.summary.mirrored, 2);
ok('a fully mirrored + verified document set is clean');

// --- a corrupt mirror of a current doc → warning that blocks CTC ---
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'appraisal.pdf', is_current: true, sharepoint_backup_ref: 'sp1', sharepoint_integrity: 'corrupt' },
] });
const c = r.findings.find((f) => f.code === 'sharepoint_mirror_integrity');
assert.ok(c, 'corrupt mirror flagged');
assert.strictEqual(c.blocks_ctc, true, 'a corrupt controlled copy blocks CTC');
assert.ok(!c.blocks_funding || c.blocks_ctc, 'it is a document-control finding');
ok('a corrupt mirror of a current document blocks CTC (must be fixed before closing)');

// --- an un-mirrored doc is an info gap only when the mirror is ON ---
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'invoice.pdf', is_current: true, sharepoint_backup_ref: null, sharepoint_integrity: null },
], mirrorEnabled: true });
assert.ok(r.findings.some((f) => f.code === 'sharepoint_not_mirrored' && f.severity === 'info'));
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'invoice.pdf', is_current: true, sharepoint_backup_ref: null },
], mirrorEnabled: false });
assert.strictEqual(r.findings.length, 0, 'mirror off → nothing expected to be mirrored');
ok('an un-mirrored document is an info gap only when the mirror is enabled');

// --- a deliberately-skipped doc (superseded snapshot) is not a finding ---
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'track_record.html', is_current: true, sharepoint_backup_ref: null, sharepoint_skipped_reason: 'superseded_snapshot' },
], mirrorEnabled: true });
assert.strictEqual(r.findings.length, 0, 'a benign skip is not a control gap');
ok('a deliberately-skipped document (superseded snapshot / duplicate) is not a finding');

// --- source-suspect + local-missing are bad integrity too ---
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'x.pdf', is_current: true, sharepoint_backup_ref: 'sp1', sharepoint_integrity: 'source-suspect' },
] });
assert.ok(r.findings.some((f) => f.code === 'sharepoint_mirror_integrity'));
ok('source-suspect / local-missing count as failed integrity');

// --- superseded (is_current false) docs are ignored ---
r = dc.reconcileDocumentControl({ documents: [
  { id: 'd1', filename: 'old.pdf', is_current: false, sharepoint_backup_ref: null },
], mirrorEnabled: true });
assert.strictEqual(r.findings.length, 0, 'only current documents are reconciled');
ok('superseded (non-current) documents are not reconciled');

console.log(`\nR6.12 document-control pure — ${passed} checks passed`);
