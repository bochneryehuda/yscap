'use strict';
/**
 * LONG-TERM — the pass that runs on its own.
 *
 * WHY THIS EXISTS. Everything the long-term side mirrors — the loans, their
 * stage, their team, their lock, the whole 1003, the Condition Center — filled
 * ONLY when a human opened the Sync screen and pressed a button. A loan somebody
 * changed in Encompass overnight stayed stale until a person happened to notice,
 * which is the same "built but never triggered" failure as a mirror with no
 * writer, one level up: every writer existed and nothing ever called them.
 *
 * OFF BY DEFAULT, and it says so. `LT_SYNC_ENABLED=1` turns it on, exactly as
 * `ENCOMPASS_ENABLED` and `CLICKUP_OUTBOUND_ENABLED` gate their own workers. With
 * the switch off this module schedules nothing, reads nothing and costs nothing —
 * so it can ship to every deployment as it stands and change none of them.
 *
 * IT IS BOUNDED BY THE PASSES IT CALLS, NOT BY A LIMIT OF ITS OWN. `loans.syncOnce`
 * reads at most its own budget of loans per pass and `conditions.syncOnce` its
 * own; both report whether there is more to do. That matters on a tenant whose API
 * budget is shared with every other integration and capped at 30 concurrent calls
 * — a worker with its own idea of "how much" would be a second place for that to
 * be got wrong.
 *
 * NOTHING IT DOES CAN THROW INTO THE EVENT LOOP. Every tick is wrapped: an
 * unhandled rejection inside a timer takes the whole process down, and a sync that
 * kills the server is worse than a sync that misses an hour.
 *
 * ENCOMPASS STAYS ONE-WAY. Every call this schedules is a read.
 */

const loans = require('./loans');
const conditions = require('../conditions/sync');
const milestoneCatalog = require('./milestone-catalog');

/** Minutes between passes. The tenant's own pacing makes a tighter loop pointless. */
const POLL_MIN = (() => {
  const raw = Number(process.env.LT_SYNC_POLL_MIN);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 20;
})();

/** How long after boot the first pass runs — long enough for migrations to finish. */
const FIRST_RUN_MS = (() => {
  const raw = Number(process.env.LT_SYNC_FIRST_RUN_SEC);
  return (Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 90) * 1000;
})();

/**
 * ON BY DEFAULT since 2026-08-23, owner-directed: *"Set up the pullback and set
 * everything on, and she will automatically pull old files and also future files."*
 *
 * It shipped OFF because a worker nobody asked for should cost nothing. The owner has
 * now asked for it, so the default flips and `LT_SYNC_ENABLED=0` is the way to stop
 * it. Turning it on is deliberately NOT the same as making it do something: with no
 * Encompass credentials `loans.syncOnce` returns "Encompass is not connected yet" and
 * the pass costs one refused call, so a deployment that has never configured
 * long-term Encompass is unaffected by this change.
 */
const enabled = () => {
  const raw = String(process.env.LT_SYNC_ENABLED == null ? '' : process.env.LT_SYNC_ENABLED).trim();
  if (!raw) return true;
  return !/^(0|false|no|off)$/i.test(raw);
};

/**
 * THE BACKFILL. How long one tick may keep pulling history, in seconds.
 *
 * `loans.syncOnce` reads at most its own budget (25) per call and reports how many
 * are still due, so a book of 772 files needs about 31 calls. At one call per
 * 20-minute tick that is ten hours before an officer can see their own closed
 * files — which is not "pull everything backwards" in any useful sense.
 *
 * So a tick keeps calling while there is more to do, until either the book is caught
 * up or this budget is spent. It is a WALL-CLOCK bound rather than a pass count
 * because what has to be protected is the gap before the next tick, and a pass takes
 * as long as the tenant's pacing makes it take. Default 10 minutes, comfortably
 * inside the 20-minute poll so a drain can never still be running when the next tick
 * lands (and `running` would skip it anyway).
 *
 * ONCE THE HISTORY IS IN, THIS COSTS NOTHING. `needsRead` is answered from the
 * database — a loan is due only if it has never been read or Encompass has touched
 * it since — so a caught-up book drains in one pass that finds nothing and stops.
 */
const DRAIN_SEC = (() => {
  const raw = Number(process.env.LT_SYNC_DRAIN_SEC);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 600;
})();

/**
 * A hard ceiling on passes per tick, so a bug that always reports "more to do" burns
 * a bounded number of calls rather than every call the tenant has. It is the backstop
 * and not the control: the wall clock above is what normally ends a drain.
 */
const MAX_PASSES = (() => {
  const raw = Number(process.env.LT_SYNC_MAX_PASSES);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 60;
})();

/**
 * Drain the loan backlog: pass after pass until the book is caught up or the budget
 * is spent.
 *
 * Returns the LAST pass's shape with the totals accumulated across the drain, so a
 * caller (and the log line) sees one answer rather than a list. `passes` and
 * `caughtUp` are what say whether the history is in yet.
 */
