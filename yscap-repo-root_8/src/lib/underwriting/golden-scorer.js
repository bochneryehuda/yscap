'use strict';
/**
 * P3 — Golden-corpus scorer / offline replay comparator (deterministic, ADVISORY).
 *
 * The owner's Priority 3: build a permanent answer-key of 200-500 hand-labeled
 * files (correct page boundaries, classifications, extracted values, canonical
 * facts, conflicts, conditions, root cause, outcome), then be able to MEASURE a
 * candidate pipeline against it. This module is the measuring stick: given ONE
 * golden case (the truth) and the pipeline's ACTUAL output for that file, it
 * scores how close the pipeline came — boundary F1, classification accuracy,
 * field-extraction accuracy, and finding recall / false-positives — and rolls a
 * whole corpus up into one report. That report is what a release gate reads to
 * prove a change helped without regressing (zero new false clears, no fatal
 * recall drop).
 *
 * Pure: no DB, no I/O, no AI. The corpus/labels live in the DB (db/262
 * evaluation_cases); this scores rows the caller loads. Advisory — it measures a
 * candidate; it never ships or blocks one (a human/release-gate decides).
 */

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' '); }
function rate(n, d) { return d > 0 ? +(n / d).toFixed(4) : (d === 0 && n === 0 ? 1 : 0); }
function pageKey(pages) { return (Array.isArray(pages) ? pages : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b).join(','); }

// Boundary match: two logical documents match when their page SETS are equal.
function scoreBoundaries(goldenDocs, actualDocs) {
  const g = (goldenDocs || []).map((d) => ({ key: pageKey(d.pages), docType: d.docType }));
  const a = (actualDocs || []).map((d) => ({ key: pageKey(d.pages), docType: d.docType }));
  const aByKey = new Map();
  a.forEach((d) => { if (!aByKey.has(d.key)) aByKey.set(d.key, d); });
  let matched = 0;
  const pairs = [];
  for (const gd of g) {
    if (gd.key && aByKey.has(gd.key)) { matched++; pairs.push({ golden: gd, actual: aByKey.get(gd.key) }); }
  }
  return {
    expected: g.length, actual: a.length, matched,
    precision: rate(matched, a.length), recall: rate(matched, g.length),
    f1: (() => { const p = rate(matched, a.length), r = rate(matched, g.length); return (p + r) ? +((2 * p * r) / (p + r)).toFixed(4) : 0; })(),
    pairs, // boundary-matched golden↔actual doc pairs, for classification scoring
  };
}

// Classification: among boundary-matched documents, docType equality.
function scoreClassification(pairs) {
  const total = pairs.length;
  let correct = 0;
  const wrong = [];
  for (const p of pairs) {
    if (norm(p.golden.docType) === norm(p.actual.docType)) correct++;
    else wrong.push({ pages: p.golden.key, expected: p.golden.docType, actual: p.actual.docType });
  }
  return { total, correct, accuracy: rate(correct, total), wrong };
}

// Field extraction: per expected field key, does the actual value match (normalized)?
function scoreFields(goldenFields, actualFields) {
  const g = goldenFields || {};
  const a = actualFields || {};
  const keys = Object.keys(g);
  let correct = 0;
  const mismatches = [];
  for (const k of keys) {
    if (norm(g[k]) === norm(a[k])) correct++;
    else mismatches.push({ field: k, expected: g[k], actual: a[k] == null ? null : a[k] });
  }
  return { total: keys.length, correct, accuracy: rate(correct, keys.length), mismatches };
}

// Findings: did the findings we EXPECTED to fire actually fire (recall)? Which
// fired that we did NOT expect (false positives)? A false clear = an expected
// finding that did NOT fire (the dangerous miss) — surfaced explicitly.
function scoreFindings(goldenFindings, actualFindings) {
  const g = new Set((goldenFindings || []).map(norm).filter(Boolean));
  const a = new Set((actualFindings || []).map(norm).filter(Boolean));
  const missed = [...g].filter((c) => !a.has(c)); // false clears — expected but did not fire
  const falsePositives = [...a].filter((c) => !g.has(c));
  const hit = [...g].filter((c) => a.has(c));
  return {
    expected: g.size, fired: a.size, hit: hit.length,
    recall: rate(hit.length, g.size),
    missed, falsePositives,
    falseClears: missed, // alias — the metric a release gate cares most about
  };
}

