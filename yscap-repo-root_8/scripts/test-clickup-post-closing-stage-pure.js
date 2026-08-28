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
/* THE INSTRUCTION'S OWN WORDING IS NOT A STATUS. The owner's opening message wrote
   "waiting for final documents"; no list carries that. ClickUp refuses a status a list
   does not have, so taking an instruction verbatim would have failed every push — which
   is precisely what "make sure it exists" was asking about. Kept even though the sold
   event no longer targets that rung: the LESSON is the guard, not the stage. */
ok('A4 the owner\'s phrasing "waiting for final documents" is NOT a status',
  !statusMap.isKnownInternal('waiting for final documents'));

/* THE SOLD EVENT LANDS ON `pa issued-post closing.` — the owner's OWN CORRECTION once the
   ladder was in front of them: *"Sold (PA date from Encompass) … should update in ClickUp
   as pa issued-post closing."* THE TRAILING FULL STOP IS PART OF THE NAME, not a sentence
   ending — dropping it makes a status no list carries, so it is pinned literally here and
   proven against the shared map by A2 above. */
eq('A5 a purchase advice lands on the purchase-advice stage', S.STAGE_FOR.sold, 'pa issued-post closing.');
ok('A5b …spelled with its trailing full stop, exactly as ClickUp stores it',
  S.STAGE_FOR.sold.endsWith('.') && statusMap.isKnownInternal(S.STAGE_FOR.sold));
ok('A5c …and dropping that full stop would be a status ClickUp does not carry',
  !statusMap.isKnownInternal('pa issued-post closing'));

/* AND IT IS EARLIER THAN THE RUNG THIS ORIGINALLY USED, which is what makes the correction
   safe on a live file: `waiting for final docs` stays on the ladder, so a card a human has
   already moved there is refused as `already_past` rather than dragged back. */
ok('A5d the purchase-advice stage sits BEFORE waiting for final docs on the ladder',
  S.ladderIndex(S.STAGE_FOR.sold) < S.ladderIndex('waiting for final docs'));

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
ok('B3 purchase review comes before the purchase-advice stage', S.ladderIndex(S.STAGE_FOR.investor_delivered) < S.ladderIndex(S.STAGE_FOR.sold));
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
  ok('C7 …and a purchase advice moves it on to the PA-issued stage', r.push === true && r.stage === 'pa issued-post closing.');
}

// Idempotence + never backwards.
eq('C8 a card already on the stage is not re-pushed (re-firing the funded stage would re-send its ClickUp email)',
  S.decideStage(FUNDED_CARD, 'funded').skipped, 'already_there');
eq('C9 a card further along is NEVER dragged back',
  S.decideStage({ status: 'funded', internal_status: 'waiting for final docs', deleted_at: null }, 'investor_delivered').skipped,
  'already_past');
/* THE CORRECTION'S OWN SAFETY CASE: the sold event now targets an EARLIER rung than the
   one it first used, so a card a human already advanced to `waiting for final docs` must
   be refused rather than pulled back a step by a re-read of the same purchase advice. */
eq('C9b …including a card a human already moved past the PA-issued stage',
  S.decideStage({ status: 'funded', internal_status: 'waiting for final docs', deleted_at: null }, 'sold').skipped,
  'already_past');
eq('C10 …including from a reconciled stage, which nothing may disturb',
  S.decideStage({ status: 'funded', internal_status: 'closed reconciled', deleted_at: null }, 'sold').skipped,
  'already_past');

/* THE SIDE DOOR THIS CLOSES. `in purchase review` and `pa issued-post closing.` both read
   back as the borrower-facing word `funded`. Pushed onto a file still in underwriting they
   would move what the borrower sees, with no status email and nothing on the screen saying
   why — so both refuse until the file has actually funded. `funded` itself is exempt: its
   caller has just established that fact. */
eq('C11 a pre-closing file is not jumped to purchase review by a tape',
  S.decideStage(PRE_CLOSE, 'investor_delivered').skipped, 'not_funded_yet');
eq('C12 …nor to the PA-issued stage by a purchase advice',
  S.decideStage(PRE_CLOSE, 'sold').skipped, 'not_funded_yet');
ok('C13 …but the funded event itself is allowed to move a pre-closing file',
  S.decideStage(PRE_CLOSE, 'funded').push === true);