async function drainLoans(now) {
  const deadline = now() + DRAIN_SEC * 1000;
  let last = null;
  let passes = 0;
  let read = 0;
  let failed = 0;
  for (;;) {
    /* eslint-disable no-await-in-loop */ // deliberately serial: see the pacing note above
    last = await loans.syncOnce({});
    passes += 1;
    if (!last || last.ok === false) break;          // a refusal ends the drain, not the tick
    read += last.read || 0;
    failed += last.failed || 0;
    // Caught up is the ordinary exit, and it is the one that matters: it is what
    // turns this back into a cheap incremental sync once the history is in.
    if (!last.remaining) break;
    if (passes >= MAX_PASSES) break;
    if (now() >= deadline) break;
  }
  if (!last || last.ok === false) return { ...(last || {}), passes };
  return { ...last, read, failed, passes, caughtUp: !last.remaining };
}

// A pass never overlaps itself. A tick that lands while the previous one is still
// reading would double this worker's share of a shared API budget, and on a slow
// tenant it would keep doing so — so a busy pass is SKIPPED rather than queued.
let running = false;
let started = false;

/**
 * One pass: the loans, then the Condition Center.
 *
 * Both halves are best-effort and independent. The condition sweep refuses
 * politely while `conditions.enabled` is off, so this is safe on a deployment
 * that has not turned that on; and a loan pass that fails must not stop the
 * conditions, because the two read different things and fail for different
 * reasons.
 */
async function tickOnce() {
  if (running) return { ok: false, reason: 'a pass is already running' };
  running = true;
  const started_at = Date.now();
  const out = { loans: null, conditions: null, milestoneCatalog: null };
  try {
    try {
      out.loans = await drainLoans(Date.now);
    } catch (e) {
      out.loans = { ok: false, reason: (e && e.message) || String(e) };
    }
    try {
      out.conditions = await conditions.syncOnce({});
    } catch (e) {
      out.conditions = { ok: false, reason: (e && e.message) || String(e) };
    }
    // The tenant's own milestone catalog. It skips itself unless a day has passed,
    // so this costs nothing on all but one pass — and when it does run it is what
    // stops a step a buyer added from blanking the progress bar on every file
    // sitting at it. Independent of the other two, like they are of each other.
    try {
      out.milestoneCatalog = await milestoneCatalog.refreshOnce({});
    } catch (e) {
      out.milestoneCatalog = { ok: false, reason: (e && e.message) || String(e) };
    }
  } finally {
    running = false;
  }

  // Said out loud, every pass. A sync nobody can see the shape of is a sync
  // nobody notices has stopped working.
  const l = out.loans || {};
  const c = out.conditions || {};
  console.log('[lt-sync] pass in %ds — loans: %s; conditions: %s',
    Math.round((Date.now() - started_at) / 1000),
    l.ok === false ? `failed (${l.reason})`
      : `${l.read || 0} read of ${l.discovered || 0} in ${l.passes || 1} pass(es)`
        + `${l.failed ? `, ${l.failed} failed` : ''}`
        + `${l.caughtUp === false ? `, ${l.remaining} still to backfill` : ''}`,
    c.ok === false ? `skipped (${c.reason})` : `${c.read || 0} read of ${c.due || 0}${c.failed ? `, ${c.failed} failed` : ''}${c.more ? ', more to go' : ''}`);

  return out;
}

/**
 * Schedule it. Called once, by the long-term module's own entry point — this is
 * LT deciding its own background work rather than a second seam into RTL.
 */
function start() {
  if (started) return false;
  if (!enabled()) {
    console.log('[lt-sync] disabled (LT_SYNC_ENABLED is set to off — unset it to turn the sync back on)');
    return false;
  }
  started = true;
  console.log('[lt-sync] on — a pass every %d min, first in %ds', POLL_MIN, Math.round(FIRST_RUN_MS / 1000));

  const safeTick = () => { tickOnce().catch((e) => console.error('[lt-sync] pass failed:', (e && e.message) || e)); };

  // UNREF'D, AND THAT BECAME LOAD-BEARING THE DAY THIS WENT ON BY DEFAULT. A pending
  // timer keeps the Node event loop alive, so once `start()` actually schedules
  // something, ANY process that merely requires the long-term module stops being able
  // to exit — every `scripts/test-lt-*.js` hung, and the whole chain went from 32
  // seconds to a timeout. Found by running the suite, not by reading the diff.
  //
  // `unref` says "do not stay alive for me". A real server is held open by its HTTP
  // listener, so the passes still fire exactly as before; a test or a CLI that loads
  // the module and finishes can now finish.
  const first = setTimeout(safeTick, FIRST_RUN_MS);
  const every = setInterval(safeTick, POLL_MIN * 60 * 1000);
  if (typeof first.unref === 'function') first.unref();
  if (typeof every.unref === 'function') every.unref();
  return true;
}

module.exports = { start, tickOnce, _internals: { enabled, drainLoans, POLL_MIN, FIRST_RUN_MS, DRAIN_SEC, MAX_PASSES } };
