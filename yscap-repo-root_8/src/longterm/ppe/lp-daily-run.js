'use strict';
/**
 * LT PPE — the DAILY drift RUN: the thin, fully IO-INJECTED wrapper that ties the pure pieces together
 * (LT plan item #52 / D19). It does the WORK — capture today's Lender-Price snapshot, compare it to
 * yesterday's, auto-apply the safe base-rate refreshes, and hand every rule/LLPA/eligibility/PPP change
 * (plus any base-rate cell we could not confidently apply) to the human review queue — but it owns NO
 * real IO of its own. The LP client, the clock, and the store are all injected, so the whole run
 * executes OFFLINE in a test with a stubbed client, a fixed clock, and an in-memory store. No network,
 * no timers, no DB.
 *
 * WHY A WRAPPER AT ALL: the pure modules (`lp-drift`, `lp-daily-schedule`) decide; this composes. The
 * split is the standing one in this codebase (canary-schedule vs the worker) and exists because a rule
 * that lives inside a wrapper is a rule no pure test can reach — so the wrapper stays a composition and
 * every DECISION lives in the pure modules it calls.
 *
 * ESCALATE, NEVER DROP, END TO END: a capture that throws does not silently skip the investor — it is
 * recorded as an error on the report and the day is NOT stamped as run (so the next tick retries),
 * rather than pretending the check happened. The FIRST time we see an investor (no prior snapshot) we
 * only BASELINE — there is nothing to diff, so nothing is auto-applied and nothing is reviewed; the
 * snapshot is saved and the day stamped.
 *
 * THE INJECTED CONTRACTS (all async-friendly; the wrapper awaits them):
 *   lpClient.captureSnapshot(investor) -> { baseRates:{key->num}, fingerprint:{key->value} }
 *   clock.now() -> epoch ms
 *   store.loadSnapshot(investor) -> prior snapshot | null
 *   store.saveSnapshot(investor, snapshot)
 *   store.loadLastRunByInvestor() -> { investorKey -> 'YYYY-MM-DD' }   (for the tick)
 *   store.saveLastRunDay(investor, etDay)
 *   store.applyBaseRates(investor, applied[])     -> apply the auto-applyable refreshes (a pure sink)
 *   store.enqueueReview(investor, reviewItems[])  -> the human review queue sink
 *
 * LT-only. No RTL imports.
 */

const drift = require('./lp-drift');
const schedule = require('./lp-daily-schedule');

function investorKey(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * Run the daily drift check for ONE investor. Idempotent-safe to call from the tick.
 *   investor: the investor name (business identity; supplied, never invented).
 *   deps: { lpClient, clock, store, config } — config carries the drift guardrail
 *         { maxDeltaMilli, maxPct, maxCellsChanged, roundTo } and program label.
 * Returns a structured report; never throws (a capture/apply failure is reported, not raised).
 */
async function runDailyForInvestor(investor, deps = {}) {
  const { lpClient, clock, store, config = {} } = deps;
  const nowMs = clock && typeof clock.now === 'function' ? Number(clock.now()) : NaN;
  const parts = schedule.etParts(nowMs);
  const etDay = parts ? parts.etDay : null;
  const base = { investor, etDay, ranAt: Number.isFinite(nowMs) ? nowMs : null };

  if (!parts) return { ...base, ok: false, reason: 'no_clock', firstRun: false, applied: [], review: [] };

  // Capture today's snapshot. A throw here is an ERROR, not a skip: do not stamp the day, so the next
  // tick tries again rather than the check silently never happening.
  let today;
  try {
    today = await lpClient.captureSnapshot(investor);
  } catch (e) {
    return { ...base, ok: false, reason: 'capture_failed', error: String(e && e.message ? e.message : e), firstRun: false, applied: [], review: [] };
  }
  if (!today || typeof today !== 'object') {
    return { ...base, ok: false, reason: 'empty_capture', firstRun: false, applied: [], review: [] };
  }

  const prev = await store.loadSnapshot(investor);

  // FIRST RUN: nothing to diff. Baseline only — never auto-apply or review on the first capture.
  if (!prev) {
    await store.saveSnapshot(investor, today);
    await store.saveLastRunDay(investor, etDay);
    return { ...base, ok: true, firstRun: true, applied: [], review: [], summary: null };
  }

  const out = drift.detectAndClassify(prev, today, { investor, program: config.program || null, nowMs }, {
    maxDeltaMilli: config.maxDeltaMilli,
    maxPct: config.maxPct,
    maxCellsChanged: config.maxCellsChanged,
    roundTo: config.roundTo,
  });

  // Apply the safe base-rate refreshes, then enqueue everything a human must see. Order matters: the
  // review sink is the record of what needs attention, so it is written even if apply is a no-op.
  if (out.applied.length && store.applyBaseRates) await store.applyBaseRates(investor, out.applied);
  if (out.review.length && store.enqueueReview) await store.enqueueReview(investor, out.review);

  // Today's snapshot becomes tomorrow's baseline, and the day is stamped as run.
  await store.saveSnapshot(investor, today);
  await store.saveLastRunDay(investor, etDay);

  return { ...base, ok: true, firstRun: false, applied: out.applied, review: out.review, summary: out.summary };
}

/**
 * The tick: given the schedule + the injected clock/store, find the investors due this minute and run
 * each. `maxPerRun` bounds how many captures fire on one tick (each is a live vendor call); the rest
 * stay due and are reported as `deferred` (never hidden — a cap too small shows up as a standing
 * number, not as investors that mysteriously never run).
 *   deps: { lpClient, clock, store, config, entries, maxPerRun }
 *     entries: [{ investor, hourEt }] — the per-investor daily schedule (10/11/12 AM ET).
 * Returns { ranAt, ran: [report...], deferred: [investor...], held: [decision...], invalid: [...] }.
 */
async function tickDaily(deps = {}) {
  const { clock, store, entries, config = {} } = deps;
  const nowMs = clock && typeof clock.now === 'function' ? Number(clock.now()) : NaN;
  const lastRunByInvestor = store.loadLastRunByInvestor ? await store.loadLastRunByInvestor() : {};
  const t = schedule.tick(entries, { nowMs, lastRunByInvestor });

  const maxPerRun = Number.isFinite(Number(config.maxPerRun)) && Number(config.maxPerRun) > 0
    ? Math.floor(Number(config.maxPerRun)) : (t.due.length || 1);

  const toRun = t.due.slice(0, maxPerRun);
  const deferred = t.due.slice(maxPerRun).map((d) => d.investor);

  const ran = [];
  for (const d of toRun) {
    ran.push(await runDailyForInvestor(d.investor, deps)); // eslint-disable-line no-await-in-loop
  }
  return { ranAt: Number.isFinite(nowMs) ? nowMs : null, ran, deferred, held: t.held, invalid: t.invalid };
}

module.exports = { runDailyForInvestor, tickDaily, _internals: { investorKey } };
