'use strict';
/**
 * DB test for the AI finding-review GATE's memory (owner-directed 2026-07-27). Against a REAL
 * Postgres (a wrong column would throw here): a remembered verdict in finding_ai_reviews is read by
 * memoryAllForFile and the display pass (annotateFindings) SUPPRESSES a confidently-rejected finding
 * while keeping (and enriching) a confirmed one; the (application_id, fingerprint) unique index makes
 * the memory idempotent. Runs inside a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-finding-ai-review-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const rev = require('../src/lib/underwriting/finding-ai-review');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'aireview+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Test','User',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
      [b.id, JSON.stringify({ line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' })])).rows[0];

    const rejected = { code: 'tieout_entity_name', field: 'entity_name', docValue: 'Old Owner LLC', fileValue: 'New Vesting LLC', title: 'Vesting mismatch', documentId: null };
    const confirmed = { code: 'contract_price_mismatch', field: 'purchase_price', docValue: '$500,000', fileValue: '$412,000', title: 'Price mismatch', documentId: null };
    const fpRej = rev.fingerprintOf(rejected);
    const fpConf = rev.fingerprintOf(confirmed);

    // Remember a REJECTED verdict for the first and a CONFIRMED (with suggestions) for the second.
    await client.query(
      `INSERT INTO finding_ai_reviews (application_id, fingerprint, code, verdict, is_real_concern, confidence, reasoning)
       VALUES ($1,$2,$3,'rejected',false,0.95,'The document names the current owner (seller), not our buyer')`,
      [app.id, fpRej, rejected.code]);
    await client.query(
      `INSERT INTO finding_ai_reviews (application_id, fingerprint, code, verdict, is_real_concern, confidence, reasoning, suggested_resolution, suggested_document)
       VALUES ($1,$2,$3,'confirmed',true,0.9,'The contract price genuinely disagrees with the file','Reconcile the price with the seller','purchase contract')`,
      [app.id, fpConf, confirmed.code]);

    // 1. The (application_id, fingerprint) unique index prevents a second row. A raw duplicate
    //    INSERT must fail — wrapped in a SAVEPOINT so the expected error doesn't poison the outer tx.
    await client.query('SAVEPOINT dup');
    await assert.rejects(
      () => client.query(`INSERT INTO finding_ai_reviews (application_id, fingerprint, verdict) VALUES ($1,$2,'uncertain')`, [app.id, fpRej]),
      /duplicate key/i, 'the (application_id, fingerprint) unique index prevents a second row');
    await client.query('ROLLBACK TO SAVEPOINT dup');
    // ...and an ON CONFLICT DO UPDATE upserts in place (what the module's persist does) — still one row.
    await client.query(
      `INSERT INTO finding_ai_reviews (application_id, fingerprint, verdict, is_real_concern, confidence)
       VALUES ($1,$2,'rejected',false,0.99)
       ON CONFLICT (application_id, fingerprint) DO UPDATE SET confidence=EXCLUDED.confidence, updated_at=now()`,
      [app.id, fpRej]);
    const cnt = (await client.query(`SELECT count(*)::int AS n FROM finding_ai_reviews WHERE application_id=$1 AND fingerprint=$2`, [app.id, fpRej])).rows[0].n;
    assert.strictEqual(cnt, 1, 'upsert keeps exactly one row per (app, fingerprint)');

    // 2. memoryAllForFile reads both remembered verdicts.
    const mem = await rev.memoryAllForFile(client, app.id);
    assert.strictEqual(mem.size, 2, 'both verdicts read back');
    assert.strictEqual(mem.get(fpRej).verdict, 'rejected');
    assert.strictEqual(mem.get(fpConf).suggested_document, 'purchase contract', 'the AI suggestion round-trips');

    // 3. The display pass SUPPRESSES the rejected finding and KEEPS + ENRICHES the confirmed one.
    const { shown, suppressed } = rev.annotateFindings([rejected, confirmed], mem);
    assert.strictEqual(suppressed.length, 1, 'the false alarm is suppressed');
    assert.strictEqual(suppressed[0].code, 'tieout_entity_name');
    assert.strictEqual(shown.length, 1, 'the real finding stays');
    assert.strictEqual(shown[0].code, 'contract_price_mismatch');
    assert.ok(shown[0].aiReview && shown[0].aiReview.verdict === 'confirmed', 'the survivor carries its AI review');
    assert.strictEqual(shown[0].aiReview.suggestedResolution, 'Reconcile the price with the seller',
      'the AI-suggested resolution is attached on top of the finding');

    // 4. reviewFindings is best-effort: no Azure config in the test env → a skip, never a throw, and
    //    it writes nothing (fail-open).
    const res = await rev.reviewFindings({ client, appId: app.id, findings: [rejected, confirmed] });
    assert.strictEqual(res.skipped, 'ai_unavailable', 'no Azure → skipped, no calls');

    await client.query('ROLLBACK');
    console.log('✓ test-finding-ai-review-db: verdict memory persists + gate suppresses/enriches + idempotent');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
