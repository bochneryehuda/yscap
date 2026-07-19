'use strict';

/**
 * Credit score selection + bracket engine (Xactus / MISMO 2.3.1 tri-merge).
 *
 * Pure logic, no DB / no network — the single source of truth for how a credit
 * report's bureau scores become (a) a per-borrower middle score, (b) the loan's
 * representative score, and (c) the standard credit-score bracket that drives
 * the "score changed → re-register" reset. Everything here is unit-tested in
 * scripts/test-credit-scoring.js.
 *
 * Owner rules (2026-07-19):
 *   - Per borrower: MIDDLE of three, LOWER of two, the one if one, NO-SCORE if
 *     zero usable bureau scores (no-score => manual review, never numeric 0).
 *   - Loan representative score = the HIGHEST of the borrowers' middle scores
 *     (business-purpose RTL; matches the existing pricing GREATEST() — #99).
 *   - Reset trigger = the STANDARD 20-point mortgage credit-score brackets. A
 *     verified score in a DIFFERENT bracket than the priced-on estimate reopens
 *     re-registration even if the price would not change. This bracket set is a
 *     separate config used ONLY for the reset decision — it is not a pricing
 *     calculation and changes no frozen pricing numbers.
 *
 * Parsing-safety (from the bug-hunt): `_Value` arrives as a STRING; we never
 * trust it until we've (1) checked for an exclusion, (2) asserted the bureau's
 * mortgage model, (3) range-guarded the integer. A "no-score" reject code
 * (9001/9002/9003) or a 0 must never become a 300-850 score.
 */

// Valid mortgage score band. (Read the model's own min/max from the response
// KEY dictionary when present; this is the classic-FICO default.)
const SCORE_MIN = 300;
const SCORE_MAX = 850;

// The GSE-required classic mortgage FICO model per bureau (assert before using
// a value — VantageScore / FICO 8 / 10T are 300-850 too, so a range check alone
// will not catch a wrong model; only the model name will).
const MORTGAGE_MODELS = {
  Equifax: 'EquifaxBeacon5.0',
  Experian: 'ExperianFairIsaac',
  TransUnion: 'FICORiskScoreClassic04',
};

// Known "score value that is actually a no-score reject code" (Experian family)
// -> map to a human reason. Any other out-of-band value is still rejected by the
// range guard; these are just for a clearer audit reason.
const EXCLUSION_VALUE_CODES = {
  9001: 'deceased',
  9002: 'no-recent-activity',
  9003: 'insufficient-credit',
};

// Standard 20-point mortgage credit-score brackets (owner-confirmed 2026-07-19,
// incl. the 760-779 / 780+ split). Config: adjust here, never in the pricing
// engine. Ordered low → high, contiguous, covering the whole valid band.
const BRACKETS = [
  { min: 300, max: 619, label: '<620' },
  { min: 620, max: 639, label: '620-639' },
  { min: 640, max: 659, label: '640-659' },
  { min: 660, max: 679, label: '660-679' },
  { min: 680, max: 699, label: '680-699' },
  { min: 700, max: 719, label: '700-719' },
  { min: 720, max: 739, label: '720-739' },
  { min: 740, max: 759, label: '740-759' },
  { min: 760, max: 779, label: '760-779' },
  { min: 780, max: 850, label: '780+' },
];

/** Parse a MISMO `_Value` string to a valid mortgage-band integer, or null.
 * Strict: only an all-digits value inside [min,max] passes. Catches "", "0",
 * "9002", "718abc", leading-zero oddities, etc. */
function parseScoreValue(raw, min = SCORE_MIN, max = SCORE_MAX) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{1,4}$/.test(s)) return null;          // non-numeric / junk
  if (s.length > 1 && s[0] === '0') return null;  // leading-zero => malformed, fail safe (→ no-score)
  const n = parseInt(s, 10);
  if (n < min || n > max) return null;
  return n;
}

/** The standard credit-score bracket LABEL for a score (300-850), else null. */
function bracketOf(score) {
  const n = parseScoreValue(score);
  if (n == null) return null;
  const b = BRACKETS.find((br) => n >= br.min && n <= br.max);
  return b ? b.label : null;
}

/**
 * Classify ONE bureau score node into a usable score or a labeled reason.
 * `raw` = { bureau, model, value, exclusionReason }.
 *   - exclusionReason present (MISMO _ExclusionReasonType) → not usable.
 *   - model must match the bureau's mortgage model (when the bureau is known).
 *   - value must be an integer in [min,max]; a reject code / 0 / blank fails.
 * Returns { bureau, model, rawValue, value, usable, reason, exclusionReason }.
 */
