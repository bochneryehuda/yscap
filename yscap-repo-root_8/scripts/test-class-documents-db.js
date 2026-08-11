'use strict';
/**
 * DB-gated test for the Class attachment ingest (src/class/documents.js) against a
 * REAL Postgres. The transport, storage and appraisal importer are INJECTED, so no
 * network and no files are touched — but every DB write (the documents row, the
 * class_attachments stamping, the id backfill) runs against the actual schema, which
 * is the only way to catch a wrong column name in a swallowing catch.
 *
 * Everything runs inside ONE transaction that is ROLLED BACK — no rows are left behind.
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-class-documents-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const doc = require(path.join(ROOT, 'src/class/documents'));
// The SAME db module documents.js uses — so ingestForOrder(appDb, ...) takes the
// per-order advisory lock (its `dbc === db` pool-path test). Connects to DATABASE_URL.
const appDb = require(path.join(ROOT, 'src/db'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A realistic MISMO XML + PDF (see the pure test for why size matters to the base64 path).
const XML = Buffer.from(
  '<?xml version="1.0"?><VALUATION_RESPONSE>' + '<COMP addr="12 Oak St"/>'.repeat(64) + '</VALUATION_RESPONSE>', 'utf8');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(4096, 0x42)]);

// A fake transport whose behaviour is chosen per test. `mode:'raw'` returns the file
// bytes directly; `mode:'envelope'` returns a JSON envelope with inline base64.
function fakeTransport(mode) {
  const calls = { attachments: 0, bytes: 0, url: 0 };
  return {
    calls,
    configured: () => ({ enabled: true }),
    attachments: async (classId) => {
      calls.attachments += 1;
      // The list carries the ids the announcement never did, matched by name.
      return { data: [
        { id: 'att-xml', name: 'report.xml', contentType: 'application/xml' },
        { id: 'att-pdf', name: 'report.pdf', contentType: 'application/pdf' },
      ] };
    },
    attachmentBytes: async (classId, attId) => {
      calls.bytes += 1;
      const file = attId === 'att-xml' ? XML : PDF;
      const ct = attId === 'att-xml' ? 'application/xml' : 'application/pdf';
      if (mode === 'envelope') {
        const body = Buffer.from(JSON.stringify({ name: attId === 'att-xml' ? 'report.xml' : 'report.pdf', contentType: ct, content: file.toString('base64') }), 'utf8');
        return { bytes: body, contentType: 'application/json' };
      }
      return { bytes: file, contentType: ct };
    },
    fetchUrl: async () => { calls.url += 1; throw new Error('no url in this test'); },
  };
}

function fakeStorage() {
  const saved = [];
  return {
    saved,
    save: async (bytes, opts) => { saved.push({ len: bytes.length, filename: opts && opts.filename }); return { ref: 'ref-' + saved.length, provider: 'local' }; },
  };
}

function fakeImporter() {
  const calls = [];
  return { calls, fn: async (args) => { calls.push(args); return { ok: true }; } };
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ---- minimal loan file + an appraisal condition to file onto ----
    const bo = await c.query(
      `INSERT INTO borrowers (first_name, last_name, email, current_address)
       VALUES ('Clara','Klein',$1,'{"line1":"1 Aardvark St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
      [`class-doc-${Date.now()}@example.com`]);
    const borrowerId = bo.rows[0].id;
    const app = await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, program, loan_type, property_address, property_type, purchase_price, loan_amount)
       VALUES ($1,'YSCAP-CLASS-1','bridge','Purchase','{"street":"12 Oak St","city":"Brooklyn","state":"NY","zip":"11249"}','SFR',400000,300000)
       RETURNING id`, [borrowerId]);
    const appId = app.rows[0].id;
    const ci = await c.query(
      `INSERT INTO checklist_items (application_id, scope, tool_key, label, status, audience, item_kind)
       VALUES ($1,'application','appraisal_card','Appraisal','outstanding','staff','document') RETURNING id`, [appId]);
    const conditionId = ci.rows[0].id;

    // ---- a placed Class order + two ANNOUNCED attachments (name only, no id — exactly
    //      what the documented NewAttachments callback carries) ----
    const ordA = await c.query(
      `INSERT INTO class_orders (application_id, checklist_item_id, class_order_id, reference_number, api_version, uad, status)
       VALUES ($1,$2,'CLASS-1001','YSCAP-CLASS-1','v1','2.6','completed') RETURNING *`, [appId, conditionId]);
    const orderA = ordA.rows[0];
    for (const name of ['report.xml', 'report.pdf']) {
      await c.query(
        `INSERT INTO class_attachments (class_order_row, application_id, name, content_type)
         VALUES ($1,$2,$3,NULL)`, [orderA.id, appId, name]);
    }

    // ================= raw-bytes path =================
    const tRaw = fakeTransport('raw');
    const store = fakeStorage();
    const imp = fakeImporter();
    const out = await doc.ingestForOrder(c, orderA, { transport: tRaw, storage: store, importAppraisal: imp.fn });

    ok(out.ok && out.filed === 2, `raw: filed both attachments (got ${JSON.stringify(out)})`);
    ok(out.imported === true, 'raw: MISMO XML handed to the importer → imported');
    ok(tRaw.calls.attachments === 1, 'raw: listed the order once to learn the ids');
    ok(store.saved.length === 2, 'raw: both files saved to storage');

    // documents rows: staff-only, system-sourced, pending review, sha256 present, on the condition
    const docs = (await c.query(
      `SELECT filename, content_type, visibility, source_type, review_status, sha256, checklist_item_id, size_bytes
         FROM documents WHERE application_id=$1 ORDER BY filename`, [appId])).rows;
    ok(docs.length === 2, `raw: two documents rows created (got ${docs.length})`);
    const xmlRow = docs.find((d) => d.filename === 'report.xml');
    const pdfRow = docs.find((d) => d.filename === 'report.pdf');
    ok(xmlRow && pdfRow, 'raw: both documents named from the attachment');
    ok(xmlRow && xmlRow.visibility === 'staff_only' && xmlRow.source_type === 'system' && xmlRow.review_status === 'pending',
      'raw: document filed staff-only / system / pending (mirrors NAN + db/424)');
    ok(xmlRow && xmlRow.sha256 && xmlRow.sha256.length === 64, 'raw: sha256 recorded');
    ok(xmlRow && String(xmlRow.checklist_item_id) === String(conditionId), 'raw: filed onto the appraisal condition');
    ok(pdfRow && Number(pdfRow.size_bytes) === PDF.length, 'raw: pdf size recorded');

    // class_attachments: document_id + fetched_at set, id backfilled from the list
    const attach = (await c.query(
      `SELECT name, class_attachment_id, document_id, fetched_at, fetch_error
         FROM class_attachments WHERE class_order_row=$1 ORDER BY name`, [orderA.id])).rows;
    ok(attach.every((a) => a.document_id && a.fetched_at && !a.fetch_error), 'raw: every attachment stamped fetched');
    ok(attach.find((a) => a.name === 'report.xml').class_attachment_id === 'att-xml', 'raw: attachment id backfilled from the list');

    // the importer got the XML string + both document ids
    ok(imp.calls.length === 1, 'raw: importer called exactly once');
    const impArg = imp.calls[0] || {};
    ok(impArg.appId === appId && impArg.xml === XML.toString('utf8'), 'raw: importer got this file + the XML string');
    ok(impArg.xmlDocumentId && impArg.pdfDocumentId && impArg.xmlDocumentId !== impArg.pdfDocumentId,
      'raw: importer got distinct xml + pdf document ids');

    // ---- IDEMPOTENCY: a second ingest fetches nothing and re-imports nothing ----
    const out2 = await doc.ingestForOrder(c, orderA, { transport: fakeTransport('raw'), storage: fakeStorage(), importAppraisal: imp.fn });
    ok(out2.ok && out2.filed === 0 && out2.imported === false, `idempotent: second pass files nothing (got ${JSON.stringify(out2)})`);
    ok(imp.calls.length === 1, 'idempotent: importer not called a second time');
    ok((await c.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1`, [appId])).rows[0].n === 2,
      'idempotent: still only two documents');

    // ================= JSON-envelope + base64 path (a DIFFERENT order) =================
    const ordB = await c.query(
      `INSERT INTO class_orders (application_id, class_order_id, reference_number, api_version, uad, status)
       VALUES ($1,'CLASS-1002','YSCAP-CLASS-1','v1','2.6','completed') RETURNING *`, [appId]);
    const orderB = ordB.rows[0];
    for (const name of ['report.xml', 'report.pdf']) {
      await c.query(`INSERT INTO class_attachments (class_order_row, application_id, name) VALUES ($1,$2,$3)`, [orderB.id, appId, name]);
    }
    const impB = fakeImporter();
    const outB = await doc.ingestForOrder(c, orderB, { transport: fakeTransport('envelope'), storage: fakeStorage(), importAppraisal: impB.fn });
    ok(outB.ok && outB.filed === 2 && outB.imported === true, `envelope: base64 envelope decoded + filed + imported (got ${JSON.stringify(outB)})`);
    const bDocs = (await c.query(`SELECT filename, size_bytes FROM documents WHERE application_id=$1 AND checklist_item_id IS NULL ORDER BY filename`, [appId])).rows;
    // orderB has no checklist_item_id, so its docs carry a NULL condition; the pdf size proves the base64 decoded to the real bytes
    const bPdf = bDocs.find((d) => d.filename === 'report.pdf');
    ok(bPdf && Number(bPdf.size_bytes) === PDF.length, 'envelope: decoded pdf bytes match the original size');

    // ================= an announcement the list can't resolve (no id, no url) =================
    const ordC = await c.query(
      `INSERT INTO class_orders (application_id, class_order_id, api_version, status)
       VALUES ($1,'CLASS-1003','v1','completed') RETURNING *`, [appId]);
    const orderC = ordC.rows[0];
    await c.query(`INSERT INTO class_attachments (class_order_row, application_id, name) VALUES ($1,$2,'orphan.pdf')`, [orderC.id, appId]);
    // a transport whose list is EMPTY, so 'orphan.pdf' never gets an id
    const tEmpty = { configured: () => ({ enabled: true }), attachments: async () => ({ data: [] }), attachmentBytes: async () => { throw new Error('should not fetch'); }, fetchUrl: async () => { throw new Error('should not fetch'); } };
    const outC = await doc.ingestForOrder(c, orderC, { transport: tEmpty, storage: fakeStorage(), importAppraisal: fakeImporter().fn });
    ok(outC.ok && outC.filed === 0, 'unresolvable: nothing filed');
    const orphan = (await c.query(`SELECT document_id, fetch_error FROM class_attachments WHERE class_order_row=$1`, [orderC.id])).rows[0];
    ok(orphan.document_id === null && /cannot fetch/i.test(orphan.fetch_error || ''),
      'unresolvable: fetch_error recorded, document_id left null for a later retry');

    // ================= gates =================
    const offOut = await doc.ingestForOrder(c, orderA, { transport: { configured: () => ({ enabled: false }) } });
    ok(offOut.skipped === 'disabled', 'gate: disabled transport → skipped');
    const noIdOut = await doc.ingestForOrder(c, { ...orderA, class_order_id: null }, { transport: fakeTransport('raw') });
    ok(noIdOut.skipped === 'no_class_order_id', 'gate: no class order id → skipped');

    await c.query('ROLLBACK');

    // ================= concurrency: the per-order advisory lock prevents double-filing =================
    // The pool path takes a REAL advisory lock, invisible to a rollback transaction, so
    // this uses COMMITTED rows through the app db pool and cleans them up in a finally.
    // Two ingests race the SAME order; the lock serializes them, so the second sees
    // document_id already set and files nothing — exactly two documents, not four.
    let raceApp = null, raceBorrower = null;
    try {
      const st = Date.now();
      raceBorrower = (await appDb.query(
        `INSERT INTO borrowers (first_name,last_name,email,current_address)
         VALUES ('Race','Klein',$1,'{"line1":"1 St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
        [`class-race-${st}@example.com`])).rows[0].id;
      raceApp = (await appDb.query(
        `INSERT INTO applications (borrower_id,ys_loan_number,program,loan_type,property_address,property_type,purchase_price,loan_amount)
         VALUES ($1,$2,'bridge','Purchase','{"street":"1 St","city":"NYC","state":"NY","zip":"10001"}','SFR',1,1) RETURNING id`,
        [raceBorrower, `YSCAP-RACE-${st}`])).rows[0].id;
      const raceOrder = (await appDb.query(
        `INSERT INTO class_orders (application_id,class_order_id,api_version,status)
         VALUES ($1,$2,'v1','completed') RETURNING *`, [raceApp, `CLASS-RACE-${st}`])).rows[0];
      for (const name of ['report.xml', 'report.pdf']) {
        await appDb.query(`INSERT INTO class_attachments (class_order_row,application_id,name) VALUES ($1,$2,$3)`, [raceOrder.id, raceApp, name]);
      }

      // A barrier so BOTH passes get past their "unfetched" SELECT before either files —
      // which is what makes the read-then-write race real (and what makes this test FAIL
      // without the lock). Each pass parks at its first fetch until the other pass also
      // reaches its first fetch, or a short timeout (the timeout only ever fires WITH the
      // lock, where the second pass is blocked at pg_advisory_lock and never fetches).
      const barrier = (() => {
        let count = 0, release;
        const all = new Promise((r) => { release = r; });
        return () => { if (++count >= 2) release(); return Promise.race([all, new Promise((r) => setTimeout(r, 400))]); };
      })();
      const racing = () => {
        const base = fakeTransport('raw'); let arrived = false;
        const inner = base.attachmentBytes;
        base.attachmentBytes = async (cid, attId) => { if (!arrived) { arrived = true; await barrier(); } return inner(cid, attId); };
        return base;
      };
      const impR = fakeImporter();
      const [r1, r2] = await Promise.all([
        doc.ingestForOrder(appDb, raceOrder, { transport: racing(), storage: fakeStorage(), importAppraisal: impR.fn }),
        doc.ingestForOrder(appDb, raceOrder, { transport: racing(), storage: fakeStorage(), importAppraisal: impR.fn }),
      ]);
      const filedTotal = (r1.filed || 0) + (r2.filed || 0);
      const docCount = (await appDb.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1`, [raceApp])).rows[0].n;
      ok(docCount === 2, `concurrency: exactly two documents under a race (got ${docCount}) — the lock prevented duplicates`);
      ok(filedTotal === 2, `concurrency: filed sums to 2 across both passes (got ${filedTotal})`);
      ok(impR.calls.length === 1, `concurrency: importer called once, not twice (got ${impR.calls.length})`);
    } catch (e) {
      fail++; console.error('  FAIL (concurrency threw):', e && e.message || e);
    } finally {
      // documents.application_id is not ON DELETE CASCADE — remove them first, then the
      // app (which cascades class_orders → class_attachments), then the borrower.
      if (raceApp) {
        await appDb.query(`DELETE FROM documents WHERE application_id=$1`, [raceApp]).catch(() => {});
        await appDb.query(`DELETE FROM applications WHERE id=$1`, [raceApp]).catch(() => {});
      }
      if (raceBorrower) await appDb.query(`DELETE FROM borrowers WHERE id=$1`, [raceBorrower]).catch(() => {});
    }
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e && e.stack || e);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-class-documents-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
