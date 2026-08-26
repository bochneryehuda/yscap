'use strict';
/**
 * LT test — the pipeline query and the sync's upsert against a REAL database.
 *
 * The pure suites prove the COMPOSITION: that the placeholders line up, that the
 * scope comes from access.js, that filters are appended rather than OR-ed. None of
 * that proves the SQL runs. Three classes of bug survive a pure suite entirely and
 * have all shipped in this repo before:
 *
 *   · a column or a table that does not exist (`lt_borrowers` was in the first cut
 *     of this very query — the phantom-table trap),
 *   · a bind that Postgres refuses (42P18: an unreferenced parameter, which is
 *     exactly what a sees-all viewer produces if the scope leaves one behind),
 *   · a COALESCE that reads the wrong way round and blanks a value we already hold.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Everything runs in ONE transaction that is ROLLED BACK, so it leaves no rows.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-pipeline-query-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/longterm/db');
const pipeline = require('../src/longterm/pipeline');
const access = require('../src/longterm/access');
const loans = require('../src/longterm/sync/loans');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

(async () => {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');
    const stamp = `ltpq${Date.now()}`;

    const { rows: su } = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Off Icer', 'loan_officer', true) RETURNING id`,
      [`${stamp}@example.test`],
    );
    const officer = String(su[0].id);

    const { rows: mine } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, stage_key, milestone_name)
            VALUES (gen_random_uuid(), $1, $2, 'underwriting', 'Processing') RETURNING id`,
      [`${stamp}-A`, `guid-${stamp}-A`],
    );
    await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, stage_key)
            VALUES (gen_random_uuid(), $1, $2, 'closing')`,
      [`${stamp}-B`, `guid-${stamp}-B`],
    );
    await c.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, staff_id)
            VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', $2::uuid)`,
      [mine[0].id, officer],
    );

    // ── The scope, actually executed ────────────────────────────────────────
    console.log('the pipeline query runs');

    const q = pipeline.buildPipelineQuery(access.accessFor({ id: officer, role: 'loan_officer' }), officer, {});
    const { rows } = await c.query(q.sql, q.params);
    check(rows.length === 1 && rows[0].loan_number === `${stamp}-A`,
      'an officer sees ONLY the file they are on');
    const { rows: counted } = await c.query(q.countSql, q.params);
    check(counted[0].n === 1, 'the count agrees with the page it describes');
    check(Array.isArray(rows[0].contacts) && rows[0].contacts[0].role === 'loan_officer',
      'the contacts sub-select returns real JSON, not a string');

    // THE 42P18 CASE: a sees-all viewer's query carries NO parameters at all, and
    // Postgres is the only thing that can prove it still binds.
    const qa = pipeline.buildPipelineQuery(access.accessFor({ id: officer, role: 'admin' }), officer, {});
    const { rows: all } = await c.query(qa.sql, qa.params);
    check(all.length >= 2, 'an admin sees both files — and a query with no parameters BINDS');

    const qf = pipeline.buildPipelineQuery(access.accessFor({ id: officer, role: 'admin' }), officer,
      { stage: 'closing', search: stamp });
    const { rows: filtered } = await c.query(qf.sql, qf.params);
    check(filtered.length === 1 && filtered[0].loan_number === `${stamp}-B`,
      'the stage and search filters bind and narrow together');

    const qu = pipeline.buildPipelineQuery(access.accessFor({ id: officer, role: 'closer' }), officer,
      { unassigned: true, search: stamp });
    const { rows: unassigned } = await c.query(qu.sql, qu.params);
    check(unassigned.length === 1 && unassigned[0].loan_number === `${stamp}-B`,
      'a closer can find the files nobody is on yet — the owner\'s reason for giving them the whole book');

    // ── The sync's upsert ───────────────────────────────────────────────────
    console.log('\nthe discovery upsert');

    const row = await loans.upsertDiscovered(c, {
      encompassLoanGuid: `guid-${stamp}-A`,
      loanNumber: null,          // the Reporting Database omits what it has no value for
      loanAmount: 500000,
      loanFolder: 'Pipeline',
      milestoneName: 'Funding',
      lastModified: '2026-08-14T10:00:00Z',
    }, {});
    check(!!row && !!row.id, 'the upsert returns the loan it wrote');

    const { rows: after } = await c.query(
      'SELECT * FROM lt_loans WHERE encompass_loan_guid = $1', [`guid-${stamp}-A`],
    );
    check(after[0].loan_number === `${stamp}-A`,
      'THE COALESCE DIRECTION: a pipeline row missing the loan number does NOT blank the one we already hold');
    // FILL-ONLY since db/623: the pipeline's milestone column is the LAGGING
    // active-form reading, so discovery never moves a milestone we already hold —
    // the full read's ladder is what moves it (test-lt-milestone-ladder.js F/G).
    check(after[0].milestone_name === 'Processing' && after[0].stage_key === 'underwriting',
      'discovery is FILL-ONLY on the milestone — the lagging pipeline reading never overwrites the held one (db/623)');
    check(Number(after[0].loan_amount) === 500000,
      'a blank amount is filled from the pipeline…');
    check(loans.needsRead(row) === true,
      '…and the loan is queued for a full read, because we have never read it');
    // …and the FILL half: a loan holding NO milestone takes discovery's.
    const rowB = await loans.upsertDiscovered(c, {
      encompassLoanGuid: `guid-${stamp}-B`,
      loanNumber: `${stamp}-B`,
      loanAmount: null,
      loanFolder: 'Pipeline',
      milestoneName: 'Funding',
      lastModified: '2026-08-14T10:00:00Z',
    }, {});
    check(!!rowB, 'the second upsert runs');
    const { rows: afterB } = await c.query(
      'SELECT milestone_name FROM lt_loans WHERE encompass_loan_guid = $1', [`guid-${stamp}-B`]);
    check(afterB[0].milestone_name === 'Funding',
      '…while a loan with NO milestone is still FILLED by discovery');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    c.release();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
