'use strict';
/**
 * LT test — the lock mirror against a real database.
 *
 * A pure test cannot prove a column exists, and this module writes eleven of them
 * across two tables inside a catch that turns any mistake into a quiet `{ok:false}`.
 * That is the exact shape of the phantom-column class this side has already been
 * bitten by twice (`staff_users.first_name`, `lt_borrowers`): a wrong name reports a
 * confident "nothing to mirror" forever rather than an error. So the writes run for
 * real here, and what lands is read back.
 *
 * It also pins the two structural rules the plan states: the posture is REPLACED
 * wholesale (a lock can be rolled back exactly as a milestone can) while the history
 * is only ever APPENDED — and that a re-read which changed nothing appends nothing.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-locks-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const ltDb = require('../src/longterm/db');
const locks = require('../src/longterm/locks');
const pipeline = require('../src/longterm/pipeline');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const S = require('../src/longterm/settings/encompass-settings').defaults();
const TODAY = new Date().toISOString().slice(0, 10);
const plus = (days) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

let loanId = null;

(async () => {
  try {
    const stamp = `LTLOCK${Date.now()}`;
    const { rows: made } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key)
            VALUES (gen_random_uuid(), $1, $1, 'Processing', 'setup') RETURNING id`, [stamp],
    );
    loanId = made[0].id;

    // ── The write ───────────────────────────────────────────────────────────
    console.log('mirroring a posture');

    const first = locks.lockFromLoan(
      { rateLock: {
        lockStatus: 'Locked', lockedRate: 7.125, lockedPrice: 100.25,
        lockDate: plus(-10), lockExpirationDate: plus(20), lockDays: 30,
        productName: 'DSCR 30 Year Fixed', commitmentType: 'Best Efforts',
      } }, null, S,
    );
    const wrote = await locks.writeLock(loanId, first);
    check(wrote.ok === true,
      `every column this writes really exists — a wrong name would report a quiet "nothing to mirror" forever${wrote.ok ? '' : ` (${wrote.reason})`}`);

    const back = await locks.loadLock(loanId);
    check(back.recorded === true && back.status === 'Locked'
      && Number(back.noteRatePct) === 7.125 && Number(back.price) === 100.25,
      'the posture reads back exactly as it went in');
    check(back.expirationDate === plus(20) && back.daysRemaining === 20 && back.expired === false,
      'the countdown runs to the date Encompass stated (20 days)');
    check(back.productName === 'DSCR 30 Year Fixed' && back.commitmentType === 'Best Efforts',
      '…and the product and commitment ride along, because a lock desk needs both');
    check(back.events.length === 1 && back.events[0].type === 'observed_lock',
      'the first posture we ever saw is recorded once');
    check(/not readable on our current API permissions/i.test(back.historyNote),
      'the screen is told plainly that this list is what PILOT watched, not Encompass\'s own history — somebody WILL ask why they cannot see who extended it');

    // ── A re-read that changed nothing ──────────────────────────────────────
    console.log('\na re-read that changed nothing');

    await locks.writeLock(loanId, first);
    await locks.writeLock(loanId, first);
    const quiet = await locks.loadLock(loanId);
    check(quiet.events.length === 1,
      'THE ONE THAT MATTERS: two more identical reads appended nothing — a history that grows on every sync is not a history');

    // ── An extension ────────────────────────────────────────────────────────
    console.log('\nan extension, and the rollback');

    const extended = locks.lockFromLoan(
      { rateLock: { lockStatus: 'Locked', lockedRate: 7.125, lockDate: plus(-10), lockExpirationDate: plus(35) } },
      null, S,
    );
    await locks.writeLock(loanId, extended);
    const after = await locks.loadLock(loanId);
    check(after.expirationDate === plus(35) && after.daysRemaining === 35,
      'the posture is REPLACED, not accumulated — the current row is what the loan says now');
    check(after.events.length === 2 && after.events[0].type === 'observed_extension',
      '…while the history is appended, and names what moved');

    const { rows: one } = await ltDb.query('SELECT count(*)::int AS n FROM lt_locks WHERE loan_id = $1::uuid', [loanId]);
    check(one[0].n === 1, 'there is exactly ONE current posture per loan, however many times it is mirrored');

    const rolledBack = locks.lockFromLoan(
      { rateLock: { lockStatus: 'Locked', lockedRate: 7.125, lockDate: plus(-10), lockExpirationDate: plus(20) } },
      null, S,
    );
    await locks.writeLock(loanId, rolledBack);
    const rb = await locks.loadLock(loanId);
    check(rb.expirationDate === plus(20),
      'a lock that was rolled back reads as rolled back — the snapshot follows the loan, it does not argue with it');
    check(rb.events.length === 3 && rb.events[0].type === 'observed_expiration_moved_in',
      '…and the rollback is recorded for what it was, never called an extension');

    // ── An expired lock ─────────────────────────────────────────────────────
    console.log('\nan expired lock');

    const gone = locks.lockFromLoan(
      { rateLock: { lockStatus: 'Locked', lockDate: plus(-60), lockExpirationDate: plus(-5) } }, null, S,
    );
    await locks.writeLock(loanId, gone);
    const exp = await locks.loadLock(loanId);
    check(exp.expired === true && exp.daysRemaining === -5,
      'a stated date in the past reads as expired, counted from the date itself');

    // ── The pipeline column ─────────────────────────────────────────────────
    console.log('\nthe pipeline carries it');

    const q = pipeline.buildPipelineQuery(
      { seesAll: true, staffId: null }, { sort: 'lock_expiration', dir: 'asc', limit: 5 },
    );
    const { rows: pipe } = await ltDb.query(q.sql, q.params);
    const mine = pipe.find((r) => String(r.id) === String(loanId));
    check(!!mine, 'the loan is on the pipeline sorted by whatever expires soonest — the lock desk\'s own order');
    check(mine && mine.lock_status === 'Locked' && String(mine.lock_expiration_date).slice(0, 10) === plus(-5),
      '…carrying its lock status and expiration, so nobody has to open a file to see them');
    check(mine && Number(mine.lock_days_remaining) === -5,
      '…and the countdown, computed in SQL so the column can be SORTED on');

    // A loan with no lock mirrored must still appear: an inner join would silently
    // shrink somebody's whole book.
    const { rows: bare } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name)
            VALUES (gen_random_uuid(), $1, $1, 'Processing') RETURNING id`, [`${stamp}B`],
    );
    const q2 = pipeline.buildPipelineQuery({ seesAll: true, staffId: null }, { limit: 200 });
    const { rows: pipe2 } = await ltDb.query(q2.sql, q2.params);
    const noLock = pipe2.find((r) => String(r.id) === String(bare[0].id));
    check(!!noLock && noLock.lock_status === null && noLock.lock_days_remaining === null,
      'a loan with no lock mirrored is still on the pipeline, with the column simply empty');
    await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [bare[0].id]);

    // ── It cannot break the pass that carries it ────────────────────────────
    console.log('\nit can never break the loan mirror');

    const bad = await locks.writeLock('not-a-uuid', locks.lockFromLoan({}, null, S));
    check(bad.ok === false && typeof bad.reason === 'string',
      'a write it cannot do reports the reason instead of throwing — one bad lock must not undo a loan we just mirrored');
  } catch (e) {
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    if (loanId) {
      await ltDb.query('DELETE FROM lt_lock_events WHERE loan_id = $1::uuid', [loanId]).catch(() => {});
      await ltDb.query('DELETE FROM lt_locks WHERE loan_id = $1::uuid', [loanId]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
