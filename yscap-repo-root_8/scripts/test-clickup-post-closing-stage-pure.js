#!/usr/bin/env node
'use strict';
/* THE CARD FOLLOWS THE FILE AFTER CLOSING — src/clickup/post-closing-stage.js
 * ---------------------------------------------------------------------------
 * Owner-directed 2026-08-21: *"Connect the statuses of our system to ClickUp: when we
 * update our loan as funded, ClickUp updates as closed. When we mark our system investor
 * delivered, ClickUp changes to in purchase review. When we mark it as sold and you get the
 * PA date from Encompass … the status in ClickUp also needs to be changed to waiting for
 * final documents. Please do research on each navigation status to make sure it exists."*
 *
 * WHY A TEST AND NOT JUST THE CODE. Three of the four things that can go wrong here are
 * SILENT: a stage ClickUp does not carry is refused by ClickUp from inside a best-effort
 * caller and nothing on any screen says so; a card dragged BACKWARDS looks like a card
 * somebody moved; and a stage pushed onto a file that has not funded moves the word the
 * BORROWER sees, by a side door, with no email and no audit anybody would think to read.
 * Each of those is pinned below.
 *
 * Pure — no database, no ClickUp, no network.
 * Run: node scripts/test-clickup-post-closing-stage-pure.js
 */
const fs = require('fs');
const path = require('path');

const S = require('../src/clickup/post-closing-stage');
const statusMap = require('../src/clickup/status');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${label}`); } };
const eq = (label, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) pass++; else { fail++; console.log(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/* ================================================================= *
 * A. The stages EXIST — the half the owner asked for by name         *
 * ================================================================= */
eq('A1 every stage is a status this system knows', S.verifyStages(), []);
for (const [event, stage] of Object.entries(S.STAGE_FOR)) {
  ok(`A2 ${event} → "${stage}" is a real ClickUp status`, statusMap.isKnownInternal(stage));
  ok(`A3 …and reads back to the SAME borrower word, so an automatic push cannot move it`,
    statusMap.externalFor(stage) === 'funded');
}
/* THE INSTRUCTION'S OWN WORDING IS NOT A STATUS. The owner wrote "waiting for final
   documents"; the list carries "waiting for final docs". ClickUp refuses a status a list
   does not have, so taking the instruction verbatim would have failed every push — which
   is precisely what "make sure it exists" was asking about. */
ok('A4 the owner\'s phrasing "waiting for final documents" is NOT a status',
  !statusMap.isKnownInternal('waiting for final documents'));
eq('A5 …and the stage used is the list\'s own spelling', S.STAGE_FOR.sold, 'waiting for final docs');

/* ================================================================= *
 * B. The ladder is ClickUp's own order (read live 2026-08-21)         *
 * ================================================================= */
// orderindex 25 / 32 / 33 / 34 / 35 / 36 / 37 on the Loan Pipeline lists.
eq('B1 the ladder is the post-closing sequence, in order', S.LADDER, [
  'closed (6-email funded)',
  'in purchase review',
  'purchase conditions',
  'pa issued-post closing.',
  'waiting for final docs',
  'non del closed reconciled',
  'closed reconciled',
]);
ok('B2 funded comes before purchase review', S.ladderIndex(S.STAGE_FOR.funded) < S.ladderIndex(S.STAGE_FOR.investor_delivered));
ok('B3 purchase review comes before waiting for final docs', S.ladderIndex(S.STAGE_FOR.investor_delivered) < S.ladderIndex(S.STAGE_FOR.sold));
ok('B4 a status that is not post-closing is not on the ladder', S.ladderIndex('in underwriting') === -1);
ok('B5 the ladder is matched case/space-insensitively, like every other status compare',
  S.ladderIndex('  In Purchase Review ') === S.ladderIndex('in purchase review'));
/* RECONCILED IS ON THE LADDER BUT IS NEVER A TARGET — the owner carved reconciliation out
   ("it should still not be reconciled"). It is listed so a card already there is left
   alone, never so something can push it. */
ok('B6 nothing here ever targets a reconciled stage',
  !Object.values(S.STAGE_FOR).some((v) => /reconciled/.test(v)));

/* ================================================================= *
 * C. What happens to a card — every branch                           *
 * ================================================================= */
const FUNDED_CARD = { status: 'funded', internal_status: 'closed (6-email funded)', deleted_at: null };
const PRE_CLOSE = { status: 'underwriting', internal_status: 'in underwriting', deleted_at: null };

eq('C1 an unknown event does nothing', S.decideStage(FUNDED_CARD, 'nonsense').skipped, 'unknown_event');
eq('C2 no file does nothing', S.decideStage(null, 'funded').skipped, 'no_file');
eq('C3 a deleted file does nothing',
  S.decideStage({ ...FUNDED_CARD, deleted_at: new Date() }, 'investor_delivered').skipped, 'deleted');
for (const st of ['declined', 'withdrawn']) {
  eq(`C4 a ${st} file is left entirely alone — that is a human's contradiction`,
    S.decideStage({ status: st, internal_status: st, deleted_at: null }, 'funded').skipped, 'terminal_negative');
}

