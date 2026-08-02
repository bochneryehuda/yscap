'use strict';
/**
 * THE STOPPED-NIGHTLY DETECTOR.
 *
 * The failure this pins down is the nastiest one a backup system has, because it looks like
 * success: the nightly job stops running, and since it only emails on FAILURE — and a job that
 * never runs never fails — everything goes quiet. The weekly drill then restores whatever the
 * NEWEST backup happens to be, which is a perfectly valid three-week-old backup, matches it to its
 * own receipt row for row, and emails "Backup test passed".
 *
 * So the drill judges the SCHEDULE separately from the RESTORE. Pure — no vault, no DB, no clock.
 * Run: node scripts/test-backup-freshness.js
 */
const { freshness, describeAge } = require('../src/lib/backup/manifest');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

const NOW = new Date('2026-08-02T12:00:00Z').getTime();
const H = 3600 * 1000;
const ago = (hours) => new Date(NOW - hours * H);

// ---- the ordinary healthy case -------------------------------------------------------------------
{
  ok(freshness(ago(11), NOW).stale === false, 'last night\'s backup is fresh');
  ok(freshness(ago(0), NOW).stale === false, 'a backup taken this instant is fresh');
  ok(freshness(ago(47.9), NOW).stale === false, 'just under the limit is still fresh — one late run is not an alarm');
  ok(freshness(ago(24), NOW).ageHours === 24, 'the age is reported in hours');
}

// ---- the case this exists for --------------------------------------------------------------------
{
  ok(freshness(ago(48.1), NOW).stale === true, 'just over the limit is stale');
  ok(freshness(ago(72), NOW).stale === true, 'three days with no backup is stale');
  const threeWeeks = freshness(ago(24 * 21), NOW);
  ok(threeWeeks.stale === true, 'a three-week-old backup is stale — the exact case that used to email "passed"');
  ok(threeWeeks.ageHours === 504, 'and its real age is reported, not rounded away');
}

// ---- never let "we could not tell" read as "we are protected" ------------------------------------
{
  ok(freshness(undefined, NOW).stale === true, 'a missing date is treated as STALE, never as fresh');
  ok(freshness('not a date', NOW).stale === true, 'an unparseable date is treated as STALE');
  ok(freshness(null, NOW).unreadable === true, 'and it says WHY it could not tell');
  ok(freshness('not a date', NOW).ageHours === null, 'an unreadable date reports no age rather than inventing one');
}

// ---- a clock that disagrees ----------------------------------------------------------------------
{
  ok(freshness(ago(-3), NOW).stale === false,
    'a backup dated slightly in the future is clock skew, not staleness — it must not raise the alarm');
}

// ---- the threshold is configurable, and junk cannot silently disable it ---------------------------
{
  ok(freshness(ago(30), NOW, 24).stale === true, 'a tighter limit is honoured');
  ok(freshness(ago(30), NOW, 72).stale === false, 'a looser limit is honoured');
  ok(freshness(ago(24 * 30), NOW, 0).stale === false, 'zero deliberately disables the check');
  ok(freshness(ago(24 * 30), NOW, 0).disabled === true, 'and being disabled is stated, not implied by a passing verdict');
  ok(freshness(ago(24 * 30), NOW, NaN).stale === false && freshness(ago(24 * 30), NOW, NaN).disabled === true,
    'a NaN limit disables rather than comparing against NaN (every comparison with NaN is false, ' +
    'which would have made everything look fresh forever)');
}

// ---- the wording that reaches a non-developer ----------------------------------------------------
{
  ok(describeAge(11) === '11 hours old', 'a recent age is given in hours');
  ok(describeAge(504) === '21 days old', 'a long gap is given in days, because "504 hours" means nothing to a reader');
  ok(describeAge(24) === '24 hours old', 'the hours/days switch is at 48h, so a one-day gap still reads in hours');
  ok(describeAge(72) === '3 days old', 'three days reads as days');
  ok(describeAge(24) !== '1 days old' && describeAge(48) === '2 days old', 'the plural is not mangled');
  ok(describeAge(null) === 'of an unknown age', 'an unknown age says so rather than printing null');
}

// ---- the combination the drill actually reports ---------------------------------------------------
{
  // Restorability and freshness are independent; the drill must be able to express all four states.
  const stale = freshness(ago(24 * 21), NOW).stale;
  const fresh = freshness(ago(10), NOW).stale;
  const overall = (restoreOk, isStale) => restoreOk && !isStale;
  ok(overall(true, fresh) === true, 'fresh + restored = pass');
  ok(overall(true, stale) === false, 'STALE + restored = FAIL — the file is fine, the schedule is not');
  ok(overall(false, fresh) === false, 'fresh + failed restore = fail');
  ok(overall(false, stale) === false, 'stale + failed restore = fail');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
