'use strict';
/**
 * R5.20 / R5.21 — Conflict taxonomy + deterministic pre-classifier.
 *
 * The review's rule: a cross-document difference is NOT automatically a
 * conflict. Every difference is classified; only `true_conflict` and
 * `material_rule_breach` may support a condition. This module owns the category
 * vocabulary AND a deterministic pre-classifier that settles the cases that do
 * NOT need an LLM — leaving only genuinely ambiguous differences for the
 * contextual adjudicator (Prompt C).
 *
 * Deterministic verdicts here:
 *   no_conflict           the two values are identical (normalized)
 *   formatting_equivalent normalize identically (ABC LLC == A.B.C., L.L.C.)
 *   incomplete_evidence   one side is missing/blank
 *   superseded_source     one side comes from a superseded document
 *   timing_difference     same field, different as-of dates (two months, etc.)
 *   role_difference       the two claims describe different roles
 *   needs_adjudication    a real value difference on the same role+timing → the
 *                         adjudicator decides true_conflict vs expected_change vs
 *                         possible_extraction_error vs material_rule_breach
 *
 * Pure: no DB, no AI. classify() returns { category, conditionEligible, reason }.
 */

const CATEGORIES = Object.freeze([
  'true_conflict', 'expected_change', 'formatting_equivalent', 'role_difference',
  'timing_difference', 'superseded_source', 'possible_extraction_error',
  'incomplete_evidence', 'material_rule_breach', 'no_conflict', 'needs_adjudication',
]);

// Only these two ever support a condition.
const CONDITION_ELIGIBLE = new Set(['true_conflict', 'material_rule_breach']);

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}
// Aggressive normalization for equivalence: strip punctuation + common entity
// suffixes so "ABC Property Holdings, LLC" == "abc property holdings llc".
function normEntity(s) {
  return norm(s)
    .replace(/[.,'"()]/g, '')
    .replace(/\b(l\s?l\s?c|l\s?p|inc|incorporated|corp|corporation|co|company|ltd|limited|trust)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function digitsOnly(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
function isMoneyish(s) { return /^[\s$]*[\d,]+(\.\d+)?\s*$/.test(String(s || '')); }
function isBlank(v) { return v == null || String(v).trim() === ''; }

/**
 * classify(a, b, opts) — a/b: { value, role?, asOf?, sourceStatus? }
 *   opts.field, opts.entityLike (bool)
 * Returns { category, conditionEligible, reason }.
 */
function classify(a, b, opts = {}) {
  a = a || {}; b = b || {};

  // incomplete evidence — one side missing.
  if (isBlank(a.value) || isBlank(b.value)) {
    return verdict('incomplete_evidence', 'one side has no value to compare — request the missing evidence');
  }

  // identical (normalized) → no conflict.
  if (norm(a.value) === norm(b.value)) {
    return verdict('no_conflict', 'the values are identical');
  }

  // money/number: same digits, different formatting → formatting_equivalent.
  if ((isMoneyish(a.value) && isMoneyish(b.value)) && digitsOnly(a.value) === digitsOnly(b.value)) {
    return verdict('formatting_equivalent', 'same amount, different formatting');
  }

  // entity/name: normalize identically → formatting_equivalent.
  if (opts.entityLike && normEntity(a.value) && normEntity(a.value) === normEntity(b.value)) {
    return verdict('formatting_equivalent', 'same entity, different punctuation/suffix');
  }

  // superseded source — one side is from a superseded document.
  const aSup = a.sourceStatus === 'superseded';
  const bSup = b.sourceStatus === 'superseded';
  if (aSup !== bSup) {
    return verdict('superseded_source', 'one value comes from a superseded document — the current one governs');
  }

  // role difference — the claims describe different roles (borrower vs seller…).
  if (a.role && b.role && norm(a.role) !== norm(b.role)) {
    return verdict('role_difference', `different roles compared (${a.role} vs ${b.role})`);
  }

  // timing difference — same field, different as-of dates (e.g. two months of
  // bank statements; a payoff that legitimately changes over time).
  if (a.asOf && b.asOf && norm(a.asOf) !== norm(b.asOf)) {
    return verdict('timing_difference', 'the two values are as-of different dates — not necessarily a conflict');
  }

  // A real value difference on the same role + timing + current sources: this is
  // where judgment is needed (true conflict vs expected change vs OCR error vs
  // rule breach). Defer to the adjudicator — never guess a true_conflict.
  return verdict('needs_adjudication', 'a real difference on the same role/timing — needs contextual adjudication');
}

function verdict(category, reason) {
  return { category, conditionEligible: CONDITION_ELIGIBLE.has(category), reason };
}

module.exports = { classify, CATEGORIES, CONDITION_ELIGIBLE, _internals: { norm, normEntity, digitsOnly, isMoneyish, isBlank } };
