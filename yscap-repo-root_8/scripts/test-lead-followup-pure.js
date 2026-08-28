'use strict';
/**
 * THE LEAD FOLLOW-UP PILES — the pure rule (owner-directed 2026-08-28: "on the
 * lead side need a system to review leads per follow up date").
 *
 * src/lib/lead-followup.js is the ONE definition of "which pile does a lead
 * belong in". This pins:
 *   · every boundary of every pile (yesterday/today/tomorrow, day 7 vs day 8);
 *   · that a CLOSED lead is in NO pile, whatever date sits on the row;
 *   · that a dateless OPEN lead is 'none' — visible, never dropped;
 *   · that an unreadable date lands in 'none' rather than being guessed;
 *   · daysOverdue whole-day arithmetic (DST-proof, calendar strings only);
 *   · that the browser's open-stage list (app-v2/src/lib/leadCrm.js OPEN_STAGES)
 *     and the server's are THE SAME LIST — a mirror pinned by reading the file,
 *     because a lead "open" on the board but closed to the review (or the
 *     reverse) is the drift this module exists to prevent;
 *   · that bucketSql exists for every pile and interpolates no values.
 *
 * PURE — no DB, no network. In `npm test`.
 */
const fs = require('fs');
const path = require('path');
const f = require('../src/lib/lead-followup');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const T = '2026-08-28';   // a fixed "today" so every boundary is exact
const lead = (d, status = 'new') => ({ next_follow_up: d, status });

// ── every boundary of every pile ────────────────────────────────────────────
const CASES = [
  ['2020-01-01', 'overdue', 'years late'],
  ['2026-08-27', 'overdue', 'yesterday'],
  ['2026-08-28', 'today', 'today'],
  ['2026-08-29', 'tomorrow', 'tomorrow'],
  ['2026-08-30', 'week', 'day 2'],
  ['2026-09-04', 'week', 'day 7 — the last day of the week pile'],
  ['2026-09-05', 'later', 'day 8 — the first day of later'],
  ['2027-01-01', 'later', 'far out'],
  [null, 'none', 'no date at all'],
];
for (const [d, want, why] of CASES) {
  ok(f.bucketOf(lead(d), T) === want, `${d || '(no date)'} → ${want} (${why})`);
}

// ── month/year boundaries by calendar arithmetic ────────────────────────────
ok(f.bucketOf(lead('2026-09-01'), '2026-08-31') === 'tomorrow', 'Aug 31 → Sep 1 is tomorrow across the month boundary');
ok(f.bucketOf(lead('2027-01-01'), '2026-12-31') === 'tomorrow', 'Dec 31 → Jan 1 is tomorrow across the year boundary');
// The DST-shift trap: March 8 2026 is the US spring-forward day.
ok(f.addDays('2026-03-07', 1) === '2026-03-08', 'addDays crosses the DST boundary without slipping a day');
ok(f.addDays('2026-03-08', 7) === '2026-03-15', 'a 7-day add across DST lands on the right day');

// ── a CLOSED lead is in NO pile, whatever date is on the row ────────────────
for (const status of ['converted', 'lost', 'archived']) {
  ok(f.bucketOf(lead('2020-01-01', status), T) === null, `a ${status} lead with an ancient date is in NO pile`);
}
for (const status of f.OPEN_STAGES) {
  ok(f.bucketOf(lead(null, status), T) === 'none', `an open (${status}) lead with no date is in 'none' — visible, never dropped`);
}

// ── junk dates land in 'none', never guessed into a pile ────────────────────
for (const junk of ['not-a-date', '0202-08', 12345, {}, '']) {
  ok(f.bucketOf(lead(junk), T) === 'none', `unreadable date ${JSON.stringify(junk)} lands in 'none'`);
}
// A pg `date` arrives as a string; a timestamptz as a Date — both readable.
ok(f.bucketOf(lead('2026-08-28T00:00:00.000Z'), T) === 'today', 'a timestamp string is read by its calendar day');
ok(f.bucketOf({ nextFollowUp: '2026-08-27', status: 'new' }, T) === 'overdue', 'the camelCase spelling is read too');

// ── daysOverdue ─────────────────────────────────────────────────────────────
ok(f.daysOverdue(lead('2026-08-27'), T) === 1, 'yesterday is 1 day late');
ok(f.daysOverdue(lead('2026-08-01'), T) === 27, 'Aug 1 is 27 days late on Aug 28');
ok(f.daysOverdue(lead('2026-08-28'), T) === 0, 'today is 0 days late');
ok(f.daysOverdue(lead('2026-09-04'), T) === 0, 'a future date is 0 days late, never negative');
ok(f.daysOverdue(lead(null), T) === null, 'no date → null (there is nothing to be late against)');

// ── the browser mirror: OPEN_STAGES must equal leadCrm.js's list ────────────
{
  const src = fs.readFileSync(path.join(__dirname, '../app-v2/src/lib/leadCrm.js'), 'utf8');
  const m = src.match(/export const OPEN_STAGES = \[([^\]]+)\]/);
  ok(!!m, 'app-v2/src/lib/leadCrm.js still declares OPEN_STAGES');
  const browser = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
  ok(JSON.stringify(browser) === JSON.stringify([...f.OPEN_STAGES]),
    `the browser's open-stage list and the server's are THE SAME list (${browser.join(',')})`);
}

// ── bucketSql: one arm per pile, placeholders only ──────────────────────────
for (const k of f.BUCKET_KEYS) {
  const sql = f.bucketSql('l', k, '$1');
  ok(typeof sql === 'string' && sql.includes('l.next_follow_up'), `bucketSql covers '${k}'`);
  ok(!/\d{4}-\d{2}-\d{2}/.test(sql), `bucketSql('${k}') interpolates no literal date — the day is always a bound parameter`);
}
ok(f.bucketSql('l', 'bogus', '$1') === null, 'an unknown pile has no SQL — the caller must validate first');
ok(f.normalizeBucket('overdue') === 'overdue' && f.normalizeBucket('junk') === null && f.normalizeBucket('') === null,
  'normalizeBucket accepts only real pile keys');
{
  const c = f.bucketCaseSql('l', '$1');
  for (const k of f.BUCKET_KEYS.filter((x) => x !== 'none')) ok(c.includes(`'${k}'`), `bucketCaseSql names '${k}'`);
  ok(/ELSE 'none' END$/.test(c), `bucketCaseSql falls through to 'none' — a NULL date is never unlabeled`);
}

// ── the piles offered to the screen ─────────────────────────────────────────
ok(f.BUCKETS.length === 6 && f.BUCKETS.every((b) => b.key && b.label && b.blurb),
  'six piles, each with a key, a label and a plain-language blurb');
ok(JSON.stringify(f.DUE_NOW_BUCKETS) === JSON.stringify(['overdue', 'today']),
  '"due now" is overdue + today — never "everything with a date"');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll lead follow-up pile checks passed.');
