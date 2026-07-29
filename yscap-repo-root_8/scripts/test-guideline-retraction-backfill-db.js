'use strict';
/**
 * DB test for desk-sync.backfillGuidelineRetractions — the boot pass that retracts stale guideline
 * findings on files nobody has re-opened (owner 2026-07-26: "fix this also for all the previous
 * files"). Focus: the CONSERVATIVE GUARD and the SCOPE, the two things unique to the backfill.
 * The retract mechanics themselves are covered by test-guideline-retraction-pure /
 * test-investor-guideline-desk-sync-pure.
 *
 * Runs inside a transaction and ROLLS BACK. Skips cleanly with no DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-guideline-retraction-backfill-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const deskSync = require('../src/lib/underwriting/investor-guidelines/desk-sync');

let passed = 0;
const ok = (n) => { console.log(`  PASS ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Isolate: take every OTHER file's open guideline row out of scope so the backfill only visits
    // the fixtures below (keeps the per-file desk computation bounded, and the assertions exact).
    await client.query(`UPDATE ai_suggestions SET status='dismissed' WHERE source=$1 AND status='open'`, [deskSync.SOURCE]);

    const uniq = 'gbf+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Gil','Bee',$1,'1980-05-15') RETURNING id`, [uniq])).rows[0];
    // An ALIVE, un-funded file with NO note buyer → the desk cannot assess it (no applicable rules).
    const alive = (await client.query(`INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`, [b.id])).rows[0];
    // A FUNDED file — out of scope regardless of its findings.
    const funded = (await client.query(`INSERT INTO applications (borrower_id, status) VALUES ($1,'funded') RETURNING id`, [b.id])).rows[0];

    // Each carries an OPEN guideline-desk suggestion with a bogus dedupe key the desk will not raise.
    const seed = async (appId) => client.query(
      `INSERT INTO ai_suggestions (application_id, source, kind, title, severity, status, dedupe_key)
       VALUES ($1,$2,'finding','Stale guideline notice','warning','open',$3)`,
      [appId, deskSync.SOURCE, 'isg-gap:stale_never_raised_' + appId]);
    await seed(alive.id);
    await seed(funded.id);

    // Run the backfill against this transaction's view of the DB.
    const res = await deskSync.backfillGuidelineRetractions(client);
    assert.ok(res && typeof res.scanned === 'number', 'returns a well-formed result and never throws');
    ok('backfill runs and returns a summary');

    // CONSERVATIVE GUARD: the alive file has no note buyer, so the desk does not assess it — and an
    // unassessed read must retract NOTHING (a transient/blank desk must never wipe real rows).
    const aliveRow = (await client.query(
      `SELECT status FROM ai_suggestions WHERE application_id=$1 AND source=$2`, [alive.id, deskSync.SOURCE])).rows[0];
    assert.strictEqual(aliveRow.status, 'open', 'an UNASSESSED file keeps its guideline row — the guard never wipes on a blank read');
    ok('conservative guard: a file the desk cannot assess has nothing retracted');

    // SCOPE: a funded file is never visited, so its row is untouched too (and not counted).
    const fundedRow = (await client.query(
      `SELECT status FROM ai_suggestions WHERE application_id=$1 AND source=$2`, [funded.id, deskSync.SOURCE])).rows[0];
    assert.strictEqual(fundedRow.status, 'open', 'a funded file is out of scope — its row is left alone');
    ok('scope: funded / dead files are not touched by the backfill');

    await client.query('ROLLBACK');
    console.log(`\nOK  guideline-retraction-backfill db — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL', e && e.stack || e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
