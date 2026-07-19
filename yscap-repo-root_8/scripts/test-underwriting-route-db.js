'use strict';
/**
 * DB test for the underwriting ROUTE's building blocks (src/routes/underwriting.js):
 *   - file-view.loadContext / subjectFor: the subject each document type is compared against
 *     is assembled correctly from the application + borrower + vesting entity + LLCs.
 *   - file-view.normalizeForCrossDoc + the GET roll-up: a file's stored extractions reconcile
 *     across documents (seller mismatch between the contract and the title is FATAL).
 *   - the resolve gate SQL: remaining open fatal blocks-CTC findings gate clear-to-close.
 * Runs inside a transaction and ROLLS BACK — leaves no rows behind. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-route-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');
const fileView = require('../src/lib/underwriting/file-view');
const { computeCrossDocumentFindings } = require('../src/lib/underwriting/cross-document');
const { toISODate } = require('../src/lib/underwriting/compare');

const ADDR = { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'uwroute+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';

    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,current_address)
       VALUES ('John','Smith',$1,'1980-05-15',$2) RETURNING id`,
      [uniq, JSON.stringify(ADDR)])).rows[0];
    const llc = (await client.query(
      `INSERT INTO llcs (borrower_id,llc_name) VALUES ($1,'Maple Grove Holdings LLC') RETURNING id`, [b.id])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, llc_id, property_address, purchase_price, is_assignment, assignment_fee, underlying_contract_price)
       VALUES ($1,$2,$3,412000,true,15000,100000) RETURNING id`,
      [b.id, llc.id, JSON.stringify(ADDR)])).rows[0];

    // ---- 1. loadContext + subjectFor ----
    const ctx = await fileView.loadContext(client, app.id);
    assert.ok(ctx && ctx.app && ctx.borrower, 'context loads app + borrower');
    assert.strictEqual(ctx.vestingName, 'Maple Grove Holdings LLC', 'vesting entity name resolved');
    assert.deepStrictEqual(ctx.entityNames, ['Maple Grove Holdings LLC'], 'borrower entities gathered for assets view');

    const idSubj = fileView.subjectFor('government_id', ctx);
    assert.strictEqual(idSubj.first_name, 'John', 'government_id subject is the borrowers row');
    // db.js returns date-only as a 'YYYY-MM-DD' string in production; a raw pg Pool returns a
    // Date. The check normalizes via toISODate either way — assert on the normalized value.
    const dobRaw = idSubj.date_of_birth;
    const dobStr = dobRaw instanceof Date ? dobRaw.toISOString().slice(0, 10) : String(dobRaw).slice(0, 10);
    assert.strictEqual(toISODate(dobStr), '1980-05-15');

    const cSubj = fileView.subjectFor('purchase_contract', ctx);
    assert.strictEqual(cSubj.entity_name, 'Maple Grove Holdings LLC', 'contract subject carries the buyer entity');
    assert.strictEqual(Number(cSubj.purchase_price), 412000);
    assert.strictEqual(cSubj.is_assignment, true);
    assert.strictEqual(Number(cSubj.assignment_fee), 15000);
    assert.deepStrictEqual(cSubj.property_address, ADDR);

    const bSubj = fileView.subjectFor('bank_statement', ctx);
    assert.strictEqual(bSubj.borrower_name, 'John Smith', 'assets subject carries the borrower name');
    assert.deepStrictEqual(bSubj.entity_names, ['Maple Grove Holdings LLC']);

    // ---- 2. Store two documents whose sellers DISAGREE, then reconcile across them ----
    const docC = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,storage_provider) VALUES ($1,$2,'contract.pdf','local') RETURNING id`, [app.id, b.id])).rows[0];
    const docT = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,storage_provider) VALUES ($1,$2,'title.pdf','local') RETURNING id`, [app.id, b.id])).rows[0];
    await store.saveAnalysis(client, {
      documentId: docC.id, applicationId: app.id, borrowerId: b.id, docType: 'purchase_contract',
      extraction: { fields: { propertyAddress: ADDR, purchasePrice: 412000, sellerNames: ['Jane Seller'], buyerName: 'Maple Grove Holdings LLC', readable: true }, status: 'analyzed' },
      findings: [],
    });
    await store.saveAnalysis(client, {
      documentId: docT.id, applicationId: app.id, borrowerId: b.id, docType: 'title',
      extraction: { fields: { propertyAddress: ADDR, vestedOwners: ['Robert Jones'], readable: true }, status: 'analyzed' },
      findings: [],
    });

    // The GET path: read current extractions → normalize → cross-document reconcile.
    const exts = (await client.query(
      `SELECT doc_type, fields FROM document_extractions WHERE application_id=$1 AND is_current`, [app.id])).rows;
    const crossInput = {};
    for (const e of exts) { const n = fileView.normalizeForCrossDoc(e.doc_type, e.fields); if (n) crossInput[e.doc_type] = n; }
    const cross = computeCrossDocumentFindings(crossInput);
    assert.ok(cross.some((f) => f.code === 'cross_seller_mismatch'), 'seller mismatch surfaces across contract + title');
    assert.ok(cross.every((f) => f.code !== 'cross_address_mismatch'), 'matching addresses do NOT false-mismatch');

    // ---- 3. Resolve gate SQL: an open fatal blocks-CTC finding gates CTC ----
    const r = await store.saveAnalysis(client, {
      documentId: docC.id, applicationId: app.id, borrowerId: b.id, docType: 'purchase_contract',
      extraction: { fields: { propertyAddress: ADDR, readable: true }, status: 'analyzed' },
      findings: [{ code: 'contract_price_mismatch', severity: 'fatal', field: 'purchase_price', title: 'price', howTo: 'x', blocksCtc: true }],
    });
    const gate = async () => (await client.query(
      `SELECT count(*)::int n FROM document_findings WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [app.id])).rows[0].n;
    assert.strictEqual(await gate(), 1, 'one open fatal blocks CTC before resolve');
    await store.resolveFinding(client, { findingId: r.findingIds[0], action: 'fix_file', value: '412000', by: b.id });
    assert.strictEqual(await gate(), 0, 'resolving the fatal clears the CTC gate');

    await client.query('ROLLBACK');
    console.log('✓ test-underwriting-route-db: file-view subjects, cross-document GET roll-up, resolve gate pass');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
