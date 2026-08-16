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

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
