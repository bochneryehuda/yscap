'use strict';
/*
 * #249 — runWholeLoan END TO END against a real Postgres. buildWholeLoanContext was
 * fixed in #684, but persistRun (+ verification-findings + shadow-capture) had ALSO
 * never run against a real DB — the only runWholeLoan test was pure/persist:false — so
 * the whole-loan run activated in #682 could STILL be throwing at persist and returning
 * null. This proves the FULL run works: it returns a runId and actually persists a
 * current underwriting_runs row (+ snapshot + decision), and a second run supersedes
 * the first (the one-current-run invariant holds).
 *
 * Requires DATABASE_URL; SKIPs otherwise. persistRun owns its own transaction on a
 * dedicated pool connection, so this COMMITS real rows — it cleans up by deleting the
 * application (underwriting_runs is ON DELETE CASCADE) + its shadow_decisions + borrower.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-run-whole-loan-e2e-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const { runWholeLoan } = require('../src/lib/underwriting/run');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let bId = null, aId = null;
  try {
    const email = 'e2erun+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    bId = (await pool.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('E2E','Run',$1,'1985-01-01') RETURNING id`, [email])).rows[0].id;
    aId = (await pool.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bId])).rows[0].id;

    // A db handle mirroring the app's: .query for reads + .pool so persistRun opens its
    // OWN dedicated connection/transaction — exactly the production path.
    const db = { query: (t, p) => pool.query(t, p), pool };

    // 1. The full run executes and PERSISTS (this is what proves it isn't dark).
    const res = await runWholeLoan(aId, db, { trigger: 'e2e_test' });
    assert.ok(res, 'runWholeLoan returned a result (not null)');
    assert.ok(res.runId, 'runWholeLoan returned a runId — the run actually persisted');
    ok('runWholeLoan runs end-to-end and returns a persisted runId');

    const runs = await pool.query(
      `SELECT id, status FROM underwriting_runs WHERE application_id=$1 AND superseded_at IS NULL`, [aId]);
    assert.strictEqual(runs.rows.length, 1, 'exactly one current underwriting_runs row');
    assert.strictEqual(runs.rows[0].id, res.runId, 'the current run is the one returned');
    ok('a current underwriting_runs row is persisted (persistRun works against the real schema)');

    const snap = await pool.query(`SELECT 1 FROM underwriting_run_snapshots WHERE run_id=$1`, [res.runId]);
    assert.strictEqual(snap.rows.length, 1, 'the run snapshot is written');
    const dec = await pool.query(`SELECT status FROM underwriting_run_decisions WHERE run_id=$1`, [res.runId]);
    assert.strictEqual(dec.rows.length, 1, 'the run decision is written');
    ok('the run snapshot + decision rows are persisted');

    // 2. A second run SUPERSEDES the first — the partial-unique one-current-run index holds.
    const res2 = await runWholeLoan(aId, db, { trigger: 'e2e_test_2' });
    assert.ok(res2 && res2.runId && res2.runId !== res.runId, 'the second run gets a new id');
    const cur = await pool.query(
      `SELECT id FROM underwriting_runs WHERE application_id=$1 AND superseded_at IS NULL`, [aId]);
    assert.strictEqual(cur.rows.length, 1, 'still exactly one current run after a second run');
    assert.strictEqual(cur.rows[0].id, res2.runId, 'the newest run is the current one');
    ok('a second run supersedes the first (the one-current-run invariant holds)');

    console.log(`\nrunWholeLoan end-to-end (#249) db — ${passed} checks passed`);
  } finally {
    if (aId) {
      await pool.query(`DELETE FROM shadow_decisions WHERE application_id=$1`, [aId]).catch(() => {});
      await pool.query(`DELETE FROM applications WHERE id=$1`, [aId]).catch(() => {}); // cascades underwriting_runs*
    }
    if (bId) await pool.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
