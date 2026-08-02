'use strict';
/**
 * The retention planner decides which backups get DELETED, so its whole truth table is pinned here.
 * The failure mode it exists to prevent is silent: a prune that runs "successfully" against a bad
 * input and removes the copy you needed. Pure — no vault, no clock, no DB.
 * Run: node scripts/test-backup-retention.js
 */
const { planRetention, policyFromEnv, DEFAULTS, _internals } = require('../src/lib/backup/retention');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

const NOW = new Date('2026-08-02T03:00:00Z');
const DAY = 24 * 3600 * 1000;
/** N nightly backups ending today. */
function nightly(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const at = new Date(NOW.getTime() - i * DAY);
    out.push({ key: `db/${at.toISOString().slice(0, 10)}`, base: `db/${at.toISOString().slice(0, 10)}`, at });
  }
  return out;
}

// ---- ISO weeks (the bucket that is easy to get wrong at year boundaries) ----------------------
ok(_internals.isoWeekKey(new Date('2026-01-01T00:00:00Z')) === '2026-W01', '1 Jan 2026 is ISO week 2026-W01');
ok(_internals.isoWeekKey(new Date('2027-01-01T00:00:00Z')) === '2026-W53',
  '1 Jan 2027 belongs to ISO week 2026-W53 — a plain year/week split would make it a second bucket');
ok(_internals.isoWeekKey(new Date('2026-08-02T00:00:00Z')) === _internals.isoWeekKey(new Date('2026-07-27T00:00:00Z')),
  'Monday and the following Sunday are the SAME ISO week');

// ---- the daily window ------------------------------------------------------------------------
{
  const p = planRetention(nightly(20), NOW, { minKeep: 3 });
  ok(p.delete.length === 0, 'nothing inside the 35-day daily window is ever deleted');
}
{
  const p = planRetention(nightly(400), NOW, {});
  const kept = new Set(p.keep.map((k) => k.key));
  const within35 = nightly(35);
  ok(within35.every((b) => kept.has(b.key)), 'every one of the last 35 nights survives');
  ok(p.delete.length > 200, 'the older tail is thinned out (not kept forever)');
  ok(p.keep.length + p.delete.length === 400, 'every backup is accounted for — none silently vanishes from the plan');
}

// ---- one survivor per week / month / year ------------------------------------------------------
{
  const p = planRetention(nightly(400), NOW, {});
  const weeks = new Set(), months = new Set();
  for (const k of p.keep) { weeks.add(_internals.isoWeekKey(k.at)); months.add(_internals.monthKey(k.at)); }
  ok(weeks.size >= 26, 'at least 26 distinct weeks are represented');
  ok(months.size >= 12, 'at least a year of distinct months is represented');
  // Past the daily window the tiers thin to one per bucket. A week can legitimately hold TWO
  // keepers — its own weekly keeper plus a month/year keeper when a month boundary falls inside
  // that week (31 Jan and 4 Feb are one ISO week) — but never more.
  const past = p.keep.filter((k) => (NOW - k.at) / DAY > DEFAULTS.dailyDays);
  const byWeek = {};
  for (const k of past) { const w = _internals.isoWeekKey(k.at); byWeek[w] = (byWeek[w] || 0) + 1; }
  ok(Object.values(byWeek).every((n) => n <= 2), 'past the daily window, at most one keeper per week (plus a month-boundary overlap)');
  ok(p.keep.length < 120, `400 nightly backups thin down to ${p.keep.length} — the tiers really do thin out`);
}

// ---- SAFETY 1: the newest backup is untouchable -------------------------------------------------
{
  const ancient = [{ key: 'db/old', base: 'db/old', at: new Date('2019-01-01T00:00:00Z') }];
  const p = planRetention(ancient, NOW, { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0, yearlyYears: 0, minKeep: 1 });
  ok(p.delete.length === 0 && p.keep.length === 1, 'a single, ancient, policy-expired backup is STILL never deleted');
  ok(/newest/.test(p.reasons['db/old']), '…and the reason says why');
}
{
  const p = planRetention(nightly(400), NOW, { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0, yearlyYears: 0, minKeep: 1 });
  ok(!p.delete.some((d) => d.key === nightly(1)[0].key), 'even with everything switched off, tonight\'s backup survives');
}

// ---- SAFETY 2: the minimum-keep floor aborts the whole prune -------------------------------------
{
  const p = planRetention(nightly(4), NOW, { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0, yearlyYears: 0, minKeep: 7 });
  ok(p.delete.length === 0, 'a plan that would leave fewer than the minimum deletes NOTHING');
  ok(/refused/.test(p.aborted || ''), '…and says so, so a half-read listing is visible instead of silent');
}
{
  // The nightmare: the listing came back nearly empty because of a network blip mid-LIST.
  const p = planRetention([{ key: 'db/a', base: 'db/a', at: new Date('2020-01-01T00:00:00Z') }], NOW,
    { dailyDays: 0, weeklyWeeks: 0, monthlyMonths: 0, yearlyYears: 0, minKeep: 7 });
  ok(p.delete.length === 0, 'a truncated listing cannot trigger a prune');
}

// ---- SAFETY 3: object lock is respected in the plan ----------------------------------------------
{
  const items = nightly(400).map((b, i) => (i > 300 ? { ...b, lockedUntil: new Date(NOW.getTime() + 30 * DAY) } : b));
  const p = planRetention(items, NOW, {});
  ok(p.skippedLocked.length > 0, 'objects still inside their immutability window are set aside');
  ok(!p.delete.some((d) => d.lockedUntil), '…and never appear in the delete list');
  // Take a backup the policy WOULD delete, give it a lock that has already lapsed, and confirm the
  // lapsed lock buys it nothing.
  const base = planRetention(nightly(400), NOW, {});
  const doomedKey = base.delete[0].key;
  const withExpired = nightly(400).map((b) => (b.key === doomedKey ? { ...b, lockedUntil: new Date('2021-01-01T00:00:00Z') } : b));
  const p2 = planRetention(withExpired, NOW, {});
  ok(p2.delete.some((d) => d.key === doomedKey), 'a lock that has EXPIRED no longer protects the object');
}

// ---- junk input ----------------------------------------------------------------------------------
{
  ok(planRetention([], NOW, {}).delete.length === 0, 'an empty vault plans no deletions');
  ok(planRetention(null, NOW, {}).delete.length === 0, 'a null listing plans no deletions');
  const p = planRetention([{ key: 'db/bad', at: 'not a date' }, ...nightly(40)], NOW, {});
  ok(!p.delete.some((d) => d.key === 'db/bad') && !p.keep.some((k) => k.key === 'db/bad'),
    'an unparseable entry is dropped from the plan entirely — never deleted on a guess');
}

// ---- the policy comes from env, with sane fallbacks -----------------------------------------------
{
  const p = policyFromEnv({ BACKUP_KEEP_DAILY_DAYS: '10', BACKUP_KEEP_MINIMUM: 'nonsense' });
  ok(p.dailyDays === 10, 'an env override is honoured');
  ok(p.minKeep === DEFAULTS.minKeep, 'a junk value falls back to the default instead of becoming NaN');
  ok(policyFromEnv({ BACKUP_KEEP_MINIMUM: '0' }).minKeep === 1, 'the minimum can never be set to zero');
  ok(policyFromEnv({}).dailyDays === DEFAULTS.dailyDays, 'an empty environment gives the documented defaults');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
