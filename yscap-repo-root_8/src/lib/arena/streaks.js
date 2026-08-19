'use strict';
/**
 * STREAKS — a run of challenges in a row earns a bonus chance.
 *
 * The owner's words: "three challenges in a row earns a bonus chance … it's
 * what keeps people going after lunch." That is exactly what it is for: the
 * hour when the room goes quiet is the hour the streak is worth something,
 * because the person who has done two already has a reason to do the third.
 *
 * ── THE THING THIS FILE EXISTS TO GET RIGHT ────────────────────────────────
 * A BONUS THAT CANNOT BE TAKEN BACK IS A BUG WITH A PRIZE ATTACHED. A super
 * admin approves a fulfilment, the streak pays, and then they look properly at
 * the screenshot and decline it. If the bonus stays, somebody is holding a
 * chance they did not earn — and the reversal has to reach not only the bonus
 * that fulfilment paid for, but every LATER bonus whose run depended on it.
 *
 * So nothing here INCREMENTS anything. `earnedFor` is a pure function of the
 * person's fulfilments as they stand right now, and `sync` writes the
 * DIFFERENCE between what they should hold and what they do hold. Approve,
 * decline, approve again, decline again — the answer is recomputed from the
 * facts each time, so it can never drift and there is no order of events that
 * leaves it wrong.
 *
 * TICKETS STAY A LEDGER. The adjustment is a row (positive or negative), never
 * an edit and never a delete, so "why do I have seven chances?" still has a
 * line-by-line answer. Bonus rows carry NO `entry_id`: the challenge ticket for
 * a fulfilment is keyed on its entry and reversed by that key when the
 * fulfilment is declined, and a bonus riding the same key would be reversed
 * twice — once by that path and once by this one.
 *
 * ── WHAT COUNTS AS "IN A ROW" ──────────────────────────────────────────────
 * The person's fulfilments in the order they SENT THEM IN. An approved one
 * extends the run; a declined one ends it. One nobody has decided on yet is
 * SKIPPED, not treated as a break — a super admin who is slow to look at a
 * screenshot must never be the reason somebody's streak died, and if they
 * decline it later the recomputation takes the bonus back anyway.
 *
 * The run is counted across the whole SESSION, which is the day. It does not
 * carry over to the next Elementix Day: a streak is a thing you are on, and a
 * new day starts at nought.
 */

// Required LAZILY, so the streak arithmetic below can be unit-tested with no
// database in reach — requiring src/db at load time fails loudly without a
// DATABASE_URL, and the maths is the half most worth testing.
let _db = null;
const db = () => (_db || (_db = require('../../db')));

/** Three in a row. A number the owner set, in one place. */
const STREAK_LENGTH = 3;
/** What each completed run pays. */
const STREAK_BONUS_TICKETS = 1;

/**
 * The run, from a person's fulfilments in the order they sent them in.
 *
 * PURE — no database, no clock. `entries` is [{status}] oldest first.
 * Returns:
 *   run        how many approved in a row they are on RIGHT NOW
 *   best       the longest run they managed all day
 *   completed  how many times a run reached the length (each one pays)
 *   toNext     how many more they need for the next bonus
 */
function streakOf(entries, { length = STREAK_LENGTH } = {}) {
  const len = Math.max(1, Math.floor(Number(length) || STREAK_LENGTH));
  let run = 0;
  let best = 0;
  let completed = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const status = e && e.status;
    // Undecided is not a break — see the header. Anything that is not a plain
    // approval and not still waiting (a decline, a withdrawal, anything a
    // future status might add) ends the run, which is the safe direction: a run
    // is a claim that everything in it was good.
    if (status === 'pending') continue;
    if (status === 'approved') {
      run += 1;
      if (run > best) best = run;
      if (run % len === 0) completed += 1;
    } else {
      run = 0;
    }
  }
  return { run, best, completed, length: len, toNext: len - (run % len) };
}

