'use strict';
/**
 * LT test — A MILESTONE MOVE IS NOTICED, EVEN THOUGH ENCOMPASS'S CLOCK DOES NOT MOVE.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-25, YSCAP258134720, 19 Lincoln St):
 * *"for this file, I updated the status already 30 minutes ago, and it was not
 * updated... We need to make this shit happen immediately because we have the
 * webhooks."*
 *
 * TWO THINGS WERE TRUE AT ONCE, AND BOTH WERE MEASURED RATHER THAN GUESSED.
 *
 * 1. THE WEBHOOK HAS NEVER FIRED. Seven days of the deployment's own logs contain
 *    exactly two `[lt-encompass-hook]` lines, and both are test pings sent by hand
 *    from this session. The endpoint is alive and correctly refuses an
 *    unauthenticated POST with 403. Encompass simply never calls it — so the
 *    five-minute discovery sweep is not a backstop, it is the ONLY mechanism.
 *
 * 2. AND THAT SWEEP WAS BLIND TO THE ONE THING IT MOST NEEDED TO SEE. Live, at
 *    16:01Z, for that loan:
 *
 *        Encompass pipeline   milestone "Clear To Close"
 *                             Loan.LastModified "8/25/2026 8:30:05 AM"
 *        PILOT                milestone_name "Submittal"
 *                             encompass_synced_at 13:02:27Z (= 9:02 AM tenant time)
 *
 *    The stamp is converted correctly — 8:30 AM tenant time IS 12:30:05Z. It simply
 *    never moved: the milestone was completed HOURS after 8:30 AM and LastModified
 *    still read 8:30 AM. **Completing a milestone does not touch this tenant's
 *    LastModified.** Every freshness test compared stamps, so the move was invisible
 *    to all of them, and the file would have waited the full twelve-hour rota.
 *
 * THE FIX COSTS NO EXTRA CALL. Discovery has always asked the pipeline for
 * `Loan.CurrentMilestoneName` and always thrown it away. Now a disagreement between
 * what the pipeline reports and what we last established IS the trigger.
 *
 * SECTION 4 IS THE HALF THAT OUTLIVES THIS PARTICULAR LOAN. The obvious version of
 * this rule — compare the two strings — re-reads all 722 loans every five minutes,
 * because the two sides say the same step differently on purpose ("Submittal" vs
 * "Submitted"). That is a self-inflicted denial of service against a call budget
 * shared with every other integration on this tenant, so it is pinned here.
 *
 * PURE. No database, no network.
 */

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const loans = require('../src/longterm/sync/loans');
const { needsRead, sameMilestone } = loans;

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-08-25T16:01:00Z');
const ago = (h) => new Date(NOW - h * HOUR).toISOString();

// ── 1. The reported loan, reproduced exactly ────────────────────────────────
console.log('\n1. YSCAP258134720, as it actually stood at 16:01Z');

// Everything here is the measured row: read at 13:02Z, Encompass's stamp 12:30:05Z
// (8:30:05 AM tenant time), our milestone "Submittal", the pipeline's "Clear To Close".
const LINCOLN = {
  encompass_synced_at: '2026-08-25T13:02:27.355Z',
  encompass_last_modified: '2026-08-25T12:30:05.000Z',
  milestone_name: 'Submittal',
  pipeline_milestone: 'Clear To Close',
};

check(needsRead(LINCOLN, NOW) === true,
  'THE ONE THAT MATTERS: the file is due, because the pipeline says Clear To Close and we hold Submittal');

// And the proof that the old rule could not have said so.
const stampsOnly = { ...LINCOLN };
delete stampsOnly.pipeline_milestone;
check(needsRead(stampsOnly, NOW) === false,
  '...and on the stamps ALONE it is not due — which is exactly why it sat for hours');
check(Date.parse(LINCOLN.encompass_last_modified) < Date.parse(LINCOLN.encompass_synced_at),
  'because Encompass\'s own last-modified is OLDER than our last read, hours after the milestone moved');

// ── 2. The trigger fires on a move, and only on a move ──────────────────────
console.log('\n2. it speaks when the file moved, and stays quiet when it did not');

const settled = (pipeline, stored) => ({
  encompass_synced_at: ago(2), encompass_last_modified: ago(3),
  milestone_name: stored, pipeline_milestone: pipeline,
});

check(needsRead(settled('Clear To Close', 'Submittal'), NOW) === true, 'a real move is due');
check(needsRead(settled('Submittal', 'Submittal'), NOW) === false, 'the same milestone is not');
check(needsRead(settled(null, 'Submittal'), NOW) === false,
  'a pass that could not read the milestone says nothing rather than crying wolf');
check(needsRead(settled('Clear To Close', null), NOW) === false,
  'and a loan with no settled milestone is left to the other tests — it is already due for being unread');

