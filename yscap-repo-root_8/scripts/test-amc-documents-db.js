'use strict';
/**
 * DB-gated test for the AMC document upload service (src/amc/documents.js) against a
 * real Postgres. Drives the network through INJECTED deps (readStorage, postDocuments,
 * transport.write) so the full stage → UploadDocument → record path runs offline:
 * the picker, the auto-upload rules (SOW + contract, HTML excluded), dedupe on re-run,
 * and a manual pick. One transaction, rolled back.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-documents-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const docs = require(path.join(ROOT, 'src/amc/documents'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// Injected transport/deps: stage returns getdocument URLs; write acks.
function makeDeps() {
  const staged = [];
  return {
    _staged: staged,
    authContext: { apiKey: 'K', subdomain: 'sub' },
    readStorage: async () => Buffer.from('the document bytes'),
    postDocuments: async (files) => files.map((f, i) => ({ name: 'part' + i, fileName: f.fileName, uploadStatus: 'Success', retrievalUrl: 'https://amc/getdoc/' + i, errorTraceID: null })),
    transport: { write: async (built) => { staged.push(built); return { message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '1000', statusCondition: 'Ack' }] } } }; } },
  };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  const ins = async (appId, filename, contentType, docKind) => (await c.query(
    `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref, doc_kind, is_current)
     VALUES ($1,$2,$3,18,'local',$4,$5,true) RETURNING id`,
    [appId, filename, contentType, 'ref/' + filename, docKind || null])).rows[0].id;

  try {
    await c.query('BEGIN');
    const bo = await c.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Doc','Test',$1) RETURNING id`, [`amc-doc-${Date.now()}@example.com`]);
    const app = await c.query(`INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,'YSCAP-DOC-1') RETURNING id`, [bo.rows[0].id]);
    const appId = app.rows[0].id;
    const ord = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, cdg_order_number, sp_order_number, status)
       VALUES ($1,'YSCAP-DOC-1','CLG300','SP-3','in_process') RETURNING *`, [appId]);
    const order = ord.rows[0];

    const sowId = await ins(appId, 'Scope of Work 2026.pdf', 'application/pdf');
    const contractId = await ins(appId, 'Purchase Contract executed.pdf', 'application/pdf');
    const otherId = await ins(appId, 'Bank Statement March.pdf', 'application/pdf');
    const sowHtmlId = await ins(appId, 'Scope of Work.html', 'text/html');

    // ---- picker categorizes ----
    const list = await docs.listUploadable(c, appId, order.id);
    ok(list.length === 4, 'picker lists all four current documents');
    const cat = (id) => (list.find((d) => String(d.id) === String(id)) || {}).category;
    ok(cat(sowId) === docs.CAT_SOW, 'SOW categorized as Scope of Work');
    ok(cat(contractId) === docs.CAT_CONTRACT, 'contract categorized as Contract & Assignment');
    ok(list.every((d) => d.alreadyUploaded === false), 'nothing uploaded yet');

    // ---- auto-upload: SOW + contract, HTML + unrelated excluded ----
    const deps = makeDeps();
    const auto = await docs.autoUploadForOrder(c, order, deps);
    ok(auto.ok && auto.uploaded === 2, 'auto-upload sends exactly the SOW + contract (2)');
    const outRows = await c.query(`SELECT document_id, document_type, action, status FROM amc_order_documents WHERE order_id=$1 AND direction='outbound' ORDER BY id`, [order.id]);
    ok(outRows.rows.length === 2, 'two outbound document rows recorded');
    const uploadedIds = new Set(outRows.rows.map((r) => String(r.document_id)));
    ok(uploadedIds.has(String(sowId)) && uploadedIds.has(String(contractId)), 'the SOW and contract are the two uploaded');
    ok(!uploadedIds.has(String(otherId)) && !uploadedIds.has(String(sowHtmlId)), 'the unrelated doc and the HTML export are NOT auto-uploaded');
    ok(outRows.rows.some((r) => r.document_type === 'Scope of Work') && outRows.rows.some((r) => r.document_type === 'Sales Contract'), 'AMC document types set per category');
    ok(outRows.rows.every((r) => r.status === 'uploaded'), 'rows marked uploaded');
    const j = await c.query(`SELECT count(*)::int n FROM amc_write_log WHERE order_id=$1 AND ok=true`, [order.id]);
    ok(j.rows[0].n === 1, 'the upload is journaled once');

    // ---- re-run auto-upload: deduped ----
    const auto2 = await docs.autoUploadForOrder(c, order, makeDeps());
    ok(auto2.uploaded === 0, 're-run auto-upload sends nothing new (deduped on document id)');

    // ---- picker now marks them uploaded ----
    const list2 = await docs.listUploadable(c, appId, order.id);
    ok(list2.find((d) => String(d.id) === String(sowId)).alreadyUploaded === true, 'SOW now shows as uploaded');

    // ---- manual pick of the unrelated document ----
    const man = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [otherId] }, makeDeps());
    ok(man.ok && man.uploaded.length === 1, 'manual upload of a picked document works');
    const total = await c.query(`SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND direction='outbound'`, [order.id]);
    ok(total.rows[0].n === 3, 'three outbound documents after the manual pick');
    // picking an already-uploaded doc is skipped, not re-sent
    const dup = await docs.uploadToOrder(c, order, { staffId: null, documentIds: [sowId] }, makeDeps());
    ok(!dup.ok && dup.error === 'nothing_to_upload' && dup.skipped.some((s) => s.reason === 'already_uploaded'), 'picking an already-sent document is skipped');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-documents-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
