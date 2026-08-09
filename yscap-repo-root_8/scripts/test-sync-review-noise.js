'use strict';
/**
 * THE SYNC-REVIEW QUEUE MUST ONLY ASK FOR WHAT IS ACTUALLY WAITING
 * (owner-reported 2026-07-28: "why am I still getting these emails, most of this
 * was resolved already and it's not coming up as a manual review required").
 *
 *   node scripts/test-sync-review-noise.js                            (pure)
 *   DATABASE_URL=postgres://… node scripts/test-sync-review-noise.js  (+ the producer)
 *
 * The report the owner received said "109 opened, 67 auto-closed … Top reasons
 * this week: encompass_address_differs: 77" while only TEN rows were actually
 * open. Two separate defects produced that, and this pins both:
 *
 *   1. THE DIGEST counted every row CREATED in the last 7 days, settled or not,
 *      so the system's own clean-up was reported back as a to-do list. It now
 *      reports the OPEN queue, and sends nothing at all when nothing is open.
 *   2. THE PRODUCER re-raised address conflicts a human had already settled,
 *      because the "already decided" guard was keyed on the Encompass LOAN the
 *      conflict arrived on and on the proposed string EXACTLY — and both move on
 *      their own (a newly mirrored loan re-keys it; the address canonicalizer
 *      re-renders it). It is now keyed on the PERSON and compared by MEANING.
 *      It also no longer claims a disagreement between two addresses it cannot
 *      read at all.
 */
const R = require('path').resolve(__dirname, '..');
const SR = require(R + '/src/lib/sync-review');
const ADDR = require(R + '/src/lib/address');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ── 1. the digest decides on the BACKLOG, not the week's activity ──────────
{
  // The owner's own week: a lot happened, almost all of it settled itself.
  const busyButClean = { opened: 109, auto_closed: 67, human_resolved: 23, dismissed: 14, open_now: 0, open_14d: 0 };
  const quiet = SR.digestMessage(busyButClean, []);
  ok(quiet.send === false, 'a week with NOTHING open sends no email at all');
  ok(quiet.why === 'nothing_open', 'and records why it stayed quiet');

  // The same week with ten rows genuinely waiting.
  const stats = { opened: 109, auto_closed: 67, human_resolved: 23, dismissed: 14, open_now: 10, open_14d: 0 };
  const open = [
    { field_key: 'current_address', reason: 'encompass_address_differs: the most recent Encompass file has a different home address for this borrower', n: 3 },
    { field_key: 'ys_loan_number', reason: 'copied_loan_number_needs_assignment', n: 2 },
  ];
  const m = SR.digestMessage(stats, open);
  ok(m.send === true, 'a week with open items does send');
  ok(/10 items are waiting/.test(m.body), 'the headline count is what is OPEN, not what was opened');
  ok(/Sync review — 10 waiting for a person/.test(m.title), 'the subject leads with the open count');
  ok(!/: 77/.test(m.body), 'the settled churn is never listed as work');
  ok(/109 came up and 104 were already settled/.test(m.body),
    'the week`s activity is still reported — explicitly as needing nothing');
  ok(/…and 5 more/.test(m.body), 'open rows beyond the listed reasons are accounted for, never dropped');

  // Every listed line is a sentence, not a code.
  ok(/• Borrower home address — the most recent Encompass file has a different home address/.test(m.body),
    'a coded reason renders as the field plus its sentence');
  ok(/• YS loan number — copied loan number needs assignment/.test(m.body),
    'a bare code renders as words, never raw snake_case');
  ok(SR.digestReasonLabel('current_address', '') === 'Borrower home address',
    'an empty reason still names the field');
  ok(SR.digestReasonLabel('brand_new_field', 'something_odd') === 'brand_new_field — something odd',
    'an unknown field never crashes the digest');

  // "0 older than 14 days" was in the owner's email and read as an alarm.
  ok(!/two weeks/.test(m.body), 'a zero-aged backlog is not mentioned at all');
  const aged = SR.digestMessage({ ...stats, open_14d: 4 }, open);
  ok(/4 of them for more than two weeks/.test(aged.body), 'a real aged backlog IS called out');

  // A single item reads as English.
  const one = SR.digestMessage({ ...stats, open_now: 1 }, [{ field_key: 'ssn', reason: 'x', n: 1 }]);
  ok(/1 item is waiting/.test(one.body), 'one item is singular');

  // Never throws on the shapes a database actually hands it.
  ok(SR.digestMessage({}, null).send === false, 'empty stats are treated as nothing to send');
  ok(SR.digestMessage({ open_now: '2' }, [{ field_key: 'ssn', reason: 'x', n: '2' }]).send === true,
    'string counts (pg bigint) are handled');
}

