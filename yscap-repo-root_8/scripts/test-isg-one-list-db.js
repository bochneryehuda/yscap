'use strict';
/*
 * The 4th note-buyer guideline surface, against a REAL database.
 *
 * WHY THIS EXISTS. The pure suite proves the merge algebra, but two things it can never
 * touch are exactly where this repo has been bitten before:
 *
 *   1. `loadRunGuidelineFindings` names seven columns across two tables inside a swallowing
 *      try/catch. Every one of them is UNVERIFIED until something executes the query — the
 *      same class as `b.full_name` (#248) and `is_current`/`created_at` on `appraisals`,
 *      both of which sat dark for weeks behind a catch that returned an empty result.
 *   2. #816's durable decision ledger is a real table. The pure test asserts the KEY logic;
 *      this asserts that a decision written through `record()` actually comes back out of
 *      `suppressedKeys()` under BOTH key forms — which is what stops a dismissal the owner
 *      already made from silently coming undone the moment a producer declares a fact.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-isg-one-list-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const uw = require('../src/routes/underwriting');
const fdec = require('../src/lib/underwriting/finding-decisions');
const { claimOf } = require('../src/lib/underwriting/finding-claims');
const investorReview = require('../src/lib/underwriting/investor-guideline-review');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed += 1; };

console.log('ISG one list (DB)');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'isgone+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Isg','One',$1,'1984-02-02') RETURNING id`, [email])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, property_address, lender)
         VALUES ($1, '{"state":"NY","city":"Brooklyn"}'::jsonb, 'Blue Lake') RETURNING id`,
      [b.id])).rows[0];

    // A `db`-shaped shim so the route helper runs on THIS transaction and rolls back with it.
    const db = { query: (t, p) => client.query(t, p) };

    // ── 1. the query executes at all ────────────────────────────────────────
    // A phantom column would throw, the catch would swallow it, and this would be [] —
    // indistinguishable from "no run yet". So the no-run case is asserted FIRST, then a
    // real run is inserted and the SAME call must return rows. Only the pair proves the
    // query ran: an always-throwing query passes step one and fails step two.
    assert.deepStrictEqual(await uw._loadRunGuidelineFindings(db, app.id), [],
      'a file with no run has no run findings');
    ok('no run on the file → no findings (and no throw)');

    const run = (await client.query(
      `INSERT INTO underwriting_runs (application_id, trigger, status)
         VALUES ($1,'manual_run','ELIGIBLE') RETURNING id`, [app.id])).rows[0];
    const addFinding = (runId, f) => client.query(
      `INSERT INTO underwriting_run_findings
         (run_id, code, severity, category, title, explanation, governing_rule, expected_value, actual_value, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [runId, f.code, f.severity, f.category, f.title, f.explanation || null,
       f.governing_rule || null, f.expected_value || null, f.actual_value || null, f.source || null]);

    await addFinding(run.id, {
      code: 'isg_rural_property', severity: 'fatal', category: investorReview.CATEGORY,
      title: 'Rural property', explanation: 'Every note buyer escalates a rural property.',
      governing_rule: 'all buyers', actual_value: 'Rural',
    });
    await addFinding(run.id, {
      code: 'isg_bl_ny_loan', severity: 'fatal', category: investorReview.CATEGORY,
      title: 'New York loan', explanation: 'Blue Lake escalates a New York loan.',
    });
    // A finding from a DIFFERENT desk in the same run must NOT be folded in — it already
    // has its own home, and folding it would double-report it.
    await addFinding(run.id, {
      code: 'structure_ltc_over_cap', severity: 'warning', category: 'structure', title: 'LTC over cap',
    });

    const rows = await uw._loadRunGuidelineFindings(db, app.id);
    assert.strictEqual(rows.length, 2,
      `every column the query names must exist — got ${rows.length} of 2 (an empty result here means the query threw and the catch ate it)`);
    ok('the run-findings query really executes — every column exists');

    assert.ok(rows.every((r) => r.category === investorReview.CATEGORY),
      'only note-buyer guideline findings are folded in');
    ok('a finding from another desk in the same run is left alone');

    // ── 2. the fold produces the shape the desk and the ledger both expect ──
    const rural = rows.find((r) => r.code === 'isg_rural_property');
    assert.strictEqual(rural.factKey, 'isg_signal:appraisal_rural',
      'the run must declare the FACT so it merges with the desk rows about the same signal');
    assert.strictEqual(rural.severity, 'fatal');
    assert.strictEqual(rural.blocksCtc, false, 'ADVISORY — a guideline finding never gates clear-to-close');
    assert.strictEqual(rural.id, undefined, 'no stored row ⇒ fileFatalCount cannot see it');
    ok('the rural finding carries its fact key, its severity, and the advisory guarantees');

    const ny = rows.find((r) => r.code === 'isg_bl_ny_loan');
    assert.strictEqual(ny.factKey, undefined,
      'a rule with no shared signal declares no fact — it must never merge with an unrelated one');
    ok('a rule with no shared signal is left unkeyed');

    // ── 3. `isgOnly` keeps these OUT of the clear-to-close summary ──────────
    // This predicate is what stops the advisory desk disagreeing with the real CTC gate.
    // It was keyed on the wrong field in the first cut and folded findings escaped into
    // summary.fatal — where the gate can't see them, so the two disagreed silently.
    assert.ok(rows.every((r) => uw._isgOnly(r)), 'every folded run finding is guideline-only');
    assert.ok(!uw._isgOnly({ code: 'bank_account_not_borrower', severity: 'fatal' }),
      'a real dealbreaker must NOT be classified as guideline-only');
    ok('isgOnly keeps guideline findings out of the summary and lets real findings through');

    // ── 4. a superseded run does not speak ──────────────────────────────────
    await client.query(`UPDATE underwriting_runs SET superseded_at = now() WHERE id = $1`, [run.id]);
    assert.deepStrictEqual(await uw._loadRunGuidelineFindings(db, app.id), [],
      'only the CURRENT run governs');
    ok('a superseded run contributes nothing');

    // ── 5. THE LEDGER, END TO END ──────────────────────────────────────────
    // The regression that made this whole change dangerous: a decision recorded before a
    // producer declared a fact keyed the old way, and stopped matching the moment it did.
    const before = { code: 'isg_appraisal_review_3345', field: 'rural' };
    const today = Object.assign({}, before, { factKey: 'isg_signal:appraisal_rural' });
    const oldKey = claimOf(before);
    assert.notStrictEqual(claimOf(today), oldKey, 'fixture must really exercise both key forms');

    await fdec.record(client, {
      applicationId: app.id, finding: before, origin: 'ai_suggestion',
      decision: 'dismissed', note: 'not a concern on this file',
    });
    let keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(keys.has(oldKey), 'the decision is on file under the key it was written with');
    assert.ok(fdec.isSuppressed(keys, today),
      'and it must STILL settle the same finding now that the producer declares a fact');
    ok('a decision recorded before the fact key existed still suppresses (no backfill needed)');

    // …and a decision taken on the MERGED card settles every producer of that fact.
    await fdec.record(client, {
      applicationId: app.id, finding: today, origin: 'ai_suggestion', decision: 'dismissed',
    });
    keys = await fdec.suppressedKeys(client, app.id);
    for (const code of ['isg_appraisal_review_123', 'isg_appraisal_review_3345', 'isg_rural_property']) {
      assert.ok(fdec.isSuppressed(keys, { code, factKey: 'isg_signal:appraisal_rural' }),
        `${code} asserts the settled fact — one dismiss must settle it too`);
    }
    assert.ok(!fdec.isSuppressed(keys, { code: 'isg_bl_ny_loan' }),
      'an unrelated finding must NOT be swept up');
    ok('one dismiss on the merged card settles every producer of that fact — and nothing else');

    // …and re-opening it un-suppresses BOTH forms, so a dismissal is never a one-way door.
    await fdec.reopen(client, { applicationId: app.id, finding: today, by: null });
    keys = await fdec.suppressedKeys(client, app.id);
    assert.ok(!fdec.isSuppressed(keys, today), 'a re-opened finding comes back');
    assert.ok(!fdec.isSuppressed(keys, before), 'including under its older key form');
    ok('re-open clears every key the decision was written under');

    await client.query('ROLLBACK');
    console.log(`\n${passed} checks passed.`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