// ── 3. The other rules still work ───────────────────────────────────────────
console.log('\n3. nothing that already worked stopped working');

check(needsRead({ encompass_synced_at: null }, NOW) === true, 'a never-read loan is due');
check(needsRead({ encompass_synced_at: ago(13), encompass_last_modified: null }, NOW) === true,
  'the twelve-hour rota still applies');
check(needsRead({ encompass_synced_at: ago(2), encompass_last_modified: ago(1) }, NOW) === true,
  'a stamp genuinely newer than our read is still due');
check(needsRead({ encompass_synced_at: ago(2), encompass_sync_error: 'came back empty' }, NOW) === true,
  'a partly-read loan still comes back on the short rota');
check(needsRead({ encompass_synced_at: ago(2), encompass_last_modified: ago(3) }, NOW) === false,
  'and an ordinary settled loan is still left alone');

// ── 4. THE HALF THAT OUTLIVES THIS LOAN ─────────────────────────────────────
// The naive rule — compare the strings — re-reads the whole book every five minutes,
// because the two sides deliberately say the same step differently.
console.log('\n4. the same step said two ways is not a move');

check(typeof sameMilestone === 'function', 'the comparison is exported so it can be held to this');
check(sameMilestone('Clear To Close', 'Submittal') === false, 'two genuinely different steps disagree');
check(sameMilestone('  clear to close  ', 'Clear To Close') === true, 'spacing and case are not a move');
check(sameMilestone(null, 'Submittal') === true, 'an unknown is not a disagreement');
check(sameMilestone('', 'Submittal') === true, 'nor is a blank');

// THE TRAP THE FIRST VERSION FELL INTO, PINNED SO IT CANNOT COME BACK.
// Comparing STAGES instead of names looks safer and is strictly worse: three of the
// busiest milestones in this book all map to `post_closing`, so a file moving
// between them would compare EQUAL and never be re-read.
const POST_CLOSING = ['Final Docs', 'Investor Delivery', 'Purchasing Conditions'];
for (const a of POST_CLOSING) {
  for (const b of POST_CLOSING) {
    if (a === b) continue;
    check(sameMilestone(a, b) === false,
      `${a} -> ${b} is a MOVE, even though both map to the same stage`);
  }
}
check(loans.stageFor('Final Docs', {}).stageKey === loans.stageFor('Investor Delivery', {}).stageKey,
  '...and they really do share a stage, which is why comparing stages would have been silently blind');

// ── 5. THE MEASUREMENT THIS RULE WAS BUILT FROM ─────────────────────────────
// Seventeen real loans, one per distinct milestone in the book, probed live on
// 2026-08-25. Recorded here so the rule is held to the data rather than to a story
// about the data.
console.log('');
const MEASURED = [
  ['YSCAP258134734', 'Schedule Closing', 'Clear To Close', 'move'],
  ['YSCAP00125081491', 'Closed', 'Closed', 'settled'],
  ['YSCAP00125070791', 'Completion', 'Completion', 'settled'],
  ['YSCAP00125070391', 'Cond. Approval', 'Cond. Approval', 'settled'],
  ['YSCAP202526115', 'Docs Out', 'Docs Out', 'settled'],
  ['YSCAP202526114', 'Final Docs', 'Final Docs', 'settled'],
  ['YSCAP258134092', 'Funding', 'Funding', 'settled'],
  ['YSCAP202526104', 'Investor Delivery', 'Investor Delivery', 'settled'],
  ['YSCAP258134344', 'LO Prep', 'LO Prep', 'settled'],
  ['YSCAP20252659', 'Loan Setup', 'Loan Setup', 'settled'],
  ['YSCAP00125063091', 'Purchasing Conditions', 'Purchasing Conditions', 'settled'],
  ['YSCAP258134063', null, 'Ready for Docs', 'silent'],
  ['YSCAP20252671', 'Final Docs', 'Final Docs', 'settled'],
  ['YSCAP258134448', 'Schedule Closing', 'Schedule Closing', 'settled'],
  ['180800002', null, 'Started', 'silent'],
  ['YSCAP00125080691', 'Submittal', 'Started', 'move'],
  ['YSCAP00525081191', 'Waiting for Docs', 'Waiting for Docs', 'settled'],
];
let moves = 0; let quiet = 0; let wrong = 0;
for (const [ln, pipeline, stored, expect] of MEASURED) {
  const row = { encompass_synced_at: ago(2), encompass_last_modified: ago(3),
    milestone_name: stored, pipeline_milestone: pipeline };
  const due = needsRead(row, NOW);
  if (expect === 'move') { moves += 1; if (!due) { wrong += 1; console.error(`       ${ln} should be due`); } }
  else { quiet += 1; if (due) { wrong += 1; console.error(`       ${ln} should NOT be due (${expect})`); } }
}
check(wrong === 0, `all 17 measured loans behave as measured — ${moves} due, ${quiet} left alone`);
check(moves === 2 && quiet === 15, 'and the split is the one that was actually observed: 2 stale, 15 quiet');

