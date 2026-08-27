'use strict';
/**
 * LONG-TERM — THE CREATE CUTOFF IS ABSOLUTE. IT NEVER REACHES BACKWARDS.
 *
 * Owner-directed 2026-08-27, after PILOT created SIX DUPLICATE ClickUp cards on
 * closed historical loans: *"stick to the original date that we set the rule so
 * that it doesn't go backwards."*
 *
 * THE INCIDENT THIS EXISTS TO PREVENT. A change added a second way into
 * `createCandidates` — "or the loan has finished LO Prep" — OR'd alongside the
 * date. That looked additive and safe. It was not, for a reason the query does
 * not say out loud:
 *
 *   `lt_loans.clickup_task_id IS NULL` does NOT mean "this loan has no card in
 *   ClickUp". It means "PILOT is not HOLDING A LINK to the card this loan may
 *   already have." Matching a loan to its existing card is a SEPARATE pass
 *   (link.js). So the create pass's own duplicate guard only ever protected
 *   loans PILOT had ALREADY LINKED — never the unlinked ones, which are exactly
 *   the population at risk.
 *
 * `created_at >= LT_CLICKUP_CREATE_SINCE` is therefore doing TWO jobs, and only
 * one of them is written on its face. The stated one is the go-live guard. The
 * unstated one — the load-bearing one — is that it keeps the entire UNLINKED
 * HISTORICAL BOOK out of the create pass. Every closed deal ever done is past
 * LO Prep, so widening on a milestone pointed the pass straight at loans that
 * already had cards, and it minted fresh duplicates.
 *
 * THE RULE, and it is not negotiable without the owner's own words: a loan PILOT
 * DISCOVERED before the cutoff is NEVER given a card by the automatic pass, in
 * any state, however far along it is, however it is milestoned, linked or not.
 * A human may still create one deliberately (routes/clickup.js) — that is a
 * person looking at a specific file, which is how the reported Syracuse file was
 * fixed, and it is not this pass.
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS. The test that FAILED to catch the
 * incident asserted "never a second card" against a loan whose clickup_task_id
 * was ALREADY SET — the one case that was never at risk. So this one asserts the
 * opposite way round: it stages the shapes that actually tempted the change and
 * requires the answer to be NO for every one of them. A future widening has to
 * make all of these pass, which it cannot do without breaking the rule.
 */
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const push = require('../src/longterm/clickup/push');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const CUT = '2026-08-24';

