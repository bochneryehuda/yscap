'use strict';
/**
 * LT PPE — the agreement SCOREBOARD (§10.5): continuous measurement of how well our shadow engine
 * agrees with Lender Price for one investor, over TIME.
 *
 * The pieces already exist: `shadow.runShadow` prices a scenario matrix beside Lender Price and
 * `summarize()` gives ONE run's agreement rate; `finding.js`/`finding-store.js` hold the durable
 * disagreement ledger; `cutover.buildScoreboard`/`eligibleForLive` DECIDE whether an investor may be
 * promoted (§11). What was missing is the layer between: turning a SERIES of dated canary runs into
 * the `{ canaryAgreementRate, dailyNewFindings }` shape `cutover` consumes, and the trend an admin
 * reads. This module is that measurement layer — it MEASURES; `cutover` DECIDES (one definition of
 * "eligible", never a second copy here).
 *
 * A canary "run record" is the minimal, engine-agnostic contract:
 *     { dayMs:number, agreementRate:number|null, findingKeys?:string[], summary?:object }
 * `agreementRate` is `shadow.summarize(...).agreementRate`; `findingKeys` are the stable identities
 * (`finding.findingKey`) the run disagreed on — supplied by the caller so this stays a pure aggregator
 * that never needs to know how a key is derived. Everything is pure + clock-injected (offline-testable).
 *
 * A NEW finding is counted the FIRST day its key is seen across the whole series (so `cutover`'s
 * consecutive-clean-days streak is honest: a recurrence on day 5 of a key first seen on day 1 is NOT a
 * new finding on day 5). A run we cannot place in time (no finite `dayMs`) is DROPPED and COUNTED
 * (`dropped`) — never silently swallowed. LT-only; no RTL import.
 */

const cutover = require('./cutover');
const parity = require('./parity');
const provenance = require('./agreement-provenance');

const DAY_MS = 24 * 60 * 60 * 1000;

function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }
// Floor a timestamp to the start of its UTC day, so many runs on one calendar day collapse together.
function dayBucket(ms) { return Math.floor(ms / DAY_MS) * DAY_MS; }

/**
 * Collapse a list of run records into one entry per calendar day, ascending by day.
 *   returns { days:[{ dayMs, agreementRate, runCount, disagreed, errors, newFindings, newFindingKeys,
 *                      seenBefore }], dropped }
 * `agreementRate`/`disagreed`/`errors` are taken from the LATEST run of that day (the freshest measure);
 * `newFindings` is how many finding keys appeared THAT day that were never seen on an earlier day.
 */
function dailySeries(runs = []) {
  let dropped = 0;
  const byDay = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !isFiniteNum(r.dayMs)) { dropped += 1; continue; }
    const day = dayBucket(r.dayMs);
    const keys = Array.isArray(r.findingKeys) ? r.findingKeys.filter((k) => typeof k === 'string' && k) : [];
    const bucket = byDay.get(day) || { dayMs: day, runs: [], keys: new Set() };
    bucket.runs.push(r);
    for (const k of keys) bucket.keys.add(k);
    byDay.set(day, bucket);
  }

  const days = [];
  const seen = new Set(); // keys observed on any strictly-earlier day
  for (const dayMs of Array.from(byDay.keys()).sort((a, b) => a - b)) {
    const bucket = byDay.get(dayMs);
    // freshest run of the day drives the agreement measure
    const latest = bucket.runs.reduce((a, b) => (b.dayMs >= a.dayMs ? b : a), bucket.runs[0]);
    const summary = latest.summary && typeof latest.summary === 'object' ? latest.summary : {};
    const newKeys = [];
    for (const k of bucket.keys) if (!seen.has(k)) newKeys.push(k);
    days.push({
      dayMs,
      agreementRate: isFiniteNum(latest.agreementRate) ? latest.agreementRate
        : (isFiniteNum(summary.agreementRate) ? summary.agreementRate : null),
      runCount: bucket.runs.length,
      disagreed: isFiniteNum(summary.disagreed) ? summary.disagreed : null,
      errors: isFiniteNum(summary.errors) ? summary.errors : null,
      newFindings: newKeys.length,
      newFindingKeys: newKeys.sort(),
      seenBefore: seen.size,
    });
    for (const k of bucket.keys) seen.add(k);
  }
  return { days, dropped };
}

