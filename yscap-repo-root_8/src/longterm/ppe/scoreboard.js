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
  const { days, dropped } = dailySeries(runs);
  const canaryAgreementRate = latestAgreementRate(runs);
  const scoreboard = cutover.buildScoreboard({
    canaryAgreementRate,
    findings: Array.isArray(findings) ? findings : [],
    dailyNewFindings: days.map((d) => ({ dayMs: d.dayMs, count: d.newFindings })),
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
  };
}

module.exports = {
  DAY_MS,
  dailySeries, dailyNewFindings, latestAgreementRate, trend, assemble,
  _internals: { dayBucket },
};
