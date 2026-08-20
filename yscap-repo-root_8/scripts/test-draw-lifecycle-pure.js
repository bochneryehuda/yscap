'use strict';
/**
 * A DRAFT IS NOT A REQUEST — the draw lifecycle vocabulary and the two notifications
 * built on it (owner-reported 2026-08-20).
 *
 * The owner's words: "he just clicks Start, and he's starting to take pictures.
 * Sometimes it could take a few days … Our draw department is getting an email right
 * away … and it sounds for our team that this is an actual draw request that he
 * submitted already. The truth is that he just started a draft, so we need to change
 * this notification and restructure it. When they actually submit the draw request
 * for review to the inspector, it should be that it was submitted for review. When
 * they start, it should only be started as a draft."
 *
 * FOUR THINGS, and each is a way the fix could be quietly undone:
 *   A. the vocabulary — which statuses mean draft, which mean submitted, and the
 *      direction an UNKNOWN status falls (submitted, never draft);
 *   B. ONE DEFINITION — the two ordering doors (TrustPoint hand-entry, Trinity
 *      inspection) read the SAME submitted set the notification does, so a drift
 *      can never leave the desk told a draw was submitted while an inspector is
 *      never sent;
 *   C. the crossing rule — a draw sent BACK for a re-inspection is not a fresh
 *      submission, and a draft that reached `approved` between two polls defers to
 *      the approval's own richer wording;
 *   D. the wording — the draft copy says "not yet" and never claims action is
 *      needed; the submitted copy says "submitted for review".
 *
 * Pure — no DB, no network. */

const path = require('path');
const fs = require('fs');
const R = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');

const L = require(R + '/src/sitewire/draw-lifecycle');
const { inboundDrawCopy, draftStartedCopy } = require(R + '/src/sitewire/draw-inbound-copy');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------------------------------------------------------------------------
console.log('\nA. the vocabulary');
// ---------------------------------------------------------------------------

// The two statuses a borrower's own draw sits in while they are still working on
// it. `drafting` is what the Start button produces — the status in the owner's
// report.
ok(L.isDraft('drafting'), 'drafting is a draft');
ok(L.isDraft('pending_borrower'), 'pending_borrower is a draft (it is BEFORE inspecting on approval.js STAGE_ORDER)');
ok(!L.isDraft('inspecting') && !L.isDraft('pending'), 'neither submitted status is a draft');

ok(L.isSubmitted('inspecting'), 'inspecting is submitted (a virtual draw lands here)');
ok(L.isSubmitted('pending'), 'pending is submitted (a physical / TrustPoint draw lands here)');
ok(L.isSubmitted('pending_capital_partner') && L.isSubmitted('approved'), 'the later rungs are submitted too');
ok(!L.isSubmitted('drafting') && !L.isSubmitted('pending_borrower'), 'a draft is never submitted');

// Nothing overlaps — a status that were in both sets would make every rule below
// depend on evaluation order.
{
  const both = [...L.DRAFT_STATUSES].filter((s) => L.SUBMITTED_STATUSES.has(s));
  ok(both.length === 0, `no status is both a draft and submitted (saw: ${both.join(', ') || 'none'})`);
}

// Casing / padding must not decide whether the desk is told a draw was submitted.
ok(L.isDraft('  DRAFTING '), 'a padded, upper-case status still reads as a draft');
ok(L.isSubmitted('Pending'), '…and the same on the submitted side');

// THE DIRECTION AN UNKNOWN STATUS FALLS. The statuses we do not name are the LATE
// ones (declined, completed, whatever Sitewire adds next). Reading one of those as
// a draft would leave the desk unaware of a live draw — the worse of the two
// errors — so it reads as submitted, and says it was unrecognised.
ok(L.phaseOf('drafting') === 'draft', 'phaseOf: drafting → draft');
ok(L.phaseOf('pending') === 'submitted', 'phaseOf: pending → submitted');
ok(L.phaseOf('completed') === 'unknown', 'phaseOf: an unnamed status → unknown, not a guess');
ok(!L.isDraft('completed'), '…and an unknown status is never treated as a draft');
ok(L.phaseOf(null) === 'unknown' && L.phaseOf('') === 'unknown' && L.phaseOf(undefined) === 'unknown',
  'no status at all → unknown');