/* ================================================================= *
 * D. The three callers go through this ONE module                    *
 * ================================================================= */
{
  /* EVERY STRUCTURAL GUARD BELOW READS THE CODE WITH THE COMMENTS STRIPPED, and that is not
     tidiness. These are ADJACENCY tests — "the push sits inside that `if`" — expressed as a
     bounded window, and a comment explaining WHY the push sits there is counted by that
     window. So the guards used to fail when somebody wrote a longer explanation, which is
     exactly backwards: the prose would then get trimmed to satisfy a test about structure.
     (This bit for real, on the day the sold stage was corrected — D6 went red on a comment,
     not on a code change.) Stripping first makes them measure the code and nothing else. */
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const funded = code('src/lib/encompass-funded.js');
  ok('D1 the Encompass funded reader moves the card', /post-closing-stage'\)[\s\S]{0,120}advanceCard\(appId, 'funded'/.test(funded));
  ok('D2 …only when the status actually moved, so a re-read never re-fires the ClickUp email',
    /if \(statusMoved\) \{[\s\S]{0,700}advanceCard\(appId, 'funded'/.test(funded));

  const tape = code('src/lib/tapes/investor-send.js');
  ok('D3 sending the tape moves the card', /advanceCard\(appId, 'investor_delivered'/.test(tape));
  ok('D4 …AFTER the email is actually sent, so the card never claims a delivery that failed',
    tape.indexOf('advanceCard') > tape.indexOf('await email.sendMail('));

  /* THE SOLD PUSH MOVED, AND WHERE IT MOVED TO IS THE POINT (2026-08-23).
     It used to live HERE, in release-party.syncPurchaseAdviceDate — which ALSO called
     sold-status.syncSoldStage, which pushes `sold` too. Two pushes for one sale, from two
     conditions that already disagreed on a cleared date and on a table-funded file; the second
     was a no-op only because decideStage refuses a card that is already there, which is a
     collision being absorbed rather than a design.
     The card now follows the STAGE, once, in sold-status.js — the right owner, because that is
     the module carrying the owner's table-funded exclusion, and a table-funded loan must not be
     dragged to `pa issued-post closing.` either. */
  const pa = code('src/sitewire/release-party.js');
  const stage = code('src/lib/sold-status.js');

  ok('D5 the sold STAGE moves the card', /advanceCard\(appId, 'sold'/.test(stage));
  /* The guard's SUBJECT is "the push sits inside the announce branch", and the condition is
     allowed to be STRICTER than that. Pinning exact text would make this fail on a change that
     makes the rule tighter, which is the wrong way round. */
  ok('D6 …only when announcing, so the back-book backfill stamps the stage silently',
    /if \(announce[^)]*\) \{[\s\S]{0,700}advanceCard\(appId, 'sold'/.test(stage));
  ok('D6b …and the stage is only reached once the file ACTUALLY moved, so a re-read never re-pushes',
    stage.indexOf("advanceCard(appId, 'sold'") > stage.indexOf("if (!r || !r.rowCount) return { skipped: 'unchanged' };"));
  ok('D6c the back-book sweep lands the date without announcing it, through the same one door',
    /syncSoldStage\(db, appId, \{ announce: !silentDiscovery \}\)/.test(pa));

  /* EXACTLY ONE PLACE PUSHES THE SOLD STAGE. This is the guard that stops the double-push
     coming back — the failure it describes is invisible at runtime (the second push is
     absorbed), so nothing but a structural test can hold the line. */
  ok('D6d release-party no longer pushes the card itself — one sale, one push',
    !/advanceCard\(appId, 'sold'/.test(pa));

  /* A hard-coded stage string in a caller is a second definition waiting to drift from the
     live list — and a drifted one is a push ClickUp silently refuses. The list is EVERY
     stage on the ladder, not only the three targeted today: a caller reaching for
     `closed reconciled` would be just as wrong, and adding a rung must not silently fall
     outside the guard. Read off LADDER so the two can never disagree. */
  for (const [f, body] of [['encompass-funded.js', funded], ['investor-send.js', tape],
    ['release-party.js', pa], ['sold-status.js', stage]]) {
    const named = S.LADDER.filter((stage) => body.includes(`'${stage}'`) || body.includes(`"${stage}"`));
    ok(`D7 ${f} names no ClickUp stage of its own`, named.length === 0);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
