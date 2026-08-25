'use strict';
/**
 * LONG-TERM — /why-no-status answers with the REAL rule, and can see the queue
 * (owner-reported 2026-08-25, YSCAP258134720).
 *
 * WHY THIS SUITE EXISTS. The route was built to answer "why did this card not
 * move", and on its first live run it answered WRONG — confidently. It handed
 * `decideStatusPush` the bare string `desired.status` where the rule reads
 * `.status` off an OBJECT, so the rule saw nothing, replied "the status engine
 * claimed no status", and the route printed that verdict directly beside a
 * `desired` of "ctc (4-email)". A diagnostic that accuses a guard which never ran
 * is worse than no diagnostic: it sends the next person hunting the wrong thing,
 * which is the exact cost this route was written to remove.
 *
 * That defect is INVISIBLE to every check that does not execute the handler.
 * `node --check` is happy. The read-only source guard is happy. Only running it
 * against a real schema, with a real ladder and a real event, shows the rule
 * being asked the question properly — so section B asserts on the ANSWER, never
 * on the shape of the call.
 *
 * AND THE SQL HAS TO RUN SOMEWHERE. The queue measurement is assembled with
 * interpolation (the shared not-trash fragment), so `test-lt-sql-prepared-db.js`
 * cannot prepare it from source and requires that something in this same CI job
 * EXECUTE it. Nothing did — that guard failed this route's first push, correctly.
 * Section C is what executes it.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */

const express = require('express');
const db = require('../src/longterm/db');

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; console.log(`  ok   ${what}`); return; }
  fails.push(what);
  console.error(`  ✗ ${what}`);
}
const eq = (got, want, what) => ok(got === want, `${what} (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);

const LOAN = 'YSWHY-1888';
const QUIET = 'YSWHY-quiet';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('test-lt-why-no-status-db: no DATABASE_URL — skipped');
    return;
  }

  const wipe = async () => {
    await db.query(`DELETE FROM lt_milestone_events WHERE loan_id IN (SELECT id FROM lt_loans WHERE loan_number LIKE 'YSWHY%')`);
    await db.query(`DELETE FROM lt_loan_milestones WHERE loan_id IN (SELECT id FROM lt_loans WHERE loan_number LIKE 'YSWHY%')`);
    await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE 'YSWHY%'`);
  };
  await wipe();

  // ── A. the reported loan, rebuilt: every link green, card still not moved ─
  console.log('\nA. the reported shape, seeded');
  const { rows: [main1] } = await db.query(
    `INSERT INTO lt_loans (id, loan_number, milestone_name, stage_key, loan_folder,
                           clickup_task_id, clickup_custom_id, clickup_link_confidence,
                           clickup_pushed_at, clickup_status_event_at,
                           encompass_synced_at, encompass_last_modified, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'Clear To Close', 'clear_to_close', 'Corr Clear To Close',
                  'task_why_1888', 'FILLE-1888', 'confirmed',
                  '2026-08-25T13:08:57Z'::timestamptz, '2026-08-25T13:02:27Z'::timestamptz,
                  '2026-08-25T16:19:00Z'::timestamptz, now(), now(), now())
       RETURNING id`, [LOAN]);
  const id = main1.id;

  // the mirrored ladder the rule actually reads — not the loan's milestone name
  const steps = [['Started', 0], ['Loan Setup', 1], ['Submittal', 2], ['Clear To Close', 3], ['Funding', 4]];
  for (const [name, pos] of steps) {
    await db.query(
      `INSERT INTO lt_loan_milestones (loan_id, milestone_name, position, done, encompass_synced_at, created_at, updated_at)
            VALUES ($1::uuid, $2, $3, $4, now(), now(), now())`,
      [id, name, pos, pos <= 3]);
  }
  await db.query(
    `INSERT INTO lt_milestone_events (id, loan_id, event_type, from_milestone, to_milestone, observed_at)
          VALUES (gen_random_uuid(), $1::uuid, 'observed_entered', 'Submittal', 'Clear To Close',
                  '2026-08-25T16:19:00Z'::timestamptz)`, [id]);
  ok(true, 'a linked, confirmed loan with a ladder and a move newer than its watermark');

  process.env.LT_BOOK_DIAG_TOKEN = 'a-token-only-this-suite-knows';
  const app = express();
  app.use('/api/lt/_diag/book', require('../src/longterm/routes/book-diag'));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const ask = async (qs) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/lt/_diag/book/why-no-status${qs}`,
      { headers: { 'x-lt-diag-token': process.env.LT_BOOK_DIAG_TOKEN } });
    return { status: r.status, body: await r.json() };
  };

  // ── B. THE REGRESSION: the rule is asked the question properly ────────────
  console.log('\nB. the rule is handed the whole desired object, not the bare string');
  const a = await ask(`?loan=${LOAN}`);
  eq(a.status, 200, 'the route answers');
  eq(a.body.decision && a.body.decision.desired, 'ctc (4-email)',
    'the engine reads the LADDER and wants the Clear To Close status');
  ok(a.body.decision && !/claimed no status/.test(String(a.body.decision.reason || '')),
    'and the rule did NOT answer "the status engine claimed no status" — the shape bug is what that sentence meant');
  ok(a.body.decision && a.body.decision.act !== 'none',
    'so the decision is a real one rather than the silent no-op a string produced');
  ok(!/claimed no status/.test(String(a.body.verdict || '')),
    'and the verdict does not blame a guard that never ran');

  // ── C. the queue measurement — and the statement that must run somewhere ──
  console.log('\nC. the push queue is measured with pushPass\'s own WHERE and ORDER BY');
  ok(a.body.queue && !a.body.queue.error, `the queue was read without error (${a.body.queue && a.body.queue.error})`);
  eq(a.body.queue && a.body.queue.position, 1, 'this loan is in the queue, and its move puts it first');
  ok(a.body.queue && a.body.queue.depth >= 1, 'the depth counts every loan due for a push');
  ok(a.body.queue && a.body.queue.capPerPass >= 1, 'and it reports how many the pass takes a tick');

  // a second due loan deepens the queue and sits BEHIND the one with a move
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, loan_folder, clickup_task_id, clickup_link_confidence,
                           clickup_pushed_at, encompass_synced_at, encompass_last_modified, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'Corr Clear To Close', 'task_why_quiet', 'confirmed',
                  '2026-08-25T01:00:00Z'::timestamptz, now(), now(), now(), now())`, [QUIET]);
  const b = await ask(`?loan=${LOAN}`);
  eq(b.body.queue && b.body.queue.depth, 2, 'a second due loan deepens the queue');
  eq(b.body.queue && b.body.queue.position, 1,
    'and the loan waiting on a witnessed move still comes first, though the other was pushed far longer ago');

  // ── D. link 1 — a loan with no witnessed move is named as such ────────────
  console.log('\nD. a loan PILOT never saw move is named at link 1, not blamed on the rule');
  const c = await ask(`?loan=${QUIET}`);
  eq(c.status, 200, 'it answers for that loan too');
  ok(/LINK 1/.test(String(c.body.verdict || '')), 'the verdict names link 1');
  ok(/never WITNESSED/i.test(String(c.body.verdict || '')), 'and says PILOT never witnessed a move');

  // ── E. the door, and a loan that is not in the book ───────────────────────
  console.log('\nE. the door and the empty cases');
  const noTok = await fetch(`http://127.0.0.1:${port}/api/lt/_diag/book/why-no-status?loan=${LOAN}`);
  eq(noTok.status, 401, 'no header, no answer — the same gate covers this path');
  const missing = await ask('?loan=YSWHY-does-not-exist');
  eq(missing.status, 404, 'a loan number the book does not carry is a 404');
  const none = await ask('');
  eq(none.status, 400, 'and no loan number at all is refused in words');

  server.close();
  await wipe();

  if (fails.length) {
    console.error(`\n${fails.length} failed:`);
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(`\nall good — ${pass} checks`);
}

main().then(() => db.pool && db.pool.end && db.pool.end()).catch((e) => {
  console.error(e);
  process.exit(1);
});