// ── 6. The pathological case has a ceiling ──────────────────────────────────
console.log('');
const justRead = { encompass_synced_at: new Date(NOW - 2 * 60 * 1000).toISOString(),
  encompass_last_modified: ago(3), milestone_name: 'Submittal', pipeline_milestone: 'Clear To Close' };
check(needsRead(justRead, NOW) === false,
  'a loan read two minutes ago does NOT re-trigger on the same disagreement — a loan that never settles cannot spin every five minutes');
const readEarlier = { ...justRead, encompass_synced_at: new Date(NOW - 30 * 60 * 1000).toISOString() };
check(needsRead(readEarlier, NOW) === true,
  '...but half an hour later it is due again, so a real move is never lost');

// The whole book, at rest, must cost nothing.
console.log('');
const BOOK = ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Approved', 'Waiting for Docs',
  'Clear To Close', 'Doc Prep', 'Funding', 'Final Docs', 'Investor Delivery', 'Purchasing Conditions'];
let churn = 0;
for (const m of BOOK) if (needsRead(settled(m, m), NOW)) churn += 1;
check(churn === 0, `a settled book triggers NO re-reads (${BOOK.length} milestones checked, ${churn} would churn)`);

// ── 7. THE WIRING, PINNED ───────────────────────────────────────────────────
// Every section above builds its rows by hand, so all of them would keep passing
// if `upsertDiscovered` stopped carrying the pipeline's milestone out — and the
// trigger would silently never fire again. Mutation testing found exactly that
// hole, which is the same shape as every other defect in this run: a green report
// about a mechanism that is no longer connected.
console.log('\n7. the pipeline milestone is actually wired through');

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/loans.js'), 'utf8');

const upsertAt = SRC.indexOf('async function upsertDiscovered');
const upsertEnd = SRC.indexOf('\n}', SRC.indexOf('RETURNING id', upsertAt));
const UPSERT = SRC.slice(upsertAt, upsertEnd);
check(upsertAt > 0 && upsertEnd > upsertAt,
  'upsertDiscovered was located — a rename must fail this loudly, not stop checking');
check(/pipeline_milestone:/.test(UPSERT),
  'upsertDiscovered hands the pipeline milestone back to its caller');
check(/RETURNING id[^`]*milestone_name/.test(UPSERT),
  '...and the row it returns carries the milestone we already hold, to compare it against');

const needsAt = SRC.indexOf('function needsRead(');
const needsEnd = SRC.indexOf('\n}', SRC.indexOf('return modified > synced', needsAt));
const NEEDS = SRC.slice(needsAt, needsEnd);
check(/row\.pipeline_milestone/.test(NEEDS), 'needsRead reads it');
check(/sameMilestone\(/.test(NEEDS), '...and compares it rather than assuming');

// And the caller must actually hand needsRead the row the upsert produced.
// LOOKED FOR AT THE CALL SITE, NOT ANYWHERE IN THE FILE: `needsRead(row` also
// matches this function's own DECLARATION, so a loose search here passes even when
// the sweep has stopped passing the row — which is exactly what a mutation proved.
const sweepAt = SRC.indexOf('const row = await upsertDiscovered(');
const SWEEP = sweepAt > 0 ? SRC.slice(sweepAt, sweepAt + 600) : '';
check(sweepAt > 0, 'the sweep still calls upsertDiscovered');
check(/needsRead\(row[,)]/.test(SWEEP),
  'the sweep passes the upsert\'s own row straight into needsRead — no copy in between to drop the field');

// Discovery must still ASK Encompass for the milestone, or there is nothing to carry.
// CHECKED INSIDE THE FIELD LIST, for the same reason: the same string appears again
// where the answer is read, so searching the whole file passes even with the field
// removed from the request.
const DISCOVER = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/discover.js'), 'utf8');
const fieldsAt = DISCOVER.indexOf('const DISCOVERY_FIELDS = [');
const FIELDS = fieldsAt > 0 ? DISCOVER.slice(fieldsAt, DISCOVER.indexOf('];', fieldsAt)) : '';
check(fieldsAt > 0, 'the discovery field list was located');
check(/'Loan\.CurrentMilestoneName'/.test(FIELDS),
  'discovery still ASKS the pipeline for the current milestone — the whole trigger is free only because this was already being fetched');
check(/'Loan\.CurrentMilestoneName'/.test(DISCOVER.slice(fieldsAt + FIELDS.length)),
  '...and still reads it off the answer');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
