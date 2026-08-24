'use strict';
/**
 * LONG-TERM — the milestone LADDER, and the file STANDING at its last completed
 * step (db/623 + owner-directed 2026-08-24).
 *
 * Owner-reported 2026-08-23 (363 Birch Dr / YSCAP258134741): the file showed
 * "Funding" although Funding had COMPLETED. The owner's governing rule
 * (2026-08-24): *"every milestone has two different kinds of wording: before
 * it's completed and after it's completed. The name of the status in our system
 * should ALWAYS be the last milestone that is completed"* — so Birch STANDS at
 * Funding and is DISPLAYED as "Funded" (the completed wording), never as
 * "Investor Delivery" (a step that has not happened). The fixtures here are
 * Birch's REAL ladder shape (trimmed), captured live on 2026-08-24.
 *
 * What this proves:
 *   A. sittingOf — the one sentence: the LAST DONE step; nothing done → the
 *      first step; an empty ladder answers null; row order never changes it
 *   A2. completedFormLabel + milestoneKey — the two-wordings table (owner-stated
 *      spellings win; unknown milestones keep their own name) and the
 *      punctuation-blind join key (audit round 2, obs 4)
 *   B. rowFrom — the real v3 item shape, associate included; junk tolerated
 *   C. msStatusOf — the tenant's wording out of a fieldReader answer; a failed
 *      batch answers nulls (so the writer's COALESCE keeps what we hold)
 *   D. itemsOf — every envelope Encompass answers with
 *   E. (DB) writeLadder — mirror, idempotent re-run, ghost steps deleted, stamped
 *   F. (DB) ladderOne — the standing milestone lands on the loan (stage included),
 *      the observed clock records it, the wording lands, and a later read that
 *      could not see the wording NEVER blanks it
 *   G. (DB) discovery is FILL-ONLY on the milestone — the pipeline's lagging
 *      reading can never flip a laddered loan (the Birch churn)
 *   H. (DB) the backfill drains — a laddered loan leaves the due list
 *   I. (DB) realignStanding — a loan still holding the OLD first-not-done
 *      milestone is moved to the last-completed one with NO history event and
 *      the clock untouched; a second pass realigns nothing
 *
 * Mutation-proven (each reverted in a scratch copy; the suite went red):
 *   1. sittingOf back to first-NOT-done                 → A fails
 *   2. discovery milestone back to new-wins             → G fails
 *   3. writeLadder without the ghost delete             → E fails
 *   4. writeMsStatus writing plainly (no COALESCE)      → F fails (wording blanked)
 *   5. completedFormLabel returning the raw name always → A2 fails
 *   6. realignStanding emitting a history event per row  → I fails ("NO history
 *      event was written"). NOTE the faithful mutation INSERTS the event row
 *      directly — routing it through writeMilestone in the mutation crashed
 *      inside the per-loan catch and failed a DIFFERENT assertion (realigned=0),
 *      the crash-masked-mutation trap CLAUDE.md warns about.
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
  const stages = require('../src/longterm/stages');

  console.log('A. sittingOf — where the file STANDS (the last completed step)');
  const rows = BIRCH.map(ladder.rowFrom);
  eq(ladder.sittingOf(rows), 'Funding',
    'Birch: Funding done → the file STANDS at Funding (the last completed step), never at a step that has not happened');
  eq(ladder.sittingOf(rows.map((r) => ({ ...r, done: true }))), 'Completion',
    'every step done → the file stands at its LAST step (finished)');
  eq(ladder.sittingOf(rows.map((r) => ({ ...r, done: false }))), 'Started',
    'nothing done → the file stands at the first step (a file just born)');
  eq(ladder.sittingOf([]), null, 'an empty ladder answers null, never a guess');
  eq(ladder.sittingOf(null), null, 'no ladder at all answers null');
  // Rows handed back out of SQL arrive in any order; the answer must not move.
  eq(ladder.sittingOf([...rows].reverse()), 'Funding',
    'row order never changes the answer — position decides, not array order');

  console.log('A2. completedFormLabel + milestoneKey — the two wordings');
  eq(stages.completedFormLabel('Funding'), 'Funded', "Funding completed reads 'Funded' (the owner's own example)");
  eq(stages.completedFormLabel('LO Prep'), 'Assigned to Processor', "LO Prep completed reads 'Assigned to Processor' (the owner's own example)");
  eq(stages.completedFormLabel('Submittal'), 'Submitted', 'Submittal completed reads Submitted');
  eq(stages.completedFormLabel('Cond. Approval'), 'Conditionally Approved', 'Cond. Approval — punctuation-blind — reads Conditionally Approved');
  eq(stages.completedFormLabel('Clear To Close'), 'Clear to Close', "Clear To Close keeps the owner's stop wording");
  // AUDIT ROUND 3, D6: 'Sent to processing' is in Encompass's STOCK declared
  // list and was never once OBSERVED on this tenant (the 490-loan MS.STATUS
  // census in encompass/dropdowns.js), and MS.STATUS lags — so a per-milestone
  // sample of it is not evidence. Loan Setup keeps its own name and joins the
  // open owner questions.
  eq(stages.completedFormLabel('Loan Setup'), 'Loan Setup',
    'Loan Setup keeps its OWN name — its only evidence was a lagging, stock-contradicted sample (D6)');
  eq(stages.completedFormLabel('Started'), 'File started',
    'Started reads File started — one of the two wordings the live census actually OBSERVED');
  eq(stages.completedFormLabel('Completion'), 'Completed', 'Completion reads Completed');
  eq(stages.completedFormLabel('Investor Delivery'), 'Investor Delivery',
    'a milestone with NO proven completed wording keeps its own name — honest, never invented');
  eq(stages.completedFormLabel('  '), null, 'a blank name answers null, never an empty label');
  eq(stages.completedFormLabel(null), null, 'no name answers null');
  eq(stages.milestoneKey('Cond. Approval'), stages.milestoneKey('Cond Approval'),
    'milestoneKey is punctuation-blind — the obs-4 join fix');
  eq(stages.milestoneKey('  Clear  To  Close '), 'clear to close', 'whitespace collapses; case folds');

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

    console.log('F. ladderOne — the standing milestone lands, the wording lands, blanks never clear');
    const client = {
      getLoanMilestones: async () => BIRCH,
      fieldReader: async () => ({ 'MS.STATUS': 'Funded', 'MS.STATUSDATE': '08/23/2026 04:07:53 PM' }),
      configured: () => true,
    };
    const one = await ladder.ladderOne(loanId, guid, {}, { client, db });
    eq(one.ok, true, 'ladderOne runs');
    eq(one.sitting, 'Funding', 'it reports the STANDING milestone — the last completed step');
    let l = (await db.query('SELECT milestone_name, stage_key, ms_status, ms_status_date FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.milestone_name, 'Funding', 'the LOAN stands at Funding — displayed everywhere as "Funded"');
    eq(l.stage_key, 'funded', 'the stage groups off the STANDING milestone — the funded bucket');
    eq(l.ms_status, 'Funded', 'the tenant wording landed');
    eq(l.ms_status_date, '08/23/2026 04:07:53 PM', 'the stamp landed verbatim');
    const ev = await db.query(
      `SELECT to_milestone FROM lt_milestone_events WHERE loan_id = $1::uuid ORDER BY observed_at DESC LIMIT 1`, [loanId]);
    eq(ev.rows[0] && ev.rows[0].to_milestone, 'Funding', 'the observed clock recorded the standing step');
    // A later read whose fieldReader failed: the wording must SURVIVE.
    const blindClient = { ...client, fieldReader: async () => { throw new Error('batch failed'); } };
    await ladder.ladderOne(loanId, guid, {}, { client: blindClient, db });
    l = (await db.query('SELECT ms_status FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.ms_status, 'Funded', 'a read that could not see the wording never blanks it');

    console.log('G. discovery is FILL-ONLY on the milestone — the lagging form cannot flip a laddered loan');
    await loans.upsertDiscovered(db, {
      encompassLoanGuid: guid, loanNumber: 'TESTLADDER1', loanAmount: null,
      milestoneName: 'Investor Delivery', loanFolder: 'Pipeline', lastModified: new Date().toISOString(),
    }, {});
    l = (await db.query('SELECT milestone_name, stage_key FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(l.milestone_name, 'Funding', 'discovery saying "Investor Delivery" did NOT move the laddered standing');
    eq(l.stage_key, 'funded', 'nor the stage');
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
    await db.query('UPDATE lt_loans SET ladder_synced_at = now() WHERE id = $1::uuid', [loanId]);

    console.log('I. realignStanding — the book moves to last-completed with NO history event');
    // Put the loan back the way the OLD rule left every laddered loan: standing
    // on the first NOT-done step, clock stamped, history already written.
    await db.query(
      `UPDATE lt_loans SET milestone_name = 'Investor Delivery', stage_key = 'post_closing',
              milestone_since = '2026-08-23T23:07:53Z', milestone_since_is_baseline = false
        WHERE id = $1::uuid`, [loanId]);
    const evBefore = (await db.query(
      'SELECT count(*)::int AS n FROM lt_milestone_events WHERE loan_id = $1::uuid', [loanId])).rows[0].n;
    let ra = await ladder.realignStanding({ db, settings: {} });
    eq(ra.ok, true, 'realignStanding runs');
    ok(ra.realigned >= 1, 'the mis-standing loan was realigned');
    l = (await db.query(
      'SELECT milestone_name, stage_key, milestone_since, milestone_since_is_baseline FROM lt_loans WHERE id = $1::uuid',
      [loanId])).rows[0];
    eq(l.milestone_name, 'Funding', 'the loan now stands at the LAST COMPLETED step');
    eq(l.stage_key, 'funded', '…and its stage moved with it');
    eq(new Date(l.milestone_since).toISOString(), '2026-08-23T23:07:53.000Z',
      'the clock is UNTOUCHED — a re-definition of the same position is not a move');
    eq(l.milestone_since_is_baseline, false, '…and the baseline flag survives');
    const evAfter = (await db.query(
      'SELECT count(*)::int AS n FROM lt_milestone_events WHERE loan_id = $1::uuid', [loanId])).rows[0].n;
    eq(evAfter, evBefore, 'NO history event was written — no spurious backward "move" on the book');
    // Idempotent: a second pass finds this loan aligned and writes nothing.
    const before2 = (await db.query('SELECT updated_at FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0].updated_at;
    ra = await ladder.realignStanding({ db, settings: {} });
    eq(ra.ok, true, 'a second pass still runs');
    const after2 = (await db.query('SELECT updated_at FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0].updated_at;
    eq(String(after2), String(before2), 'an aligned loan is not touched again (IS DISTINCT FROM drains it)');
    // And the next ladderOne finds prior == next and records nothing new either.
    await ladder.ladderOne(loanId, guid, {}, { client, db });
    const evAfterOne = (await db.query(
      'SELECT count(*)::int AS n FROM lt_milestone_events WHERE loan_id = $1::uuid', [loanId])).rows[0].n;
    eq(evAfterOne, evBefore, 'the next ordinary sync sees prior == next — still no spurious event');

    // A PASS WHERE EVERY WRITE FAILED IS NOT A QUIET PASS (audit round 3, D5).
    // Same {realigned:0} either way, so the two must be told apart by `ok`.
    await db.query("UPDATE lt_loans SET milestone_name = 'Investor Delivery' WHERE id = $1::uuid", [loanId]);
    const brokenDb = {
      query: async (sql, params) => {
        if (/^\s*UPDATE lt_loans SET milestone_name/.test(sql)) throw new Error('write refused');
        return db.query(sql, params);
      },
    };
    const raFail = await ladder.realignStanding({ db: brokenDb, settings: {} });
    eq(raFail.ok, false, 'a pass whose every write was refused reports ok:false — never a silent success');
    ok(raFail.failed >= 1 && /refused/.test(raFail.reason || ''),
      '…and it says how many failed and why');
    // Put it back for the trash assertion below.
    await ladder.realignStanding({ db, settings: {} });

    // A TRASHED loan is not part of the book, so the realign leaves it alone.
    await db.query("UPDATE lt_loans SET milestone_name = 'Investor Delivery', loan_folder = '(Trash)' WHERE id = $1::uuid", [loanId]);
    const raTrash = await ladder.realignStanding({ db, settings: {} });
    eq(raTrash.ok, true, 'the realign still runs with a trashed loan present');
    const trashed = (await db.query('SELECT milestone_name FROM lt_loans WHERE id = $1::uuid', [loanId])).rows[0];
    eq(trashed.milestone_name, 'Investor Delivery', 'a TRASHED loan is not realigned — it is out of the book');
    await db.query("UPDATE lt_loans SET loan_folder = 'Pipeline' WHERE id = $1::uuid", [loanId]);
  } finally {
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loanId]).catch(() => {});
    await db.query("DELETE FROM lt_loans WHERE loan_number IN ('TESTLADDER1','TESTLADDER2')").catch(() => {});
  }

  console.log(`\nAll ${checks} checks passed.`);
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e && e.message); process.exit(1); });