// The happy paths.
{
  const p = S.decideStage(PRE_CLOSE, 'funded');
  ok('C5 a file that just funded moves onto the funded stage', p.push === true && p.stage === 'closed (6-email funded)');
  const q = S.decideStage(FUNDED_CARD, 'investor_delivered');
  ok('C6 a funded file whose tape went out moves to purchase review', q.push === true && q.stage === 'in purchase review');
  const r = S.decideStage({ status: 'funded', internal_status: 'in purchase review', deleted_at: null }, 'sold');
  ok('C7 …and a purchase advice moves it on to waiting for final docs', r.push === true && r.stage === 'waiting for final docs');
}

// Idempotence + never backwards.
eq('C8 a card already on the stage is not re-pushed (re-firing the funded stage would re-send its ClickUp email)',
  S.decideStage(FUNDED_CARD, 'funded').skipped, 'already_there');
eq('C9 a card further along is NEVER dragged back',
  S.decideStage({ status: 'funded', internal_status: 'waiting for final docs', deleted_at: null }, 'investor_delivered').skipped,
  'already_past');
eq('C10 …including from a reconciled stage, which nothing may disturb',
  S.decideStage({ status: 'funded', internal_status: 'closed reconciled', deleted_at: null }, 'sold').skipped,
  'already_past');

/* THE SIDE DOOR THIS CLOSES. `in purchase review` and `waiting for final docs` both read
   back as the borrower-facing word `funded`. Pushed onto a file still in underwriting they
   would move what the borrower sees, with no status email and nothing on the screen saying
   why — so both refuse until the file has actually funded. `funded` itself is exempt: its
   caller has just established that fact. */
eq('C11 a pre-closing file is not jumped to purchase review by a tape',
  S.decideStage(PRE_CLOSE, 'investor_delivered').skipped, 'not_funded_yet');
eq('C12 …nor to waiting for final docs by a purchase advice',
  S.decideStage(PRE_CLOSE, 'sold').skipped, 'not_funded_yet');
ok('C13 …but the funded event itself is allowed to move a pre-closing file',
  S.decideStage(PRE_CLOSE, 'funded').push === true);

/* ================================================================= *
 * D. The three callers go through this ONE module                    *
 * ================================================================= */
{
  const funded = read('src/lib/encompass-funded.js');
  ok('D1 the Encompass funded reader moves the card', /post-closing-stage'\)[\s\S]{0,120}advanceCard\(appId, 'funded'/.test(funded));
  ok('D2 …only when the status actually moved, so a re-read never re-fires the ClickUp email',
    /if \(statusMoved\) \{[\s\S]{0,700}advanceCard\(appId, 'funded'/.test(funded));

  const tape = read('src/lib/tapes/investor-send.js');
  ok('D3 sending the tape moves the card', /advanceCard\(appId, 'investor_delivered'/.test(tape));
  ok('D4 …AFTER the email is actually sent, so the card never claims a delivery that failed',
    tape.indexOf('advanceCard') > tape.indexOf('await email.sendMail('));

  const pa = read('src/sitewire/release-party.js');
  ok('D5 a purchase advice date moves the card', /advanceCard\(appId, 'sold'/.test(pa));
  ok('D6 …only when the date CHANGED, so a re-read of the same date never re-pushes',
    /if \(changed && paDate\) \{[\s\S]{0,900}advanceCard\(appId, 'sold'/.test(pa));

  // A hard-coded stage string in a caller is a second definition waiting to drift from the
  // live list — and a drifted one is a push ClickUp silently refuses.
  for (const [f, body] of [['encompass-funded.js', funded], ['investor-send.js', tape], ['release-party.js', pa]]) {
    ok(`D7 ${f} names no ClickUp stage of its own`,
      !/['"](closed \(6-email funded\)|in purchase review|waiting for final docs)['"]/.test(body));
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