/**
 * scoreCase(golden, actual, thresholds?) → a per-file score card + pass/fail.
 *   golden/actual: { documents:[{docType,pages}], fields:{...}, findings:[code], outcome? }
 *   thresholds: { boundaryF1, classificationAccuracy, fieldAccuracy, findingRecall,
 *                 maxFalseClears } — a case PASSES when it meets them all.
 */
function scoreCase(golden, actual, thresholds = {}) {
  const g = golden || {}, a = actual || {};
  const boundaries = scoreBoundaries(g.documents, a.documents);
  const classification = scoreClassification(boundaries.pairs);
  const fields = scoreFields(g.fields, a.fields);
  const findings = scoreFindings(g.findings, a.findings);

  const t = {
    boundaryF1: thresholds.boundaryF1 != null ? thresholds.boundaryF1 : 0.9,
    classificationAccuracy: thresholds.classificationAccuracy != null ? thresholds.classificationAccuracy : 0.9,
    fieldAccuracy: thresholds.fieldAccuracy != null ? thresholds.fieldAccuracy : 0.9,
    findingRecall: thresholds.findingRecall != null ? thresholds.findingRecall : 1, // never miss an expected finding by default
    maxFalseClears: thresholds.maxFalseClears != null ? thresholds.maxFalseClears : 0,
  };
  const pass = boundaries.f1 >= t.boundaryF1
    && classification.accuracy >= t.classificationAccuracy
    && fields.accuracy >= t.fieldAccuracy
    && findings.recall >= t.findingRecall
    && findings.falseClears.length <= t.maxFalseClears;

  return {
    fileId: g.fileId || a.fileId || null,
    boundaries: { expected: boundaries.expected, actual: boundaries.actual, matched: boundaries.matched, precision: boundaries.precision, recall: boundaries.recall, f1: boundaries.f1 },
    classification,
    fields,
    findings,
    pass,
    thresholds: t,
  };
}

/**
 * scoreCorpus(cases, thresholds?) → { cases:[scoreCase...], summary }.
 * `cases` is an array of { golden, actual }. The summary is the corpus-level
 * report a release gate reads: pass rate, mean boundary F1 / classification /
 * field accuracy / finding recall, and the TOTAL false clears (the number that
 * must not rise between baseline and candidate).
 */
function scoreCorpus(cases, thresholds = {}) {
  const list = Array.isArray(cases) ? cases : [];
  const scored = list.map((c) => scoreCase(c && c.golden, c && c.actual, thresholds));
  const n = scored.length;
  const mean = (sel) => n ? +(scored.reduce((s, c) => s + sel(c), 0) / n).toFixed(4) : 0;
  const totalFalseClears = scored.reduce((s, c) => s + c.findings.falseClears.length, 0);
  return {
    cases: scored,
    summary: {
      total: n,
      passed: scored.filter((c) => c.pass).length,
      passRate: rate(scored.filter((c) => c.pass).length, n),
      meanBoundaryF1: mean((c) => c.boundaries.f1),
      meanClassificationAccuracy: mean((c) => c.classification.accuracy),
      meanFieldAccuracy: mean((c) => c.fields.accuracy),
      meanFindingRecall: mean((c) => c.findings.recall),
      totalFalseClears,
      totalFalsePositives: scored.reduce((s, c) => s + c.findings.falsePositives.length, 0),
    },
  };
}

module.exports = { scoreCase, scoreCorpus, _internals: { scoreBoundaries, scoreClassification, scoreFields, scoreFindings, norm, pageKey } };
