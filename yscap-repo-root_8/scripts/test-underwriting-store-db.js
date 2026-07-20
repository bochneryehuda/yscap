'use strict';
/**
 * DB test for the underwriting persistence layer (src/lib/underwriting/store.js).
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Runs inside a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-store-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fixtures.
    const uniq = 'uwtest+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('John','Smith',$1,'1980-05-15') RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const doc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider) VALUES ($1,$2,'id.jpg','image/jpeg','local') RETURNING id`,
      [app.id, b.id])).rows[0];

    // 1. Save an analysis with a sensitive field + one fatal finding.
    const r1 = await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'government_id',
      extraction: { fields: { firstName: 'John', documentNumber: 'TX1234567', dateOfBirth: '1980-05-15' }, ocrEngine: 'document_intelligence', pageCount: 1, confidence: 'analyzed', status: 'analyzed' },
      findings: [{ source: 'government_id', code: 'id_dob_mismatch', severity: 'fatal', field: 'date_of_birth', docValue: '1979-01-01', fileValue: '1980-05-15', title: 'DOB mismatch', howTo: 'check', blocksCtc: true }],
    });
    assert.ok(r1.extractionId && r1.findingIds.length === 1);

    // PII masking: documentNumber stored as last-4 only; non-sensitive field intact.
    const ext = (await client.query(`SELECT fields, is_current FROM document_extractions WHERE id=$1`, [r1.extractionId])).rows[0];
    assert.strictEqual(ext.fields.documentNumber, '***4567', 'ID number must be masked to last-4');
    assert.strictEqual(ext.fields.firstName, 'John', 'non-sensitive fields kept');
    assert.strictEqual(ext.is_current, true);

    // 2. File roll-up: one open fatal, blocks CTC.
    const roll1 = await store.getFileFindings(client, app.id);
    assert.strictEqual(roll1.findings.length, 1);
    assert.strictEqual(roll1.summary.fatal, 1);
    assert.strictEqual(roll1.summary.blocksCtc, true);

    // 2b. Underwriter resolves it: post_condition keeps it open (still blocks); clear closes it.
    const posted = await store.resolveFinding(client, { findingId: r1.findingIds[0], action: 'post_condition', note: 'request an updated ID', by: b.id });
    assert.strictEqual(posted.status, 'open');
    assert.strictEqual(posted.resolution, 'post_condition');
    assert.strictEqual((await store.getFileFindings(client, app.id)).summary.blocksCtc, true, 'a posted condition still blocks until cleared');
    const cleared = await store.resolveFinding(client, { findingId: r1.findingIds[0], action: 'clear', by: b.id });
    assert.strictEqual(cleared.status, 'resolved');
    assert.strictEqual((await store.getFileFindings(client, app.id)).summary.fatal, 0, 'clearing drops the open fatal');
    // Resolving an already-closed finding is a no-op.
    assert.strictEqual(await store.resolveFinding(client, { findingId: r1.findingIds[0], action: 'dismiss', by: b.id }), null);

    // 3. Re-analyze the SAME document → prior extraction superseded, exactly one current.
    const r2 = await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'government_id',
      extraction: { fields: { firstName: 'John' }, status: 'analyzed', confidence: 'analyzed' },
      findings: [],
    });
    const currents = (await client.query(`SELECT count(*)::int n FROM document_extractions WHERE document_id=$1 AND is_current`, [doc.id])).rows[0].n;
    assert.strictEqual(currents, 1, 'exactly one current extraction after re-analysis');
    const prevExt = (await client.query(`SELECT is_current FROM document_extractions WHERE id=$1`, [r1.extractionId])).rows[0];
    assert.strictEqual(prevExt.is_current, false, 'prior extraction superseded on re-analysis');
    assert.ok(r2.extractionId);

    // 4. CROSS-FILE supersede scoping (deep-audit BLOCKER regression). A profile-level document
    // (application_id NULL) can be analyzed under two files of the SAME borrower. Analyzing it on
    // file B must NOT supersede file A's current extraction or its open findings — the supersede
    // is scoped by application_id. Before the fix, file B's analyze wiped file A's fatal and falsely
    // opened its clear-to-close gate.
    const appB = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const pdoc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider) VALUES (NULL,$1,'oa.pdf','application/pdf','local') RETURNING id`, [b.id])).rows[0];
    const fatalF = [{ source: 'government_id', code: 'id_expired', severity: 'fatal', field: 'expiry', docValue: '2020-01-01', fileValue: null, title: 'ID expired', howTo: 'x', blocksCtc: true }];
    await store.saveAnalysis(client, { documentId: pdoc.id, applicationId: app.id, borrowerId: b.id, docType: 'government_id', extraction: { fields: {}, status: 'analyzed' }, findings: fatalF });
    await store.saveAnalysis(client, { documentId: pdoc.id, applicationId: appB.id, borrowerId: b.id, docType: 'government_id', extraction: { fields: {}, status: 'analyzed' }, findings: fatalF });
    const aCur = (await client.query(`SELECT count(*)::int n FROM document_extractions WHERE application_id=$1 AND document_id=$2 AND is_current`, [app.id, pdoc.id])).rows[0].n;
    const aFatal = (await client.query(`SELECT count(*)::int n FROM document_findings WHERE application_id=$1 AND status='open' AND severity='fatal'`, [app.id])).rows[0].n;
    assert.strictEqual(aCur, 1, 'file A keeps its current extraction after the profile doc is analyzed on file B');
    assert.strictEqual(aFatal, 1, 'file A keeps its open fatal (CTC gate) after file B analyzes the shared profile doc');

    await client.query('ROLLBACK');
    console.log('✓ test-underwriting-store-db: persistence, PII masking, supersede, roll-up pass');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
