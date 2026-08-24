'use strict';
/**
 * LONG-TERM — the status watermark and the status review row, against a REAL
 * Postgres (db/626, owner-directed 2026-08-24).
 *
 * WHY THIS SUITE EXISTS AND THE PURE ONE IS NOT ENOUGH. Three of the things
 * this change depends on cannot be proven without a database, and each has bitten
 * this repo before:
 *
 *  · `raiseStatusReview` INSERTs with `ON CONFLICT (…) WHERE status = 'open'`.
 *    A PARTIAL unique index cannot be inferred without repeating its predicate,
 *    and CLAUDE.md records that exact mistake shipping THREE times — invisible
 *    every time, because the write sat behind a swallowing catch. This one has a
 *    swallowing catch too (by design: a review row may never fail a push), so a
 *    broken statement here would log once and silently stop surfacing every
 *    status disagreement in the system. The test asserts the ROW, never the call.
 *  · The migration's BASELINE backfill is the whole point of db/626 — get it
 *    wrong and the first pass after the fix reproduces the sweep it removes.
 *  · `readStatusWatermark` must exclude 'observed_baseline'. A phantom column or
 *    a wrong event_type would read as "no event" — a confident, permanent no-op.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */

const db = require('../src/longterm/db');
const push = require('../src/longterm/clickup/push');
const { readStatusWatermark, stampStatusWatermark, raiseStatusReview } = push._internals;

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; return; }
  fails.push(what);
  console.error(`  ✗ ${what}`);
}
const eq = (got, want, what) => ok(got === want, `${what} (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);

const T_OLD = '2026-08-20T10:00:00Z';
const T_NEW = '2026-08-24T10:00:00Z';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('test-lt-status-push-db: no DATABASE_URL — skipped');
    return;
  }

  // ── 0. The migration actually landed ──────────────────────────────────────
  console.log('0. db/626 shape');
  {
    const { rows } = await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'lt_loans' AND column_name = 'clickup_status_event_at'`);
    eq(rows.length, 1, 'lt_loans.clickup_status_event_at exists');
    eq(rows[0] && rows[0].data_type, 'timestamp with time zone', 'and it is a timestamptz');

    const { rows: idx } = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'lt_milestone_events_loan_entered_idx'`);
    eq(idx.length, 1, "the drain's index exists");
    ok(idx.length && /observed_entered/.test(idx[0].indexdef), 'and it is the partial one on observed_entered');
  }

  const loanId = '00000000-0000-4000-8000-00000626a001';
  const linkedId = '00000000-0000-4000-8000-00000626a002';
  const taskId = 'tsk626a';
  await cleanup([loanId, linkedId], [taskId]);

  // ── 1. The baseline backfill ──────────────────────────────────────────────
  // A LINKED loan must be baselined by the migration; an UNLINKED one must not
  // be — it has no card, so there is nothing to protect and nothing to stamp.
  console.log('1. the baseline backfill');
  {
    await db.query(
      `INSERT INTO lt_loans (id, loan_number, clickup_task_id, created_at, updated_at)
       VALUES ($1::uuid, 'YSCAP626A', $3, now(), now()), ($2::uuid, 'YSCAP626B', NULL, now(), now())`,
      [linkedId, loanId, taskId]);

    // Run the migration's OWN backfill statement, READ OUT OF db/626 rather
    // than retyped here — a hand-copied duplicate is free to drift from the
    // migration, and then this section would prove a statement that no longer
    // ships. The rows above were inserted after the real run, so it has real
    // work to do.
    const backfill = backfillStatementFromMigration();
    ok(/clickup_status_event_at\s*=\s*now\(\)/.test(backfill), 'the backfill was found in db/626');
    ok(/clickup_task_id IS NOT NULL/.test(backfill), 'and it is scoped to LINKED loans');
    await db.query(backfill);

    const { rows } = await db.query(
      `SELECT id, clickup_status_event_at FROM lt_loans WHERE id = ANY($1::uuid[]) ORDER BY loan_number`,
      [[linkedId, loanId]]);
    ok(rows[0].clickup_status_event_at != null, 'a LINKED loan is baselined');
    eq(rows[1].clickup_status_event_at, null, 'an UNLINKED loan is left alone');

    // Idempotent: a second run matches nothing and moves nothing.
    const was = rows[0].clickup_status_event_at.toISOString();
    const { rowCount } = await db.query(
      `UPDATE lt_loans SET clickup_status_event_at = now()
        WHERE clickup_status_event_at IS NULL AND clickup_task_id IS NOT NULL AND id = ANY($1::uuid[])`,
      [[linkedId, loanId]]);
    eq(rowCount, 0, 'a second run of the backfill touches no already-baselined row');
    const { rows: again } = await db.query('SELECT clickup_status_event_at FROM lt_loans WHERE id = $1::uuid', [linkedId]);
    eq(again[0].clickup_status_event_at.toISOString(), was, 'and the watermark did not move');
  }

  // ── 2. readStatusWatermark ────────────────────────────────────────────────
  console.log('2. reading the watermark and the newest fired milestone');
  {
    await db.query('UPDATE lt_loans SET clickup_status_event_at = $2::timestamptz WHERE id = $1::uuid', [linkedId, T_OLD]);

    let r = await readStatusWatermark(linkedId);
    eq(r.watermark.toISOString(), new Date(T_OLD).toISOString(), 'the watermark reads back');
    eq(r.latestEntered, null, 'a loan with no events has no fired milestone');

    // A BASELINE event is a first sighting, not a move — it must be invisible here.
    await addEvent(linkedId, 'observed_baseline', T_NEW);
    r = await readStatusWatermark(linkedId);
    eq(r.latestEntered, null, 'an observed_baseline event is NOT a fired milestone');

    await addEvent(linkedId, 'observed_entered', T_NEW);
    r = await readStatusWatermark(linkedId);
    eq(r.latestEntered.toISOString(), new Date(T_NEW).toISOString(), 'an observed_entered event IS');

    // The NEWEST entered event wins, not the last inserted.
    await addEvent(linkedId, 'observed_entered', T_OLD);
    r = await readStatusWatermark(linkedId);
    eq(r.latestEntered.toISOString(), new Date(T_NEW).toISOString(), 'the newest entered event wins');

    // Another loan's events never leak in.
    await addEvent(loanId, 'observed_entered', '2027-01-01T00:00:00Z');
    r = await readStatusWatermark(linkedId);
    eq(r.latestEntered.toISOString(), new Date(T_NEW).toISOString(), "another loan's events are not counted");
  }

  // ── 3. stampStatusWatermark ───────────────────────────────────────────────
  console.log('3. answering the event');
  {
    await stampStatusWatermark(linkedId, T_NEW);
    let { rows } = await db.query('SELECT clickup_status_event_at w FROM lt_loans WHERE id = $1::uuid', [linkedId]);
    eq(rows[0].w.toISOString(), new Date(T_NEW).toISOString(), 'the watermark advances to the event');

    // GREATEST: a late-arriving older stamp must never REOPEN answered events.
    await stampStatusWatermark(linkedId, T_OLD);
    ({ rows } = await db.query('SELECT clickup_status_event_at w FROM lt_loans WHERE id = $1::uuid', [linkedId]));
    eq(rows[0].w.toISOString(), new Date(T_NEW).toISOString(), 'and never moves backwards');

    await stampStatusWatermark(linkedId, null);
    ({ rows } = await db.query('SELECT clickup_status_event_at w FROM lt_loans WHERE id = $1::uuid', [linkedId]));
    eq(rows[0].w.toISOString(), new Date(T_NEW).toISOString(), 'a null stamp is a no-op, never a wipe');
  }

  // ── 4. THE ON CONFLICT TRAP ───────────────────────────────────────────────
  // Asserted on the ROW, never on the call: raiseStatusReview swallows its own
  // errors by design, so a broken statement would look exactly like a success.
  console.log('4. the status review row (partial-index ON CONFLICT)');
  {
    await raiseStatusReview({ loanId: linkedId, taskId, current: 'ctc (4-email)', proposed: 'workflow', reason: 'first' });
    let { rows } = await db.query(
      `SELECT * FROM lt_clickup_review_queue WHERE task_id = $1 AND field_key = '__status' AND status = 'open'`, [taskId]);
    eq(rows.length, 1, 'a disagreement raises exactly one open row');
    eq(rows[0].current_value, 'ctc (4-email)', 'carrying what ClickUp holds');
    eq(rows[0].proposed_value, 'workflow', "and what Encompass's milestones imply");
    eq(rows[0].direction, 'outbound', 'as an outbound row');
    eq(String(rows[0].lt_loan_id), linkedId, 'tied to the loan');

    // The SAME disagreement again must REFRESH, never stack a second question.
    await raiseStatusReview({ loanId: linkedId, taskId, current: 'active closing', proposed: 'workflow', reason: 'second' });
    ({ rows } = await db.query(
      `SELECT * FROM lt_clickup_review_queue WHERE task_id = $1 AND field_key = '__status' AND status = 'open'`, [taskId]));
    eq(rows.length, 1, 'raising it again does not stack a duplicate');
    eq(rows[0].reason, 'second', 'the reason refreshes');
    eq(rows[0].current_value, 'active closing', 'and so does what the card now holds');

    // A DIFFERENT proposal is a different question and gets its own row.
    await raiseStatusReview({ loanId: linkedId, taskId, current: 'active closing', proposed: 'scheduling closing', reason: 'third' });
    ({ rows } = await db.query(
      `SELECT * FROM lt_clickup_review_queue WHERE task_id = $1 AND field_key = '__status' AND status = 'open'`, [taskId]));
    eq(rows.length, 2, 'a different proposal is its own question');

    // Resolving one frees the slot — the index is partial ON status='open'.
    await db.query(`UPDATE lt_clickup_review_queue SET status = 'resolved' WHERE task_id = $1`, [taskId]);
    await raiseStatusReview({ loanId: linkedId, taskId, current: 'active closing', proposed: 'workflow', reason: 'fourth' });
    ({ rows } = await db.query(
      `SELECT * FROM lt_clickup_review_queue WHERE task_id = $1 AND field_key = '__status' AND status = 'open'`, [taskId]));
    eq(rows.length, 1, 'once resolved, the same question may be asked afresh');
    eq(rows[0].reason, 'fourth', 'as a new row');

    // A reason longer than the slice must not throw the statement.
    await raiseStatusReview({ loanId: linkedId, taskId, current: 'x', proposed: 'y'.repeat(10), reason: 'z'.repeat(5000) });
    ({ rows } = await db.query(
      `SELECT reason FROM lt_clickup_review_queue WHERE task_id = $1 AND proposed_value = $2 AND status = 'open'`,
      [taskId, 'y'.repeat(10)]));
    eq(rows.length, 1, 'a very long reason still records');
    ok(rows[0].reason.length <= 500, 'trimmed to the column\'s working length');
  }

  await cleanup([loanId, linkedId], [taskId]);
  console.log(`\ntest-lt-status-push-db: ${pass} passed, ${fails.length} failed`);
  if (fails.length) process.exitCode = 1;
}

/** The one UPDATE in db/626, lifted from the file itself so this suite can
 *  never prove a backfill that has since been edited. */
function backfillStatementFromMigration() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'db', '626_lt_status_push_is_event_driven_not_reconciled.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const m = sql.match(/^\s*UPDATE\s+lt_loans[\s\S]*?;/m);
  if (!m) throw new Error('db/626 no longer carries an UPDATE lt_loans backfill — this suite is out of date');
  return m[0];
}

async function addEvent(loanId, type, at) {
  await db.query(
    `INSERT INTO lt_milestone_events (id, loan_id, event_type, to_milestone, observed_at, created_at)
     VALUES (gen_random_uuid(), $1::uuid, $2, 'Funding', $3::timestamptz, now())`, [loanId, type, at]);
}

async function cleanup(loanIds, taskIds) {
  await db.query('DELETE FROM lt_clickup_review_queue WHERE task_id = ANY($1::text[])', [taskIds]);
  await db.query('DELETE FROM lt_milestone_events WHERE loan_id = ANY($1::uuid[])', [loanIds]);
  await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [loanIds]);
}

main().then(() => db.pool && db.pool.end && db.pool.end()).catch((e) => {
  console.error(e);
  process.exit(1);
});
