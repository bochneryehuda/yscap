'use strict';
/**
 * DB test for findings-triage. Against a real Postgres: a persisted triage ranking is read back by
 * readMemory and applied by the display pass (re-order + annotate); reviewTriage is best-effort
 * (skips cleanly with no Azure). Runs in a transaction and ROLLS BACK. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-findings-triage-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const t = require('../src/lib/underwriting/findings-triage');
const { claimOf } = require('../src/lib/underwriting/finding-claims');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'triage+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('T','U',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
      [b.id, JSON.stringify({ line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' })])).rows[0];

    const f1 = { code: 'contract_price_mismatch', field: 'purchase_price', severity: 'fatal', title: 'Price' };
    const f2 = { code: 'bank_large_deposit', field: 'deposits', severity: 'warning', title: 'Large deposit' };
    // Rank f2 as the primary "look here first", f1 as noise.
    await client.query(`INSERT INTO finding_triage (application_id, claim_key, bucket, rank, why, set_hash) VALUES ($1,$2,'primary',1,'the real story','h')`, [app.id, claimOf(f2)]);
    await client.query(`INSERT INTO finding_triage (application_id, claim_key, bucket, rank, why, set_hash) VALUES ($1,$2,'noise',2,'fine in context','h')`, [app.id, claimOf(f1)]);

    // Unique per (app, claim_key) — a second insert on the same key must upsert.
    await client.query('SAVEPOINT d');
    await assert.rejects(() => client.query(`INSERT INTO finding_triage (application_id, claim_key, bucket) VALUES ($1,$2,'noise')`, [app.id, claimOf(f2)]), /duplicate key/i);
    await client.query('ROLLBACK TO SAVEPOINT d');

    const mem = await t.readMemory(client, app.id);
    assert.strictEqual(mem.size, 2, 'both rankings read back');
    const out = t.applyTriage([f1, f2], mem);
    assert.strictEqual(out[0].code, 'bank_large_deposit', 'the AI-primary finding floats to the top of the worklist');
    assert.strictEqual(out[0].aiTriage.bucket, 'primary');
    assert.strictEqual(out[1].aiTriage.bucket, 'noise');

    // reviewTriage is best-effort — no Azure in the test env → a clean skip, no throw.
    const res = await t.reviewTriage({ client, appId: app.id, findings: [f1, f2] });
    assert.strictEqual(res.skipped, 'ai_unavailable');

    await client.query('ROLLBACK');
    console.log('✓ test-findings-triage-db: ranking persists + display re-order + idempotent');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); process.exit(1);
  } finally { client.release(); await pool.end(); }
})();
