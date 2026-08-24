'use strict';
/**
 * LONG-TERM — the milestone LADDER, and the file SITTING in its next step (db/623).
 *
 * Owner-reported 2026-08-23 (363 Birch Dr / YSCAP258134741): the file showed
 * "Funding" although Funding had COMPLETED — *"it's sitting in the NEXT status,
 * waiting for that status to be completed."* The fixtures here are Birch's REAL
 * ladder shape (trimmed), captured live on 2026-08-24.
 *
 * What this proves:
 *   A. sittingOf — the one sentence: first not-done step; a finished file sits at
 *      its LAST step; an empty ladder answers null
 *   B. rowFrom — the real v3 item shape, associate included; junk tolerated
 *   C. msStatusOf — the tenant's wording out of a fieldReader answer; a failed
 *      batch answers nulls (so the writer's COALESCE keeps what we hold)
 *   D. itemsOf — every envelope Encompass answers with
 *   E. (DB) writeLadder — mirror, idempotent re-run, ghost steps deleted, stamped
 *   F. (DB) ladderOne — the sitting milestone lands on the loan (stage included),
 *      the observed clock records it, the wording lands, and a later read that
 *      could not see the wording NEVER blanks it
 *   G. (DB) discovery is FILL-ONLY on the milestone — the pipeline's lagging
 *      reading can never flip a laddered loan back (the Birch churn)
 *   H. (DB) the backfill drains — a laddered loan leaves the due list
 *
 * Mutation-proven (each reverted in a scratch copy; the suite went red):
 *   1. sittingOf ignoring `done` (first step always)   → A fails
 *   2. discovery milestone back to new-wins            → G fails
 *   3. writeLadder without the ghost delete            → E fails
 *   4. writeMsStatus writing plainly (no COALESCE)     → F fails (wording blanked)
 */

const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

// Birch's real ladder, trimmed to the shape that matters: thirteen done steps
// collapsed to two, the sitting step and the two planned ones kept verbatim.
const BIRCH = [
  { id: 'a', name: 'Started', doneIndicator: true, startDate: '2026-06-22T14:00:00Z', roleRequired: 'N' },
  {
    id: 'b',
    name: 'Funding',
    doneIndicator: true,
    startDate: '2026-08-23T23:07:53Z',
    roleRequired: 'Y',
    loanAssociate: {
      loanAssociateType: 'User',
      user: { entityId: 'tbrauner', entityName: 'Toby Brauner', entityType: 'User' },
      email: 'Toby@yscapgroup.com',
      phone: '718-635-0277',
      role: { entityId: '8', entityName: 'Funder', entityType: 'Role' },
    },
  },
  { id: 'c', name: 'Investor Delivery', doneIndicator: false, startDate: '2026-08-25T00:00:00Z' },
  { id: 'd', name: 'Completion', doneIndicator: false, startDate: '2026-09-29T00:00:00Z' },
];

