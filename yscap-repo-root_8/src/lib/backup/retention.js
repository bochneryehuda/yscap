'use strict';
/**
 * Retention planner — PURE. Decides which stored backups may be deleted, and never touches a byte
 * itself; the caller does the deleting. Kept pure precisely so the "which backups die" decision is
 * unit-testable without a bucket, because a retention bug is silent until the day you need the
 * backup it quietly removed.
 *
 * SCHEME: Grandfather-Father-Son (GFS), the standard for regulated record retention — dense
 * coverage of the recent past, thinning out with age, so "restore to yesterday afternoon" and
 * "produce the book as it stood 18 months ago" are both possible without keeping every dump
 * forever.
 *
 *   dailyDays      keep EVERY backup taken in the last N days      (default 35)
 *   weeklyWeeks    then one per ISO week, for W weeks              (default 26)
 *   monthlyMonths  then one per calendar month, for M months       (default 36)
 *   yearlyYears    then one per calendar year, for Y years         (default 10)
 *
 * Within a week/month/year bucket the NEWEST backup wins — it is the one whose contents are
 * closest to how the business actually ended that period.
 *
 * THREE HARD SAFETY RULES, in order of precedence, because every real-world backup disaster is a
 * retention job that ran correctly against a broken input:
 *   1. The newest backup is NEVER deleted. Not for any policy, not at any age.
 *   2. If the plan would leave fewer than `minKeep` backups, nothing is deleted at all. An empty
 *      or half-read listing (a network blip mid-LIST) must not read as "the vault is nearly empty,
 *      prune it" — it reads as "something is wrong, keep everything".
 *   3. Nothing is deleted while it is inside its immutability window. The vault enforces this
 *      itself (Object Lock refuses the delete), but planning around it keeps the logs honest
 *      instead of full of expected failures.
 */

/** PURE — UTC calendar day bucket, "YYYY-MM-DD". */
function dayKey(d) { return d.toISOString().slice(0, 10); }
/** PURE — UTC calendar month bucket, "YYYY-MM". */
function monthKey(d) { return d.toISOString().slice(0, 7); }
/** PURE — UTC calendar year bucket, "YYYY". */
function yearKey(d) { return d.toISOString().slice(0, 4); }

/**
 * PURE — ISO-8601 week bucket, "YYYY-Www". ISO weeks start Monday and belong to the year holding
 * their Thursday, which is why this is not just "day of year / 7": the last days of December
 * routinely belong to week 01 of the NEXT year, and treating them as separate buckets would keep
 * two backups for one week every single year.
 */
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;                 // Mon=0 … Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3);              // the Thursday of this week
  const isoYear = t.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

const DEFAULTS = {
  dailyDays: 35,
  weeklyWeeks: 26,
  monthlyMonths: 36,
  yearlyYears: 10,
  minKeep: 7,
};

/**
 * PURE — plan the prune.
 *
 * @param {Array<{key:string, at:string|Date, lockedUntil?:string|Date}>} backups  every stored backup
 * @param {Date} now
 * @param {object} policy  overrides for DEFAULTS
 * @returns {{keep:Array, delete:Array, reasons:Object<string,string>, skippedLocked:Array, aborted:string|null}}
 *          `reasons[key]` says WHY each kept backup was kept — the log line that makes a prune
 *          reviewable after the fact instead of a number.
 */
function planRetention(backups, now, policy = {}) {
  const p = Object.assign({}, DEFAULTS, policy || {});
  const items = (backups || [])
    .map((b) => ({ ...b, when: b.at instanceof Date ? b.at : new Date(b.at) }))
    .filter((b) => b.when instanceof Date && !isNaN(b.when))
    .sort((a, b) => b.when - a.when);                       // newest first

  const keep = new Set();
  const reasons = {};
  const mark = (item, why) => { if (item && !keep.has(item.key)) { keep.add(item.key); reasons[item.key] = why; } };

  if (items.length) mark(items[0], 'newest backup (never deleted)');

  const dayMs = 24 * 3600 * 1000;
  for (const it of items) {
    const ageDays = (now - it.when) / dayMs;
    if (ageDays < p.dailyDays) mark(it, `within the ${p.dailyDays}-day daily window`);
  }

  // One survivor per bucket, for the most recent N buckets of each tier. Buckets are collected in
  // newest-first order, so "the most recent N" falls out of insertion order.
  const tier = (keyFn, limit, label) => {
    const seen = new Map();
    for (const it of items) {
      const k = keyFn(it.when);
      if (!seen.has(k)) seen.set(k, it);                    // items are newest-first → newest wins
    }
    let n = 0;
    for (const [k, it] of seen) {
      if (n++ >= limit) break;
      mark(it, `${label} ${k}`);
    }
  };
  tier(isoWeekKey, p.weeklyWeeks, 'weekly keeper for');
  tier(monthKey, p.monthlyMonths, 'monthly keeper for');
  tier(yearKey, p.yearlyYears, 'yearly keeper for');

  const doomed = items.filter((it) => !keep.has(it.key));

  // SAFETY 3 — anything still inside its immutability window is not planned for deletion.
  const skippedLocked = [];
  const deletable = [];
  for (const it of doomed) {
    const until = it.lockedUntil ? new Date(it.lockedUntil) : null;
    if (until && !isNaN(until) && until > now) skippedLocked.push(it);
    else deletable.push(it);
  }

  // SAFETY 2 — refuse to prune down past the floor. Returns everything as "kept" with an explicit
  // abort reason so the caller logs a warning instead of silently doing nothing.
  const survivors = items.length - deletable.length;
  if (items.length && survivors < p.minKeep) {
    return {
      keep: items, delete: [], reasons, skippedLocked,
      aborted: `prune refused: it would leave ${survivors} backups, below the ${p.minKeep} minimum ` +
               `(only ${items.length} backups are visible — check the listing before pruning)`,
    };
  }

  return { keep: items.filter((it) => keep.has(it.key)), delete: deletable, reasons, skippedLocked, aborted: null };
}

/** PURE — read the retention policy out of env, falling back to the defaults. */
function policyFromEnv(env = process.env) {
  const num = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    dailyDays:     num(env.BACKUP_KEEP_DAILY_DAYS, DEFAULTS.dailyDays),
    weeklyWeeks:   num(env.BACKUP_KEEP_WEEKLY_WEEKS, DEFAULTS.weeklyWeeks),
    monthlyMonths: num(env.BACKUP_KEEP_MONTHLY_MONTHS, DEFAULTS.monthlyMonths),
    yearlyYears:   num(env.BACKUP_KEEP_YEARLY_YEARS, DEFAULTS.yearlyYears),
    minKeep:       Math.max(1, num(env.BACKUP_KEEP_MINIMUM, DEFAULTS.minKeep)),
  };
}

module.exports = { planRetention, policyFromEnv, DEFAULTS, _internals: { dayKey, isoWeekKey, monthKey, yearKey } };
