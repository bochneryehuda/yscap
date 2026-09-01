'use strict';
/**
 * LONG-TERM — THE DAILY PRICE SNAPSHOT'S OWN PASS (owner-directed 2026-08-30;
 * research `docs/longterm/PRICING-RATE-MOVEMENT-REPORTS.md` §8).
 *
 * The sync worker ticks every few minutes; a snapshot belongs to a DAY. So this
 * is the thin thing between them: it answers "has today's snapshot been taken
 * yet, and is it time to take it?" and does nothing at all the other 287 times
 * a day it is asked.
 *
 * ⛔ IT COSTS ONE INDEXED SELECT WHEN THERE IS NOTHING TO DO, and that is what
 * makes it safe on a five-minute tick. The vendor is not called, no lock is
 * taken and nothing is written until the day's row is genuinely missing.
 *
 * ⛔ ONE VENDOR CALL A DAY, MEASURED. A single Lender Price search returns every
 * investor and every programme at once — the live capture of 2026-08-23 recorded
 * 17 lenders / 32 programmes / 1,055 priced rungs from ONE call. So a daily
 * snapshot of the whole book is one call per benchmark per day: never one per
 * programme, never one per officer, and never a loop.
 *
 * ⛔ IT IS ON BY DEFAULT, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. A
 * movement report has nothing to say on its first day BY CONSTRUCTION, and it
 * has nothing to say on its thirtieth either unless somebody started collecting
 * on day one. Shipping the collector switched off produces a feature that looks
 * finished and reports nothing whenever it is finally turned on. It is one read
 * a day against a vendor this desk already calls dozens of times an hour, it
 * writes only `lt_price_snapshot`, it tells nobody anything, and
 * `LT_PRICE_SNAPSHOT_ENABLED=0` stops it without a deploy.
 *
 * ⛔ IT NEVER THROWS. Every outcome is a shaped answer the worker logs.
 *
 * SEPARATION: `lt_price_snapshot` only, through `pricing/snapshot.js`. No RTL
 * table, no RTL import.
 */

const benchmark = require('./benchmark');
const snapshotLib = require('./snapshot');
const tenantTime = require('../sync/tenant-time');

const lazy = {
  get lp() { return require('../lenderprice/client'); },
};

/** Off with `LT_PRICE_SNAPSHOT_ENABLED=0`; anything else, including unset, is on.
 *  Read at CALL time so the switch works without a deploy. */
function enabled() {
  const raw = String(process.env.LT_PRICE_SNAPSHOT_ENABLED || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/**
 * THE HOUR THE SNAPSHOT REPRESENTS, in New York.
 *
 * ⛔ IT IS AN HOUR, NOT A CRON. The worker's tick is the only scheduler Long-Term
 * has, so the pass asks whether the day has reached its hour rather than being
 * fired at one — which also means a deploy or an outage over the hour costs the
 * day nothing: the next tick after it comes back takes the snapshot, and the row
 * still belongs to the day an officer means.
 *
 * 1:00 PM Eastern by default: after the morning's rate sheets have landed and
 * before the afternoon's re-prices, which is the research's own reasoning.
 */
const HOUR = (() => {
  const n = Number(process.env.LT_PRICE_SNAPSHOT_HOUR);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 13;
})();

/**
 * Take today's snapshot if today's is missing and the day has reached its hour.
 * ALWAYS answers a shape; NEVER throws.
 */
async function dailyPass(opts = {}) {
  if (!enabled()) return { ok: true, skipped: 'off', reason: 'LT_PRICE_SNAPSHOT_ENABLED=0' };
  const lp = opts.lp || lazy.lp;
  if (typeof lp.configured === 'function' && !lp.configured()) {
    return { ok: true, skipped: 'not_configured', reason: 'Lender Price is not configured on this deployment' };
  }

  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const tz = opts.tz || tenantTime.tzName();
  const wall = tenantTime.wallClockOf(now, tz);
  if (!wall) return { ok: false, reason: `the ${tz} wall clock could not be read` };
  const p = (v) => String(v).padStart(2, '0');
  const day = `${wall.y}-${p(wall.mo)}-${p(wall.d)}`;
  const hour = Number.isFinite(Number(opts.hour)) ? Number(opts.hour) : HOUR;
  if (wall.h < hour) {
    return { ok: true, skipped: 'too_early', day, reason: `today's snapshot is taken from ${hour}:00 ${tz}` };
  }

  const scenario = opts.scenario || benchmark.DEFAULT_BENCHMARK;
  const hash = benchmark.scenarioHash(scenario);
  try {
    if (await snapshotLib.alreadyTaken(hash, day, opts.db || null)) {
      return { ok: true, skipped: 'already', day, scenarioHash: hash };
    }
  } catch (e) {
    // ⛔ AN UNREADABLE "have we already?" DOES NOT SPEND A VENDOR CALL. The
    // upsert would make a second snapshot harmless, but a database that cannot
    // answer this question is not one to write a day of the market into either.
    return { ok: false, day, scenarioHash: hash, reason: `could not check today's snapshot: ${(e && e.message) || e}` };
  }

  return snapshotLib.takeSnapshot({ ...opts, scenario, now, day });
}

module.exports = { dailyPass, enabled, _internals: { HOUR } };
