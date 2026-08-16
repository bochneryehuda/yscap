'use strict';
/**
 * LT test — the milestone clock against a real database.
 *
 * A pure test cannot prove a column exists, and `writeMilestone` writes nine of them
 * across two objects inside a catch that turns any mistake into a quiet `{ok:false}`.
 * That is the phantom-column class this side keeps meeting — most recently the very
 * field this feature replaces: `milestoneStepper` read `m.completed_at` off the rows
 * it was handed, and those rows come from `lt_encompass_milestones`, the tenant's
 * GLOBAL catalog, which has no per-loan row and no such column. It reported null on
 * every step of every loan, forever, and nothing ever failed.
 *
 * So the writes run for real here, and what lands is read back.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-milestones-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const ms = require('../src/longterm/milestones');
const workspace = require('../src/longterm/workspace');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = [];
async function makeLoan(milestone, stage) {
  const stamp = `LTMS${Date.now()}${made.length}`;
  const { rows } = await ltDb.query(
    `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key)
          VALUES (gen_random_uuid(), $1, $1, $2, $3) RETURNING *`,
    [stamp, milestone, stage],
  );
  made.push(rows[0].id);
  return rows[0];
}
const loanRow = async (id) => (await ltDb.query('SELECT * FROM lt_loans WHERE id = $1::uuid', [id])).rows[0];
const eventsOf = async (id) => (await ltDb.query(
  'SELECT * FROM lt_milestone_events WHERE loan_id = $1::uuid ORDER BY observed_at', [id])).rows;

(async () => {
  try {
    // ── A. The migration is really there ────────────────────────────────────
    console.log('the table and the columns exist');

    const { rows: cols } = await ltDb.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'lt_milestone_events' ORDER BY column_name`);
    const names = cols.map((c) => c.column_name);
    for (const c of ['id', 'loan_id', 'event_type', 'from_milestone', 'to_milestone',
      'from_stage', 'to_stage', 'observed_at', 'encompass_synced_at']) {
      check(names.includes(c), `lt_milestone_events.${c} exists`);
    }
    const { rows: lcols } = await ltDb.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'lt_loans' AND column_name IN ('milestone_since','milestone_since_is_baseline')`);
    check(lcols.length === 2, 'lt_loans carries both clock columns');

    // ── B. The first sighting baselines ─────────────────────────────────────
    console.log('\nthe first sighting is a baseline, not an arrival');

    const loan = await makeLoan('Loan Setup', 'setup');
    const t0 = new Date('2026-08-01T10:00:00Z');
    const w0 = await ms.writeMilestone(loan.id, await ms.loadPrior(loan.id),
      { milestoneName: 'Loan Setup', stageKey: 'setup' }, { now: t0 });
    check(w0.ok && w0.action === 'baseline', 'the first write is a baseline');

    let row = await loanRow(loan.id);
    check(row.milestone_since_is_baseline === true,
      'THE ONE THAT MATTERS: the loan is flagged as merely BASELINED — the stamp is when we started watching, not when it arrived');
    check(new Date(row.milestone_since).getTime() === t0.getTime(), 'and the stamp is the observation time');

    const clock0 = ms.describeClock(row, { expectedDays: 3, now: new Date('2026-08-16T10:00:00Z') });
    check(clock0.days === null && clock0.stalled === null,
      'so the clock refuses to age it — 15 real days later it still reports no age, because we never saw it arrive');

    // ── C. A watched move is a real date ────────────────────────────────────
    console.log('\na move we watched IS a real date');

    const t1 = new Date('2026-08-10T09:00:00Z');
    await ltDb.query('UPDATE lt_loans SET milestone_name=$2, stage_key=$3 WHERE id=$1::uuid',
      [loan.id, 'Processing', 'underwriting']);
    const prior1 = await ms.loadPrior(loan.id);
    check(prior1.hasRecord === true && prior1.milestoneName === 'Processing',
      'the prior read finds the record we baselined');

    // Simulate the sync order properly: prior is captured BEFORE the row is updated.
    const loan2 = await makeLoan('Loan Setup', 'setup');
    await ms.writeMilestone(loan2.id, await ms.loadPrior(loan2.id),
      { milestoneName: 'Loan Setup', stageKey: 'setup' }, { now: t0 });
    const priorBefore = await ms.loadPrior(loan2.id);
    await ltDb.query('UPDATE lt_loans SET milestone_name=$2, stage_key=$3 WHERE id=$1::uuid',
      [loan2.id, 'Processing', 'underwriting']);
    const w1 = await ms.writeMilestone(loan2.id, priorBefore,
      { milestoneName: 'Processing', stageKey: 'underwriting' }, { now: t1 });
    check(w1.ok && w1.action === 'entered', 'watching it move records an arrival');

    row = await loanRow(loan2.id);
    check(row.milestone_since_is_baseline === false,
      'THE ONE THAT MATTERS: the baseline flag is CLEARED — from here the stamp means what it says');
    const clock1 = ms.describeClock(row, { expectedDays: 3, now: new Date('2026-08-16T09:00:00Z') });
    check(clock1.days === 6 && clock1.stalled === true,
      'and now it ages honestly — 6 days at a milestone the tenant expects to take 3 reads as stalled');

    const evs = await eventsOf(loan2.id);
    check(evs.length === 2 && evs[0].event_type === 'observed_baseline'
      && evs[1].event_type === 'observed_entered',
    'the history is APPEND-ONLY: the baseline is still there beside the arrival');
    check(evs[1].from_milestone === 'Loan Setup' && evs[1].to_milestone === 'Processing'
      && evs[1].from_stage === 'setup' && evs[1].to_stage === 'underwriting',
    'and the arrival records both ends in both layers');

    // ── D. Nothing changed appends nothing ──────────────────────────────────
    console.log('\na re-read that changed nothing appends nothing');

    const w2 = await ms.writeMilestone(loan2.id, await ms.loadPrior(loan2.id),
      { milestoneName: 'Processing', stageKey: 'underwriting' }, { now: new Date('2026-08-12T09:00:00Z') });
    check(w2.action === 'none' && (await eventsOf(loan2.id)).length === 2,
      'still two events, and the clock was not restarted by looking at it again');
    const rowAfter = await loanRow(loan2.id);
    check(new Date(rowAfter.milestone_since).getTime() === t1.getTime(),
      'THE ONE THAT MATTERS: the stamp did not move — a re-read must never reset the age of a stalled file');

    // ── E. The stepper gets real dates ──────────────────────────────────────
    console.log('\nthe stepper draws the dates we watched, and only those');

    const reached = await ms.reachedAtByMilestone(loan2.id);
    check(!!reached.processing && !reached['loan setup'],
      'THE ONE THAT MATTERS: the WATCHED arrival has a date and the BASELINED milestone has none — a baseline is not an arrival and never becomes one');

    const catalog = [{ name: 'Loan Setup', sort_order: 1 }, { name: 'Processing', sort_order: 2 },
      { name: 'Clear To Close', sort_order: 3 }];
    const step = workspace.milestoneStepper(rowAfter, catalog, { reachedAt: reached });
    const byName = (n) => step.steps.find((s) => s.name === n);
    check(byName('Processing').reachedAt && !byName('Loan Setup').reachedAt,
      'so the stepper shows a date on the step we witnessed and nothing on the one we did not');
    check(byName('Clear To Close').reached === false && byName('Clear To Close').reachedAt === null,
      'a step not yet reached carries no date at all');
    check(!('completedAt' in byName('Processing')),
      'and the dead `completedAt` field is gone — it read a column that exists on no row the stepper is ever handed');

    // A rollback and return: the LATEST observation wins, because it reached it again.
    await ltDb.query('UPDATE lt_loans SET milestone_name=$2 WHERE id=$1::uuid', [loan2.id, 'Loan Setup']);
    const p3 = await ms.loadPrior(loan2.id);
    await ltDb.query('UPDATE lt_loans SET milestone_name=$2 WHERE id=$1::uuid', [loan2.id, 'Processing']);
    await ms.writeMilestone(loan2.id, p3, { milestoneName: 'Processing', stageKey: 'underwriting' },
      { now: new Date('2026-08-14T09:00:00Z') });
    const reached2 = await ms.reachedAtByMilestone(loan2.id);
    check(new Date(reached2.processing).toISOString().startsWith('2026-08-14'),
      'a file that rolled back and returned is dated from when it reached it AGAIN, not the first time');

    // ── F. It can never break the sync that carries it ──────────────────────
    console.log('\nit can never break the loan mirror');

    const bad = await ms.writeMilestone('not-a-uuid', { hasRecord: false }, { milestoneName: 'X' });
    check(bad.ok === false && typeof bad.reason === 'string',
      'a write it cannot do reports the reason instead of throwing');
    const priorBad = await ms.loadPrior('not-a-uuid');
    check(priorBad.hasRecord === false, 'and an unreadable prior reads as "no record", which baselines rather than inventing a move');
    check((await ms.loadHistory('not-a-uuid')).length === 0, 'an unreadable history is empty, not an exception');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    for (const id of made) {
      await ltDb.query('DELETE FROM lt_milestone_events WHERE loan_id = $1::uuid', [id]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
