'use strict';
/**
 * Idempotency tests for the document-underwriting engine (db/168 + store.findReusableExtraction
 * + fingerprint.js). Two halves:
 *   - fingerprint.js is pure (no DB): stable subject hashing, version bumping.
 *   - the store lookup round-trips against a real DB (skips cleanly with no DATABASE_URL),
 *     inside a transaction that ROLLS BACK — leaves no rows behind.
 */
const assert = require('assert');
const { subjectHash, stableStringify, ANALYZER_VERSION } = require('../src/lib/underwriting/fingerprint');

// ---- fingerprint.js (pure) -------------------------------------------------
{
  // Key order must not change the hash (deterministic JSON).
  assert.strictEqual(subjectHash({ a: 1, b: 2 }), subjectHash({ b: 2, a: 1 }), 'key order is irrelevant');
  // A different VALUE must change the hash (a file edit re-analyzes).
  assert.notStrictEqual(subjectHash({ price: 400000 }), subjectHash({ price: 410000 }), 'a changed value changes the hash');
  // null / undefined are stable.
  assert.strictEqual(subjectHash(null), subjectHash(undefined), 'null and undefined hash the same');
  // Arrays keep order (order is meaningful).
  assert.notStrictEqual(stableStringify(['a', 'b']), stableStringify(['b', 'a']), 'array order matters');
  assert.ok(/gpt5/.test(ANALYZER_VERSION), 'version tag names the analyzer');
}

// ---- store lookup (DB) -----------------------------------------------------
async function main() {
  if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-idempotency DB half (no DATABASE_URL)'); return; }
  const { Pool } = require('pg');
  const store = require('../src/lib/underwriting/store');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'uwidem+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Ida','Idem',$1,'1980-01-01') RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const doc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider,sha256)
       VALUES ($1,$2,'contract.pdf','application/pdf','local','abc123sha') RETURNING id`, [app.id, b.id])).rows[0];

    const SHA = 'abc123sha';
    const SUBJ = subjectHash({ price: 400000 });
    // Save an analysis stamped with the fingerprint.
    await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'purchase_contract',
      extraction: { fields: { purchasePrice: 400000 }, status: 'analyzed', confidence: 'analyzed' },
      findings: [{ source: 'purchase_contract', code: 'price_mismatch', severity: 'fatal', blocksCtc: true, title: 'x' }],
      analyzedSha256: SHA, analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ,
    });

    // 1. Exact match → reusable extraction found + its open finding.
    const hit = await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: SHA,
      analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ });
    assert.ok(hit, 'identical inputs → reusable extraction');
    const hf = await store.findingsForExtraction(client, hit.id);
    assert.strictEqual(hf.length, 1, 'its open finding comes back');

    // 2. Different content hash (re-uploaded/edited doc) → no reuse.
    assert.strictEqual(await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: 'DIFFERENT',
      analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ }), null, 'changed bytes → re-analyze');

    // 3. Changed FILE STATE (subject hash) → no reuse (findings depend on the file).
    assert.strictEqual(await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: SHA,
      analyzerVersion: ANALYZER_VERSION, subjectHash: subjectHash({ price: 999999 }) }), null, 'file edit → re-analyze');

    // 4. Bumped analyzer version → no reuse (new model/prompt).
    assert.strictEqual(await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: SHA,
      analyzerVersion: 'newer-version', subjectHash: SUBJ }), null, 'version bump → re-analyze');

    // 5. No content hash at all (legacy doc) → never reuse.
    assert.strictEqual(await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: null,
      analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ }), null, 'no sha → always re-analyze');

    // 5b. A DIFFERENT application must NOT reuse this file's extraction — a profile-level doc
    //     analyzed on file A must re-analyze (and re-gate) on file B (same borrower). [audit #2]
    const app2 = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    assert.strictEqual(await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app2.id, docType: 'purchase_contract', analyzedSha256: SHA,
      analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ }), null, 'a different file never reuses another file\'s extraction');

    // 6. After a re-save (supersede), the OLD extraction is no longer current → not reused,
    //    the NEW one is.
    await store.saveAnalysis(client, {
      documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'purchase_contract',
      extraction: { fields: { purchasePrice: 400000 }, status: 'analyzed', confidence: 'analyzed' },
      findings: [], analyzedSha256: SHA, analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ });
    const hit2 = await store.findReusableExtraction(client, {
      documentId: doc.id, applicationId: app.id, docType: 'purchase_contract', analyzedSha256: SHA,
      analyzerVersion: ANALYZER_VERSION, subjectHash: SUBJ });
    assert.ok(hit2 && hit2.id !== hit.id, 'the current (re-saved) extraction is the reusable one');

    await client.query('ROLLBACK');
    console.log('test-underwriting-idempotency: fingerprint + store reuse pass');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
