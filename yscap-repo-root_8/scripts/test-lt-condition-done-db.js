#!/usr/bin/env node
'use strict';
/**
 * LT — THE LOAN OFFICER'S OWN "DONE" STEP.
 *
 * Owner-directed 2026-09-01, looking at a Long-Term condition whose Done button
 * answered *"Long-Term has no separate loan-officer 'done' step"*: *"It's missing
 * this feature for the loan officer to click Done. Research this free feature on
 * the short-term side and share the code to enable this feature in the long-term
 * side."*
 *
 * ── WHY IT WAS FREE, AND WHY THAT MAKES THIS SUITE A DATABASE ONE ───────────
 *
 * The fact is stored in `checklist_items.reviewed_by` / `reviewed_at` — two
 * columns db/033 added for the short-term side, on the table Long-Term already
 * owns rows in (db/652/653) and is already authorised to write. So nothing was
 * migrated and nothing was copied: the SAME columns, read and written by a
 * Long-Term door. What no pure test can see is exactly that — whether the SQL
 * this adds actually runs against the real schema. A phantom column inside a
 * swallowing catch is this repo's most expensive recurring bug, and the read
 * this change touches is the one that draws the whole conditions screen.
 *
 * THE PROPERTY THAT MATTERS MOST is the one a money-adjacent system can get
 * wrong quietly: marking done must move NOTHING ELSE. It is a stamp, not a
 * clearance — the back office still signs the condition off afterwards, and a
 * "done" that silently satisfied the condition would let one person clear work
 * a second pair of eyes is supposed to clear.
 *
 * DB-GATED.
 */
