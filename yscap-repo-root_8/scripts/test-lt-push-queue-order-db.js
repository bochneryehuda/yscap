'use strict';
/**
 * LONG-TERM — a WITNESSED MILESTONE MOVE IS SERVED BEFORE A COSMETIC REFRESH
 * (owner-reported 2026-08-25, YSCAP258134720).
 *
 * WHAT THIS IS FOR. The owner moved a file to Clear to Close in Encompass and the
 * ClickUp card did not follow. Every link in the chain measured GREEN: the move was
 * witnessed, the loan was due for a push, the rule said "push", and the status was
 * on the card's list in a forward position. The card simply had not been reached —
 * `pushPass` takes five loans a tick, longest-since-pushed first, and that order has
 * no opinion whatsoever about statuses, so a real move sat behind a few hundred
 * routine field refreshes for hours. Nothing anywhere read as broken, because
 * nothing was: it was last in line, every time.
 *
 * WHY THE ORDERING NEEDS A DATABASE TO PROVE. The whole fix IS one ORDER BY, and
 * `node --check` has no opinion about SQL. Worse, the three ordering keys interact:
 * urgency has to beat "pushed recently" and simultaneously LOSE to the recorded-
 * problem flag, or a permanently failing loan carrying an unconsumed event retakes
 * the head of the queue every pass forever — which is the exact starvation the
 * problem flag was added to stop. Only real rows in a real Postgres order that way.
 *
 * IT RUNS THE SHIPPING QUERY. `push.pushQueue` is the function `pushPass` itself
 * calls; nothing here retypes the SQL, because a hand-copied ORDER BY is free to
 * drift from the one that ships and would then prove nothing at all.
 *
 * Skips cleanly with no DATABASE_URL, like every other -db suite here.
 */

const db = require('../src/longterm/db');
const push = require('../src/longterm/clickup/push');

let pass = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { pass++; console.log(`  ok   ${what}`); return; }
  fails.push(what);
  console.error(`  ✗ ${what}`);
}
const eq = (got, want, what) => ok(got === want, `${what} (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`);

const ids = {};
const U = (n) => ids[n];

/** A loan that IS due for a push: linked, confirmed, not trash, read since it was pushed. */
async function seedLoan(name, { pushedAt, folder = 'Corr Clear To Close', problem = null }) {
  const { rows } = await db.query(
    `INSERT INTO lt_loans (id, loan_number, clickup_task_id, clickup_link_confidence,
                           loan_folder, clickup_pushed_at, clickup_push_error,
                           encompass_synced_at, encompass_last_modified, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, $2, 'confirmed', $3, $4::timestamptz, $5,
                  now(), now(), now(), now())
       RETURNING id`,
    [name, `task_${name}`, folder, pushedAt, problem]);
  ids[name] = rows[0].id;
  return rows[0].id;
}

/** A witnessed move, and where the loan's own watermark sits against it. */
async function witness(name, { observedAt, watermark }) {
  await db.query(
    `INSERT INTO lt_milestone_events (id, loan_id, event_type, from_milestone, to_milestone, observed_at)
          VALUES (gen_random_uuid(), $1::uuid, 'observed_entered', 'Submittal', 'Clear To Close', $2::timestamptz)`,
    [U(name), observedAt]);
  await db.query('UPDATE lt_loans SET clickup_status_event_at = $2::timestamptz WHERE id = $1::uuid',
    [U(name), watermark]);
}

