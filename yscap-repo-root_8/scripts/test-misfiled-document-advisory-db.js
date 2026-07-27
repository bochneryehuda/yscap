'use strict';
/**
 * DB test for the mis-filed-document advisory (owner-directed 2026-07-27). Against a real Postgres:
 * a current extraction whose stored reasoning confidently says it does NOT match its filed slot
 * raises ONE ai_suggestion; once the reasoning says it DOES match (re-read correctly), the advisory
 * is withdrawn. Runs in a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-misfiled-document-advisory-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { syncMisfiledDocumentAdvisory } = require('../src/lib/underwriting/misfiled-document-advisory');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'misfiled+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('T','U',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
      [b.id, JSON.stringify({ line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' })])).rows[0];
    const doc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,storage_provider) VALUES ($1,$2,'tax.pdf','local') RETURNING id`, [app.id, b.id])).rows[0];

    // A tax certificate filed under the "title" slot, the model confident it's mis-filed.
    const misReasoning = { docNature: 'tax certificate', matchesFiledType: false, confidence: 0.95, purpose: 'shows the current owner of record' };
    await client.query(
      `INSERT INTO document_extractions (document_id, application_id, borrower_id, doc_type, fields, reasoning, status, is_current)
       VALUES ($1,$2,$3,'title','{}'::jsonb,$4::jsonb,'analyzed',true)`,
      [doc.id, app.id, b.id, JSON.stringify(misReasoning)]);

    // 1. Raises exactly one advisory.
    const r1 = await syncMisfiledDocumentAdvisory(client, app.id);
    assert.strictEqual(r1.raised, 1, 'a confident mis-file raises one advisory');
    const s1 = (await client.query(
      `SELECT title, status, dedupe_key FROM ai_suggestions WHERE application_id=$1 AND source='misfiled_document' AND status='open'`, [app.id])).rows;
    assert.strictEqual(s1.length, 1, 'one open misfiled_document suggestion');
    assert.ok(/tax certificate/.test(s1[0].title) && /title/.test(s1[0].title), 'the advisory names what it is vs where it was filed');
    assert.strictEqual(s1[0].dedupe_key, `misfiled_document:${doc.id}`, 'deduped per document');

    // 2. Idempotent — a second pass does not create a second row.
    await syncMisfiledDocumentAdvisory(client, app.id);
    const openCount = (await client.query(
      `SELECT count(*)::int AS n FROM ai_suggestions WHERE application_id=$1 AND source='misfiled_document' AND status='open'`, [app.id])).rows[0].n;
    assert.strictEqual(openCount, 1, 'still exactly one open row (idempotent)');

    // 3. Re-read correctly (matchesFiledType now true) → the advisory is withdrawn.
    await client.query(
      `UPDATE document_extractions SET reasoning = $2::jsonb WHERE document_id=$1 AND is_current`,
      [doc.id, JSON.stringify({ docNature: 'title commitment', matchesFiledType: true, confidence: 0.95 })]);
    const r2 = await syncMisfiledDocumentAdvisory(client, app.id);
    assert.strictEqual(r2.retracted, 1, 'the advisory is withdrawn once the document reads correctly');
    const stillOpen = (await client.query(
      `SELECT count(*)::int AS n FROM ai_suggestions WHERE application_id=$1 AND source='misfiled_document' AND status='open'`, [app.id])).rows[0].n;
    assert.strictEqual(stillOpen, 0, 'no open misfiled advisory remains');

    await client.query('ROLLBACK');
    console.log('✓ test-misfiled-document-advisory-db: raise + idempotent + auto-withdraw');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
