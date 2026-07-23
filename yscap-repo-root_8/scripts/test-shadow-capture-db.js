'use strict';
/**
 * #200 — DB round-trip for the shadow-decision live feed. Proves: recordRunShadow
 * INSERTs one open whole_loan shadow and a second run UPDATES (not duplicates) the
 * same open candidate; ingestStatusOutcome on a terminal status stamps human_outcome
 * so loadReliabilityReport scores it; and a non-terminal status stamps nothing.
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-shadow-capture-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const sc = require('../src/lib/underwriting/shadow-capture');
const reliability = require('../src/lib/underwriting/reliability');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'shadowtest+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Jane','Doe',$1,'1985-03-10') RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];

    // 1. First run → inserts one open whole_loan shadow.
    const r1 = await sc.recordRunShadow(client, { applicationId: app.id, run: { status: 'MANUAL_PENDING', termSheetEligible: true, ctcEligible: false, fundingEligible: false, runId: 'run1' } });
    assert.strictEqual(r1.action, 'inserted');
    let rows = (await client.query(`SELECT candidate_decision, human_outcome FROM shadow_decisions WHERE application_id=$1`, [app.id])).rows;
    assert.strictEqual(rows.length, 1, 'one shadow row');
    assert.strictEqual(rows[0].candidate_decision.verdict, 'refer', 'MANUAL_PENDING → refer candidate');
    ok('first run inserts one open whole_loan shadow (refer)');

    // 2. Second run → UPDATES the same open candidate (no duplicate).
    const r2 = await sc.recordRunShadow(client, { applicationId: app.id, run: { status: 'ELIGIBLE', term_sheet_eligible: true, ctc_eligible: true, funding_eligible: true, runId: 'run2' } });
    assert.strictEqual(r2.action, 'updated');
    rows = (await client.query(`SELECT candidate_decision FROM shadow_decisions WHERE application_id=$1`, [app.id])).rows;
    assert.strictEqual(rows.length, 1, 'still one shadow row (no flood)');
    assert.strictEqual(rows[0].candidate_decision.verdict, 'clear', 'refreshed to the newest run (ELIGIBLE → clear)');
    assert.strictEqual(rows[0].candidate_decision.runId, 'run2');
    ok('a second run refreshes the open candidate in place (no duplicate)');

    // 3. A non-terminal status stamps nothing.
    const nt = await sc.ingestStatusOutcome(client, { applicationId: app.id, status: 'in_review' });
    assert.strictEqual(nt.stamped, 0, 'in_review is not a terminal outcome');
    rows = (await client.query(`SELECT human_outcome FROM shadow_decisions WHERE application_id=$1`, [app.id])).rows;
    assert.strictEqual(rows[0].human_outcome, null, 'shadow stays open');
    ok('a non-terminal status leaves the shadow open');

    // 4. funded → stamps the outcome; the reliability report then scores it.
    const fin = await sc.ingestStatusOutcome(client, { applicationId: app.id, status: 'funded' });
    assert.strictEqual(fin.stamped, 1, 'funded stamps the open whole_loan shadow');
    rows = (await client.query(`SELECT human_outcome FROM shadow_decisions WHERE application_id=$1`, [app.id])).rows;
    assert.strictEqual(rows[0].human_outcome.outcome, 'clear', 'realized outcome recorded');
    // The AI said clear (ELIGIBLE), the humans funded (clear) → a correct call.
    const rep = await reliability.loadReliabilityReport(client, { sinceDays: 1 });
    assert.ok(rep.scored >= 1, 'the report now has at least one scored decision');
    ok('funded stamps the outcome and the reliability report scores it');

    // 5. Idempotent: a second funded call does not re-stamp (human_outcome already set).
    const again = await sc.ingestStatusOutcome(client, { applicationId: app.id, status: 'funded' });
    assert.strictEqual(again.stamped, 0, 'already-stamped shadow is not re-written');
    ok('re-stamping an already-outcome shadow is a no-op');

    await client.query('ROLLBACK');
    console.log(`\nshadow-capture db — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL', e && e.stack || e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
