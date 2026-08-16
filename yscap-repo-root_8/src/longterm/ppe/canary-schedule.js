'use strict';
/**
 * LT PPE — WHEN the canary runs, and on WHAT (§10.3a, the continuous reconciliation loop).
 *
 * The canary itself exists (`canary.js`) and the admin can fire one by hand (`POST /canary`). What
 * has never existed is the CADENCE — so "how well do the two engines agree?" is only ever answered
 * on the days somebody remembered to press the button, while the cutover gate reads a clean-day
 * STREAK and an agreement TREND off that same series. A streak nobody is feeding does not read as
 * "unmeasured"; it reads as a low score, and an investor can sit permanently short of promotion for
 * want of a cron rather than for want of agreement.
 *
 * THIS MODULE IS THE DECISION ONLY — pure, no DB, no network, no clock of its own. The worker that
 * takes the advisory lock, prices the battery and stamps the result is the thin IO wrapper around it.
 * That split is the standing one in this codebase (cutover-store/cutover-ledger, gate/
 * gate-disposition, foundationReadiness/pricingReadiness) and it exists because the wrapper calls its
 * collaborators as LOCAL functions: a require-cache stub silently does nothing, so a rule that lives
 * inside the wrapper is a rule no test can reach.
 *
 * THE ONE RULE THAT IS NOT ABOUT TIMING: A SCHEDULE NEVER INVENTS A BATTERY.
 * `coverage.js` says it in its own header — "the caller supplies the axis VALUES; this module never
 * invents a pricing band" — and the same discipline has to survive automation, where it is easier to
 * break and much harder to notice. WHICH scenarios are worth measuring is a business judgement about
 * the investor's book; a battery this code made up would produce an agreement rate over scenarios
 * nobody chose, and that number would then feed the promote gate. So a schedule carries the battery a
 * HUMAN saved, and a schedule with no battery is INCOMPLETE — it never runs, and it says why.
 *
 * FAILS TOWARD NOT RUNNING. Every uncertainty here — an unreadable interval, a missing battery, a
 * last-run stamp from the future, a schedule nobody enabled — resolves to "do not run", because the
 * cost of a canary that does not fire is a measurement gap somebody can see on the scoreboard, while
 * the cost of one that fires when it should not is N live vendor calls per tick, forever.
 *
 * LT-only. No RTL imports, no DB, no network.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// The cadence bounds. The FLOOR is the real guard: a canary prices a whole battery against a live
// upstream, so a schedule set to "every minute" is a request to hammer the vendor several hundred
// times a minute forever. One hour is far below any real reconciliation need (the plan's loop is
// daily) and far above anything that could look like an attack. The CEILING is not a safety rule but
// an honesty one — a cadence longer than a month cannot feed a clean-DAY streak, so it would leave
// the gate permanently unmeasurable while looking configured.
const MIN_INTERVAL_MS = Number(process.env.LT_PPE_CANARY_MIN_INTERVAL_MS || HOUR_MS);
const MAX_INTERVAL_MS = Number(process.env.LT_PPE_CANARY_MAX_INTERVAL_MS || 31 * 24 * HOUR_MS);
const DEFAULT_INTERVAL_MS = Number(process.env.LT_PPE_CANARY_DEFAULT_INTERVAL_MS || 24 * HOUR_MS);
// Mirrors the route's own refusal (`MAX_CANARY_SCENARIOS`). Kept as a bound on the SAVED battery so
// an oversized one is refused when it is stored — once, in front of the person who wrote it — rather
// than every tick forever, into a log nobody reads.
const MAX_BATTERY_SCENARIOS = Number(process.env.LT_PPE_CANARY_MAX_SCENARIOS || 500);

function posInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * PURE — is this a schedule that could ever run?
 *
 * Returns { ok, reason, message, intervalMs, battery } where `battery` is the normalized description
 * of WHAT to price: either { kind:'scenarios', scenarios } or { kind:'matrix', matrix }. A schedule
 * that is not ok is never run and the reason is reportable to a human, because "the nightly canary
 * has not run for a week" must always be answerable without reading code.
 *
 * `enabled` is deliberately NOT part of validity: a saved-but-paused schedule is perfectly valid and
 * simply not due (see `decide`). Conflating the two would report a paused schedule as broken.
 */