function classifyScore(raw, opts = {}) {
  const min = opts.min || SCORE_MIN;
  const max = opts.max || SCORE_MAX;
  const bureau = raw && raw.bureau != null ? String(raw.bureau) : null;
  const model = raw && raw.model != null ? String(raw.model) : null;
  const rawValue = raw ? raw.value : undefined;
  const out = { bureau, model, rawValue, value: null, usable: false, reason: 'missing', exclusionReason: null,
    // Pass the bureau reason-code factors straight through so every classified
    // score keeps its "why" (adverse-action + display). Never affects scoring.
    factors: Array.isArray(raw && raw.factors) ? raw.factors : [] };

  // (1) explicit exclusion wins regardless of value
  const ex = raw && raw.exclusionReason != null ? String(raw.exclusionReason).trim() : '';
  if (ex) { out.reason = 'excluded'; out.exclusionReason = ex; return out; }

  // (2) a value that is a known no-score reject code (before range guard, for a
  //     clear reason label)
  const rawNum = raw != null && /^\d{1,4}$/.test(String(raw.value ?? '').trim())
    ? parseInt(String(raw.value).trim(), 10) : null;
  if (rawNum != null && EXCLUSION_VALUE_CODES[rawNum]) {
    out.reason = 'excluded'; out.exclusionReason = EXCLUSION_VALUE_CODES[rawNum]; return out;
  }

  // (3) model assertion — FAIL CLOSED: an unknown/absent bureau cannot have its
  //     model asserted, so it is NOT usable when model-checking is on (else an
  //     untagged VantageScore/FICO-8, also 300-850, would slip through).
  if (opts.requireModel !== false) {
    const expected = bureau ? MORTGAGE_MODELS[bureau] : undefined;
    if (!expected) { out.reason = 'unknown_bureau'; return out; }
    if (model !== expected) { out.reason = 'model_mismatch'; return out; }
  }

  // (4) range-guard the integer
  const v = parseScoreValue(rawValue, min, max);
  if (v == null) { out.reason = 'out_of_range'; return out; }

  out.value = v; out.usable = true; out.reason = 'ok';
  return out;
}

/** MIDDLE score for one borrower from that borrower's bureau score nodes.
 * 3 usable → median (index 1 of the sorted MULTISET — ties keep duplicates);
 * 2 → lower; 1 → that one; 0 → null (no-score). Returns a detail object. */
function borrowerMiddle(scoreNodes, opts = {}) {
  const classified = (Array.isArray(scoreNodes) ? scoreNodes : []).map((s) => classifyScore(s, opts));
  // ONE usable score per bureau — each bureau reports one score, so collapse any
  // duplicate-bureau nodes (first usable wins) before the median. This keeps the
  // median over ≤3 distinct bureaus (so a stray 4th node can't skew it) while
  // preserving genuine ties across *different* bureaus ({Eq:680, Ex:680, TU:720}
  // → 680, not deduped by value).
  const perBureau = new Map();
  for (const c of classified) {
    if (c.usable && !perBureau.has(c.bureau)) perBureau.set(c.bureau, c.value);
  }
  const usable = [...perBureau.values()].sort((a, b) => a - b); // ascending; ≤3 distinct bureaus

  let middle = null;
  if (usable.length >= 3) middle = usable[1];    // median of the three
  else if (usable.length === 2) middle = usable[0]; // lower of two
  else if (usable.length === 1) middle = usable[0];
  // 0 usable → middle stays null (no-score)

  return {
    middle,
    usableCount: usable.length,
    usedValues: usable,
    noScore: usable.length === 0,
    bracket: bracketOf(middle),
    classified,
  };
}

/** Loan REPRESENTATIVE score = the HIGHEST middle across the borrowers.
 * `borrowerMiddles` = array of numbers-or-null (one per borrower). Ignores nulls
 * when taking the max, but flags when any borrower had no usable score so the
 * caller can route to manual review. */
function loanRepresentative(borrowerMiddles) {
  const list = (Array.isArray(borrowerMiddles) ? borrowerMiddles : [])
    .map((m) => (m == null ? null : parseScoreValue(m)));
  const nums = list.filter((m) => m != null);
  const score = nums.length ? Math.max(...nums) : null;
  return {
    score,
    bracket: bracketOf(score),
    borrowerCount: list.length,
    scoredBorrowerCount: nums.length,
    hasNoScoreBorrower: list.some((m) => m == null),
  };
}

/** Did the verified score move to a DIFFERENT standard bracket than the
 * estimate it was priced on? True → reopen re-registration (even if the price
 * would not change). A null estimate vs a real verified score counts as changed. */
function bracketChanged(estimateScore, verifiedScore) {
  return bracketOf(estimateScore) !== bracketOf(verifiedScore);
}

module.exports = {
  SCORE_MIN, SCORE_MAX, MORTGAGE_MODELS, EXCLUSION_VALUE_CODES, BRACKETS,
  parseScoreValue, bracketOf, classifyScore, borrowerMiddle, loanRepresentative, bracketChanged,
};
