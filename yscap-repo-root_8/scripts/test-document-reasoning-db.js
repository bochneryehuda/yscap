'use strict';
/**
 * DB test for the per-document REASONING layer (owner-directed 2026-07-27, the tax-cert incident).
 * Proves, against a REAL Postgres (a wrong column name would throw here — a pure test can't catch
 * that): (1) store.saveAnalysis persists the `reasoning` jsonb; (2) file-review.tieoutForFile threads
 * it back and the comparison-gate SUPPRESSES a cross-side entity_name discrepancy end-to-end; (3) the
 * SAME file with no reasoning DOES raise the discrepancy — so the gate, not the data, is the change.
 * Runs inside a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-document-reasoning-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');
const { tieoutForFile } = require('../src/lib/underwriting/file-review');

const ADDR = { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'uwreason+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';

    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Jane','Doe',$1) RETURNING id`, [uniq])).rows[0];
    const llc = (await client.query(
      `INSERT INTO llcs (borrower_id,llc_name) VALUES ($1,'New Vesting LLC') RETURNING id`, [b.id])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, llc_id, property_address) VALUES ($1,$2,$3) RETURNING id`,
      [b.id, llc.id, JSON.stringify(ADDR)])).rows[0];

    // A document whose slot-driven extraction (wrongly) carries the CURRENT OWNER in its entity_name
    // field — the tax-cert-filed-under-title case. Save it WITH reasoning that names only the current
    // owner (seller side).
    const doc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,storage_provider) VALUES ($1,$2,'tax-cert.pdf','local') RETURNING id`,
      [app.id, b.id])).rows[0];
    const reasoning = {
      docNature: 'tax_certificate', purpose: 'Shows the current owner of record and taxes owed.',
      asOf: 'pre_close', matchesFiledType: false, confidence: 0.95,
      parties: [{ name: 'Old Owner LLC', role: 'current_owner' }],
    };
    await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'operating_agreement',
      extraction: { fields: { entityLegalName: 'Old Owner LLC', readable: true }, status: 'analyzed', reasoning },
      findings: [],
    });

    // 1. The reasoning column persisted (a wrong column name / cast would have thrown on the insert).
    const row = (await client.query(
      `SELECT reasoning FROM document_extractions WHERE document_id=$1 AND is_current`, [doc.id])).rows[0];
    assert.ok(row, 'extraction row exists');
    let stored = row.reasoning;
    if (typeof stored === 'string') stored = JSON.parse(stored);
    assert.ok(stored && Array.isArray(stored.parties), 'reasoning jsonb persisted with parties');
    assert.strictEqual(stored.parties[0].role, 'current_owner', 'party role round-trips');
    assert.strictEqual(stored.docNature, 'tax_certificate');

    // 2. tieoutForFile threads reasoning through and the gate SUPPRESSES the entity_name discrepancy.
    const to = await tieoutForFile(client, app.id);
    assert.ok(!to.discrepancies.some((d) => d.field === 'entity_name'),
      'the reasoning gate suppressed the cross-side entity_name comparison end-to-end');

    // 3. Re-save the SAME extraction WITHOUT reasoning → the discrepancy DOES fire (the gate, not the
    //    data, was the difference). Supersedes the prior current row.
    await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'operating_agreement',
      extraction: { fields: { entityLegalName: 'Old Owner LLC', readable: true }, status: 'analyzed' },
      findings: [],
    });
    const to2 = await tieoutForFile(client, app.id);
    assert.ok(to2.discrepancies.some((d) => d.field === 'entity_name'),
      'without reasoning the same operating-agreement name still ties out against the vesting entity');

    await client.query('ROLLBACK');
    console.log('✓ test-document-reasoning-db: reasoning persists + threads through + gate suppresses end-to-end');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
