'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — shadow enqueue gate
 * (src/pipeline/enqueue-on-upload.js). Pure: no DB, no network.
 *
 * Proves the gate is INERT by default and only opens for an enrolled family under shadow/v2:
 *  - default config (all OFF) → disabled, no enqueue attempted
 *  - shadow on but family not in UW_PIPELINE_V2_FAMILIES → family_not_enrolled
 *  - shadow on + enrolled family → gate open (enqueue attempted via injected db)
 *  - never throws (a throwing db is swallowed → { enqueued:false, reason:'error' })
 *  - no documentId → no_document
 */
const R = require('path').resolve(__dirname, '..');
const EU = require(R + '/src/pipeline/enqueue-on-upload');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const OFF = { v2Shadow: false, v2Enabled: false, v2Families: [] };
const SHADOW = { v2Shadow: true, v2Enabled: false, v2Families: ['bank_statement', 'insurance'] };
const FULLV2 = { v2Shadow: false, v2Enabled: true, v2Families: ['bank_statement'] };

(async function main() {
  // ---- shadowGate (pure) ----
  ok(EU.shadowGate('bank_statement', OFF).on === false && EU.shadowGate('bank_statement', OFF).reason === 'disabled', 'default config → disabled');
  ok(EU.shadowGate('bank_statement', SHADOW).on === true, 'shadow + enrolled family → open');
  ok(EU.shadowGate('BANK_STATEMENT', SHADOW).on === true, 'family match is case-insensitive');
  ok(EU.shadowGate('appraisal', SHADOW).on === false && EU.shadowGate('appraisal', SHADOW).reason === 'family_not_enrolled', 'shadow + non-enrolled family → family_not_enrolled');
  ok(EU.shadowGate('', SHADOW).on === false && EU.shadowGate('', SHADOW).reason === 'no_family', 'empty family → no_family');
  ok(EU.shadowGate('bank_statement', FULLV2).on === true, 'full-v2 (not shadow) + enrolled → open');
  ok(EU.shadowGate('insurance', FULLV2).on === false, 'full-v2 respects its own family list');

  // ---- maybeEnqueueUpload gating (with an injected fake db) ----
  let enqueued = null;
  const fakeDb = { query: async () => ({ rows: [] }) };
  // Stub job-queue via the payload path: we can't easily intercept require('./job-queue'),
  // so use a family NOT enrolled to prove the gate short-circuits BEFORE touching the db.
  const offRes = await EU.maybeEnqueueUpload(fakeDb, { documentId: 'd1', family: 'appraisal', pipelineCfg: SHADOW });
  ok(offRes.enqueued === false && offRes.reason === 'family_not_enrolled', 'gate closed → no enqueue, reason surfaced');

  const disabledRes = await EU.maybeEnqueueUpload(fakeDb, { documentId: 'd1', family: 'bank_statement', pipelineCfg: OFF });
  ok(disabledRes.enqueued === false && disabledRes.reason === 'disabled', 'disabled config → no enqueue');

  const noDocRes = await EU.maybeEnqueueUpload(fakeDb, { documentId: null, family: 'bank_statement', pipelineCfg: SHADOW });
  ok(noDocRes.enqueued === false && noDocRes.reason === 'no_document', 'gate open but no documentId → no_document');

  // ---- never throws: a throwing db (gate open, real enqueue path) is swallowed ----
  const throwDb = { query: async () => { throw new Error('db down'); } };
  const errRes = await EU.maybeEnqueueUpload(throwDb, { documentId: 'd1', family: 'bank_statement', pipelineCfg: SHADOW });
  ok(errRes.enqueued === false && errRes.reason === 'error', 'gate open + throwing db → swallowed, reason:error (never throws)');

  console.log(`test-enqueue-on-upload-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
