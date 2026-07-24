'use strict';
/*
 * #248 — the canonical whole-loan context loads its CURRENT appraisal from the
 * REAL columns (superseded=false, ordered by imported_at), not the phantom
 * is_current/created_at the old query used. Those columns don't exist on the
 * appraisals table, so the query threw and a swallowing catch left the appraisal
 * (and its as_is_value/arv candidates) silently DARK. This proves the appraisal
 * value now actually surfaces — the kind of wrong-column regression a pure test
 * (which mocks the query) cannot catch.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-whole-loan-context-appraisal-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { buildWholeLoanContext } = require('../src/lib/underwriting/whole-loan-context');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'apprctx+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Appr','Ctx',$1,'1985-03-10') RETURNING id`, [email])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];

    // 1. No appraisal on file → the appraisal-sourced values are null (never fabricated).
    let ctx = await buildWholeLoanContext(app.id, client);
    assert.ok(ctx, 'context builds');
    assert.strictEqual(ctx.values.as_is_value, null, 'no appraisal → as_is_value null');
    assert.strictEqual(ctx.values.arv, null, 'no appraisal → arv null');
    ok('with no appraisal on file, the appraisal-sourced values are null');

    // 2. A CURRENT appraisal (superseded=false) → its as_is_value/arv now surface.
    //    Before the column fix this query threw (is_current/created_at don't exist),
    //    the catch nulled the appraisal, and these stayed null — the bug this guards.
    await client.query(
      `INSERT INTO appraisals (application_id, as_is_value, arv_value, appraised_value)
         VALUES ($1, 555000, 700000, 560000)`, [app.id]);
    ctx = await buildWholeLoanContext(app.id, client);
    assert.strictEqual(Number(ctx.values.as_is_value), 555000, 'appraisal as_is_value surfaces (was dark before the fix)');
    assert.strictEqual(Number(ctx.values.arv), 700000, 'appraisal arv_value surfaces');
    ok('a current appraisal lights up the context as_is_value/arv');

    // 3. A SUPERSEDED appraisal is excluded (the superseded=false filter works).
    await client.query(`UPDATE appraisals SET superseded = true WHERE application_id = $1`, [app.id]);
    ctx = await buildWholeLoanContext(app.id, client);
    assert.strictEqual(ctx.values.as_is_value, null, 'a superseded appraisal is not loaded');
    assert.strictEqual(ctx.values.arv, null, 'a superseded appraisal contributes no arv');
    ok('a superseded appraisal is excluded (no stale value leaks in)');

    console.log(`\nwhole-loan-context appraisal load (#248) db — ${passed} checks passed`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
