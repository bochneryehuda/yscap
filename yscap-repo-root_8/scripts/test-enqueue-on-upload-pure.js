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
const ALL = { v2Shadow: true, v2Enabled: false, v2Families: ['all'] };
const STAR = { v2Shadow: true, v2Enabled: false, v2Families: ['*'] };

(async function main() {
  // ---- shadowGate (pure) ----
  ok(EU.shadowGate('bank_statement', OFF).on === false && EU.shadowGate('bank_statement', OFF).reason === 'disabled', 'default config → disabled');
  ok(EU.shadowGate('bank_statement', SHADOW).on === true, 'shadow + enrolled family → open');
  ok(EU.shadowGate('BANK_STATEMENT', SHADOW).on === true, 'family match is case-insensitive');
  ok(EU.shadowGate('appraisal', SHADOW).on === false && EU.shadowGate('appraisal', SHADOW).reason === 'family_not_enrolled', 'shadow + non-enrolled family → family_not_enrolled');
  ok(EU.shadowGate('', SHADOW).on === false && EU.shadowGate('', SHADOW).reason === 'no_family', 'empty family → no_family');
  ok(EU.shadowGate('bank_statement', FULLV2).on === true, 'full-v2 (not shadow) + enrolled → open');
  ok(EU.shadowGate('insurance', FULLV2).on === false, 'full-v2 respects its own family list');

  // ---- "all" / "*" enrollment: every family opts in (owner-directed 2026-07-26 widen) ----
  ok(EU.shadowGate('bank_statement', ALL).on === true && EU.shadowGate('bank_statement', ALL).reason === 'enrolled_all', '"all" → any known family enrolled');
  ok(EU.shadowGate('appraisal', ALL).on === true && EU.shadowGate('appraisal', ALL).reason === 'enrolled_all', '"all" → a previously-unlisted family is enrolled too');
  ok(EU.shadowGate('anything_new', ALL).on === true, '"all" → even an unrecognized family enrolls');
  ok(EU.shadowGate('appraisal', STAR).on === true && EU.shadowGate('appraisal', STAR).reason === 'enrolled_all', '"*" is an alias for "all"');
  ok(EU.shadowGate('', ALL).on === false && EU.shadowGate('', ALL).reason === 'no_family', '"all" still needs a family on the document (empty → no_family)');
  ok(EU.shadowGate('bank_statement', { v2Shadow: false, v2Enabled: false, v2Families: ['all'] }).on === false, '"all" is inert while shadow/v2 are both OFF');

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

  // ================= VSLICE-7: enqueueUploadedDocument (every eligible upload) =================
  const CM = require(R + '/src/lib/underwriting/condition-map');
  // A real condition code whose expected doc type is NOT "insurance" (so we can prove the
  // template-code family wins OVER a docKind of "insurance").
  const codeEntry = Object.keys(CM.CODE_TO_DOCTYPES)
    .map((c) => [c, CM.expectedDocTypeForCode(c)])
    .find(([, f]) => f && String(f).toLowerCase() !== 'insurance');
  ok(!!codeEntry, 'condition-map has a code mapping to a non-insurance family (test precondition)');
  const someCode = codeEntry && codeEntry[0];
  const mappedFam = codeEntry && String(codeEntry[1]).trim().toLowerCase();

  // A fake db that (a) answers the family-derivation query, (b) satisfies job-queue.enqueue's
  // INSERT, and (c) records calls + the INSERT params so we can assert the derived family.
  function makeDb({ code = null, throwChecklist = false } = {}) {
    const db = { calls: [], insertParams: null };
    db.query = async (sql, params) => {
      db.calls.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 60));
      if (/FROM checklist_items ci/i.test(sql)) {
        if (throwChecklist) throw new Error('checklist boom');
        return { rows: code ? [{ condition_code: code }] : [] };
      }
      if (/INSERT INTO document_pipeline_jobs/i.test(sql)) { db.insertParams = params; return { rows: [{ id: 'job1' }] }; }
      return { rows: [] };   // job-queue.enqueue adopt-SELECTs come back empty → fresh insert
    };
    return db;
  }

  // (1) Flags OFF → disabled BEFORE any db work (cheap gate — behavior-identical to today).
  let touched = false;
  const noWorkDb = { query: async () => { touched = true; throw new Error('must not query when off'); } };
  const offUpload = await EU.enqueueUploadedDocument(noWorkDb, { documentId: 'd1', docKind: 'insurance', pipelineCfg: OFF });
  ok(offUpload.enqueued === false && offUpload.reason === 'disabled' && touched === false, 'upload: flags off → disabled with ZERO db work');

  // (2) No documentId (flags on) → no_document.
  const noDoc = await EU.enqueueUploadedDocument(makeDb(), { documentId: null, docKind: 'insurance', pipelineCfg: ALL });
  ok(noDoc.enqueued === false && noDoc.reason === 'no_document', 'upload: no documentId → no_document');

  // (3) docKind-only (no checklist item) → family = docKind; no checklist query fired.
  const db3 = makeDb();
  const r3 = await EU.enqueueUploadedDocument(db3, { documentId: 'd3', loanId: 'L3', docKind: 'insurance', pipelineCfg: ALL });
  ok(r3.enqueued === true, 'upload: docKind-only → gate open, enqueued');
  ok(db3.insertParams && db3.insertParams[3] === 'insurance', 'upload: family derived from docKind is passed to the enqueue');
  ok(!db3.calls.some((c) => /checklist_items/i.test(c)), 'upload: no checklist query when there is no checklistItemId');

  // (4) checklist template code takes PRECEDENCE over docKind (mirrors auto-read.js:41).
  const db4 = makeDb({ code: someCode });
  const r4 = await EU.enqueueUploadedDocument(db4, { documentId: 'd4', checklistItemId: 'ci4', docKind: 'insurance', pipelineCfg: ALL });
  ok(r4.enqueued === true, 'upload: checklist item → enqueued');
  ok(db4.calls.some((c) => /checklist_items/i.test(c)), 'upload: checklist family query ran');
  ok(db4.insertParams && db4.insertParams[3] === mappedFam, 'upload: template-code family WINS over docKind');

  // (5) Never throws mid-derivation — a failing checklist query falls back to the docKind family.
  const db5 = makeDb({ code: someCode, throwChecklist: true });
  const r5 = await EU.enqueueUploadedDocument(db5, { documentId: 'd5', checklistItemId: 'ci5', docKind: 'insurance', pipelineCfg: ALL });
  ok(r5.enqueued === true && db5.insertParams && db5.insertParams[3] === 'insurance', 'upload: checklist query throws → falls back to docKind (never throws)');

  // (6) No family derivable at all (no checklist item, no docKind) → no_family, no job.
  const db6 = makeDb();
  const r6 = await EU.enqueueUploadedDocument(db6, { documentId: 'd6', pipelineCfg: ALL });
  ok(r6.enqueued === false && r6.reason === 'no_family', 'upload: no derivable family → no_family, no job');
  ok(!db6.calls.some((c) => /INSERT INTO document_pipeline_jobs/i.test(c)), 'upload: no family → no enqueue INSERT');

  // (7) Whole call never throws — a db that throws on everything is swallowed to error.
  const throwAll = { query: async () => { throw new Error('db down'); } };
  const r7 = await EU.enqueueUploadedDocument(throwAll, { documentId: 'd7', docKind: 'insurance', pipelineCfg: ALL });
  ok(r7.enqueued === false && r7.reason === 'error', 'upload: throwing db → swallowed to error (never throws)');

  // ================= VSLICE-8: jobMaxAttempts now actually controls the durable job =================
  // job-queue.enqueue INSERT params order: [documentId, loanId, pipelineVersion, documentFamily,
  // idempotencyKey, maxAttempts, payload] → index 5 is the retry cap the enqueue passes.
  const dbCap = makeDb();
  await EU.maybeEnqueueUpload(dbCap, { documentId: 'dcap', family: 'insurance', pipelineCfg: { v2Shadow: true, v2Families: ['all'], jobMaxAttempts: 9 } });
  ok(dbCap.insertParams && dbCap.insertParams[5] === 9, 'jobMaxAttempts: the configured cap (9) is passed to the enqueue');

  const dbNoCap = makeDb();
  await EU.maybeEnqueueUpload(dbNoCap, { documentId: 'dncap', family: 'insurance', pipelineCfg: { v2Shadow: true, v2Families: ['all'] } });
  ok(dbNoCap.insertParams && dbNoCap.insertParams[5] === null, 'jobMaxAttempts: absent in cfg → null (job-queue keeps the table default — behavior-identical)');

  console.log(`test-enqueue-on-upload-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