(async () => {
  const tag = `cut${Math.random().toString(36).slice(2, 8)}`;
  try {
    await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-clickup-create-cutoff');
    await ensureSchema();

    /* THE FIXTURES CARRY WHAT A REAL LOAN CARRIES. An earlier cut left stage_key
       and milestone_name NULL, and a mutation widening on `stage_key IS NOT NULL`
       therefore selected nothing and the suite passed — a guard that only holds
       for the columns its fixtures happen to populate is not a guard. A real
       closed loan has both, so these do too. */
    const mk = async (suffix, createdAt, linked, stage, milestone) => (await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name,
                             encompass_synced_at, created_at, clickup_task_id,
                             stage_key, milestone_name)
       VALUES (gen_random_uuid(), $1, $2, 'Cutoff Test', now(), $3, $4, $5, $6) RETURNING id`,
      [`${tag}-${suffix}`, `${tag}-${suffix}`, createdAt, linked || null,
       stage || 'closed', milestone || 'Funded'])).rows[0].id;
    const ms = (id, name, done) => db.query(
      `INSERT INTO lt_loan_milestones (loan_id, milestone_name, done) VALUES ($1,$2,$3)`, [id, name, done]);

    const picked = async () => (await push.createCandidates({ scan: 20000, since: CUT }))
      .rows.map((r) => r.loan_number).filter((n) => String(n || '').startsWith(`${tag}-`));

    console.log('\nA. the six shapes that were actually duplicated — all discovered before the cutoff');
    /* These mirror the real incident: closed / PA-issued 2025-early-2026 deals
       that already had cards in ClickUp while PILOT held no link to them. PILOT
       cannot see the far side, so the DATE is the only thing standing between
       the pass and a duplicate. */
    const closed = await mk('CLOSED', '2026-03-11');
    await ms(closed, 'LO Prep', true); await ms(closed, 'Funded', true);
    const pa = await mk('PA', '2025-11-02');
    await ms(pa, 'LO Prep', true); await ms(pa, 'Purchased', true);
    const midway = await mk('MIDWAY', '2026-08-13');
    await ms(midway, 'LO Prep', true);
    const started = await mk('STARTED', '2026-08-13');
    await ms(started, 'Started', true);
    const noLadder = await mk('NOLADDER', '2026-01-05');
    const everything = await mk('EVERYTHING', '2025-06-01');
    for (const n of ['Started', 'LO Prep', 'Submittal', 'Cond Approval', 'Clear to Close', 'Funded', 'Purchased', 'Final Docs']) await ms(everything, n, true);

    const got = await picked();
    ok(!got.includes(`${tag}-CLOSED`), 'A1 a CLOSED historical loan is never given a card (the incident shape)');
    ok(!got.includes(`${tag}-PA`), 'A2 nor a PA-issued one');
    ok(!got.includes(`${tag}-MIDWAY`), 'A3 nor one that finished LO Prep before the cutoff');
    ok(!got.includes(`${tag}-STARTED`), 'A4 nor one still starting');
    ok(!got.includes(`${tag}-NOLADDER`), 'A5 nor one with no ladder at all');
    ok(!got.includes(`${tag}-EVERYTHING`), 'A6 nor one with EVERY milestone finished');
    ok(got.length === 0, `A7 NOT ONE pre-cutoff loan is selected, in any state (selected: ${JSON.stringify(got)})`);

    console.log('\nB. the go-live rule still does its stated job');
    await mk('NEW', '2026-08-25');
    ok((await picked()).includes(`${tag}-NEW`), 'B1 a loan discovered after the cutoff is still selected');
    await mk('ONCUT', CUT);
    ok((await picked()).includes(`${tag}-ONCUT`), 'B2 the boundary is inclusive — discovered ON the cutoff day counts');

    console.log('\nC. an already-linked loan is never a candidate, whenever it was discovered');
    await mk('LINKED', '2026-08-25', 'task-abc');
    ok(!(await picked()).includes(`${tag}-LINKED`), 'C1 a loan PILOT already linked is never re-created');

    console.log('\nD. the guarantee, stated as one property');
    const rows = (await push.createCandidates({ scan: 20000, since: CUT })).rows;
    const older = rows.filter((r) => r.created_at && new Date(r.created_at) < new Date(CUT));
    ok(older.length === 0,
      `D1 ACROSS THE WHOLE BOOK, not just this suite's fixtures: the pass returns nothing discovered before the cutoff (${older.length} would-be duplicates)`);

    console.log('\nE. the cutoff is ANDed — structurally, not just by today\'s fixtures');
    /* A behavioural guard can only catch a widening on a column its fixtures
       populate. This one catches the SHAPE: the incident was an `OR` placed
       beside the date, and any future one would have to be too. Read from the
       function's own source so it cannot drift from what actually runs. */
    const src = require('fs').readFileSync(require.resolve('../src/longterm/clickup/push.js'), 'utf8');
    const body = (src.split('async function createCandidates')[1] || '').split('\n}')[0];
    ok(/AND l\.created_at >= \$2::date/.test(body),
      'E1 the create query still ANDs the cutoff');
    ok(!/\bOR\b/i.test(body.split('WHERE')[1] || ''),
      'E2 and nothing in its WHERE is OR\'d past it — the incident was exactly such an OR');
  } catch (e) {
    fail++; console.error('  FAIL threw:', e.message);
  } finally {
    try { await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE $1`, [`${tag}-%`]); } catch (_) { /* best-effort */ }
  }
  console.log(fail ? `\n${fail} failing` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
