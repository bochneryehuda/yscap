'use strict';
/**
 * WHO IS WORKING THIS PROPERTY — the shared-queue claim.
 *
 * The two that carry this file:
 *   §2  CLAIMING IS ATOMIC. Two reviewers pressing "start review" on the same
 *       property in the same instant is the ordinary shape once a queue is
 *       shared, and the read-then-write version of this would hand it to both.
 *   §4  A CLAIM NEVER BLOCKS A DECISION. This is the rule that keeps the queue
 *       from acquiring a new way to get stuck: a closed tab must not make a
 *       property unpromotable, so a claim is a label and never a lock.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record claims (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const CLAIMS = require('../src/lib/track-record/claims');
const IMP = require('../src/lib/track-record/importer');
const tag = `trclaim_${process.pid}`;

(async () => {
  await ensureSchema();

  const alice = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Alice Reviewer','underwriter') RETURNING id`,
    [`alice+${tag}@x.test`])).rows[0].id;
  const bob = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Bob Reviewer','underwriter') RETURNING id`,
    [`bob+${tag}@x.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Claim','Tester',$1) RETURNING id`,
    [`b+${tag}@x.test`])).rows[0].id;

  const mkCandidate = async (addr) => (await db.query(
    `INSERT INTO track_record_candidates (borrower_id, property_address, dedupe_key, status, raw)
     VALUES ($1,$2,$3,'staged','{}'::jsonb) RETURNING id`,
    [borrowerId, JSON.stringify({ oneLine: addr }), `${tag}:${addr}`])).rows[0].id;

  console.log('\n1. A claim is recorded, and it names the person');
  const c1 = await mkCandidate('1 First St, Lakewood, NJ 08701');
  {
    const out = await CLAIMS.claimForReview([c1], alice);
    ok(out.claimed.length === 1 && out.claimed[0] === c1, 'the reviewer takes the property');
    ok(out.heldByOthers.length === 0, '…and nobody else is reported as holding it');

    const bobView = await IMP.loadQueue(borrowerId, null, { viewerStaffId: bob });
    const row = bobView.toReview.find((r) => r.id === c1);
    ok(row && row.claim && row.claim.held === true, 'a COLLEAGUE sees the property as being worked');
    ok(row && row.claim.by === 'Alice Reviewer',
      '…and is told WHO — "someone else" would send them hunting');
    ok(row && row.claim.mine === false, '…and it is not reported as theirs');

    const aliceView = await IMP.loadQueue(borrowerId, null, { viewerStaffId: alice });
    const mine = aliceView.toReview.find((r) => r.id === c1);
    ok(mine && mine.claim.mine === true && !mine.claim.by,
      'the holder sees it as their own, with nobody to name');
  }

  console.log('\n2. Two reviewers at the same instant — exactly one wins');
  {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await mkCandidate(`${10 + i} Race Ave, Lakewood, NJ 08701`));

    /* Fired together on purpose: the read-then-write shape hands the same rows
       to both, which is the db/401 race in a different table. */
    const [a, b] = await Promise.all([
      CLAIMS.claimForReview(ids, alice),
      CLAIMS.claimForReview(ids, bob),
    ]);
    const overlap = a.claimed.filter((id) => b.claimed.includes(id));
    ok(overlap.length === 0, 'no property is handed to both reviewers');
    ok(a.claimed.length + b.claimed.length === ids.length,
      '…and every property went to exactly one of them, none dropped');

    const loser = a.claimed.length < b.claimed.length ? a : b;
    ok(loser.heldByOthers.length > 0 || loser.claimed.length === ids.length,
      'whoever lost a row is TOLD it is held, rather than it silently vanishing');
  }

  console.log('\n3. An abandoned claim expires; my own claim refreshes');
  const c3 = await mkCandidate('55 Stale Rd, Lakewood, NJ 08701');
  {
    await CLAIMS.claimForReview([c3], alice);
    const stale = await CLAIMS.claimForReview([c3], bob);
    ok(stale.claimed.length === 0, 'a LIVE claim is not taken from the person holding it');

    /* Age it past the window — a closed tab, a reviewer who went home. */
    await db.query(
      `UPDATE track_record_candidates SET claimed_at = now() - interval '${CLAIMS.STALE_MINUTES + 5} minutes' WHERE id=$1`,
      [c3]);
    const took = await CLAIMS.claimForReview([c3], bob);
    ok(took.claimed.length === 1, 'an abandoned claim is taken over — a closed tab never parks a property');

    const row = (await db.query(`SELECT claimed_by, claimed_at FROM track_record_candidates WHERE id=$1`, [c3])).rows[0];
    ok(String(row.claimed_by) === String(bob), '…by the person who asked for it');

    /* Re-claiming my own must RESET the clock, or a long review run expires
       under the person actually doing it. */
    await db.query(
      `UPDATE track_record_candidates SET claimed_at = now() - interval '${CLAIMS.STALE_MINUTES - 2} minutes' WHERE id=$1`,
      [c3]);
    await CLAIMS.claimForReview([c3], bob);
    const fresh = (await db.query(
      `SELECT claimed_at > now() - interval '1 minute' AS recent FROM track_record_candidates WHERE id=$1`, [c3])).rows[0];
    ok(fresh.recent === true, 're-claiming my own refreshes the clock, so a long run never expires under me');
  }

  console.log('\n4. A CLAIM NEVER BLOCKS A DECISION — the rule that carries this file');
  const c4 = await mkCandidate('9 Blocked Way, Lakewood, NJ 08701');
  {
    await CLAIMS.claimForReview([c4], alice);
    /* Bob decides a property Alice is holding. This must go through: a claim is
       a label, and the durable status guard is what stops a double-decide. */
    let threw = null;
    try {
      await IMP.decideCandidate(c4, { action: 'decline', staffId: bob, note: 'not theirs' });
    } catch (e) { threw = e; }
    ok(!threw, 'a colleague can still decide a property somebody else is holding');

    const row = (await db.query(`SELECT status FROM track_record_candidates WHERE id=$1`, [c4])).rows[0];
    ok(row.status === 'declined', '…and the decision actually landed');
  }

  console.log('\n5. Releasing gives back only MY claims');
  const c5 = await mkCandidate('7 Release Ct, Lakewood, NJ 08701');
  {
    await CLAIMS.claimForReview([c5], alice);
    const wrong = await CLAIMS.releaseClaims([c5], bob);
    ok(wrong === 0, 'releasing is not a way to take a property off a colleague');
    const mine = await CLAIMS.releaseClaims([c5], alice);
    ok(mine === 1, '…and the holder can give their own back');
    const row = (await db.query(`SELECT claimed_by FROM track_record_candidates WHERE id=$1`, [c5])).rows[0];
    ok(row.claimed_by === null, '…leaving the property free for anyone');
  }

  console.log('\n6. A stale claim READS as no claim, and a decided row is never claimable');
  {
    const old = { claimed_by: alice, claimed_at: new Date(Date.now() - (CLAIMS.STALE_MINUTES + 60) * 60000), claimed_by_name: 'Alice Reviewer' };
    const st = CLAIMS.claimStateOf(old, bob);
    ok(st.held === false && st.expired === true,
      'an expired claim is reported as unheld — "held by Alice (2 days ago)" reads as current and is worse than silence');
    ok(CLAIMS.claimStateOf({}, bob).held === false, 'an unclaimed row is unheld');
    ok(CLAIMS.claimStateOf({ claimed_by: alice, claimed_at: null }, bob).held === false,
      'a half-written claim is unheld, never a crash');

    /* A decided property has left the queue; claiming it would be meaningless. */
    const done = await mkCandidate('3 Done Dr, Lakewood, NJ 08701');
    await db.query(`UPDATE track_record_candidates SET status='imported' WHERE id=$1`, [done]);
    const out = await CLAIMS.claimForReview([done], alice);
    ok(out.claimed.length === 0, 'a property already decided cannot be claimed');
  }

  console.log('\n7. The claim is STAFF-ONLY — a borrower never sees the team working');
  {
    const forBorrower = await require('../src/lib/track-record/borrower-confirm')
      .loadForBorrower(borrowerId, db);
    const leaked = JSON.stringify(forBorrower).match(/claimed_by|claimed_at|Alice Reviewer|Bob Reviewer/);
    ok(!leaked, 'no reviewer name or claim stamp reaches the borrower');
  }

  await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[alice, bob]]);


  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  a claim says who is looking, and it can never stop anybody acting');
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await db.end(); } catch (_) {} process.exit(1); });