async function order(limit = 20) {
  const { rows } = await push.pushQueue({ limit });
  const byId = new Map(Object.entries(ids).map(([n, id]) => [id, n]));
  return rows.map((r) => byId.get(r.id)).filter(Boolean);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('test-lt-push-queue-order-db: no DATABASE_URL — skipped');
    return;
  }

  await db.query(`DELETE FROM lt_milestone_events WHERE loan_id IN (SELECT id FROM lt_loans WHERE loan_number LIKE 'YSQORD%')`);
  await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE 'YSQORD%'`);

  // ── A. the reported shape: the urgent loan was pushed MOST recently ────────
  // Under the old order this loan sorted DEAD LAST of the four — it had just been
  // refreshed — which is precisely how a real move ends up hours behind cosmetics.
  console.log('\nA. a loan waiting on a witnessed move is served first, however recently it was pushed');
  await seedLoan('YSQORD-oldest',  { pushedAt: '2026-08-25T09:00:00Z' });
  await seedLoan('YSQORD-older',   { pushedAt: '2026-08-25T10:00:00Z' });
  await seedLoan('YSQORD-old',     { pushedAt: '2026-08-25T11:00:00Z' });
  await seedLoan('YSQORD-urgent',  { pushedAt: '2026-08-25T13:08:57Z' });
  await witness('YSQORD-urgent', { observedAt: '2026-08-25T16:19:00Z', watermark: '2026-08-25T13:02:27Z' });

  const a = await order();
  eq(a[0], 'YSQORD-urgent', 'the loan whose move is unanswered comes first');
  eq(a.length, 4, 'and every due loan is still in the queue — this reorders, it never filters');
  eq(a.slice(1).join(','), 'YSQORD-oldest,YSQORD-older,YSQORD-old',
    'the rest keep the old longest-since-pushed order exactly as before');

  // The cap is what made this bite: with five slots and hundreds of refreshes
  // ahead, position IS the outage.
  const capped = await order(1);
  eq(capped[0], 'YSQORD-urgent', 'and with only one slot in the pass, that slot goes to the move');

  // ── B. an ANSWERED move is not urgent ─────────────────────────────────────
  // The urgency test is the rule's own `isNewEvent`: an event NEWER than the
  // loan's watermark. A loan whose event has already been answered must sink back
  // to its ordinary place, or every linked loan in the book would be permanently
  // "urgent" and this would be the sweep the owner reported as a bug in August.
  console.log('\nB. a move that has already been answered is not urgent any more');
  await db.query('UPDATE lt_loans SET clickup_status_event_at = $2::timestamptz WHERE id = $1::uuid',
    [U('YSQORD-urgent'), '2026-08-25T16:19:00Z']);
  const b = await order();
  eq(b[0], 'YSQORD-oldest', 'with its watermark caught up it stops jumping the queue');
  eq(b[3], 'YSQORD-urgent', 'and takes its ordinary place by when it was last pushed');

  // A baseline is a first sighting, not a move — it must never promote anything.
  await db.query(
    `INSERT INTO lt_milestone_events (id, loan_id, event_type, from_milestone, to_milestone, observed_at)
          VALUES (gen_random_uuid(), $1::uuid, 'observed_baseline', NULL, 'Loan Setup', now())`,
    [U('YSQORD-old')]);
  const bb = await order();
  eq(bb[0], 'YSQORD-oldest', 'a baseline sighting does not promote a loan — it is not a move');

  // ── C. urgency LOSES to the recorded-problem flag ──────────────────────────
  // This is the ordering's load-bearing subtlety. A loan whose status write keeps
  // failing KEEPS its event (the write path clears `stamp` on a failure), so it is
  // permanently urgent. If urgency outranked the problem flag it would retake the
  // head of the queue every pass forever and starve the whole book — the exact
  // starvation the flag exists to prevent.
  console.log('\nC. a loan with a recorded problem stays demoted even while it is urgent');
  await db.query('UPDATE lt_loans SET clickup_status_event_at = $2::timestamptz, clickup_push_error = $3 WHERE id = $1::uuid',
    [U('YSQORD-urgent'), '2026-08-25T13:02:27Z', 'ClickUp refused the status write']);
  const c = await order();
  eq(c[3], 'YSQORD-urgent', 'it sorts behind every healthy loan, urgent or not');
  ok(c.indexOf('YSQORD-urgent') > c.indexOf('YSQORD-oldest'), 'so one broken loan can never own the head of the queue');

  // …and within the demoted cohort it still comes round first.
  await seedLoan('YSQORD-alsoStuck', { pushedAt: '2026-08-25T08:00:00Z', problem: 'a different problem' });
  const c2 = await order();
  const stuck = c2.filter((n) => n === 'YSQORD-urgent' || n === 'YSQORD-alsoStuck');
  eq(stuck[0], 'YSQORD-urgent', 'but inside the demoted group the one with a real move goes first');

  // ── D. the queue's own WHERE is untouched ─────────────────────────────────
  // A reorder that quietly changed WHICH loans are eligible would be a far worse
  // bug than the one it fixes, so the exclusions are re-proven here against a loan
  // that is urgent in every other respect.
  console.log('\nD. urgency does not smuggle an ineligible loan into the queue');
  await seedLoan('YSQORD-trash', { pushedAt: '2026-08-25T07:00:00Z', folder: '(Trash)' });
  await witness('YSQORD-trash', { observedAt: '2026-08-25T16:19:00Z', watermark: '2026-08-25T13:00:00Z' });
  ok(!(await order()).includes('YSQORD-trash'), 'a trashed loan is still excluded, however urgent');

  await db.query(`UPDATE lt_loans SET clickup_link_confidence = 'probable' WHERE loan_number = 'YSQORD-oldest'`);
  ok(!(await order()).includes('YSQORD-oldest'), 'an unconfirmed link is still excluded');
  await db.query(`UPDATE lt_loans SET clickup_link_confidence = 'confirmed' WHERE loan_number = 'YSQORD-oldest'`);

  await db.query(`UPDATE lt_loans SET clickup_pushed_at = now() + interval '1 hour' WHERE loan_number = 'YSQORD-old'`);
  ok(!(await order()).includes('YSQORD-old'), 'a loan pushed since its last read is still not due');

  await db.query(`DELETE FROM lt_milestone_events WHERE loan_id IN (SELECT id FROM lt_loans WHERE loan_number LIKE 'YSQORD%')`);
  await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE 'YSQORD%'`);

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
