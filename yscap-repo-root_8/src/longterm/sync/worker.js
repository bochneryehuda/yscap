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

const enabled = () => /^(1|true|yes|on)$/i.test(String(process.env.LT_SYNC_ENABLED || '').trim());

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
      out.loans = await loans.syncOnce({});
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
    l.ok === false ? `failed (${l.reason})` : `${l.read || 0} read of ${l.discovered || 0}${l.failed ? `, ${l.failed} failed` : ''}${l.more ? ', more to go' : ''}`,
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
    console.log('[lt-sync] disabled (set LT_SYNC_ENABLED=1 to turn it on)');
    return false;
  }
  started = true;
  console.log('[lt-sync] on — a pass every %d min, first in %ds', POLL_MIN, Math.round(FIRST_RUN_MS / 1000));

  const safeTick = () => { tickOnce().catch((e) => console.error('[lt-sync] pass failed:', (e && e.message) || e)); };
  setTimeout(safeTick, FIRST_RUN_MS);
  setInterval(safeTick, POLL_MIN * 60 * 1000);
  return true;
}

module.exports = { start, tickOnce, _internals: { enabled, POLL_MIN, FIRST_RUN_MS } };