// ---------------------------------------------------------------------------
console.log('\nB. ONE definition — the ordering doors read the same set');
// ---------------------------------------------------------------------------

const tpIntake = require(R + '/src/sitewire/trustpoint-intake');
ok(tpIntake.SUBMITTED_STATUSES === L.SUBMITTED_STATUSES,
  'the TrustPoint import task reads the SAME Set object — not a copy that can drift');
{
  // Trinity does not re-export it, so the guard is on the source: a hand-typed Set
  // here is how an inspector stops being sent to a property the desk was told about.
  const trinity = read('src/trinity/intake.js');
  ok(/require\('\.\.\/sitewire\/draw-lifecycle'\)/.test(trinity),
    'the Trinity inspection order imports the shared vocabulary');
  ok(!/const SUBMITTED_STATUSES = new Set\(/.test(trinity),
    '…and keeps no second hand-typed copy of the set');
  const tp = read('src/sitewire/trustpoint-intake.js');
  ok(!/const SUBMITTED_STATUSES = new Set\(/.test(tp),
    'the TrustPoint door keeps no second copy either');
}

// ---------------------------------------------------------------------------
console.log('\nC. the crossing rule');
// ---------------------------------------------------------------------------

ok(L.crossedIntoSubmitted('drafting', 'inspecting'), 'drafting → inspecting is a crossing');
ok(L.crossedIntoSubmitted('pending_borrower', 'pending'), 'pending_borrower → pending is a crossing');
ok(!L.crossedIntoSubmitted('inspecting', 'pending'), 'a move between two submitted rungs is not a crossing');
ok(!L.crossedIntoSubmitted('drafting', 'pending_borrower'), 'a move between two draft rungs is not a crossing');

// WHAT GETS ANNOUNCED AS "SUBMITTED FOR REVIEW".
ok(L.announcesSubmission('drafting', 'inspecting'),
  'a virtual draw submitted (→ inspecting) is announced as submitted');
ok(L.announcesSubmission('pending_borrower', 'pending'),
  'a physical / TrustPoint draw submitted (→ pending) is announced as submitted');
// THE RE-INSPECTION CASE: a LIVE draw moving back to `inspecting` must never be
// announced as though the borrower had just submitted it.
ok(!L.announcesSubmission('pending', 'inspecting'),
  'a live draw sent back for a re-inspection is NOT a fresh submission');
// THE WIDE POLL GAP: it really was submitted, but "submitted for review" would tell
// the desk LESS than the truth, so the approval's own message wins.
ok(!L.announcesSubmission('drafting', 'approved'),
  'a draft that reached approved between two polls defers to the approval message');
ok(!L.announcesSubmission('drafting', 'pending_capital_partner'),
  '…same for one that reached the capital-partner rung');
ok(!L.announcesSubmission(null, 'pending') && !L.announcesSubmission('pending', null),
  'a missing status on either side announces nothing');

// ---------------------------------------------------------------------------
console.log('\nD. the wording');
// ---------------------------------------------------------------------------

for (const platform of ['trustpoint', 'sitewire', 'trinity', null]) {
  for (const method of ['traditional', 'virtual', null]) {
    const d = draftStartedCopy({ platform, method });
    const where = `(${platform || 'no platform'} / ${method || 'no method'})`;
    // THE ONE THING A DRAFT MUST NEVER SAY. The old notification's "Action needed"
    // badge on a draft is what made the desk act days early.
    ok(d.actionNeeded === false, `draft never needs action ${where}`);
    ok(!/action needed/i.test(`${d.actionLabel} ${d.nextStep} ${d.whenItLands}`),
      `draft copy never contains the words the desk scans for ${where}`);
    // …and the two things it must say.
    ok(/draft/i.test(d.actionLabel), `draft copy names the phase ${where}`);
    ok(/submitted for review/i.test(d.nextStep),
      `draft copy promises the next email, so the silence after it is not read as the draw being lost ${where}`);
    ok(/once they submit it/i.test(d.whenItLands),
      `draft copy is FUTURE tense about what happens next ${where}`);
  }
}
{
  // An unrecognised status is admitted to rather than asserted as a phase.
  const unsure = draftStartedCopy({ platform: 'sitewire', method: null, phaseKnown: false });
  ok(/do not recognise/i.test(unsure.nextStep), 'an unconfirmed phase says so in the copy');
  const sure = draftStartedCopy({ platform: 'sitewire', method: null, phaseKnown: true });
  ok(!/do not recognise/i.test(sure.nextStep), '…and a known phase does not');
}

// The submitted copy is unchanged in behaviour — it is the SAME function the desk
// has always used, and it still routes by platform.
{
  const tp = inboundDrawCopy({ platform: 'trustpoint', method: 'traditional', submitted: true });
  ok(tp.actionNeeded === true && /task was opened/.test(tp.nextStep),
    'a submitted TrustPoint draw still opens the coordinator task, in the past tense');
  const virtual = inboundDrawCopy({ platform: 'sitewire', method: null, submitted: true });
  ok(virtual.actionNeeded === false, 'a submitted virtual draw still needs no action');
}

// ---------------------------------------------------------------------------
console.log('\nE. the reconcile is wired to all of it');
// ---------------------------------------------------------------------------
{
  const rec = read('src/sitewire/reconcile.js');
  ok(/require\('\.\/draw-lifecycle'\)/.test(rec), 'the reconcile reads the shared vocabulary');
  ok(/type: 'draw_draft_started'/.test(rec), 'it can announce a draft');
  ok(/lifecycle\.announcesSubmission\(prev\.status_synced, newStatus\)/.test(rec),
    'the submission is keyed on the CROSSING, not on a status rung');
  // A status rung for the submission would double-announce on one shape and
  // mislabel a re-inspection on another — the reason the crossing exists.
  ok(!/^\s{2}inspecting: \{/m.test(rec),
    'there is no `inspecting` REACT_STATUS rung competing with the crossing');
  ok(/inAppOnly: process\.env\.DRAW_DRAFT_STARTED_EMAIL !== '1'/.test(rec),
    'the draft is in-app only, with a switch to put the email back without a deploy');
  // The submitted arm must keep its money block, and the draft arm must not gain one.
  const draftArm = rec.slice(rec.indexOf('const announceDraftStarted'), rec.indexOf('// A draw with no prior mirror row'));
  ok(!/moneyOpts\(/.test(draftArm), 'the draft notice carries NO dollar figure — a draft\'s numbers still move');
  const subArm = rec.slice(rec.indexOf('const announceSubmitted'), rec.indexOf('const announceDraftStarted'));
  ok(/moneyOpts\(b\)/.test(subArm), 'the submitted notice still carries the money block');
}
{
  // The type has to exist everywhere a notification type must, or it silently
  // degrades: no category means no draw loop-in and no role-scoped visibility.
  const cat = require(R + '/src/lib/notification-catalog');
  const entry = cat.entryForKey('draw_draft_started');
  ok(!!entry && entry.category === 'draws' && entry.audience === 'staff',
    'draw_draft_started is in the notification catalog, as a staff draws event');
  const notify = read('src/lib/notify.js');
  ok(/draw_draft_started: 'draws'/.test(notify), 'CATEGORY_OF knows it — this is what loops the draw desk in');
  ok(/'draw_draft_started',/.test(notify), 'STAFF_INAPP_TYPES knows it, so any future sender inherits in-app-only');
  ok(/draw_draft_started: 'Construction draw — draft started'/.test(notify), 'it has its own email eyebrow');
  ok(/const inAppOnly = opts\.inAppOnly === true;/.test(notify),
    'notifyAppStaffThread HONOURS an explicit inAppOnly — it used to accept and ignore it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