async function main() {
  const ladder = require('../src/longterm/sync/milestone-ladder');

  console.log('A. sittingOf — where the file sits');
  const rows = BIRCH.map(ladder.rowFrom);
  eq(ladder.sittingOf(rows), 'Investor Delivery',
    'Birch: Funding done → the file sits in Investor Delivery, not Funding');
  eq(ladder.sittingOf(rows.map((r) => ({ ...r, done: true }))), 'Completion',
    'every step done → the file sits at its LAST step (finished)');
  eq(ladder.sittingOf(rows.map((r) => ({ ...r, done: false }))), 'Started',
    'nothing done → the file sits at the first step');
  eq(ladder.sittingOf([]), null, 'an empty ladder answers null, never a guess');
  eq(ladder.sittingOf(null), null, 'no ladder at all answers null');

  console.log('B. rowFrom — the real v3 item shape');
  const funding = ladder.rowFrom(BIRCH[1], 1);
  eq(funding.milestoneName, 'Funding', 'the step name');
  eq(funding.done, true, 'doneIndicator read');
  eq(funding.position, 1, 'the ladder order is the list order');
  eq(funding.associateId, 'tbrauner', 'the associate LOGIN — the people-map join key');
  eq(funding.associateName, 'Toby Brauner', 'the associate display name');
  eq(funding.associateRole, 'Funder', 'the associate ROLE — the persona ground truth');
  eq(funding.associateEmail, 'Toby@yscapgroup.com', 'the associate email');
  eq(funding.roleRequired, 'Y', 'roleRequired mirrored verbatim');
  const bare = ladder.rowFrom({ name: '  Docs Out  ', doneIndicator: 'yes' }, 3);
  eq(bare.milestoneName, 'Docs Out', 'names are trimmed');
  eq(bare.done, false, 'only a literal true reads as done — junk is not-done');
  eq(bare.associateId, null, 'no associate stays null, never an empty string');
  eq(ladder.rowFrom(null, 0).milestoneName, null, 'a null item does not throw');

  console.log('C. msStatusOf — the tenant wording out of the shared batch');
  const ms = ladder.msStatusOf({ 'MS.STATUS': 'Funded', 'MS.STATUSDATE': '08/23/2026 04:07:53 PM' });
  eq(ms.status, 'Funded', 'the wording (Birch, verified live)');
  eq(ms.date, '08/23/2026 04:07:53 PM', 'the stamp, VERBATIM — never parsed into a guess');
  eq(ladder.msStatusOf(null).status, null, 'a failed batch answers null (COALESCE keeps ours)');
  eq(ladder.msStatusOf({ 'MS.STATUS': '  ' }).status, null, 'a blank wording answers null');

  console.log('D. itemsOf — every envelope');
  eq(ladder.itemsOf(BIRCH).length, 4, 'a bare array');
  eq(ladder.itemsOf({ items: BIRCH }).length, 4, 'an items envelope');
  eq(ladder.itemsOf({ value: BIRCH }).length, 4, 'a value envelope');
  eq(ladder.itemsOf('nonsense').length, 0, 'junk answers empty, never throws');

  // ── The DB half ────────────────────────────────────────────────────────────
  if (!process.env.DATABASE_URL) {
    console.log(`\nNo DATABASE_URL — the pure half passed (${checks} checks); DB half skipped.`);
    return;
  }
  const db = require('../src/longterm/db');
  const loans = require('../src/longterm/sync/loans');

  const { rows: made } = await db.query(
    `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, milestone_name, stage_key)
     VALUES (gen_random_uuid(), 'test-ladder-' || gen_random_uuid(), 'TESTLADDER1', NULL, NULL)
     RETURNING id, encompass_loan_guid AS guid`,
  );
  const loanId = made[0].id;
  const guid = made[0].guid;

  try {
    console.log('E. writeLadder — mirror, idempotent, ghosts deleted, stamped');
    let w = await ladder.writeLadder(loanId, rows, { db });
    eq(w.ok, true, 'the ladder writes');
    let held = await db.query(
      'SELECT milestone_name, done, position, associate_role FROM lt_loan_milestones WHERE loan_id = $1::uuid ORDER BY position', [loanId]);
    eq(held.rows.length, 4, 'four steps mirrored');
    eq(held.rows[1].associate_role, 'Funder', 'the persona rides the step');
    w = await ladder.writeLadder(loanId, rows, { db });
    held = await db.query('SELECT count(*)::int AS n FROM lt_loan_milestones WHERE loan_id = $1::uuid', [loanId]);
    eq(held.rows[0].n, 4, 'a re-run is idempotent — still four rows');
    // A tenant rename: the ladder comes back without "Started".
    const renamed = rows.filter((r) => r.milestoneName !== 'Started');
    await ladder.writeLadder(loanId, renamed, { db });
    held = await db.query('SELECT milestone_name FROM lt_loan_milestones WHERE loan_id = $1::uuid ORDER BY position', [loanId]);
    eq(held.rows.length, 3, 'a step the ladder no longer carries is deleted — no ghosts');
    ok(!held.rows.some((r) => r.milestone_name === 'Started'), 'the deleted step is the right one');
    const stamped = await db.query('SELECT ladder_synced_at FROM lt_loans WHERE id = $1::uuid', [loanId]);
    ok(!!stamped.rows[0].ladder_synced_at, 'the loan is stamped laddered (the backfill drain key)');

    console.log('F. ladderOne — the sitting milestone lands, the wording lands, blanks never clear');
    const client = {
      getLoanMilestones: async () => BIRCH,
      fieldReader: async () => ({ 'MS.STATUS': 'Funded', 'MS.STATUSDATE': '08/23/2026 04:07:53 PM' }),
      configured: () => true,
    };
    const one = await ladder.ladderOne(loanId, guid, {}, { client, db });
    eq(one.ok, true, 'ladderOne runs');
    eq(one.sitting, 'Investor Delivery', 'it reports the sitting milestone');
    let l = (await db.query('SELECT milestone_name, stage_key, ms_status, ms_status_date FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.milestone_name, 'Investor Delivery', 'the LOAN now sits in Investor Delivery — the Birch fix');
    eq(l.stage_key, 'post_closing', 'the stage groups off the SITTING milestone');
    eq(l.ms_status, 'Funded', 'the tenant wording landed');
    eq(l.ms_status_date, '08/23/2026 04:07:53 PM', 'the stamp landed verbatim');
    const ev = await db.query(
      `SELECT to_milestone FROM lt_milestone_events WHERE loan_id = $1::uuid ORDER BY observed_at DESC LIMIT 1`, [loanId]);
    eq(ev.rows[0] && ev.rows[0].to_milestone, 'Investor Delivery', 'the observed clock recorded the sitting step');
    // A later read whose fieldReader failed: the wording must SURVIVE.
    const blindClient = { ...client, fieldReader: async () => { throw new Error('batch failed'); } };
    await ladder.ladderOne(loanId, guid, {}, { client: blindClient, db });
    l = (await db.query('SELECT ms_status FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.ms_status, 'Funded', 'a read that could not see the wording never blanks it');

    console.log('G. discovery is FILL-ONLY on the milestone — the lagging form cannot flip a laddered loan back');
    await loans.upsertDiscovered(db, {
      encompassLoanGuid: guid, loanNumber: 'TESTLADDER1', loanAmount: null,
      milestoneName: 'Funding', loanFolder: 'Pipeline', lastModified: new Date().toISOString(),
    }, {});
    l = (await db.query('SELECT milestone_name, stage_key FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.milestone_name, 'Investor Delivery', 'discovery saying "Funding" did NOT flip the sitting milestone back');
    eq(l.stage_key, 'post_closing', 'nor the stage');
    // And it still FILLS a blank — a brand-new discovery is not left milestone-less.
    const { rows: fresh } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number)
       VALUES (gen_random_uuid(), 'test-ladder-fresh-' || gen_random_uuid(), 'TESTLADDER2')
       RETURNING id, encompass_loan_guid AS guid`);
    await loans.upsertDiscovered(db, {
      encompassLoanGuid: fresh[0].guid, loanNumber: 'TESTLADDER2', loanAmount: null,
      milestoneName: 'LO Prep', loanFolder: 'Pipeline', lastModified: new Date().toISOString(),
    }, {});
    const f = (await db.query('SELECT milestone_name FROM lt_loans WHERE id = $1::uuid', [fresh[0].id])).rows[0];
    eq(f.milestone_name, 'LO Prep', 'a blank milestone is still FILLED by discovery');
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [fresh[0].id]);

    console.log('H. the backfill drains — a laddered loan leaves the due list');
    const due = await ladder._internals.ladderDue(db, 5000);
    ok(!due.some((r) => String(r.id) === String(loanId)), 'the laddered loan is no longer due');
    await db.query('UPDATE lt_loans SET ladder_synced_at = NULL WHERE id = $1::uuid', [loanId]);
    const due2 = await ladder._internals.ladderDue(db, 5000);
    ok(due2.some((r) => String(r.id) === String(loanId)), 'clearing the stamp puts it back — the drain key is real');
  } finally {
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    await db.query("DELETE FROM lt_loans WHERE loan_number IN ('TESTLADDER1','TESTLADDER2')").catch(() => {});
  }

  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });
