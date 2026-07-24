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
    // property_address is a jsonb blob; the subject STATE lives inside it — there is NO
    // applications.property_state column (the #259 phantom-column bug read that non-existent
    // column, leaving ctx.values.property_state null → the Blue Lake NY escalation could never fire).
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, property_address)
         VALUES ($1, '{"state":"NY","city":"Brooklyn"}'::jsonb) RETURNING id`, [b.id])).rows[0];

    // 1. No appraisal on file → the appraisal-sourced values are null (never fabricated).
    let ctx = await buildWholeLoanContext(app.id, client);
    assert.ok(ctx, 'context builds');
    assert.strictEqual(ctx.values.as_is_value, null, 'no appraisal → as_is_value null');
    assert.strictEqual(ctx.values.arv, null, 'no appraisal → arv null');
    ok('with no appraisal on file, the appraisal-sourced values are null');

    // 1b. #259 — the subject state surfaces from property_address.state (normalized to the USPS
    //     2-letter code), NOT from a phantom applications.property_state column. This is the guard
    //     a pure test can't provide: it proves buildWholeLoanContext reads the REAL jsonb column.
    assert.strictEqual(ctx.values.property_state, 'NY', 'property_state surfaces from property_address.state (was always null before the fix)');
    ok('the subject state surfaces from property_address.state — the Blue Lake NY rule can now fire');

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