// ── 2. WHY the producer needs an unreadable-address guard ──────────────────
{
  // sameAddress answers "false" for anything it cannot read on both sides — it
  // also backs the queue CLOSER, where that conservatism is correct. The
  // producer must therefore never treat a plain false as "these differ".
  const box = 'PO Box 123, Brooklyn, NY 11219';
  ok(ADDR.sameAddress(box, box) === false,
    'sameAddress cannot confirm even two IDENTICAL PO boxes — the guard is load-bearing');
  const p = ADDR.parseAddressParts(box);
  ok(!(p.house && p.street), 'a PO box has no house number + street to read');
  const real = ADDR.parseAddressParts('5701 15th Ave, Brooklyn, NY 11219');
  ok(!!(real.house && real.street), 'an ordinary address IS readable, so it is still compared');
}

// ── 3. DB: the producer never re-raises a settled conflict ─────────────────
(async () => {
  if (process.env.DATABASE_URL) {
    const db = require(R + '/src/db');
    const enrich = require(R + '/src/encompass/enrich');
    const mk = (s) => ({ oneLine: s });
    const openRows = async (b) => (await db.query(
      `SELECT count(*)::int c FROM sync_review_queue
        WHERE borrower_id=$1 AND field_key='current_address' AND status='open'`, [b])).rows[0].c;
    let b = null;
    try {
      b = (await db.query(
        `INSERT INTO borrowers(first_name,last_name,email,current_address)
         VALUES('Addr','Noise',$1,$2::jsonb) RETURNING id`,
        ['addrnoise' + Math.random() + '@e.com',
          JSON.stringify(mk('5701 15th Ave Apt 4d, Brooklyn, NY 11219'))])).rows[0].id;

      // (a) the same home written differently is not a conflict at all
      const agree = await enrich.verifyPrimaryAddress(db, b, mk('5701 15 Ave 4D, Brooklyn, NY 11219, USA'),
        { loanGuid: 'g-agree' });
      ok(agree.agrees === true, 'the same home written differently agrees — no row');
      ok(await openRows(b) === 0, 'and nothing was queued');

      // (b) a genuinely different home IS a conflict, raised once
      const first = await enrich.verifyPrimaryAddress(db, b, mk('641 Dahill Rd, Brooklyn, NY 11218'),
        { loanGuid: 'g-1' });
      ok(first.conflict === true && first.queued === true, 'a different home raises a review');
      ok(await openRows(b) === 1, 'exactly one row');

      // (c) THE REGRESSION: the next pass sees the conflict on a DIFFERENT
      // Encompass loan and re-renders the address — the old guard missed both.
      const again = await enrich.verifyPrimaryAddress(db, b, mk('641 Dahill Road, Brooklyn, NY 11218, USA'),
        { loanGuid: 'g-2-a-newly-mirrored-loan' });
      ok(again.alreadyQueued === true, 'an already-open conflict is recognised on a new loan + a new spelling');
      ok(await openRows(b) === 1, 'and NO second card is created for one question');

      // (d) a human dismisses it — it must stay dismissed, forever, on any loan
      await db.query(
        `UPDATE sync_review_queue SET status='rejected', resolved_at=now()
          WHERE borrower_id=$1 AND field_key='current_address' AND status='open'`, [b]);
      const afterDismiss = await enrich.verifyPrimaryAddress(db, b, mk('641 Dahill Rd, Brooklyn, NY 11218, USA'),
        { loanGuid: 'g-3-another-loan' });
      ok(afterDismiss.alreadyDecided === true, 'a dismissed conflict is never raised again');
      ok(await openRows(b) === 0, 'and the queue stays empty');

      // (e) they really did move → a DIFFERENT place still surfaces
      const moved = await enrich.verifyPrimaryAddress(db, b, mk('27 Ridge Ave Unit 207, Spring Valley, NY 10977'),
        { loanGuid: 'g-4' });
      ok(moved.conflict === true, 'a genuinely new address still reaches a human');
      ok(await openRows(b) === 1, 'exactly one new row');
      await db.query(`DELETE FROM sync_review_queue WHERE borrower_id=$1`, [b]);

      // (f) THE BACKLOG: the rows that piled up before the producer was fixed —
      // a dismissed question raised again, and two cards for one question.
      {
        const closer = require(R + '/src/lib/address-review-close');
        // THE FIXTURE IS BACKDATED PAST EVERY REAL ROW ON PURPOSE.
        // `closeSupersededAddressReviewsOnce` is a GLOBAL sweep over the whole
        // queue — `ORDER BY created_at LIMIT 500` — not a per-borrower one. On a
        // re-used database (a developer's box, a CI job that ran the suite
        // before) a few hundred older open address reviews sit in front of these
        // five, so a fixture dated `now() - 9 days` falls past the cap, is never
        // looked at, and every assertion below fails with nothing wrong with the
        // closer. The `- 9000 days` offset is applied to EVERY row, so their
        // relative ages — which is what the older-card-survives rule turns on —
        // are unchanged, and they are always the first rows the sweep reads.
        const mkRow = async (enc, status, ageDays) => (await db.query(
          `INSERT INTO sync_review_queue
             (borrower_id, task_id, direction, field_key, current_value, proposed_value,
              reason, clickup_value, portal_value, source, status, created_at, resolved_at)
           VALUES ($1,$2,'inbound','current_address','5701 15th Ave, Brooklyn, NY 11219',$3,
                   'encompass_address_differs: test',$3,'5701 15th Ave, Brooklyn, NY 11219','encompass',$4,
                   now() - ($5 || ' days')::interval - interval '9000 days',
                   CASE WHEN $4='open' THEN NULL ELSE now() END)
           RETURNING id`,
          [b, 'encompass:' + Math.random(), enc, status, String(ageDays)])).rows[0].id;
        const st = async (id) => (await db.query(`SELECT status FROM sync_review_queue WHERE id=$1`, [id])).rows[0].status;

        const dismissed = await mkRow('641 Dahill Rd, Brooklyn, NY 11218', 'rejected', 9);
        const reRaised = await mkRow('641 Dahill Road, Brooklyn, NY 11218, USA', 'open', 2);
        const firstCard = await mkRow('27 Ridge Ave Unit 207, Spring Valley, NY 10977', 'open', 5);
        const secondCard = await mkRow('27 Ridge Avenue 207, Spring Valley, NY 10977', 'open', 1);
        const genuine = await mkRow('100 Whisper Vlg Wy, Lakewood, NJ 08701', 'open', 3);

        const r = await closer.closeSupersededAddressReviewsOnce({ limit: 500 });
        ok(await st(reRaised) === 'resolved', 'a re-raise of a DISMISSED address is retired');
        ok(await st(dismissed) === 'rejected', 'the human decision itself is left exactly as it was');
        ok(await st(secondCard) === 'resolved', 'the duplicate second card is retired');
        ok(await st(firstCard) === 'open', 'the ORIGINAL card survives — the question is never lost');
        ok(await st(genuine) === 'open', 'an unrelated open conflict is untouched');
        // >= 1, NOT === 1: the two counters are the sweep's GLOBAL tally, so on a
        // re-used database they also count other borrowers' rows. The five
        // per-row assertions above already pin exactly which of OUR rows closed
        // and which stayed open, so nothing is weakened — this only asserts that
        // both kinds are reported on their own counter rather than merged.
        ok(r.closedDecided >= 1 && r.closedDuplicate >= 1, 'both kinds are reported separately');

        // IDEMPOTENT is asserted on OUR rows, not on the global counters — a
        // second pass legitimately reaches other borrowers' rows the first pass's
        // 500-row cap left behind, and counting those would fail a pass that did
        // exactly the right thing.
        const snap = async () => (await Promise.all(
          [reRaised, dismissed, secondCard, firstCard, genuine].map(st))).join(',');
        const before = await snap();
        await closer.closeSupersededAddressReviewsOnce({ limit: 500 });
        ok(await snap() === before, 'a second pass changes nothing (idempotent)');
        await db.query(`DELETE FROM sync_review_queue WHERE borrower_id=$1`, [b]);
      }

      // (g) two unreadable sides are never asserted to differ
      await db.query(`UPDATE borrowers SET current_address=$2::jsonb WHERE id=$1`,
        [b, JSON.stringify(mk('PO Box 123, Brooklyn, New York 11219'))]);
      const boxes = await enrich.verifyPrimaryAddress(db, b, mk('P.O. Box 123, Brooklyn, NY 11219'), { loanGuid: 'g-5' });
      ok(boxes.conflict !== true, 'two addresses we cannot read never become a "they differ" review');
      ok(await openRows(b) === 0, 'nothing queued for an unreadable pair');
    } catch (e) {
      fail++; console.log('  FAIL: DB producer test threw:', e.message);
    } finally {
      if (b) {
        await db.query(`DELETE FROM sync_review_queue WHERE borrower_id=$1`, [b]).catch(() => {});
        await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]).catch(() => {});
      }
      try { await db.pool.end(); } catch (_) {}
    }
  } else {
    console.log('  ~~ SKIP producer DB test (no DATABASE_URL)');
  }

  console.log(`sync-review noise: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
