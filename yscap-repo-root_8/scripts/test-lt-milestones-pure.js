'use strict';
/**
 * LT test — the milestone clock, the pure half.
 *
 * The property this suite exists for:
 *
 *   A FIRST SIGHTING IS NOT AN ARRIVAL.
 *
 * PILOT cannot read Encompass's milestone log (403 on this tenant), so the only
 * history available is noticing that a loan's milestone is not what it was. The first
 * time a loan is read there is nothing to compare it to — it may have been sitting
 * where it is for ten minutes or ten months. Recording that as "reached today" would
 * make the entire back book look freshly moved on the day the sync first ran, and
 * would make the stalled-file signal confidently wrong on exactly the files it exists
 * to surface. So the first sighting is a BASELINE, and a baseline yields NO age.
 */

const fs = require('fs');
const path = require('path');
const ms = require('../src/longterm/milestones');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const NOW = new Date('2026-08-16T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

// ── What gets recorded ──────────────────────────────────────────────────────
console.log('what a read decides to record');

const first = ms.decideMilestoneEvent(
  { hasRecord: false }, { milestoneName: 'Processing', stageKey: 'underwriting' }, { now: NOW },
);
check(first.action === 'baseline' && first.event.eventType === 'observed_baseline',
  'THE ONE THAT MATTERS: a first sighting is a BASELINE — it records WHERE the loan already was, never that it arrived today');
check(first.event.fromMilestone === null && first.event.toMilestone === 'Processing',
  'a baseline names where it is and claims nothing about where it came from');

const moved = ms.decideMilestoneEvent(
  { hasRecord: true, milestoneName: 'Loan Setup', stageKey: 'setup' },
  { milestoneName: 'Processing', stageKey: 'underwriting' }, { now: NOW },
);
check(moved.action === 'entered' && moved.event.eventType === 'observed_entered',
  'a milestone we WATCHED change is an observed arrival — the only case that produces a real date');
check(moved.event.fromMilestone === 'Loan Setup' && moved.event.fromStage === 'setup'
  && moved.event.toStage === 'underwriting',
  'and it records both ends, in both layers');

check(ms.decideMilestoneEvent(
  { hasRecord: true, milestoneName: 'Processing' }, { milestoneName: 'Processing' }, { now: NOW },
).action === 'none',
'a re-read that changed nothing appends nothing — the history is what happened, not how often we looked');
check(ms.decideMilestoneEvent(
  { hasRecord: true, milestoneName: 'Processing' }, { milestoneName: '  processing  ' }, { now: NOW },
).action === 'none',
'…and the same milestone spelled with different spacing or casing is the same milestone');

check(ms.decideMilestoneEvent(
  { hasRecord: true, milestoneName: 'Processing' }, { milestoneName: null }, { now: NOW },
).action === 'none',
'THE ONE THAT MATTERS: Encompass saying nothing about the milestone is an ABSENT READING, not a move to "no milestone" — writing it would erase real history');

// A file legitimately rolls back and returns; each of those is a real observation.
const back = ms.decideMilestoneEvent(
  { hasRecord: true, milestoneName: 'Clear To Close' }, { milestoneName: 'Processing' }, { now: NOW },
);
check(back.action === 'entered' && back.event.fromMilestone === 'Clear To Close',
  'a milestone can go BACKWARDS and that is recorded like any other move — a file can be rolled back exactly as a lock can');

// ── The clock ───────────────────────────────────────────────────────────────
console.log('\nhow long it has been there');

const baselineClock = ms.describeClock(
  { milestone_since: daysAgo(30), milestone_since_is_baseline: true }, { expectedDays: 5, now: NOW },
);
check(baselineClock.days === null && baselineClock.stalled === null,
  'THE ONE THAT MATTERS: a BASELINE yields no age and no verdict — we know when we started watching, not when the loan arrived');
check(/not known/i.test(baselineClock.note),
  '…and it says so in plain words, rather than leaving a blank somebody reads as zero');
check(baselineClock.sinceIsBaseline === true, 'the flag rides along so a screen cannot render it as an arrival');

const watched = ms.describeClock(
  { milestone_since: daysAgo(9), milestone_since_is_baseline: false }, { expectedDays: 5, now: NOW },
);
check(watched.days === 9 && watched.stalled === true,
  'a WATCHED arrival gives a real age, and past the tenant’s own expected days it reads as stalled');
check(/9 days/.test(watched.note) && /5 expected/.test(watched.note),
  'the sentence quotes both numbers, so the verdict can be checked rather than trusted');

const withinExp = ms.describeClock(
  { milestone_since: daysAgo(2), milestone_since_is_baseline: false }, { expectedDays: 5, now: NOW },
);
check(withinExp.days === 2 && withinExp.stalled === false, 'inside the expectation it is not stalled');

const noExpectation = ms.describeClock(
  { milestone_since: daysAgo(40), milestone_since_is_baseline: false }, { expectedDays: null, now: NOW },
);
check(noExpectation.days === 40 && noExpectation.stalled === null,
  'THE ONE THAT MATTERS: with no expected duration set, `stalled` is NULL not false — "nobody set a bar" and "it is under the bar" are different answers');

check(ms.describeClock({}, { now: NOW }).days === null
  && /has not read this loan/i.test(ms.describeClock({}, { now: NOW }).note),
'a loan PILOT has never read has no clock at all, and says which of the two it is');

const skew = ms.describeClock(
  { milestone_since: new Date(NOW.getTime() + 60000), milestone_since_is_baseline: false }, { now: NOW },
);
check(skew.days === 0, 'a stamp slightly in the future reads as today, never as a negative age');

check(ms.describeClock({ milestone_since: 'not-a-date', milestone_since_is_baseline: false }, { now: NOW }).days === null,
  'an unreadable stamp yields no age rather than NaN');

// A loan row that predates the table has a milestone but no `milestone_since`, so it
// has no history and its next read must BASELINE — never date itself from a row we
// did not write.
check(ms.describeClock({ milestone_since: null, milestone_since_is_baseline: false }, { now: NOW }).days === null,
  'a loan with no recorded sighting has no age even when the baseline flag says otherwise');

// ── The sentence names the step the BAR came from (round 5, defect 5) ───────
//
// Under the last-completed rule the clock measures the wait on the NEXT step
// and the expectation is that step's. Saying "at THIS milestone … longer than
// the 3 expected" put the awaited step's number under the standing step's name,
// so the header and the Milestones board on the same screen quoted two
// different expectations for what read as one step, with nothing to reconcile
// them.
console.log('\nthe clock names the step it is measuring against');

const named = ms.describeClock(
  { milestone_since: daysAgo(9), milestone_since_is_baseline: false },
  { expectedDays: 3, awaiting: 'Cond. Approval', now: NOW },
);
check(/Waiting on Cond\. Approval/.test(named.note) && !/At this milestone/.test(named.note),
  'the sentence names the AWAITED step rather than saying "this milestone"');
check(/9 days/.test(named.note) && /3 expected for it/.test(named.note) && named.stalled === true,
  '…and still quotes both numbers, tied to that step');

const namedOk = ms.describeClock(
  { milestone_since: daysAgo(1), milestone_since_is_baseline: false },
  { expectedDays: 3, awaiting: 'Funding', now: NOW },
);
check(/Waiting on Funding for 1 day,/.test(namedOk.note) && namedOk.stalled === false,
  'a single day reads "1 day", not "1 days" — and within the bar it is not stalled');

const namedNoBar = ms.describeClock(
  { milestone_since: daysAgo(12), milestone_since_is_baseline: false },
  { expectedDays: null, awaiting: 'Wire Order', now: NOW },
);
check(/Waiting on Wire Order/.test(namedNoBar.note) && /no expected duration for Wire Order/.test(namedNoBar.note),
  'with no bar it still names the step, and blames the catalog for THAT step');

// "Nothing is awaited" and "the catalog set no duration" are different facts.
// The old wording blamed the catalog on a finished ladder, which is simply false.
const done = ms.describeClock(
  { milestone_since: daysAgo(4), milestone_since_is_baseline: false },
  { expectedDays: null, nothingAwaited: true, now: NOW },
);
check(/nothing is being waited on/i.test(done.note) && !/catalog/.test(done.note),
  'a finished ladder says nothing is being waited on — never that the catalog set no duration');
check(done.days === 4 && done.stalled === null,
  '…and claims no bar, so a completed file can never read as stalled');

// A caller that does not name a step keeps the older wording rather than
// inventing one, so nothing that has not been moved over changes meaning.
const unnamed = ms.describeClock(
  { milestone_since: daysAgo(9), milestone_since_is_baseline: false }, { expectedDays: 3, now: NOW },
);
check(/At this milestone/.test(unnamed.note) && !/Waiting on/.test(unnamed.note),
  'a caller that names no step gets the previous wording — never a fabricated step name');
check(!/Waiting on\s*\./.test(ms.describeClock(
  { milestone_since: daysAgo(9), milestone_since_is_baseline: false },
  { expectedDays: 3, awaiting: '   ', now: NOW }).note),
'a blank step name is treated as none, never rendered as an empty gap in the sentence');

// ── It never pretends to be Encompass ───────────────────────────────────────
console.log('\nit can never pretend to be Encompass’s own record');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/milestones.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

check(ms.EVENT_ENTERED.startsWith('observed_') && ms.EVENT_BASELINE.startsWith('observed_'),
  'EVERY event type is named `observed_*` — Encompass’s milestone log is unreadable here, and ours must never be mistaken for it');
const types = [...code.matchAll(/eventType:\s*([A-Z_]+)/g)].map((m) => m[1]);
check(types.length > 0 && types.every((t) => t === 'EVENT_ENTERED' || t === 'EVENT_BASELINE'),
  'and no third event type is minted anywhere in the module');

const tables = [...code.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());
check(tables.length > 0 && tables.every((t) => /^lt_/.test(t)),
  `every table it touches is an lt_ one (${[...new Set(tables)].join(', ')})`);
check(!/lt_loan_investors/.test(code), 'the investor table is not read here');

// ── The ordering the whole feature rests on ─────────────────────────────────
console.log('\nthe sync reads the OLD milestone before it writes the new one');

// This is the one thing that cannot be checked from the module alone, and the one
// that fails SILENTLY. `loadPrior` reads `lt_loans.milestone_name`; the sync then
// OVERWRITES that column. If the read ever moved after the write, `prev` would equal
// `next` on every pass, `decideMilestoneEvent` would answer `unchanged` every time,
// and the history would simply stop being recorded — no error, no empty table to
// notice, just a feature that quietly reports nothing forever. Nothing about the
// three statements looks order-dependent, which is exactly why it is guarded here.
const sync = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/loans.js'), 'utf8');
const iPrior = sync.indexOf('milestones.loadPrior');
const iUpdate = sync.indexOf('SET milestone_name =');
const iWrite = sync.indexOf('milestones.writeMilestone');

check(iPrior > -1 && iUpdate > -1 && iWrite > -1,
  'the sync reads the prior milestone, updates the loan, and records the movement');
check(iPrior < iUpdate,
  'THE ONE THAT MATTERS: `loadPrior` runs BEFORE the UPDATE that overwrites the milestone — after it, every read would compare the new value with itself and the history would silently stop');
check(iUpdate < iWrite,
  'and the movement is recorded after the loan is mirrored, so a failed history write can never undo the mirror');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
