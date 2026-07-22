'use strict';
/**
 * R5.45 — Offline replay runner: baseline vs candidate report + metric slices
 * (deterministic core, ADVISORY).
 *
 * The golden-scorer (R5.42/P3) scores ONE pipeline run against the answer key.
 * Before a change ships, the real question is comparative: did the CANDIDATE
 * (the proposed prompt/rule/model) do BETTER or WORSE than the current BASELINE
 * on the same corpus? This module is that diff. It replays a scored baseline run
 * against a scored candidate run, per file and in aggregate, and surfaces:
 *   - what REGRESSED (a case that passed on baseline now fails; a finding that
 *     used to fire and no longer does — a NEW false clear, the dangerous kind);
 *   - what IMPROVED (fail→pass; a false clear that got fixed);
 *   - the mean change in each metric, SLICED (by risk tier / doc family / any
 *     tag the caller supplies) so a change that helps overall but regresses one
 *     slice is not hidden by the average.
 * `toGateMetrics()` then assembles the exact shape the R5.46 release-gate reads,
 * so a replay flows straight into the hard gate that blocks a bad release.
 *
 * Pure: no DB, no AI, no I/O — it consumes two arrays of golden-scorer scoreCase
 * results the caller loaded/ran. Advisory: it MEASURES a candidate; a human /
 * the release gate decides whether to ship. Never throws.
 */

const METRICS = Object.freeze(['boundaryF1', 'classificationAccuracy', 'fieldAccuracy', 'findingRecall']);

