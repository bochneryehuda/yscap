'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — packet-control job processor
 * (src/pipeline/packet-control-processor.js). Pure: no DB, no network.
 *
 * Proves: the processor records the stage manifest in order (intake→packet_control→ocr_layout→
 * classification); in SHADOW (no adapters) it plans + records the route but records the read
 * stages not_applicable; with adapters it drives the real read path; and it NEVER throws — a
 * router that throws → the stage is recorded failed_retryable and a retryable outcome returned.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const PC = require(R + '/src/pipeline/packet-control-processor');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// Fake job-queue that captures recordStage + recordArtifact calls.
function fakeJq() {
  const stages = [];
  const artifacts = [];
  return {
    stages, artifacts,
    recordStage: async (_db, _id, key, status, detail) => { stages.push({ key, status, detail }); },
    recordArtifact: async (_db, _id, { kind, meta }) => { artifacts.push({ kind, meta }); },
  };
}
// Fake router with a controllable plan + a recordRoute spy.
function fakeRouter(plan, recorded) {
  return {
    planFor: () => plan,
    recordRoute: async (_db, row) => { recorded.push(row); return 'route-xyz'; },
    routeDocument: async () => ({ outcome: 'completed', result: { confidence: 0.88 } }),
  };
}

(async function main() {
  const job = { id: 'job-1', document_id: 'doc-1', loan_id: 'loan-1', payload: { features: { docType: 'bank_statement' } } };

  // ---- SHADOW: no adapters → plan+record route, read stages not_applicable ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: { provider: 'google' }, reason: 'table-dense', materiality: 'high', specialHandling: ['preserve_tables'] };
    const proc = PC.makePacketControlProcessor({ router: fakeRouter(plan, recorded) });
    const out = await proc(job, { db: {}, jq });
    ok(out.status === 'completed', 'shadow: processor completes');
    const keys = jq.stages.map((s) => s.key + ':' + s.status);
    ok(keys[0] === 'intake:completed', 'first stage: intake completed');
    ok(keys.includes('packet_control:running') && keys.includes('packet_control:completed'), 'packet_control running→completed recorded');
    ok(keys.includes('ocr_layout:not_applicable') && keys.includes('classification:not_applicable'), 'shadow: read stages not_applicable');
    ok(recorded.length === 1 && recorded[0].provider === 'azure' && recorded[0].outcome === 'planned', 'shadow: one route row recorded, planned');
    ok(recorded[0].jobId === 'job-1' && recorded[0].documentId === 'doc-1' && recorded[0].loanId === 'loan-1', 'route row links job/document/loan from the job');
    // ordering: intake before packet_control before read stages
    const order = jq.stages.map((s) => s.key);
    ok(order.indexOf('intake') < order.indexOf('packet_control') && order.indexOf('packet_control') < order.indexOf('ocr_layout'), 'stage order intake→packet_control→ocr_layout');
  }

  // ---- READ PATH: adapters injected + a real adapter engine + bytes loaded → ocr_layout completed ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: null, reason: 'r', materiality: 'high', specialHandling: [] };
    let loadedFor = null;
    const loadBytes = async (_db, documentId) => { loadedFor = documentId; return { buffer: Buffer.from('%PDF-1.4 test'), base64: 'JVBERi0x', mimeType: 'application/pdf', filename: 'x.pdf' }; };
    let sawRequest = null;
    const router = { ...fakeRouter(plan, recorded), routeDocument: async (args) => { sawRequest = args.request; return { outcome: 'completed', result: { confidence: 0.88 } }; } };
    const proc = PC.makePacketControlProcessor({ router, adapters: [{ provider: 'azure', service: 'document_intelligence', analyze: async () => ({}) }], loadBytes });
    const out = await proc(job, { db: {}, jq });
    ok(out.status === 'completed', 'read path: completes');
    const keys = jq.stages.map((s) => s.key + ':' + s.status);
    ok(keys.includes('ocr_layout:completed'), 'read path: ocr_layout completed');
    ok(keys.includes('classification:pending'), 'read path: classification pending (not yet wired)');
    ok(loadedFor === 'doc-1', 'read path: loadBytes called with the job document id');
    ok(sawRequest && sawRequest.buffer && sawRequest.mimeType === 'application/pdf', 'read path: the loaded bytes are passed to routeDocument as the request');
    const art = jq.artifacts.find((a) => a.kind === 'ocr_result');
    ok(!!art, 'read path: an ocr_result artifact is recorded (Phase 3c)');
    ok(art && art.meta && art.meta.confidence === 0.88 && art.meta.outcome === 'completed', 'read path: artifact meta carries the read confidence + outcome');
  }

  // ---- VSLICE-3: a real read records evidence candidates WITH page provenance ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: null, reason: 'r', materiality: 'high', specialHandling: [] };
    // Count only the candidate INSERTs (evidence-candidate.recordCandidate). Other reads on the same
    // table (e.g. VSLICE-6's diff SELECTs document_pipeline_evidence via listCandidates) must not count.
    const evidenceInserts = [];
    const db = { query: async (sql, params) => { if (/INSERT INTO document_pipeline_evidence/.test(sql)) evidenceInserts.push({ sql, params }); return { rows: [{ id: 'ev1' }] }; } };
    const router = {
      ...fakeRouter(plan, recorded),
      routeDocument: async () => ({
        outcome: 'completed',
        plan: { primary: { provider: 'azure', service: 'document_intelligence' } },
        result: {
          documentType: 'bank_statement', confidence: 0.9, provider: 'azure', service: 'document_intelligence',
          segments: [{ docType: 'bank_statement', confidence: 0.9, pages: [1] }],
          fields: [{ key: 'account_holder', value: 'John Smith', confidence: 0.88, page: 1 }],
        },
      }),
    };
    const loadBytes = async () => ({ buffer: Buffer.from('%PDF'), base64: 'JVBE', mimeType: 'application/pdf', filename: 'x.pdf' });
    const proc = PC.makePacketControlProcessor({ router, adapters: [{ provider: 'azure', service: 'document_intelligence', analyze: async () => ({}) }], loadBytes });
    const out = await proc(job, { db, jq });
    ok(out.status === 'completed', 'evidence path: processor completes');
    ok(evidenceInserts.length === 2, 'evidence path: two candidates recorded (document_type + one field)');
    // recordCandidate params include page_number ($16) + evidence_span ($17) — provenance persisted
    ok(evidenceInserts.every((e) => e.params.length >= 17), 'evidence path: recordCandidate persists page_number + evidence_span params');
    ok(evidenceInserts.some((e) => e.params[5] === 'account_holder' && e.params[15] === 1), 'evidence path: the account_holder field is recorded with page_number 1');
  }

  // ---- READ PATH but bytes UNAVAILABLE (loadBytes → null) → read stages not_applicable, no adapter call ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: null, reason: 'r', materiality: 'high', specialHandling: [] };
    let routed = false;
    const router = { ...fakeRouter(plan, recorded), routeDocument: async () => { routed = true; return { outcome: 'completed', result: {} }; } };
    const proc = PC.makePacketControlProcessor({ router, adapters: [{ provider: 'azure', service: 'document_intelligence', analyze: async () => ({}) }], loadBytes: async () => null });
    const out = await proc(job, { db: {}, jq });
    // VSLICE-5 — a READ-mode job whose read didn't happen (no bytes → ocr_layout not_applicable)
    // now FAILS CLOSED instead of falsely "completing" (the "marked completed when nothing was
    // read" defect). Not transient (bytes won't appear on retry) → non-retryable → terminal.
    ok(out.status === 'failed' && out.retryable === false, 'bytes unavailable: FAILS CLOSED, non-retryable (nothing was read)');
    ok(out.result && out.result.manifest && out.result.manifest.complete === false, 'bytes unavailable: result carries an incomplete stage manifest');
    const keys = jq.stages.map((s) => s.key + ':' + s.status);
    ok(keys.includes('ocr_layout:not_applicable') && keys.includes('classification:not_applicable'), 'bytes unavailable: read stages recorded not_applicable');
    ok(routed === false, 'bytes unavailable: the adapter is NOT called with an empty request');
    ok(!jq.artifacts.some((a) => a.kind === 'ocr_result'), 'bytes unavailable: no ocr_result artifact (nothing was read)');
    ok(jq.artifacts.some((a) => a.kind === 'stage_manifest'), 'bytes unavailable: a stage_manifest artifact IS recorded (for the shadow view)');
  }

  // ---- READ PATH with bytes ALREADY in the payload.request → loadBytes is not called ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: null, reason: 'r', materiality: 'high', specialHandling: [] };
    let loadCalled = false;
    const router = { ...fakeRouter(plan, recorded), routeDocument: async () => ({ outcome: 'completed', result: {} }) };
    const jobWithBytes = { id: 'job-b', document_id: 'doc-1', payload: { features: { docType: 'bank_statement' }, request: { base64: 'QUJD' } } };
    const proc = PC.makePacketControlProcessor({ router, adapters: [{ provider: 'azure', service: 'document_intelligence', analyze: async () => ({}) }], loadBytes: async () => { loadCalled = true; return null; } });
    const out = await proc(jobWithBytes, { db: {}, jq });
    ok(out.status === 'completed' && loadCalled === false, 'payload already carries bytes → loadBytes not called, read proceeds');
    ok(jq.stages.map((s) => s.key + ':' + s.status).includes('ocr_layout:completed'), 'payload bytes → ocr_layout completed');
  }

  // ---- native_pdf plan (no adapter engine) → still shadow read stages even if adapters present ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'native_pdf', service: null, adapterKey: null }, challenger: null, reason: 'native', materiality: 'high', specialHandling: [] };
    const proc = PC.makePacketControlProcessor({ router: fakeRouter(plan, recorded), adapters: [{ provider: 'azure', service: 'document_intelligence', analyze: async () => ({}) }] });
    await proc(job, { db: {}, jq });
    const keys = jq.stages.map((s) => s.key + ':' + s.status);
    ok(keys.includes('ocr_layout:not_applicable'), 'native_pdf (no adapter key) → ocr_layout not_applicable even with adapters present');
  }

  // ---- NEVER THROWS: a router that throws in planFor → failed_retryable + retryable outcome ----
  {
    const jq = fakeJq();
    const throwingRouter = { planFor: () => { throw new Error('plan boom'); }, recordRoute: async () => null, routeDocument: async () => ({}) };
    const proc = PC.makePacketControlProcessor({ router: throwingRouter });
    const out = await proc(job, { db: {}, jq });
    ok(out.status === 'failed' && out.retryable === true, 'router throw → failed retryable outcome (never throws)');
    ok(jq.stages.some((s) => s.key === 'packet_control' && s.status === 'failed_retryable'), 'router throw → packet_control failed_retryable recorded');
  }

  // ---- recordStage that throws is swallowed (best-effort) — processor still completes ----
  {
    const badJq = { recordStage: async () => { throw new Error('stage db down'); } };
    const recorded = [];
    const plan = { primary: { provider: 'azure', service: 'document_intelligence', adapterKey: 'azure/document_intelligence' }, challenger: null, reason: 'r', materiality: 'high', specialHandling: [] };
    const proc = PC.makePacketControlProcessor({ router: fakeRouter(plan, recorded) });
    const out = await proc(job, { db: {}, jq: badJq });
    ok(out.status === 'completed', 'a throwing recordStage is swallowed — processor still completes');
  }

  // ---- payload.docType shorthand (no features object) still builds features ----
  {
    const jq = fakeJq(); const recorded = [];
    const plan = { primary: { provider: 'mistral', service: 'ocr', adapterKey: 'mistral/ocr' }, challenger: null, reason: 'r', materiality: 'low', specialHandling: [] };
    const proc = PC.makePacketControlProcessor({ router: fakeRouter(plan, recorded) });
    await proc({ id: 'j2', payload: { docType: 'insurance' } }, { db: {}, jq });
    ok(recorded[0] && recorded[0].documentFamily === 'insurance', 'payload.docType shorthand → documentFamily insurance');
  }

  console.log(`test-packet-control-processor-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