function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { ok: false, reason: 'no_schedule', message: 'No canary schedule is saved for this scope.' };
  }
  const rawInterval = schedule.intervalMs != null ? schedule.intervalMs
    : (schedule.intervalMinutes != null ? posInt(schedule.intervalMinutes) * MINUTE_MS : null);
  const intervalMs = rawInterval == null ? DEFAULT_INTERVAL_MS : posInt(rawInterval);
  if (intervalMs == null) {
    return { ok: false, reason: 'bad_interval',
      message: 'The canary interval is not a positive number of minutes, so nothing is scheduled.' };
  }
  if (intervalMs < MIN_INTERVAL_MS) {
    return { ok: false, reason: 'interval_too_short',
      message: `A canary prices a whole battery against Lender Price, so it may run at most once every ${Math.round(MIN_INTERVAL_MS / MINUTE_MS)} minutes; this schedule asks for every ${Math.round(intervalMs / MINUTE_MS)}.` };
  }
  if (intervalMs > MAX_INTERVAL_MS) {
    return { ok: false, reason: 'interval_too_long',
      message: `A cadence longer than ${Math.round(MAX_INTERVAL_MS / (24 * HOUR_MS))} days cannot feed a clean-day streak, so the promotion gate would never have anything to read.` };
  }

  // THE BATTERY. Exactly one of the two shapes, and it must be non-empty — never a default.
  const hasScenarios = Array.isArray(schedule.scenarios);
  const hasMatrix = schedule.matrix && typeof schedule.matrix === 'object' && !Array.isArray(schedule.matrix);
  if (hasScenarios && hasMatrix) {
    return { ok: false, reason: 'ambiguous_battery',
      message: 'This schedule carries BOTH a scenario list and a matrix. Save one or the other — running the wrong one would measure agreement over scenarios nobody chose.' };
  }
  if (!hasScenarios && !hasMatrix) {
    return { ok: false, reason: 'no_battery',
      message: 'This schedule has no scenarios to price. Save the battery you want measured — PILOT never invents one, because the agreement rate it produced would feed the promotion gate.' };
  }
  if (hasScenarios) {
    if (!schedule.scenarios.length) {
      return { ok: false, reason: 'no_battery', message: 'The saved scenario list is empty, so there is nothing to price.' };
    }
    if (schedule.scenarios.length > MAX_BATTERY_SCENARIOS) {
      return { ok: false, reason: 'battery_too_large',
        message: `That battery is ${schedule.scenarios.length} scenarios; a canary run prices at most ${MAX_BATTERY_SCENARIOS}. Narrow it — it is refused rather than shortened, because a quietly-truncated battery reports an agreement rate over scenarios nobody chose.` };
    }
    return { ok: true, reason: null, message: null, intervalMs, battery: { kind: 'scenarios', scenarios: schedule.scenarios } };
  }
  return { ok: true, reason: null, message: null, intervalMs, battery: { kind: 'matrix', matrix: schedule.matrix } };
}

/**
 * PURE — should this schedule run RIGHT NOW, and if not, when?
 *
 * Returns { run, reason, message, dueAt, intervalMs, battery }.
 *
 * `lastRunMs` is the last time a canary was recorded for this scope. It is deliberately read from
 * the RUN SERIES the canary already writes rather than from a stamp this scheduler keeps: a stamp of
 * its own would be a second answer to "when did we last measure this?", and the one that drifts is
 * the one the gate reads. It also means a canary an admin fired BY HAND counts — which is right, and
 * would not be true of a private stamp.
 */
function decide(schedule, opts = {}) {
  const nowMs = Number(opts.nowMs);
  if (!Number.isFinite(nowMs)) {
    return { run: false, reason: 'no_clock', message: 'No clock was supplied, so nothing is scheduled.', dueAt: null, intervalMs: null, battery: null };
  }
  const v = validateSchedule(schedule);
  if (!v.ok) return { run: false, reason: v.reason, message: v.message, dueAt: null, intervalMs: null, battery: null };
  if (schedule.enabled !== true) {
    return { run: false, reason: 'disabled', message: 'This canary schedule is saved but paused.', dueAt: null, intervalMs: v.intervalMs, battery: v.battery };
  }

  const last = Number(opts.lastRunMs);
  // NEVER RUN is not an error, and it is the ordinary state of a schedule somebody just saved: run
  // on the next tick so the first measurement does not wait a whole cadence.
  if (!Number.isFinite(last)) {
    return { run: true, reason: 'never_run', message: 'No canary has run for this scope yet.', dueAt: nowMs, intervalMs: v.intervalMs, battery: v.battery };
  }
  // A last-run stamp in the FUTURE is unreadable state (a clock skew between instances, a restored
  // backup), and the safe reading is "recently measured": wait it out rather than firing a battery
  // on data we cannot interpret. It heals by itself once the clock passes it.
  if (last > nowMs) {
    return { run: false, reason: 'future_last_run', dueAt: last + v.intervalMs, intervalMs: v.intervalMs, battery: v.battery,
      message: 'The last canary is stamped in the future, so this scope is treated as recently measured until the clock catches up.' };
  }
  const dueAt = last + v.intervalMs;
  if (nowMs < dueAt) {
    return { run: false, reason: 'not_due', dueAt, intervalMs: v.intervalMs, battery: v.battery,
      message: `The next canary for this scope is due in ${Math.max(1, Math.round((dueAt - nowMs) / MINUTE_MS))} minutes.` };
  }
  return { run: true, reason: 'due', message: null, dueAt, intervalMs: v.intervalMs, battery: v.battery };
}

/**
 * PURE — pick the schedules to run this tick, in the order they have waited longest.
 *
 * `maxPerTick` is a real bound and not a formality: every run is a live battery against the vendor,
 * so a tick that found twenty due schedules must not fire twenty batteries at once. What it does NOT
 * do is hide the overflow — `skipped` names how many were due and left, so a cap that is genuinely
 * too small shows up as a standing number rather than as schedules that mysteriously never run.
 */
function selectDue(entries = [], opts = {}) {
  const maxPerTick = posInt(opts.maxPerTick) || 1;
  const due = [];
  const held = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== 'object') continue;
    const d = decide(e.schedule, { nowMs: opts.nowMs, lastRunMs: e.lastRunMs });
    if (d.run) due.push({ ...e, decision: d });
    else held.push({ ...e, decision: d });
  }
  // Longest-waiting first, so a scope can never be starved by one that runs more often. A
  // never-run schedule has no stamp to sort by and is the most overdue thing there is, so it leads.
  due.sort((a, b) => {
    const av = Number.isFinite(Number(a.lastRunMs)) ? Number(a.lastRunMs) : -Infinity;
    const bv = Number.isFinite(Number(b.lastRunMs)) ? Number(b.lastRunMs) : -Infinity;
    return av - bv;
  });
  return { run: due.slice(0, maxPerTick), skipped: Math.max(0, due.length - maxPerTick), held };
}

module.exports = {
  validateSchedule, decide, selectDue,
  MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS, MAX_BATTERY_SCENARIOS,
  _internals: { posInt, MINUTE_MS, HOUR_MS },
};