// The [{ dayMs, count }] shape cutover.consecutiveCleanDays consumes (count = NEW findings that day).
function dailyNewFindings(runs = []) {
  return dailySeries(runs).days.map((d) => ({ dayMs: d.dayMs, count: d.newFindings }));
}

// The most recent run's agreement rate (null when there is none / it is unmeasured).
function latestAgreementRate(runs = []) {
  let best = null; let bestDay = -Infinity;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !isFiniteNum(r.dayMs) || r.dayMs < bestDay) continue;
    if (r.dayMs > bestDay || best == null) { bestDay = r.dayMs; best = isFiniteNum(r.agreementRate) ? r.agreementRate : null; }
  }
  return best;
}

// The most recent run's `summary` object ({} when there is none), so the gate can read how much the
// latest canary actually compared (comparable / incomparable counts).
function latestRunSummary(runs = []) {
  let best = null; let bestDay = -Infinity;
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !isFiniteNum(r.dayMs) || r.dayMs < bestDay) continue;
    if (r.dayMs > bestDay || best == null) { bestDay = r.dayMs; best = (r.summary && typeof r.summary === 'object') ? r.summary : {}; }
  }
  return best || {};
}

/**
 * The direction of agreement over the trailing `window` measured days (default 7).
 * Compares the mean agreement of the newest half to the older half.
 *   returns { direction:'improving'|'flat'|'worsening'|'unknown', delta, samples }
 * `unknown` until at least 2 measured days exist. `eps` (default 0.001 = 0.1pt) is the flat band.
 */
function trend(days = [], opts = {}) {
  const window = Number.isInteger(opts.window) && opts.window > 0 ? opts.window : 7;
  const eps = isFiniteNum(opts.eps) ? opts.eps : 0.001;
  const measured = (Array.isArray(days) ? days : []).filter((d) => isFiniteNum(d.agreementRate)).slice(-window);
  if (measured.length < 2) return { direction: 'unknown', delta: null, samples: measured.length };
  const mid = Math.floor(measured.length / 2);
  const older = measured.slice(0, mid);
  const newer = measured.slice(mid);
  const mean = (a) => a.reduce((s, d) => s + d.agreementRate, 0) / a.length;
  const delta = mean(newer) - mean(older);
  const direction = delta > eps ? 'improving' : (delta < -eps ? 'worsening' : 'flat');
  return { direction, delta, samples: measured.length };
}

/**
 * Assemble one investor's full standing from raw canary runs + the finding ledger.
 *   runs     — the run records described above (the canary history).
 *   findings — the ledger rows `cutover.buildScoreboard` needs: [{ status, firstSeenMs }].
 *   opts     — { nowMs, settings (passed to cutover.eligibleForLive), trendWindow }
 * MEASURES here; DELEGATES the promote/no decision to cutover so "eligible" has one definition.
 * Returns { scoreboard, eligible, series, trend, latestAgreementRate, dropped }.
 */