const crypto = require('crypto');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-condition-done');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const write = require('../src/longterm/conditions-center/write.js');
  const read = require('../src/longterm/conditions-center/read.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Done','Probe',$1) RETURNING id`,
      [`done-${stamp}@example.test`])).rows[0].id;

    // A REAL member of staff, because the whole value of the stamp is the NAME
    // it carries — a test that stamped a null id would prove the column moved
    // and nothing about whether anybody can read it afterwards.
    const officer = (await cx.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Dina the Loan Officer','loan_officer',true) RETURNING id`,
      [`officer-${stamp}@example.test`])).rows[0].id;

    const makeLoan = async (tag) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','purchase'::lt_loan_purpose)`,
        [id, borrower, `DONE-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'7 Done Way','Anytown','NJ','07001',1,'SFR')`, [id]);
      await engine.evaluateLoan(id, { db: cx });
      return id;
    };

    const oneCondition = async (loanId) => (await cx.query(
      `SELECT ci.id, ci.status FROM checklist_items ci
        WHERE ci.lt_loan_id = $1::uuid ORDER BY ci.sort_order LIMIT 1`, [loanId])).rows[0];

    const stampOf = async (id) => (await cx.query(
      `SELECT reviewed_at, reviewed_by, status, signed_off_at, waived_at, is_required
         FROM checklist_items WHERE id = $1::uuid`, [id])).rows[0];

    const loan = await makeLoan('main');
    const cond = await oneCondition(loan);
    ok(!!cond, 'the file has a condition to work with');

    // ── A. THE STAMP LANDS, WITH A NAME ON IT ───────────────────────────────
    console.log('\nA. THE OFFICER MARKS THEIR STEP DONE');
    {
      const before = await stampOf(cond.id);
      ok(before.reviewed_at === null, 'nobody has marked it done yet');

      const r = await write.markDone(loan, cond.id, officer, true, cx);
      ok(r.ok === true, 'the door accepts it');

      const after = await stampOf(cond.id);
      ok(after.reviewed_at !== null, 'the time it was done is recorded');
      ok(after.reviewed_by === officer, 'and WHOSE step it was — the stamp carries a name, not just a clock');
    }

    // ── B. THE ONE THAT MATTERS: IT MOVES NOTHING ELSE ──────────────────────
    console.log('\nB. IT IS A STAMP, NOT A CLEARANCE — the back office still signs off');
    {
      const s = await stampOf(cond.id);
      ok(s.status === cond.status,
        'THE ONE THAT MATTERS: the condition is in exactly the status it was — marking done never clears it', `${cond.status} -> ${s.status}`);
      ok(s.signed_off_at === null, '…it is NOT signed off, so a second pair of eyes is still required');
      ok(s.waived_at === null, '…and it is not waived either');
      ok(s.is_required !== false, '…and a required condition is still required');
    }

    // ── C. THE SCREEN CAN READ IT BACK ──────────────────────────────────────
    // This is the half a pure test cannot reach: the read is where a phantom
    // column would throw, and it draws the whole conditions screen.
    console.log('\nC. THE SCREEN SHOWS WHO FINISHED THEIR PART');
    {
      const flatten = (v) => [].concat(...(v.buckets || []).map((b) => b.conditions || []));
      const view = await read.forLoan(loan, { db: cx, audience: 'internal' });
      const mine = flatten(view).find((c) => c.id === cond.id);
      ok(!!mine, 'the condition comes back on the team\'s view');
      ok(mine && mine.reviewedAt, 'the read carries the stamp — so the SQL this change added really runs');
      ok(mine && mine.reviewedBy === 'Dina the Loan Officer',
        'and it resolves to the officer\'s NAME, which is what the line prints', String(mine && mine.reviewedBy));

      /* WHO DID OUR INTERNAL STEP IS OURS. The client read deliberately withholds
         every "how we work" fact — who signed off, why it was waived — and this
         stamp is one of them. Pinned from the other side so a future widening of
         the client shape cannot quietly put a staffer's name on a borrower's
         screen. */
      const client = await read.forLoan(loan, { db: cx, audience: 'borrower' });
      const theirs = flatten(client).find((c) => c.id === cond.id);
      if (theirs) {
        ok(!theirs.reviewedAt && !theirs.reviewedBy,
          'the borrower is NOT shown who on our team finished their step', JSON.stringify({ at: theirs.reviewedAt, by: theirs.reviewedBy }));
      } else {
        ok(true, 'the condition is not borrower-facing at all, so there is nothing to leak');
      }
    }

    // ── D. UNDO ─────────────────────────────────────────────────────────────
    console.log('\nD. AND THEY CAN PUT IT BACK');
    {
      const r = await write.markDone(loan, cond.id, officer, false, cx);
      ok(r.ok === true, 'undo is accepted');
      const s = await stampOf(cond.id);
      ok(s.reviewed_at === null && s.reviewed_by === null, 'both halves of the stamp are gone — no orphan name, no orphan clock');
      ok(s.status === cond.status, '…and undoing it moved the status no more than doing it did');
    }

    // ── E. A REOPENED CONDITION IS NOT STILL "DONE" ─────────────────────────
    console.log('\nE. WORK THAT COMES BACK IS NOT STILL MARKED DONE');
    {
      await write.markDone(loan, cond.id, officer, true, cx);
      ok((await stampOf(cond.id)).reviewed_at !== null, 'it is marked done');
      const r = await write.reopen(loan, cond.id, cx);
      ok(r.ok === true, 'the condition is reopened');
      const s = await stampOf(cond.id);
      ok(s.reviewed_at === null && s.reviewed_by === null,
        'THE CONTRADICTION IS GONE: a condition back on the list no longer says the officer finished it');
    }

    // ── F. IT CANNOT REACH ANOTHER FILE ─────────────────────────────────────
    console.log('\nF. THE DOOR IS SCOPED TO THE FILE IT WAS OPENED ON');
    {
      const other = await makeLoan('other');
      const otherCond = await oneCondition(other);
      ok(otherCond.id !== cond.id, 'the second file has its own condition');

      const r = await write.markDone(loan, otherCond.id, officer, true, cx);
      ok(r.ok === false && r.status === 404,
        'a condition id from ANOTHER file is refused, never stamped', JSON.stringify(r).slice(0, 80));
      ok((await stampOf(otherCond.id)).reviewed_at === null, '…and that other file\'s row was genuinely left alone');
    }

    // ── G. A STAMP WITH NOBODY'S NAME IS REFUSED ────────────────────────────
    console.log('\nG. A NAMELESS STAMP IS NOT WRITTEN');
    {
      /* The loan id is REAL here, deliberately. Passing null for it too would
         make the door refuse for a second reason — an owner with no id throws
         before the guard is ever reached — so a suite that did that would go
         green with this guard deleted, and would report a CRASH rather than a
         clean failure. One thing wrong at a time, or the assertion proves the
         other thing. */
      const nameless = await makeLoan('nameless');
      const fresh = await oneCondition(nameless);
      const r = await write.markDone(nameless, fresh.id, null, true, cx);
      ok(r.ok === false, 'marking done with no signed-in staffer is refused');
      ok((await stampOf(fresh.id)).reviewed_at === null,
        '…and nothing was written — better no stamp than a timestamp nobody can act on');
    }

    console.log(`\n${pass} passed, ${fails.length} failed`);
    failed = fails.length > 0;
  } catch (e) {
    console.error('  ✗ threw:', (e && e.stack) || e);
    failed = true;
  } finally {
    await cx.query('ROLLBACK').catch(() => {});
    cx.release();
    await db.pool.end().catch(() => {});
  }
  process.exit(failed ? 1 : 0);
})();
