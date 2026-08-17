'use strict';
/**
 * DB-gated test for the AMC sync worker (src/amc/sync.js) against a real Postgres.
 *
 * Exercises the two seams that own the pulled-back state: applyStatusResponse (the
 * status lifecycle + timeline + dedupe, no network) and ingestDocuments (documents
 * pulled back into the Document Center + the appraisal import), driving the network
 * through an INJECTED transport + importer so the whole path runs offline. Everything
 * is one transaction that is ROLLED BACK.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-sync-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const sync = require(path.join(ROOT, 'src/amc/sync'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A product-level GetAppraisalStatus response.
const statusResp = (code, name, desc) => ({
  message: { products: [{ statusResponses: [{ statusCode: code, statusName: name, statusDescription: desc, statusCondition: 'Ack' }] }] },
});
// An auth NACK.
const nackResp = {
  message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '-100', statusName: 'NOT_AUTHENTICATED', statusDescription: 'not authenticated', statusCondition: 'Nack' }] } },
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const bo = await c.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Sync','Test',$1) RETURNING id`,
      [`amc-sync-${Date.now()}@example.com`]);
    const app = await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address)
       VALUES ($1,'YSCAP-SYNC-1','{"street":"1 St","city":"NYC","state":"NY","zip":"10001"}') RETURNING id`,
      [bo.rows[0].id]);
    const appId = app.rows[0].id;
    const ordRow = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
       VALUES ($1,'YSCAP-SYNC-1','SP-777','ordered','integrations.uat') RETURNING *`, [appId]);
    let order = ordRow.rows[0];

    // ---- status advances ----
    let out = await sync.applyStatusResponse(c, order, statusResp('1102', 'InProcess', 'working'));
    ok(out.status === 'in_process' && out.changed === true, 'status advances ordered → in_process');
    let ev = await c.query(`SELECT count(*)::int n FROM amc_status_events WHERE order_id=$1`, [order.id]);
    ok(ev.rows[0].n === 1, 'one status event recorded');

    // re-apply the SAME status → deduped (no new event; still updates last_polled_at)
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    out = await sync.applyStatusResponse(c, order, statusResp('1102', 'InProcess', 'working'));
    ev = await c.query(`SELECT count(*)::int n FROM amc_status_events WHERE order_id=$1`, [order.id]);
    ok(ev.rows[0].n === 1, 're-applying the same status does not double the timeline');

    // a NACK sets last_error and leaves the status unchanged
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    out = await sync.applyStatusResponse(c, order, nackResp);
    ok(out.error && String(out.error.code) === '-100', 'a NACK is surfaced as an error');
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    ok(order.status === 'in_process' && order.last_error, 'status unchanged on NACK, last_error set');

    // product available → status flips
    out = await sync.applyStatusResponse(c, order, statusResp('1990', 'Vendor-ProductAvailable', 'ready'));
    ok(out.status === 'product_available', 'status flips to product_available on 1990');

    // ---- a cancel we asked for HOLDS until the vendor confirms it (1051) ----
    // Put the order into the 'cancel_requested' holding state (as requestCancel does).
    await c.query(`UPDATE amc_orders SET status='cancel_requested' WHERE id=$1`, [order.id]);
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    // The order is still live at the AMC, so the next poll returns its CURRENT vendor
    // status — that must NOT downgrade the marker ("asking is not agreeing").
    out = await sync.applyStatusResponse(c, order, statusResp('1102', 'InProcess', 'still working'));
    ok(out.status === 'cancel_requested' && out.changed === false, 'a live status does not clobber cancel_requested');
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    ok(order.status === 'cancel_requested', 'the order stays cancel_requested after a live-status poll');
    ok(order.status_name === 'InProcess', 'the latest vendor status detail is still recorded while holding');
    // The vendor CONFIRMS the cancellation (Cancellation / 1051) → it flips to cancelled.
    out = await sync.applyStatusResponse(c, order, statusResp('1051', 'Cancellation', 'order cancelled'));
    ok(out.status === 'cancelled', 'a 1051 Cancellation confirmation releases cancel_requested → cancelled');
    // restore a live status for the document-ingest section below
    await c.query(`UPDATE amc_orders SET status='product_available' WHERE id=$1`, [order.id]);
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];

    // ---- ingestDocuments with an injected transport + importer ----
    const docsResp = { message: { deals: [{ embeddedFiles: [
      { documentId: 'D1', documentType: 'Appraisal Document', objectName: 'appraisal.xml', objectURL: 'https://amc/getdoc/D1', isAdditionalDocument: '0' },
      { documentId: 'D2', documentType: 'Appraisal PDF', objectName: 'appraisal.pdf', objectURL: 'https://amc/getdoc/D2', isAdditionalDocument: '0' },
    ] }] } };
    let importedArgs = null;
    const deps = {
      authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
      transport: {
        read: async () => docsResp,
        getDocument: async (url) => url.endsWith('D1')
          ? { bytes: Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>'), contentType: 'application/xml' }
          : { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' },
      },
      importAppraisal: async (args) => { importedArgs = args; return { ok: true }; },
    };
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    const ing = await sync.ingestDocuments(c, order, deps);
    ok(ing.ok && ing.filed === 2, 'ingest files both returned documents');
    const docCount = await c.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1`, [appId]);
    ok(docCount.rows[0].n === 2, 'two Document Center rows created');
    const linkCount = await c.query(`SELECT count(*)::int n FROM amc_order_documents WHERE order_id=$1 AND direction='inbound'`, [order.id]);
    ok(linkCount.rows[0].n === 2, 'two inbound order-document links created');
    ok(importedArgs && /VALUATION_RESPONSE/.test(importedArgs.xml) && importedArgs.xmlDocumentId && importedArgs.pdfDocumentId, 'the appraisal importer got the XML + both document ids');
    order = (await c.query(`SELECT * FROM amc_orders WHERE id=$1`, [order.id])).rows[0];
    ok(order.status === 'completed' && order.completed_at, 'order completes after a successful import');

    // re-run → deduped on amc_document_id (no new documents)
    const ing2 = await sync.ingestDocuments(c, order, deps);
    ok(ing2.filed === 0, 're-ingest dedupes on the AMC document id (files nothing new)');
    const docCount2 = await c.query(`SELECT count(*)::int n FROM documents WHERE application_id=$1`, [appId]);
    ok(docCount2.rows[0].n === 2, 'still exactly two Document Center rows after re-ingest');

    // ---- THE DATA FILE IS FETCHED BY ITS OWN ID (RetriveDocumentContent) ------
    //
    // The listing's entries carry the PDF. The MISMO data file the appraisal
    // importer runs on is NAMED on an entry (`objectXMLFileName`) and flagged by
    // `includeXMLIndicator` — it is not an entry with a URL of its own — so without a
    // second call a delivered order files a report and NO data file, and the
    // appraisal never imports. These four cases pin that second call, including the
    // two ways it must decline to file anything.
    const xmlListing = { message: { deals: [{ embeddedFiles: [{
      documentId: '1843_XML', documentType: 'Appraisal', objectName: 'report.pdf',
      objectURL: 'https://amc/getdoc/PDF-ONLY', isAdditionalDocument: '0',
      includeXMLIndicator: true, objectXMLFileName: 'integrations_Test(1843)-V1.xml',
    }] }] } };
    const contentResp = { message: { deals: [{ embeddedFiles: [{ objectURL: 'https://amc/content/1843' }] }] } };
    const contentNack = { message: { digitalGatewaySystem: { statusResponses: [
      { statusCode: '-1', statusName: 'ERROR', statusDescription: 'Document not available.', statusCondition: 'Nack' },
    ] } } };

    // A fresh order per case: the fetch is deduped per (order, document id, name),
    // so re-using one order would prove nothing about the cases after the first.
    const freshOrder = async (tag) => {
      const r = await c.query(
        `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, sp_subdomain)
         VALUES ($1,$2,$3,'product_available','integrations.uat') RETURNING *`,
        [appId, 'YSCAP-SYNC-' + tag, 'SP-' + tag]);
      return r.rows[0];
    };
    const xmlDocsFor = (orderId) => c.query(
      `SELECT d.filename, d.doc_kind, aod.action FROM amc_order_documents aod
         JOIN documents d ON d.id = aod.document_id
        WHERE aod.order_id=$1 AND aod.action='RetriveDocumentContent'`, [orderId]).then((r) => r.rows);

    // (a) the happy path: the data file is fetched by its id and reaches the importer.
    {
      const o = await freshOrder('XML-OK');
      let contentReq = null, imported = null;
      const r = await sync.ingestDocuments(c, o, {
        authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
        transport: {
          read: async (built, opts) => {
            if (opts && opts.label === 'RetriveDocumentContent') { contentReq = built; return contentResp; }
            return xmlListing;
          },
          getDocument: async (url) => url.endsWith('/1843')
            ? { bytes: Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>'), contentType: 'application/xml' }
            : { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' },
        },
        importAppraisal: async (args) => { imported = args; return { ok: true }; },
      });
      ok(r.ok && r.filed === 2, 'the report AND the data file are both filed');
      ok(contentReq && contentReq.message.products[0].documentId === '1843_XML',
        'the data file is asked for by the _XML-suffixed documentId the listing gave us');
      const rows = await xmlDocsFor(o.id);
      ok(rows.length === 1 && rows[0].filename === 'integrations_Test(1843)-V1.xml',
        'the data file is filed under the name the vendor gave it (objectXMLFileName)');
      ok(rows[0].doc_kind && /xml/i.test(rows[0].doc_kind), 'it takes the condition’s XML slot');
      ok(imported && /VALUATION_RESPONSE/.test(imported.xml), 'the appraisal importer receives the fetched XML');

      // Re-syncing must not file it a second time. The listing loop skips an
      // already-filed entry WITHOUT setting the xml marker, so the gap still reads
      // as open — the fetch needs its own dedupe or every poll adds a duplicate to
      // the one condition a human has to sign off.
      // The stub answers the second call FAITHFULLY — a stub that refused it would
      // pass whether or not the dedupe exists, proving nothing.
      let refetched = false;
      const again = await sync.ingestDocuments(c, o, {
        authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
        transport: {
          read: async (built, opts) => {
            if (opts && opts.label === 'RetriveDocumentContent') { refetched = true; return contentResp; }
            return xmlListing;
          },
          getDocument: async () => ({ bytes: Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>'), contentType: 'application/xml' }),
        },
        importAppraisal: async () => ({ ok: true }),
      });
      ok(again.filed === 0, 're-sync files nothing new');
      ok(refetched === false, 're-sync does not ask the vendor for the data file a second time');
      ok((await xmlDocsFor(o.id)).length === 1, 're-sync does NOT file a second copy of the data file');
    }

    // (b) THE BYTES ARE VERIFIED, NEVER TRUSTED. Their package proves the shape of
    //     the call, not what comes back down the URL — so an answer that is not XML
    //     is discarded rather than filed as a data file the importer would choke on.
    {
      const o = await freshOrder('XML-BAD');
      let imported = false;
      const r = await sync.ingestDocuments(c, o, {
        authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
        transport: {
          read: async (built, opts) => (opts && opts.label === 'RetriveDocumentContent' ? contentResp : xmlListing),
          getDocument: async (url) => url.endsWith('/1843')
            ? { bytes: Buffer.from('<!doctype html><html>Session expired</html>'), contentType: 'text/html' }
            : { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' },
        },
        importAppraisal: async () => { imported = true; return { ok: true }; },
      });
      ok(r.filed === 1, 'a non-XML answer files nothing — only the report lands');
      ok((await xmlDocsFor(o.id)).length === 0, 'no data file is recorded for an answer that is not XML');
      ok(imported === false, 'the importer is never handed an error page');
    }

    // (c) the vendor refuses the content call: the report still lands, nothing is invented.
    {
      const o = await freshOrder('XML-NACK');
      const r = await sync.ingestDocuments(c, o, {
        authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
        transport: {
          read: async (built, opts) => (opts && opts.label === 'RetriveDocumentContent' ? contentNack : xmlListing),
          getDocument: async () => ({ bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }),
        },
        importAppraisal: async () => ({ ok: true }),
      });
      ok(r.filed === 1, 'a NACK on the content call leaves the report filed and files no data file');
      ok((await xmlDocsFor(o.id)).length === 0, 'a refused fetch records nothing');
    }

    // (d) ONLY EVER FILLS A GAP: a vendor that returns the data file as an entry of
    //     its own makes the second call a no-op instead of fetching the same file twice.
    {
      const o = await freshOrder('XML-INLINE');
      let contentCalled = false;
      const r = await sync.ingestDocuments(c, o, {
        authContext: { apiKey: 'K', subdomain: 'integrations.uat' },
        transport: {
          read: async (built, opts) => {
            if (opts && opts.label === 'RetriveDocumentContent') { contentCalled = true; return contentResp; }
            return { message: { deals: [{ embeddedFiles: [
              { documentId: 'INLINE_XML', objectName: 'appraisal.xml', objectURL: 'https://amc/getdoc/INLINE',
                includeXMLIndicator: true, objectXMLFileName: 'appraisal.xml', isAdditionalDocument: '0' },
            ] }] } };
          },
          getDocument: async () => ({ bytes: Buffer.from('<?xml version="1.0"?><VALUATION_RESPONSE/>'), contentType: 'application/xml' }),
        },
        importAppraisal: async () => ({ ok: true }),
      });
      ok(r.filed === 1, 'a listing that carries the data file itself files it once');
      ok(contentCalled === false, 'and the second call is never made — never the same file twice');
    }

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-sync-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