function assemble(runs = [], findings = [], opts = {}) {
  const nowMs = isFiniteNum(opts.nowMs) ? opts.nowMs : null;

  // ⛔ THE RUNS THAT CANNOT BE READ ARE SET ASIDE FIRST (§2.126b), and this is the whole point of the
  // function. §2.122a built the reader — `runIsReadable`, `partitionReadable` — because the canary's
  // own leg used to hand our engine the RAW Lender Price scenario, so every agreement rate it recorded
  // is a number and not a measurement. NOTHING IN PRODUCTION EVER CALLED IT. Measured, 2026-08-19:
  // sixty runs that this codebase itself classifies as unreadable produced `agreementRate 1`,
  // `compared 305`, `cleanDays 60` and the verdict `{ eligible: true, reasons: [] }` — take this
  // investor live, nothing standing in the way. The recognition existed and never reached the one
  // decision it was built for.
  const all = Array.isArray(runs) ? runs : [];
  const readableRuns = all.filter((r) => provenance.recordIsReadable(r));
  const unreadableRuns = all.filter((r) => !provenance.recordIsReadable(r));

  const { days, dropped } = dailySeries(readableRuns);
  const canaryAgreementRate = latestAgreementRate(readableRuns);
  const latestSummary = latestRunSummary(readableRuns);

  // ⛔ AND AN UNREADABLE DAY BREAKS THE STREAK — it is not simply absent. `consecutiveCleanDays` walks
  // the entries it is GIVEN, so dropping a day silently joins the stretches either side of it into one
  // longer clean run: exactly the wrong direction, and invisible. A day whose evidence cannot be read
  // is not evidence of a clean day, so it is passed through carrying `readable: false`.
  const unreadableDayMs = new Set();
  for (const r of unreadableRuns) if (r && isFiniteNum(r.dayMs)) unreadableDayMs.add(dayBucket(r.dayMs));
  const dailyNew = days.map((d) => ({
    dayMs: d.dayMs, count: d.newFindings, readable: !unreadableDayMs.has(d.dayMs),
  }));
  const covered = new Set(days.map((d) => d.dayMs));
  for (const dm of unreadableDayMs) if (!covered.has(dm)) dailyNew.push({ dayMs: dm, count: 0, readable: false });
  const buckets = parity.bucketsOf(latestSummary);
  const scoreboard = cutover.buildScoreboard({
    canaryAgreementRate,
    // how much the freshest canary actually compared (§10.5/§10.6) — the gate reads these
    //
    // ⛔ THROUGH THE SHARED DEFINITION (§2.77), not off `comparable` directly. `comparable` is
    // agreed + disagreed and an ENGINE ERROR lands in `disagreed`, so the raw figure counts scenarios
    // where nothing was compared at all — and since §2.73 this number is a real coverage FLOOR on
    // promotion. The canary's own verdict has always subtracted the errors; the gate's copy did not,
    // so one run reported `compared: 6` and `coverage: 10` about the same ten scenarios.
    //
    // A run with NO summary must stay `null` — "not measured" and "measured zero" send a reader to two
    // different places, and `comparedOf` answers 0 for both.
    // THROUGH `parity.bucketsOf`, which is `comparedOf` plus the three buckets the board was silently
    // dropping (§2.79). `compared` is byte-identical to what this line computed before — bucketsOf keeps
    // comparedOf's own precondition, so a summary with no `comparable` figure still reports null.
    canaryScenarioCount: buckets.compared,
    canaryIncomparable: isFiniteNum(latestSummary.incomparable) ? latestSummary.incomparable : null,
    // THE REST OF THE SPLIT, so the page adds up. A 300-scenario run reporting `196 compared` beside a
    // `0` incomparable count leaves 104 scenarios named nowhere, and the only remedy its refusal
    // suggested — a bigger battery — is the one that cannot help.
    canaryScenarios: buckets.scenarios,
    canaryOverlay: buckets.compared == null ? null : buckets.overlay,
    canaryErrors: buckets.compared == null ? null : buckets.errors,
    canaryUnaccounted: buckets.unaccounted,
    findings: Array.isArray(findings) ? findings : [],
    dailyNewFindings: dailyNew,
    // §2.126b — the census, so a refusal can name the remedy. "No canary run has proven 100%
    // agreement" is TRUE of sixty unreadable runs and points at the one action that cannot help.
    canaryRunsReadable: readableRuns.length,
    canaryRunsUnreadable: unreadableRuns.length,
    nowMs,
  });
  const eligible = cutover.eligibleForLive(scoreboard, opts.settings || {});
  return {
    scoreboard,
    eligible,
    series: days,
    trend: trend(days, { window: opts.trendWindow }),
    latestAgreementRate: canaryAgreementRate,
    dropped,
    // Every number above is derived from `readableRuns` alone. These say how much was set aside, so a
    // reader can tell "nobody has measured this investor" from "everything measured is unreadable".
    runsReadable: readableRuns.length,
    runsUnreadable: unreadableRuns.length,
  };
}

module.exports = {
  DAY_MS,
  dailySeries, dailyNewFindings, latestAgreementRate, latestRunSummary, trend, assemble,
  _internals: { dayBucket },
};