// Pull the comparable metrics out of a golden-scorer scoreCase result. A missing
// metric is null (not 0) so it is EXCLUDED from a mean delta — "not measured" is
// never treated as a measured zero.
function readCase(c) {
  const g = c || {};
  return {
    fileId: g.fileId != null ? g.fileId : null,
    boundaryF1: numOrNull(g.boundaries && g.boundaries.f1),
    classificationAccuracy: numOrNull(g.classification && g.classification.accuracy),
    fieldAccuracy: numOrNull(g.fields && g.fields.accuracy),
    findingRecall: numOrNull(g.findings && g.findings.recall),
    falseClears: arr(g.findings && g.findings.falseClears),
    falsePositives: arr(g.findings && g.findings.falsePositives),
    pass: g.pass === true,
  };
}
// An explicit null/undefined is "not measured" → null (never a coerced 0). Check
// == null BEFORE Number(), since Number(null) === 0 would fabricate a measured
// zero — the same discipline release-gate.js uses for a SQL-NULL metric.
function numOrNull(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function arr(v) { return Array.isArray(v) ? v.filter((x) => x != null).map(String) : []; }
function mean(nums) { const f = nums.filter((n) => Number.isFinite(n)); return f.length ? +(f.reduce((s, n) => s + n, 0) / f.length).toFixed(4) : null; }
function diff(a, b) { return (a == null || b == null) ? null : +(a - b).toFixed(4); }
function setMinus(a, b) { const bs = new Set(b); return a.filter((x) => !bs.has(x)); }

function keyOf(fileId, opts, scoredCase) {
  if (opts && typeof opts.sliceBy === 'function') { try { return String(opts.sliceBy(scoredCase, fileId) || 'all'); } catch (_e) { return 'all'; } }
  if (opts && opts.tags && fileId != null && opts.tags[fileId] != null) return String(opts.tags[fileId]);
  return 'all';
}

/**
 * compareRuns(baseline, candidate, opts?) → {
 *   matched, onlyBaseline:[fileId], onlyCandidate:[fileId],
 *   cases:[{ fileId, slice, deltas:{metric→delta|null}, newFalseClears:[code],
 *            fixedFalseClears:[code], newFalsePositives:[code], transition }],
 *   summary:{ matched, meanDeltas, totalNewFalseClears, totalFixedFalseClears,
 *             regressedCases, improvedCases, passRateBaseline, passRateCandidate, passRateDelta },
 *   slices:{ [slice]:{ count, meanDeltas, newFalseClears, regressedCases } },
 *   sliceRegressions:[{ slice, metric, delta }],   // slices whose mean metric got WORSE (<0)
 * }
 *   baseline/candidate: [scoreCase result] — arrays of golden-scorer per-file scores.
 * Matched by fileId. `transition`: 'regressed' (pass→fail) / 'improved' (fail→pass)
 * / 'unchanged'. A NEW false clear = a finding the baseline caught that the
 * candidate now misses (the release-blocking signal).
 */
function compareRuns(baseline, candidate, opts = {}) {
  const bList = (Array.isArray(baseline) ? baseline : []).map(readCase);
  const cList = (Array.isArray(candidate) ? candidate : []).map(readCase);
  const bById = new Map(bList.filter((c) => c.fileId != null).map((c) => [c.fileId, c]));
  const cById = new Map(cList.filter((c) => c.fileId != null).map((c) => [c.fileId, c]));
  // A corpus should have one row per file. Surface a repeated fileId rather than
  // silently keeping only the last (Map-collision) — a caller can't trust a diff
  // built on a corpus with duplicate rows.
  const dupIds = (l) => { const seen = new Set(), dup = new Set(); for (const c of l) { if (c.fileId == null) continue; if (seen.has(c.fileId)) dup.add(c.fileId); else seen.add(c.fileId); } return [...dup]; };
  const duplicateIds = { baseline: dupIds(bList), candidate: dupIds(cList) };

  const onlyBaseline = [...bById.keys()].filter((id) => !cById.has(id));
  const onlyCandidate = [...cById.keys()].filter((id) => !bById.has(id));
  const matchedIds = [...bById.keys()].filter((id) => cById.has(id));

  const cases = [];
  const slices = {};
  const epsilon = opts.epsilon != null ? opts.epsilon : 0.0001;

  for (const id of matchedIds) {
    const b = bById.get(id), c = cById.get(id);
    const deltas = {};
    for (const m of METRICS) deltas[m] = diff(c[m], b[m]);
    const newFalseClears = setMinus(c.falseClears, b.falseClears); // used to fire, now missed
    const fixedFalseClears = setMinus(b.falseClears, c.falseClears);
    const newFalsePositives = setMinus(c.falsePositives, b.falsePositives);
    const transition = (b.pass && !c.pass) ? 'regressed' : (!b.pass && c.pass) ? 'improved' : 'unchanged';
    const slice = keyOf(id, opts, c);
    cases.push({ fileId: id, slice, deltas, newFalseClears, fixedFalseClears, newFalsePositives, transition });

    const s = slices[slice] || (slices[slice] = { count: 0, _byMetric: {}, newFalseClears: 0, regressedCases: [] });
    s.count++;
    for (const m of METRICS) { if (deltas[m] != null) (s._byMetric[m] = s._byMetric[m] || []).push(deltas[m]); }
    s.newFalseClears += newFalseClears.length;
    if (transition === 'regressed') s.regressedCases.push(id);
  }

  // Finalize per-slice means + collect slice regressions (a slice whose mean for a
  // metric dropped below -epsilon — a real localized regression an average hides).
  const sliceRegressions = [];
  for (const slice of Object.keys(slices)) {
    const s = slices[slice];
    s.meanDeltas = {};
    for (const m of METRICS) {
      const md = mean(s._byMetric[m] || []);
      s.meanDeltas[m] = md;
      if (md != null && md < -epsilon) sliceRegressions.push({ slice, metric: m, delta: md });
    }
    delete s._byMetric;
  }

  const meanDeltas = {};
  for (const m of METRICS) meanDeltas[m] = mean(cases.map((c) => c.deltas[m]).filter((d) => d != null));
  const passRate = (l) => l.length ? +(l.filter((c) => c.pass).length / l.length).toFixed(4) : 0;
  const bMatched = matchedIds.map((id) => bById.get(id));
  const cMatched = matchedIds.map((id) => cById.get(id));
  const prB = passRate(bMatched), prC = passRate(cMatched);

  return {
    matched: matchedIds.length,
    onlyBaseline, onlyCandidate,
    duplicateIds, // repeated fileIds within a corpus (only the last row was kept)
    cases,
    summary: {
      matched: matchedIds.length,
      meanDeltas,
      totalNewFalseClears: cases.reduce((n, c) => n + c.newFalseClears.length, 0),
      totalFixedFalseClears: cases.reduce((n, c) => n + c.fixedFalseClears.length, 0),
      regressedCases: cases.filter((c) => c.transition === 'regressed').map((c) => c.fileId),
      improvedCases: cases.filter((c) => c.transition === 'improved').map((c) => c.fileId),
      passRateBaseline: prB,
      passRateCandidate: prC,
      passRateDelta: +(prC - prB).toFixed(4),
    },
    slices,
    sliceRegressions,
  };
}

/**
 * toGateMetrics(comparison, extra?) → the R5.46 release-gate `evaluate` input.
 * Fills the parts a replay measures — dangerousFalseClears (new false clears
 * introduced) and sliceRegressions — and passes through the gate inputs the
 * corpus can't derive on its own (fatalRecall {candidate,baseline},
 * boundaryF1ByFamily, conditionClearPrecision, unsupported/citation counts,
 * suppressionRules) from `extra`. A caller pipes the result straight into
 * release-gate.evaluate(...).
 */
function toGateMetrics(comparison, extra = {}) {
  const cmp = comparison || {};
  const sum = cmp.summary || {};
  return {
    dangerousFalseClears: sum.totalNewFalseClears != null ? sum.totalNewFalseClears : 0,
    sliceRegressions: Array.isArray(cmp.sliceRegressions) ? cmp.sliceRegressions : [],
    fatalRecall: extra.fatalRecall,
    unsupportedFactCount: extra.unsupportedFactCount,
    nonexistentCitationCount: extra.nonexistentCitationCount,
    boundaryF1ByFamily: extra.boundaryF1ByFamily,
    conditionClearPrecision: extra.conditionClearPrecision,
    suppressionRules: extra.suppressionRules,
  };
}

module.exports = { compareRuns, toGateMetrics, METRICS, _internals: { readCase, mean, diff, setMinus } };
