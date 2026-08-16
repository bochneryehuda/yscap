'use strict';
/**
 * LT PPE — the findings REVIEW QUEUE (§10.4/§12): turn the durable findings ledger into a prioritized,
 * human-workable list. `finding.js` produces the records, `finding-store.js` persists them, and
 * `scoreboard.js` counts them for the cutover gate — this is the layer BETWEEN the ledger and a human:
 * given the stored records, it decides what a reviewer should look at FIRST.
 *
 * It only ORGANIZES. It never decides an investor's fate (that is `cutover`/`cutover-ledger`), never
 * persists (that is `finding-store`), and never explains the numeric build-up of one gap (that is
 * `divergence`). So each of those keeps its single definition and this stays a pure, offline-testable
 * ranker + roll-up.
 *
 * Two honesty rules carried from §10.6:
 *   - a finding whose kind we don't recognise is surfaced (severity `high`), never silently ranked low;
 *   - an `incomparable` scenario is a real item a human must resolve (we could not prove agreement), so
 *     it ranks high — it is never treated as agreement and never hidden.
 *
 * Pure + clock-injected (`nowMs`). LT-only; no RTL imports.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Severity order, worst first. A numeric weight drives the priority score.
const SEVERITY = { critical: 4, high: 3, medium: 2, low: 1 };

// Baseline severity by finding kind. `price_mismatch` is computed from the gap magnitude; anything
// unrecognised falls to `high` (surfaced, never silently low — §10.6).
const SEVERITY_BY_KIND = {
  eligibility_mismatch: 'critical', // we would approve/decline differently — the worst divergence
  engine_error: 'critical',         // our code threw — our bug to fix, not an LP disagreement
  incomparable: 'high',             // could not validate; never scored as agreement (§10.6)
  rate_mismatch: 'high',            // a coupon priced to a different note rate
  rung_missing_ours: 'high',        // LP offers a rung we do not — the borrower loses an option
  rung_missing_theirs: 'medium',    // we offer a rung LP does not — verify eligibility, less urgent
};

function isMilli(v) { return typeof v === 'number' && Number.isFinite(v); }
function abs(n) { return Math.abs(n); }
function bump(sev) {
  if (sev === 'critical' || sev === 'high') return 'critical';
  if (sev === 'medium') return 'high';
  return 'medium';
}

// The price gap for a price_mismatch, read from the stored structured diff (parity finding shape).
function gapMilliOf(rec) {
  const d = rec && rec.diff ? rec.diff : {};
  if (isMilli(d.deltaMilli)) return abs(d.deltaMilli);
  if (isMilli(d.ourPriceMilli) && isMilli(d.theirPriceMilli)) return abs(d.ourPriceMilli - d.theirPriceMilli);
  return null;
}

/**
 * Severity of ONE finding.
 *   opts.highMilli   (default 500  = 0.5 pt) — a price gap this big or bigger is `high`.
 *   opts.mediumMilli (default 100  = 0.1 pt) — a gap this big or bigger is `medium`; smaller is `low`.
 * A `regressed` finding (a fix that broke) is bumped one level. An unmeasurable price gap is `high`
 * (we know we disagree on price but cannot size it — worth a human, never ranked low).
 */
function severityOf(rec = {}, opts = {}) {
  const highMilli = isMilli(opts.highMilli) ? opts.highMilli : 500;
  const mediumMilli = isMilli(opts.mediumMilli) ? opts.mediumMilli : 100;
  let sev;
  if (rec.kind === 'price_mismatch') {
    const g = gapMilliOf(rec);
    if (g == null) sev = 'high';
    else if (g >= highMilli) sev = 'high';
    else if (g >= mediumMilli) sev = 'medium';
    else sev = 'low';
  } else {
    sev = SEVERITY_BY_KIND[rec.kind] || 'high'; // unknown kind -> surfaced, never silently low
  }
  if (rec.regressed) sev = bump(sev);
  return sev;
}

// Whole days a finding has been open (first seen -> now). null when unknowable.
function ageDays(rec, nowMs) {
  if (!isMilli(nowMs) || !isMilli(rec.firstSeenMs)) return null;
  return Math.max(0, Math.floor((nowMs - rec.firstSeenMs) / DAY_MS));
}

/**
 * A deterministic priority score — severity dominates, then a broken fix, then how often it recurs and
 * how long it has sat open. Higher = look at it sooner.
 */
function priorityScore(rec = {}, nowMs, opts = {}) {
  const sev = severityOf(rec, opts);
  const age = ageDays(rec, nowMs) || 0;
  const rec_ = Math.min(rec.recurrence || 1, 99);
  return (SEVERITY[sev] || 1) * 1000
    + (rec.regressed ? 500 : 0)
    + rec_ * 5
    + Math.min(age, 365);
}

/**
 * Build the review queue from the stored ledger.
 *   records: [...] finding-store records (each with key/kind/status/recurrence/firstSeenMs/diff...).
 *   opts: { nowMs, highMilli, mediumMilli, includeSettled=false }
 * Returns { items, settled, summary }:
 *   - items   — OPEN/triaged findings, each decorated { severity, score, ageDays }, worst first.
 *   - settled — fixed/verified/wontfix (returned so a UI can show them, never in the active queue).
 *   - summary — counts for the dashboard (see below).
 */
function buildQueue(records = [], opts = {}) {
  const nowMs = isMilli(opts.nowMs) ? opts.nowMs : null;
  const list = Array.isArray(records) ? records.filter(Boolean) : [];

  const active = [];
  const settled = [];
  for (const r of list) {
    if (r.status === 'open' || r.status === 'triaged') active.push(r);
    else settled.push(r);
  }

  const items = active.map((r) => ({
    ...r,
    severity: severityOf(r, opts),
    score: priorityScore(r, nowMs, opts),
    ageDays: ageDays(r, nowMs),
  })).sort((a, b) =>
    b.score - a.score
    || (b.lastSeenMs || 0) - (a.lastSeenMs || 0)
    || String(a.key).localeCompare(String(b.key)));

  const summary = summarize(items, settled, nowMs);
  const out = { items, settled: opts.includeSettled ? settled : settled.map(stripSettled), summary };
  return out;
}

function stripSettled(r) { return { key: r.key, investor: r.investor, kind: r.kind, status: r.status, recurrence: r.recurrence }; }

// Roll-up a reviewer/dashboard reads at a glance.
function summarize(items, settled, nowMs) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byKind = {};
  const byInvestor = {};
  const byStatus = { open: 0, triaged: 0 };
  let regressed = 0;
  let oldestOpenDays = null;

  for (const it of items) {
    bySeverity[it.severity] = (bySeverity[it.severity] || 0) + 1;
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    const inv = it.investor || '(unknown)';
    byInvestor[inv] = (byInvestor[inv] || 0) + 1;
    if (it.status === 'open' || it.status === 'triaged') byStatus[it.status] += 1;
    if (it.regressed) regressed += 1;
    if (it.ageDays != null && (oldestOpenDays == null || it.ageDays > oldestOpenDays)) oldestOpenDays = it.ageDays;
  }

  return {
    open: items.length,
    byStatus,
    bySeverity,
    byKind,
    byInvestor,
    regressed,
    settled: settled.length,
    oldestOpenDays,
    top: items.length ? { key: items[0].key, severity: items[0].severity, score: items[0].score } : null,
  };
}

module.exports = {
  DAY_MS, SEVERITY, SEVERITY_BY_KIND,
  severityOf, ageDays, priorityScore, buildQueue,
  _internals: { gapMilliOf, bump, summarize },
};
