'use strict';
/**
 * "IF PILOT CAN'T READ IT, DON'T GIVE A FINDING" — the persist chokepoint (owner-directed 2026-07-28).
 *
 * Proves, against a real DB, that store.saveAnalysis:
 *   1. DROPS a can't-read finding (bank_unreadable) at persist — it is never born as a document_findings
 *      row — while a REAL finding on the same document persists untouched;
 *   2. KEEPS the re-request signal alive — document_extractions.confidence stays 'unreadable', which is
 *      what drives the "still to read" nudge (completeness), entirely independent of the finding;
 *   3. reports the suppressed count on its return; and
 *   4. honors the escape hatch UW_UNREADABLE_FINDINGS_SHOW=1 (both findings persist).
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Runs in a transaction and
 * ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-unreadable-findings-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');

// A real discrepancy that must always survive, paired with a can't-read finding that must not.
const REAL = { source: 'bank_statement', code: 'bank_account_other_entity', severity: 'warning', field: 'holder', docValue: 'Some LLC', title: 'account held by another entity', howTo: 'verify', blocksCtc: false };
const CANT_READ = { source: 'bank_statement', code: 'bank_unreadable', severity: 'warning', field: 'document', title: 'could not read this statement', howTo: 'request a clearer copy', blocksCtc: false };

async function findingsFor(client, extractionId) {
  return (await client.query(`SELECT code FROM document_findings WHERE extraction_id=$1 ORDER BY code`, [extractionId])).rows.map((r) => r.code);
}
async function confidenceFor(client, extractionId) {
  return (await client.query(`SELECT confidence FROM document_extractions WHERE id=$1`, [extractionId])).rows[0].confidence;
}

(async () => {
  delete process.env.UW_UNREADABLE_FINDINGS_SHOW; // default: suppress
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  let passed = 0;
  const ok = (m) => { passed += 1; console.log(`  ok  ${m}`); };
  try {
    await client.query('BEGIN');
    const uniq = 'uwunread+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Jane','Doe',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const doc = (await client.query(`INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider) VALUES ($1,$2,'bank.pdf','application/pdf','local') RETURNING id`, [app.id, b.id])).rows[0];

    // 1+2+3: default posture — the can't-read finding is dropped, the real one persists, confidence survives.
    const r = await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'bank_statement',
      // readable:false → engine would set confidence 'unreadable'; here we set it directly since we call store.
      extraction: { fields: { readable: false }, status: 'analyzed', confidence: 'unreadable' },
      findings: [REAL, CANT_READ],
    });
    const codes = await findingsFor(client, r.extractionId);
    assert.deepStrictEqual(codes, ['bank_account_other_entity'], 'only the real finding is persisted');
    ok('the can’t-read finding (bank_unreadable) is never born; the real finding persists');
    assert.strictEqual(r.suppressedUnreadable, 1, 'saveAnalysis reports one suppressed');
    ok('saveAnalysis returns suppressedUnreadable=1');
    assert.strictEqual(await confidenceFor(client, r.extractionId), 'unreadable',
      'the re-request signal (confidence=unreadable) survives suppression');
    ok('confidence=unreadable is preserved — the document is still chased for a clearer copy');

    // The file roll-up shows only the real finding — the desk is clean of the can't-read note.
    const roll = await store.getFileFindings(client, app.id);
    assert.strictEqual(roll.findings.length, 1);
    assert.strictEqual(roll.findings[0].code, 'bank_account_other_entity');
    ok('the file roll-up carries only the real finding');

    // 4: escape hatch — re-save the SAME document with the switch ON; both findings now persist.
    process.env.UW_UNREADABLE_FINDINGS_SHOW = '1';
    const r2 = await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'bank_statement',
      extraction: { fields: { readable: false }, status: 'analyzed', confidence: 'unreadable' },
      findings: [REAL, CANT_READ],
    });
    const codes2 = await findingsFor(client, r2.extractionId);
    assert.deepStrictEqual(codes2, ['bank_account_other_entity', 'bank_unreadable'], 'both persist when shown');
    assert.strictEqual(r2.suppressedUnreadable, 0);
    ok('UW_UNREADABLE_FINDINGS_SHOW=1 re-persists the can’t-read finding');

    console.log(`\nOK  unreadable-findings-db: ${passed} checks passed`);
  } catch (e) {
    console.error('FAIL', e && e.stack || e);
    process.exitCode = 1;
  } finally {
    delete process.env.UW_UNREADABLE_FINDINGS_SHOW;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})();
