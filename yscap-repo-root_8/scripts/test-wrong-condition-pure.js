#!/usr/bin/env node
'use strict';
/** Pure tests for src/lib/underwriting/wrong-condition.js — no DB. */
const assert = require('assert');
const wc = require('../src/lib/underwriting/wrong-condition');

// ---- placement map is symmetric ----
assert.ok(wc.isValidPlacement('insurance', 'rtl_p4_insurance'));
assert.ok(wc.isValidPlacement('bank_statement', 'rtl_p3_assets'));
assert.ok(!wc.isValidPlacement('insurance', 'rtl_p3_assets'), 'insurance on assets condition → wrong');
assert.ok(!wc.isValidPlacement('operating_agreement', 'rtl_p1_id'), 'OA on ID condition → wrong');

// ---- the REAL live template codes must be recognized (2026-07-23 fix) ----
// Before the fix these primary codes were absent, so the detector silently
// no-op'd on insurance / entity / purchase-contract conditions.
assert.ok(wc.isValidPlacement('insurance', 'rtl_cond_insurance'), 'insurance on the real insurance condition → ok');
assert.ok(wc.isValidPlacement('operating_agreement', 'rtl_p1_llc'), 'OA on the real entity condition → ok');
assert.ok(wc.isValidPlacement('operating_agreement', 'rtl_llc_opagmt'), 'OA on the real operating-agreement condition → ok');
assert.ok(wc.isValidPlacement('purchase_contract', 'rtl_p1_contract'), 'contract on the real contract condition → ok');
assert.ok(wc.isValidPlacement('drivers_license', 'rtl_p1_id'), 'ID on the real ID condition → ok');
// And a WRONG doc on a real condition is now caught (was invisible before).
assert.ok(!wc.isValidPlacement('bank_statement', 'rtl_cond_insurance'), 'bank statement on the insurance condition → wrong');
assert.ok(!wc.isValidPlacement('insurance', 'rtl_p1_llc'), 'insurance on the entity condition → wrong');
assert.ok(!wc.isValidPlacement('operating_agreement', 'rtl_p1_contract'), 'OA on the contract condition → wrong');

// Unmapped codes get no opinion (treated as valid).
assert.ok(wc.isValidPlacement('bank_statement', 'rtl_appraisal_report_new_shiny_thing'));

// ---- analyze() ----
const r1 = wc.analyze({
  documentId: 'd1', checklistItemId: 'ci-1',
  conditionCode: 'rtl_p3_assets', conditionLabel: 'Bank statements',
  classifier: { docType: 'insurance', confidence: 0.91, pages: [1, 2] },
});
assert.strictEqual(r1.action, 'suggest_move');
assert.match(r1.reason, /insurance page/);
assert.match(r1.reason, /91% confident/);
assert.deepStrictEqual(r1.suggestedTargets, ['rtl_cond_insurance', 'rtl_p4_insurance', 'ins_binder', 'insurance', 'hoi']);

// Right doc on right condition → ok.
const r2 = wc.analyze({ conditionCode: 'rtl_p4_insurance', classifier: { docType: 'insurance', confidence: 0.88 } });
assert.strictEqual(r2.action, 'ok');

// Below the 0.75 confidence gate → we don't accuse.
const r3 = wc.analyze({ conditionCode: 'rtl_p3_assets', classifier: { docType: 'insurance', confidence: 0.6 } });
assert.strictEqual(r3.action, 'ok');

// Unmapped classifier type → silently allowed (no false accusation).
const r4 = wc.analyze({ conditionCode: 'rtl_p3_assets', classifier: { docType: 'exotic_type', confidence: 0.95 } });
assert.strictEqual(r4.action, 'ok');

// analyzeAndRecord — mock client, assert the suggestion shape.
let recorded = null;
const client = { query: async () => ({ rows: [] }) };
// Stub the ai-suggestions module the way the module wires it.
require.cache[require.resolve('../src/lib/underwriting/ai-suggestions')].exports = {
  record: async (_c, s) => { recorded = s; return { id: 'sug-1', deduped: false }; },
};
// Reload wrong-condition to pick up the stub.
delete require.cache[require.resolve('../src/lib/underwriting/wrong-condition')];
const wc2 = require('../src/lib/underwriting/wrong-condition');

(async () => {
  const out = await wc2.analyzeAndRecord(client, {
    applicationId: 'app-1', documentId: 'd-42', checklistItemId: 'ci-1',
    conditionCode: 'rtl_p3_assets', conditionLabel: 'Bank statements',
    classifier: { docType: 'insurance', confidence: 0.92, pages: [1, 2] },
    traceUrl: 'https://lf/x',
  });
  assert.strictEqual(out.action, 'suggest_move');
  assert.strictEqual(out.suggestionId, 'sug-1');
  assert.strictEqual(recorded.source, 'wrong_condition');
  assert.strictEqual(recorded.kind, 'info');
  assert.strictEqual(recorded.documentId, 'd-42');
  assert.strictEqual(recorded.checklistItemId, 'ci-1');
  assert.strictEqual(recorded.proposedAction.type, 'move_document');
  assert.strictEqual(recorded.proposedAction.from.checklistItemId, 'ci-1');
  assert.deepStrictEqual(recorded.proposedAction.to.candidateCodes, ['rtl_cond_insurance', 'rtl_p4_insurance', 'ins_binder', 'insurance', 'hoi']);
  assert.strictEqual(recorded.dedupeKey, 'wrong-condition:d-42');
  assert.strictEqual(recorded.traceUrl, 'https://lf/x');

  // Correct placement → no record.
  recorded = null;
  const out2 = await wc2.analyzeAndRecord(client, {
    applicationId: 'app-1', documentId: 'd-43', checklistItemId: 'ci-2',
    conditionCode: 'rtl_p4_insurance',
    classifier: { docType: 'insurance', confidence: 0.9 },
  });
  assert.strictEqual(out2.action, 'ok');
  assert.strictEqual(recorded, null, 'no suggestion recorded on a valid placement');

  console.log('test-wrong-condition-pure: placement map + analyze() + analyzeAndRecord() all pass');
})().catch(e => { console.error(e); process.exit(1); });