/** What a person's streaks should have paid them, in tickets. PURE. */
function bonusFor(entries, { length = STREAK_LENGTH, perStreak = STREAK_BONUS_TICKETS } = {}) {
  const s = streakOf(entries, { length });
  const per = Math.max(0, Math.floor(Number(perStreak) || 0));
  return { ...s, bonusTickets: s.completed * per };
}

/** One person's fulfilments for a session, oldest first. */
async function entriesFor(sessionId, staffId, client = null) {
  const q = client || db();
  const r = await q.query(
    `SELECT e.id, e.status, e.created_at
       FROM arena_challenge_entries e JOIN arena_challenges c ON c.id = e.challenge_id
      WHERE c.session_id = $1 AND e.staff_id = $2
      ORDER BY e.created_at, e.id`, [sessionId, staffId]);
  return r.rows;
}

/**
 * Make the ledger agree with the facts, for ONE person in ONE session.
 *
 * Runs INSIDE the caller's transaction (pass the client), because the decision
 * that changed the run and the bonus that follows from it are one event: a
 * crash between them would leave a person holding a bonus for a fulfilment that
 * was never approved.
 *
 * The advisory lock is per (session, person) and lasts to the end of the
 * transaction. Without it, two admins approving two different fulfilments of
 * the same person at the same instant both read "they hold 0, they have earned
 * 1" and both write it — the lock on the ENTRY row cannot help, because those
 * are two different rows.
 *
 * Returns { earned, held, delta } — delta is what this call wrote.
 */
async function sync(client, { sessionId, staffId, byStaffId = null }) {
  if (!sessionId || !staffId) return { earned: 0, held: 0, delta: 0 };
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`arena-streak:${sessionId}:${staffId}`]);

  const entries = await entriesFor(sessionId, staffId, client);
  const { bonusTickets, best, completed } = bonusFor(entries);

  const heldRow = await client.query(
    `SELECT COALESCE(sum(count), 0)::int AS n FROM arena_tickets
      WHERE session_id = $1 AND staff_id = $2 AND source = 'bonus'`, [sessionId, staffId]);
  const held = Number(heldRow.rows[0].n) || 0;
  const delta = bonusTickets - held;
  if (delta === 0) return { earned: bonusTickets, held, delta: 0, best, completed };

  await client.query(
    `INSERT INTO arena_tickets (session_id, staff_id, count, source, reason, created_by)
     VALUES ($1,$2,$3,'bonus',$4,$5)`,
    [sessionId, staffId, delta, reasonFor(delta, completed), byStaffId]);
  return { earned: bonusTickets, held: held + delta, delta, best, completed };
}

/** Plain words for the ledger line, so the row explains itself. */
function reasonFor(delta, completed) {
  if (delta > 0) {
    return completed === 1
      ? `${STREAK_LENGTH} in a row — bonus chance`
      : `${STREAK_LENGTH * completed} in a row — bonus chance ${completed}`;
  }
  return completed > 0
    ? `Streak shortened — bonus taken back to ${completed}`
    : 'Streak broken — bonus taken back';
}

/** What to SHOW a person about their own streak. Never throws. */
async function standingFor(sessionId, staffId) {
  try {
    const s = bonusFor(await entriesFor(sessionId, staffId));
    return {
      run: s.run, best: s.best, completed: s.completed,
      length: s.length, toNext: s.toNext, bonusTickets: s.bonusTickets,
      // The nudge the whole feature exists for. Said only when it is TRUE and
      // when it is close enough to be worth saying.
      nudge: s.run > 0 && s.toNext <= 2
        ? (s.toNext === 1
          ? 'One more in a row and you earn a bonus chance.'
          : `${s.toNext} more in a row and you earn a bonus chance.`)
        : null,
    };
  } catch (_) {
    return { run: 0, best: 0, completed: 0, length: STREAK_LENGTH, toNext: STREAK_LENGTH, bonusTickets: 0, nudge: null };
  }
}

module.exports = {
  STREAK_LENGTH, STREAK_BONUS_TICKETS,
  streakOf, bonusFor, sync, standingFor, entriesFor, reasonFor,
};
