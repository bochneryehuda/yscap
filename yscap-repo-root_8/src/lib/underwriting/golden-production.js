'use strict';
/**
 * #219 — the senior-underwriter-APPROVED golden production set + END-TO-END replay.
 *
 * R5.44 built an evaluation dataset from historical corrections; R5.45 compared two
 * runs. This adds the two things a production go/no-go needs on top:
 *
 *   1. An APPROVAL layer — a golden case only counts as ground truth once a SENIOR
 *      underwriter (or super-admin) has signed off on its correct verdict + the
 *      material findings that must appear. Auto-mined corrections are candidates;
 *      only human-approved cases gate a release.
 *   2. An END-TO-END replay — run each approved case's inputs through the ACTUAL
 *      pipeline (an injected runFn), score the result against the approved ground
 *      truth (a FALSE CLEAR when the pipeline cleared something the senior didn't;
 *      a MISSED MATERIAL when the pipeline omitted an approved material finding),
 *      and fold it through the strict production metrics (#218) into ONE pass/fail.
 *
 * PURE core (runFn injected — no DB, no pipeline import). NEVER THROWS.
 */
const productionMetrics = require('./production-metrics');
const shadow = require('./shadow-decision');

const SENIOR_ROLES = Object.freeze(new Set(['super_admin', 'senior_underwriter', 'chief_underwriter']));

function low(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function codes(v) { return Array.isArray(v) ? v.map(low).filter(Boolean) : []; }

/**
 * isSeniorApproved(c) — a case is release-grade ground truth iff a senior role
 * approved it AND it carries a ground-truth verdict. PURE, never throws.
 */
function isSeniorApproved(c) {
  try {
    const o = c || {};
    const ap = o.approval || {};
    const gt = o.groundTruth || o.ground_truth || {};
    return SENIOR_ROLES.has(low(ap.role)) && !!low(ap.by) && !!low(gt.verdict);
  } catch (_e) { return false; }
}

/** approvedSet(cases) → only the senior-approved cases. PURE, never throws. */
function approvedSet(cases) {
  try { return (Array.isArray(cases) ? cases : []).filter(isSeniorApproved); }
  catch (_e) { return []; }
}

/**
 * coverage(cases) → { total, approved, pending, byVerdict, fatalCases,
 *   materialFindingCases }  (PURE, never throws)
 * Proves the approved set actually covers the costly risks (a golden set that is
 * all easy clears can't catch a false clear — R5.44's fatal/false-clear weighting).
 */
function coverage(cases) {
  try {
    const list = Array.isArray(cases) ? cases : [];
    const approved = approvedSet(list);
    const byVerdict = {};
    let fatalCases = 0; let materialFindingCases = 0;
    for (const c of approved) {
      const gt = c.groundTruth || c.ground_truth || {};
      const v = shadow.canonicalVerdict(gt.verdict);
      byVerdict[v] = (byVerdict[v] || 0) + 1;
      if (v !== shadow.VERDICT.CLEAR) fatalCases += 1; // a non-clear ground truth is where a false clear can happen
      if (codes(gt.materialFindings || gt.material_findings).length > 0) materialFindingCases += 1;
    }
    return { total: list.length, approved: approved.length, pending: list.length - approved.length, byVerdict, fatalCases, materialFindingCases };
  } catch (_e) {
    return { total: 0, approved: 0, pending: 0, byVerdict: {}, fatalCases: 0, materialFindingCases: 0 };
  }
}

/**
 * scoreCase(runResult, groundTruth) → { verdict, outcome, missedMaterial,
 *   falseClear }  (PURE, never throws)
 *   falseClear     = the pipeline CLEARED but the approved truth was NOT clear.
 *   missedMaterial = an approved material finding code the pipeline did NOT surface.
 */
function scoreCase(runResult, groundTruth) {
  const rr = runResult || {}; const gt = groundTruth || {};
  const aiVerdict = shadow.canonicalVerdict(rr.verdict);
  const truthVerdict = shadow.canonicalVerdict(gt.verdict);
  const wantCodes = codes(gt.materialFindings || gt.material_findings);
  const gotCodes = new Set(codes(rr.findings || rr.findingCodes));
  const missedMaterial = wantCodes.some((code) => !gotCodes.has(code));
  const falseClear = aiVerdict === shadow.VERDICT.CLEAR && truthVerdict !== shadow.VERDICT.CLEAR && truthVerdict !== shadow.VERDICT.UNKNOWN;
  return { verdict: rr.verdict, outcome: gt.verdict, missedMaterial, falseClear };
}

/**
 * replay(cases, runFn, opts?) → Promise<{
 *   ran, skipped, metrics, release:{ pass, blockers }, coverage, cases:[...]
 * }>  (async; NEVER THROWS — a runFn that throws on one case is a skip, not a crash)
 *   runFn(input) → { verdict, findings:[codes] } | Promise thereof — the ACTUAL
 *     pipeline for one case's inputs. Injected so this stays unit-testable.
 *   The release PASSES only when the production metrics come back green (zero false
 *   clears, missed-material within threshold, enough approved cases).
 */
async function replay(cases, runFn, opts = {}) {
  const approved = approvedSet(cases);
  const cov = coverage(cases);
  const records = []; const perCase = [];
  for (const c of approved) {
    const gt = c.groundTruth || c.ground_truth || {};
    let rr = null;
    try { rr = await runFn(c.input != null ? c.input : c.inputs); }
    catch (_e) { rr = null; }
    if (rr == null) { perCase.push({ id: c.id || null, skipped: true }); continue; }
    const s = scoreCase(rr, gt);
    records.push({ verdict: s.verdict, outcome: s.outcome, missedMaterial: s.missedMaterial });
    perCase.push({ id: c.id || null, falseClear: s.falseClear, missedMaterial: s.missedMaterial });
  }
  const metrics = productionMetrics.productionMetrics(records, { thresholds: opts.thresholds });
  const pass = metrics.status === 'green';
  return {
    ran: records.length,
    skipped: perCase.filter((p) => p.skipped).length,
    metrics,
    release: { pass, blockers: metrics.blockers },
    coverage: cov,
    cases: perCase,
  };
}

module.exports = { SENIOR_ROLES, isSeniorApproved, approvedSet, coverage, scoreCase, replay };
