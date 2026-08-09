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
