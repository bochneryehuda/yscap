'use strict';
/**
 * R5.39 — Investor-fit reasoning (deterministic core, ADVISORY).
 *
 * A loan can often be placed with more than one investor/program, each with its own
 * guideline set (R5.32-36). After the deterministic evaluator (R5.35) runs a loan
 * against each investor's rules, SOMETHING has to answer the human question: "which
 * investor does this loan fit best, and — for the ones it doesn't — WHY not?" This
 * module takes the per-investor evaluation results and produces a ranked fit report
 * with a plain "Investor A vs B" differentiator: the exact rules that separate a fit
 * from a non-fit.
 *
 * Ranking (best first): a FIT (no blocking failures) beats a non-fit; among fits,
 * fewer advisory notes / exceptions is better; among non-fits, fewer + less-severe
 * blockers is closer. Deterministic tie-break on investor name so the order is
 * stable.
 *
 * Pure: no DB, no AI, no I/O. It RANKS + EXPLAINS already-computed evaluation
 * results; it runs no guideline itself, changes no decision, and picks no investor —
 * a human chooses. Advisory. Never throws.
 */

// Severity ranks for ordering blockers (lower = worse).
const SEV_RANK = Object.freeze({ fatal: 0, blocking: 0, high: 1, major: 1, medium: 2, low: 3, advisory: 4, info: 5 });
function sevRank(s) { const r = SEV_RANK[String(s == null ? '' : s).toLowerCase()]; return r == null ? 2 : r; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Normalize one investor's evaluation result to a stable shape.
//   { investor, eligible, failures:[{ ruleId, reason, severity }], notes:[...], score? }
// Wrapped so a hostile result object (e.g. a throwing getter on investor/failures)
// degrades to a safe non-fit rather than escaping the module's never-throws contract.
function normResult(r) {
  try { return normResultUnsafe(r); }
  catch (_e) { return { investor: 'unknown', eligible: false, failures: [], blockers: [], notes: [], exceptions: 0 }; }
}
function normResultUnsafe(r) {
  const rr = r || {};
  const investor = rr.investor != null ? String(rr.investor) : (rr.name != null ? String(rr.name) : (rr.id != null ? String(rr.id) : 'unknown'));
  const failsRaw = Array.isArray(rr.failures) ? rr.failures
    : (Array.isArray(rr.failedRules) ? rr.failedRules : (Array.isArray(rr.violations) ? rr.violations : []));
  const failures = failsRaw.filter(Boolean).map((f) => ({
    ruleId: f.ruleId != null ? String(f.ruleId) : (f.rule_id != null ? String(f.rule_id) : (f.id != null ? String(f.id) : null)),
    reason: f.reason != null ? String(f.reason) : (f.message != null ? String(f.message) : null),
    severity: String(f.severity == null ? 'blocking' : f.severity).toLowerCase(),
  }));
  // a BLOCKER is a failure whose severity is fatal/blocking/high/major (it stops a fit).
  const blockers = failures.filter((f) => sevRank(f.severity) <= sevRank('high'));
  const notes = Array.isArray(rr.notes) ? rr.notes.map(String) : [];
  // eligible: an explicit flag wins; else "no blockers".
  const eligible = rr.eligible === true ? true : (rr.eligible === false ? false : blockers.length === 0);
  return { investor, eligible, failures, blockers, notes, exceptions: Array.isArray(rr.exceptions) ? rr.exceptions.length : num(rr.exceptions) || 0 };
}

// A comparable "distance from a clean fit": blockers dominate, then a severity-weighted
// failure sum, then advisory notes/exceptions. Lower is a better fit.
function fitScore(n) {
  const blockerWeight = n.blockers.length * 1000;
  const sevWeight = n.failures.reduce((s, f) => s + (10 - sevRank(f.severity)), 0);
  return blockerWeight + sevWeight + n.notes.length + n.exceptions;
}

/**
 * rankInvestorFit(results, opts?) → {
 *   ranked: [{ investor, fit:'fits'|'fails', eligible, score, blockers:[{ruleId,reason,severity}],
 *              failures, notes }],
 *   best,                 // the top-ranked investor's name, or null when none fit / none given
 *   anyFit,               // true iff at least one investor is a clean fit
 *   comparison: [{ a, b, aFits, bFits, differentiators:[{ ruleId, reason, onlyOn }] }],
 * }
 *   results: [{ investor|name|id, eligible?, failures|failedRules|violations?, notes?, exceptions? }]
 * Ranks investors best-fit-first and, for each adjacent pair in the ranking, explains
 * the DIFFERENTIATORS — the rules that failed on one but not the other. Deterministic;
 * never throws.
 */
function rankInvestorFit(results, opts = {}) {
  const list = (Array.isArray(results) ? results : []).map(normResult);
  const ranked = list.slice().sort((a, b) => {
    // fits before non-fits
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const fa = fitScore(a), fb = fitScore(b);
    if (fa !== fb) return fa - fb;
    return a.investor.localeCompare(b.investor);
  }).map((n) => ({
    investor: n.investor,
    fit: n.eligible ? 'fits' : 'fails',
    eligible: n.eligible,
    score: fitScore(n),
    blockers: n.blockers,
    failures: n.failures,
    notes: n.notes,
  }));

  const anyFit = ranked.some((r) => r.eligible);
  const best = anyFit ? ranked.find((r) => r.eligible).investor : (ranked.length ? ranked[0].investor : null);

  // pairwise differentiators between adjacent ranked investors (the rules that
  // separate them) — the "Investor A vs B" explanation.
  const comparison = [];
  for (let i = 0; i + 1 < ranked.length; i++) {
    const a = ranked[i], b = ranked[i + 1];
    comparison.push(diffPair(a, b));
  }
  return { ranked, best, anyFit, comparison };
}

// The failed rules that are on exactly one of the two (the differentiators).
function diffPair(a, b) {
  const keyOf = (f) => f.ruleId || f.reason || JSON.stringify(f);
  const aFail = new Map(a.failures.map((f) => [keyOf(f), f]));
  const bFail = new Map(b.failures.map((f) => [keyOf(f), f]));
  const differentiators = [];
  for (const [k, f] of aFail) if (!bFail.has(k)) differentiators.push({ ruleId: f.ruleId, reason: f.reason, severity: f.severity, onlyOn: a.investor });
  for (const [k, f] of bFail) if (!aFail.has(k)) differentiators.push({ ruleId: f.ruleId, reason: f.reason, severity: f.severity, onlyOn: b.investor });
  return { a: a.investor, b: b.investor, aFits: a.eligible, bFits: b.eligible, differentiators };
}

/**
 * compareInvestors(results, a, b) → the differentiator report for exactly two named
 * investors (a direct "A vs B"), or null when either isn't in results. Never throws.
 */
function compareInvestors(results, a, b) {
  const list = (Array.isArray(results) ? results : []).map(normResult);
  const ra = list.find((r) => r.investor === String(a));
  const rb = list.find((r) => r.investor === String(b));
  if (!ra || !rb) return null;
  return diffPair(
    { investor: ra.investor, eligible: ra.eligible, failures: ra.failures },
    { investor: rb.investor, eligible: rb.eligible, failures: rb.failures });
}

module.exports = {
  rankInvestorFit,
  compareInvestors,
  _internals: { normResult, fitScore, sevRank, diffPair },
};
