'use strict';
/**
 * R6.2 — Provenance wrapper for the Whole-Loan Underwriting Context.
 *
 * Every MATERIAL value in the whole-loan context carries where it came from, so
 * every underwriting conclusion can name its source, version, and confidence
 * (the review's "no unexplained answers"). This module builds + reads those
 * wrapped values. A missing value stays a wrapped null — NEVER coerced to 0 or
 * false (a required-but-absent fact must read as unknown, not as a real zero).
 *
 * Wrapped shape:
 *   { value, raw, source, sourceId, sourceVersion, confidence, governing }
 *
 * Pure: no DB, no AI.
 */

// Confidence levels, strongest → weakest.
const CONFIDENCE = Object.freeze(['definite', 'high', 'medium', 'low', 'unknown']);
const CONF_RANK = { definite: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/**
 * fact({value, raw?, source, sourceId?, sourceVersion?, confidence?, governing?})
 * A missing/undefined value becomes null with confidence 'unknown'.
 */
function fact(input) {
  const i = input || {};
  const missing = i.value === undefined || i.value === null;
  return {
    value: missing ? null : i.value,
    raw: i.raw !== undefined ? i.raw : (missing ? null : i.value),
    source: i.source || null,
    sourceId: i.sourceId || null,
    sourceVersion: i.sourceVersion || null,
    confidence: missing ? 'unknown' : (CONFIDENCE.includes(i.confidence) ? i.confidence : 'medium'),
    governing: !!i.governing,
  };
}

// A wrapped null placeholder for a required-but-absent fact.
function missing(source) {
  return fact({ value: null, source: source || null });
}

function isPresent(f) {
  return !!f && f.value !== null && f.value !== undefined;
}
function valueOf(f, fallback) {
  return isPresent(f) ? f.value : (fallback === undefined ? null : fallback);
}
function isWrapped(f) {
  return !!f && typeof f === 'object' && 'value' in f && 'confidence' in f && 'governing' in f;
}

// Rank helper for comparing two wrapped facts' confidence.
function moreConfident(a, b) {
  return (CONF_RANK[a && a.confidence] || 0) >= (CONF_RANK[b && b.confidence] || 0);
}

module.exports = { fact, missing, isPresent, valueOf, isWrapped, moreConfident, CONFIDENCE, CONF_RANK };
