/**
 * DB-gated — the Richer Values report actually LANDS on the loan file.
 *
 *   DATABASE_URL=... node scripts/test-richer-value-pdf-db.js
 *
 * WHY THIS EXISTS. `documents.fileReport` is the last mile of the whole
 * integration: the order can be placed perfectly, the poll can notice completion
 * perfectly, and if this step is wrong the desk is holding a finished report it
 * cannot see and a condition it cannot sign off. Every other Richer Values suite
 * is PURE (no database) or exercises the schema without ever driving a report onto
 * a real file — `test-richer-value-db.js` literally SKIPS its order section when
 * the database has no application to hang one off. So the one step that touches
 * `documents` was never executed by anything.
 *
 * WHAT IS PINNED, and why each one is a real failure mode:
 *
 *  A  The PDF is filed on the CONDITION, not merely on the file — a report filed
 *     loose leaves a reviewer unable to clear the condition it satisfies.
 *  B  Its slot label CONTAINS "pdf", because the appraisal condition's sign-off
 *     gate matches that slot by substring. A label that reads well but omits the
 *     word makes the condition permanently unsignable.
 *  C  It is born `accepted` (db/424 — nothing un-accepted leaves the building, and
 *     PILOT ordered this one itself) and `staff_only` (it is the lender's own
 *     valuation), under its OWN doc_kind — never `appraisal_pdf`, which
 *     `undoAppraisalImport` DELETES.
 *  D  A re-fetch files NOTHING new. Their PDF endpoint answers with the same bytes
 *     every time and the poll runs every few minutes, so a second copy per tick is
 *     the default failure if the guard is wrong.
 *  E  Bytes that are not a PDF are REFUSED. An HTML error page base64'd into their
 *     `pdf_file` slot would otherwise be filed as the appraisal report and nobody
 *     would find out until somebody opened it.
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-richer-value-pdf-db: SKIP (no DATABASE_URL)');
  process.exit(0);
}
process.env.STORAGE_DIR = process.env.STORAGE_DIR || path.join(require('os').tmpdir(), 'rv-pdf-test-store');

const db = require(R + '/src/db');
const client = require(R + '/src/richervalues/client');
const documents = require(R + '/src/richervalues/documents');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('PASS ' + m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); console.log('PASS ' + m); pass++; };

// A real, minimal PDF — magic bytes and enough length to clear the floor.
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'),
  Buffer.alloc(200, 0x20),
]);

(async () => {
  const suffix = Date.now();
  const bEmail = `rv-pdf-${suffix}@example.test`;

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('RvPdf','Tester',$1) RETURNING id`,
    [bEmail])).rows[0];

  const app = (await db.query(
    `INSERT INTO applications (borrower_id, property_address, status)
     VALUES ($1, $2::jsonb, 'underwriting') RETURNING id`,
    [borrower.id, JSON.stringify({ line1: '1 Report Way', city: 'Gainesville', state: 'FL', zip: '32608' })])).rows[0];

  // The appraisal-documents condition this report is meant to satisfy.
  const item = (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, audience, status, item_kind)
     VALUES ($1, 'application', 'Appraisal documents', 'staff', 'outstanding', 'document') RETURNING id`,
    [app.id])).rows[0];

  const order = (await db.query(
    `INSERT INTO rv_orders (application_id, checklist_item_id, status, report_type, inspection_type, intake_token, order_token, client_loan_number)
     VALUES ($1, $2, 'completed', 'reno-arv', 'interior-w-exterior', 'intake-tok', 'order-tok', 'YSCAP-${suffix}') RETURNING *`,
    [app.id, item.id])).rows[0];

  // ---- stub their PDF endpoint -------------------------------------------
  const realPdfFile = client.pdfFile;
  let served = 0;
  client.pdfFile = async () => { served++; return { data: { pdf_file: PDF.toString('base64') } }; };

  try {
    // ---- A/B/C — it lands, on the condition, correctly shaped -------------
    const r1 = await documents.fileReport(db, order);
    ok(r1.filed === true, 'A the report is filed');
    const doc = (await db.query(`SELECT * FROM documents WHERE id=$1`, [r1.documentId])).rows[0];
    ok(!!doc, 'A a documents row exists');
    eq(doc.application_id, app.id, 'A it is on the right loan file');
    eq(doc.checklist_item_id, item.id, 'A it is filed ON the appraisal condition, not loose on the file');
    ok(/pdf/i.test(doc.slot_label || ''), `B its slot label contains "pdf" so the sign-off gate can match it (${doc.slot_label})`);
    eq(doc.review_status, 'accepted', 'C it is born accepted — PILOT ordered this report itself');
    eq(doc.visibility, 'staff_only', 'C it is staff-only — this is the lender’s own valuation');
    eq(doc.doc_kind, 'hybrid_appraisal_pdf', 'C its own doc_kind, never appraisal_pdf (undoAppraisalImport deletes those)');
    eq(doc.content_type, 'application/pdf', 'C it is recorded as a PDF');
    eq(Number(doc.size_bytes), PDF.length, 'C the stored size is the real byte length');
    ok(!!doc.sha256, 'C the content hash is recorded');

    // the bytes really are retrievable, byte for byte
    const store = require(R + '/src/lib/storage');
    const back = await store.read(doc.storage_ref);
    ok(Buffer.compare(Buffer.from(back), PDF) === 0, 'C the stored bytes read back identical to what they sent');

    const linked = (await db.query(`SELECT pdf_document_id FROM rv_orders WHERE id=$1`, [order.id])).rows[0];
    eq(linked.pdf_document_id, r1.documentId, 'C the order row points at the filed report');

    // ---- D — the poll re-runs and files nothing new -----------------------
    const fresh = (await db.query(`SELECT * FROM rv_orders WHERE id=$1`, [order.id])).rows[0];
    const r2 = await documents.fileReport(db, fresh);
    eq(r2.filed, false, 'D a re-fetch files nothing new');
    eq(r2.documentId, r1.documentId, 'D it adopts the report already on the file');
    const n = (await db.query(
      `SELECT count(*)::int AS c FROM documents WHERE application_id=$1 AND doc_kind='hybrid_appraisal_pdf'`,
      [app.id])).rows[0].c;
    eq(n, 1, 'D exactly one copy of the report is on the file');

    // even with the order row's pointer cleared, the content hash still dedupes
    await db.query(`UPDATE rv_orders SET pdf_document_id=NULL WHERE id=$1`, [order.id]);
    const r3 = await documents.fileReport(db, (await db.query(`SELECT * FROM rv_orders WHERE id=$1`, [order.id])).rows[0]);
    eq(r3.filed, false, 'D the content hash alone stops a duplicate, even with the pointer lost');
    eq(r3.documentId, r1.documentId, 'D and it re-points the order at the report already filed');

    // ---- E — anything that is not a PDF is refused ------------------------
    const order2 = (await db.query(
      `INSERT INTO rv_orders (application_id, checklist_item_id, status, report_type, inspection_type, intake_token, order_token)
       VALUES ($1, $2, 'completed', 'reno-arv', 'interior-w-exterior', 'intake-2', 'order-2') RETURNING *`, [app.id, item.id])).rows[0];

    for (const [label, payload] of [
      ['an HTML error page', Buffer.from('<html><body>Gateway timeout, please retry later.</body></html>'.repeat(4), 'utf8').toString('base64')],
      ['an empty string', ''],
      ['a truncated stub', Buffer.from('%PDF-', 'latin1').toString('base64')],
      ['plain prose', Buffer.from('the report is not completed yet'.repeat(10), 'utf8').toString('base64')],
    ]) {
      client.pdfFile = async () => ({ data: { pdf_file: payload } });
      const bad = await documents.fileReport(db, order2);
      eq(bad.filed, false, `E ${label} is refused, never filed as the appraisal report`);
    }
    const stillOne = (await db.query(
      `SELECT count(*)::int AS c FROM documents WHERE application_id=$1`, [app.id])).rows[0].c;
    eq(stillOne, 1, 'E nothing junk reached the file');

    // ---- their "not completed yet" is an expected state, not an error -----
    client.pdfFile = async () => { throw new Error('Richer Values pdfFile failed: HTTP 422 — Report is not completed yet!'); };
    const notReady = await documents.fileReport(db, order2);
    eq(notReady.filed, false, 'F "not completed yet" files nothing');
    eq(notReady.reason, 'not_ready', 'F …and is reported as not-ready rather than as a failure');

    console.log(`\ntest-richer-value-pdf-db: ${pass} assertions passed`);
  } finally {
    client.pdfFile = realPdfFile;
    await db.query(`DELETE FROM documents WHERE application_id=$1`, [app.id]).catch(() => {});
    await db.query(`DELETE FROM rv_orders WHERE application_id=$1`, [app.id]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [app.id]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower.id]).catch(() => {});
    await db.end?.().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
