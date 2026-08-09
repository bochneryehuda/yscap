'use strict';
/**
 * ONE PROPERTY, ONE DECISION — the race the audit measured, pinned closed.
 *
 * Before the fix, `decideCandidate` read the candidate, tested its status and
 * then wrote — the db/401 read-then-write class. Measured over real concurrent
 * calls: two simultaneous decides produced two track-record lines in 5 of 6
 * trials, eight produced seven lines for ONE property, and an import racing a
 * decline left the candidate DECLINED (durably — no future search re-raises
 * it) while the line the import created sat on the record and counted.
 *
 * The fix is `SELECT … FOR UPDATE` in one transaction plus conditional
 * settling UPDATEs (`AND status IN ('staged','snoozed')`), and this suite
 * drives the REAL functions concurrently on a real Postgres — a pure test
 * cannot prove a lock.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record decide race (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const IMP = require('../src/lib/track-record/importer');
const CONFIRM = require('../src/lib/track-record/borrower-confirm');
const tag = `trrace_${process.pid}`;

(async () => {
  await ensureSchema();

  const staffA = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Racer A','underwriter') RETURNING id`,
    [`racea+${tag}@x.test`])).rows[0].id;
  const staffB = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Racer B','underwriter') RETURNING id`,
    [`raceb+${tag}@x.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Race','Tester',$1) RETURNING id`,
    [`race+${tag}@x.test`])).rows[0].id;

  const mk = async (addr) => (await db.query(
    `INSERT INTO track_record_candidates
       (borrower_id, property_address, dedupe_key, status, raw, purchase_date, purchase_price, sale_date, sale_price)
     VALUES ($1,$2,$3,'staged','{}'::jsonb,'2025-08-02',210000,'2026-03-14',390000) RETURNING id`,
    [borrowerId, JSON.stringify({ oneLine: addr }), `${tag}:${addr}`])).rows[0].id;
  const lines = async () => (await db.query(
    `SELECT id, deal_type FROM track_records WHERE borrower_id=$1`, [borrowerId])).rows;
  const wipeLines = () => db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);

  console.log('\n1. N simultaneous imports of one candidate → exactly ONE line');
  for (const n of [2, 8]) {
    const c = await mk(`${n}0 Race St, Lakewood, NJ 08701`);
    const results = await Promise.allSettled(
      Array.from({ length: n }, (_, i) => IMP.decideCandidate(c, {
        action: 'import_new', staffId: i % 2 ? staffA : staffB, dealType: 'flip',
      })));
    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');
    ok(wins.length === 1, `${n} concurrent imports: exactly one succeeds (got ${wins.length})`);
    ok(losses.every((r) => r.reason && r.reason.status === 409),
      `…and every loser gets the 409, not a silent second write`);
    const rows = await lines();
    ok(rows.length === 1, `…and the record holds ONE line (got ${rows.length})`);
    await wipeLines();
  }

  console.log('\n2. Import racing a decline → never both');
  {
    /* The worst measured shape: candidate declined ("not their property",
       durable) while the imported line sits on the record anyway. */
    let importedAndDeclined = 0;
    for (let t = 0; t < 6; t++) {
      const c = await mk(`${t} Split Ave, Lakewood, NJ 08701`);
      await Promise.allSettled([
        IMP.decideCandidate(c, { action: 'import_new', staffId: staffA, dealType: 'flip' }),
        IMP.decideCandidate(c, { action: 'decline', staffId: staffB, note: 'a different person' }),
      ]);
      const st = (await db.query(
        `SELECT status, imported_track_record_id FROM track_record_candidates WHERE id=$1`, [c])).rows[0];
      const nLines = (await lines()).length;
      if (st.status === 'declined' && nLines > 0) importedAndDeclined++;
      if (st.status === 'imported') {
        ok(nLines === 1 && st.imported_track_record_id != null,
          `trial ${t}: the import won and the line + link agree`);
      } else {
        ok(st.status === 'declined' && nLines === 0,
          `trial ${t}: the decline won and NO line exists`);
      }
      await wipeLines();
    }
    ok(importedAndDeclined === 0,
      'no trial ever left a property both DECLINED in the queue and PRESENT on the record');
  }

  console.log('\n3. The borrower door has the same lock');
  {
    const c = await mk('77 Tap Twice Ln, Lakewood, NJ 08701');
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => CONFIRM.answerCandidate(c, {
        borrowerId, answer: 'mine',
      })));
    const wins = results.filter((r) => r.status === 'fulfilled');
    ok(wins.length === 1, `3 concurrent borrower "yes" taps: one lands (got ${wins.length})`);
    ok((await lines()).length === 1, '…and one line on the record');
    await wipeLines();
  }

  console.log('\n4. A garbage id is "not found", never a 500');
  {
    for (const bad of ['abc', "1' OR '1'='1", '99999999999999999999', '']) {
      let status = null;
      try { await CONFIRM.answerCandidate(bad, { borrowerId, answer: 'mine' }); }
      catch (e) { status = e.status; }
      ok(status === 404, `answer(${JSON.stringify(bad)}) → 404 (got ${status})`);
      status = null;
      try { await CONFIRM.undoAnswer(bad, { borrowerId }); }
      catch (e) { status = e.status; }
      ok(status === 404, `undo(${JSON.stringify(bad)}) → 404 (got ${status})`);
    }
  }

  console.log('\n5. The borrower undo: staff work survives, and a kept line never duplicates');
  {
    /* (a) a PRISTINE line goes, and the question reopens. */
    const c1 = await mk('5 Pristine Pl, Lakewood, NJ 08701');
    const first = await CONFIRM.answerCandidate(c1, { borrowerId, answer: 'mine' });
    const u1 = await CONFIRM.undoAnswer(c1, { borrowerId });
    ok(u1.lineRemoved === true && u1.status === 'staged', 'an untouched line is removed and the question reopens');
    ok((await lines()).length === 0, '…and the record is clean');

    /* (b) each kind of staff work protects the line — the audit deleted all
       five of these. */
    const worked = [
      { col: 'lo_notes', val: `'CANDID: seller is the borrower''s brother'`, what: 'an officer note' },
      { col: 'verification_status', val: `'limited'`, what: `status 'limited' (counts as verified per db/485)` },
      { col: 'verification_status', val: `'docs'`, what: `status 'docs'` },
      { col: 'docs_status', val: `'satisfied'`, what: 'collected paperwork' },
      { col: 'sale_price', val: '401000', what: 'a corrected figure' },
      { col: 'notes', val: `'REVIEWED BY STAFF'`, what: 'an edited note' },
    ];
    for (const w of worked) {
      const c = await mk(`W ${w.col} ${w.val.slice(0, 8)} St, Lakewood, NJ 08701`);
      const ans = await CONFIRM.answerCandidate(c, { borrowerId, answer: 'mine' });
      /* Session-level replica of a staffer touching it. The db/485 trigger only
         watches material columns, so these UPDATEs stand exactly as a staff
         edit would. */
      await db.query(`UPDATE track_records SET ${w.col} = ${w.val} WHERE id=$1`, [ans.trackRecordId]);
      const u = await CONFIRM.undoAnswer(c, { borrowerId });
      ok(u.lineKept === true && u.changed === false,
        `a line carrying ${w.what} is KEPT and the answer stands`);
      const st = (await db.query(
        `SELECT status, imported_track_record_id FROM track_record_candidates WHERE id=$1`, [c])).rows[0];
      ok(st.status === 'imported' && String(st.imported_track_record_id) === String(u.lineRemoved ? '' : (await lines())[0] && ans.trackRecordId),
        '…and the candidate still points at the surviving line — no reopened question, no duplicate path');
      /* Re-answering must be impossible: the question did NOT reopen. */
      let re = null;
      try { await CONFIRM.answerCandidate(c, { borrowerId, answer: 'mine' }); } catch (e) { re = e; }
      ok(re && re.status === 409, '…so a second "yes" cannot mint a duplicate line');
      ok((await lines()).length === 1, '…one line, still');
      await wipeLines();
      await db.query(`DELETE FROM track_record_candidates WHERE id=$1`, [c]);
    }

    /* (c) a VERIFIED line survives, as before. */
    const c2 = await mk('6 Verified Way, Lakewood, NJ 08701');
    const ans2 = await CONFIRM.answerCandidate(c2, { borrowerId, answer: 'mine' });
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`,
      [ans2.trackRecordId]);
    const u2 = await CONFIRM.undoAnswer(c2, { borrowerId });
    ok(u2.lineKept === true, 'a VERIFIED line is kept');
    await wipeLines();
  }

  await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[staffA, staffB]]);

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  one property, one decision — under load, from both doors');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
