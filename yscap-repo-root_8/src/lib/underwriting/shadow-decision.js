'use strict';
/**
 * R5.47 — Shadow-decision capture + underwriter-disagreement review (ADVISORY).
 *
 * A shadow decision is the decision the AI WOULD have made, recorded silently
 * alongside the human underwriter's ACTUAL decision — the AI never acts on it.
 * Comparing the two on the same component is how we measure, safely and in
 * production, where the AI agrees with a real underwriter and — far more
 * important — where it DISAGREES, and in which direction:
 *
 *   FALSE CLEAR   the AI would have CLEARED what the human DECLINED/referred.
 *                 The dangerous direction: the AI would have let a bad loan
 *                 through. Every one of these is review-worthy, always.
 *   FALSE FLAG    the AI would have DECLINED/referred what the human CLEARED.
 *                 The cautious direction: annoying, not dangerous.
 *   AGREE         same canonical verdict.
 *   PARTIAL       neither cleared, but they differ (decline vs refer).
 *
 * This module normalizes a shadow decision, compares it to the human decision,
 * classifies the (dis)agreement + a severity, and marks which disagreements a
 * human should review. aggregateShadows() rolls a batch up into an agreement rate
 * + a false-clear count that release-gate.js / outcome-learning.js consume.
 *
 * Pure: no DB, no AI, no I/O. It records + compares; it changes no decision and
 * the AI never acts on a shadow. Advisory: disagreements are surfaced for a human
 * to review, never auto-applied. Never throws.
 */

// Canonical verdict buckets. Everything a component can conclude maps to one of
// these so two differently-worded verdicts still compare.
const VERDICT = Object.freeze({ CLEAR: 'clear', DECLINE: 'decline', REFER: 'refer', UNKNOWN: 'unknown' });

// Disagreement classes, worst first.
const CLASS = Object.freeze({
  AGREE: 'agree',
  FALSE_CLEAR: 'false_clear',   // AI cleared, human did not — the dangerous miss
  FALSE_FLAG: 'false_flag',     // AI declined/referred, human cleared — over-cautious
  PARTIAL: 'partial',           // neither cleared, but differ
  UNKNOWN: 'unknown',           // a verdict couldn't be read
});

const SEVERITY = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NONE: 'none' });

// Map many verdict spellings to a canonical bucket.
const CLEAR_WORDS = new Set(['clear', 'cleared', 'approve', 'approved', 'pass', 'passed', 'eligible', 'satisfied', 'accept', 'accepted', 'ok', 'yes', 'true', 'clear_to_close', 'ctc']);
const DECLINE_WORDS = new Set(['decline', 'declined', 'deny', 'denied', 'reject', 'rejected', 'fail', 'failed', 'ineligible', 'no', 'false', 'suspend', 'suspended', 'withdraw', 'withdrawn']);
const REFER_WORDS = new Set(['refer', 'referred', 'manual', 'manual_review', 'review', 'conditions', 'conditional', 'pending', 'more_info', 'escalate', 'escalated', 'hold']);

function canonicalVerdict(v) {
  if (v === true) return VERDICT.CLEAR;
  if (v === false) return VERDICT.DECLINE;
  const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === '') return VERDICT.UNKNOWN;
  if (CLEAR_WORDS.has(s)) return VERDICT.CLEAR;
  if (DECLINE_WORDS.has(s)) return VERDICT.DECLINE;
  if (REFER_WORDS.has(s)) return VERDICT.REFER;
  return VERDICT.UNKNOWN;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/**
 * captureShadow(shadow) → normalized { component, verdict (canonical), rawVerdict,
 * confidence, evidenceSpanIds, at, runId, model }.
 * A defensive normalization of whatever the AI produced, so the record is stable.
 * confidence is clamped to [0,1] when present; null otherwise.
 */
function captureShadow(shadow) {
  const s = shadow || {};
  const conf = num(s.confidence);
  return {
    component: s.component != null ? String(s.component) : null,
    verdict: canonicalVerdict(s.verdict != null ? s.verdict : s.decision),
    rawVerdict: s.verdict != null ? s.verdict : (s.decision != null ? s.decision : null),
    confidence: conf == null ? null : Math.max(0, Math.min(1, conf)),
    evidenceSpanIds: Array.isArray(s.evidenceSpanIds) ? s.evidenceSpanIds : [],
    at: s.at != null ? String(s.at) : null,
    runId: s.runId != null ? String(s.runId) : null,
    model: s.model != null ? String(s.model) : null,
  };
}

/**
 * compareToHuman(shadow, human, opts?) → {
 *   component, aiVerdict, humanVerdict, class, severity, reviewWorthy, confidence, reason
 * }
 *   shadow: the AI's would-be decision (raw or captured).
 *   human:  { verdict|decision, ... } the underwriter's ACTUAL decision.
 *   opts.reviewConfidence: a disagreement at/above this AI confidence is review-worthy
 *     even when it isn't a false clear (default 0.7).
 * Classifies the (dis)agreement and severity. A FALSE CLEAR is ALWAYS review-worthy.
 * When either side is unknown → class 'unknown', not a false anything (never invent a
 * disagreement from missing data).
 */
function compareToHuman(shadow, human, opts = {}) {
  const s = shadow && shadow.verdict && shadow.rawVerdict !== undefined ? shadow : captureShadow(shadow);
  const ai = s.verdict;
  const hv = canonicalVerdict((human && (human.verdict != null ? human.verdict : human.decision)));
  const reviewConf = num(opts.reviewConfidence);
  const confGate = reviewConf == null ? 0.7 : Math.max(0, Math.min(1, reviewConf));

  let klass = CLASS.UNKNOWN;
  let severity = SEVERITY.NONE;
  let reason = '';

  if (ai === VERDICT.UNKNOWN || hv === VERDICT.UNKNOWN) {
    klass = CLASS.UNKNOWN;
    severity = SEVERITY.NONE;
    reason = 'a verdict could not be read — no comparison';
  } else if (ai === hv) {
    klass = CLASS.AGREE;
    severity = SEVERITY.NONE;
    reason = `both ${ai}`;
  } else if (ai === VERDICT.CLEAR && hv !== VERDICT.CLEAR) {
    klass = CLASS.FALSE_CLEAR;
    // declined-by-human is worse than merely referred-by-human
    severity = hv === VERDICT.DECLINE ? SEVERITY.HIGH : SEVERITY.MEDIUM;
    reason = `the AI would have cleared what the underwriter ${hv === VERDICT.DECLINE ? 'declined' : 'referred'}`;
  } else if (hv === VERDICT.CLEAR && ai !== VERDICT.CLEAR) {
    klass = CLASS.FALSE_FLAG;
    severity = ai === VERDICT.DECLINE ? SEVERITY.MEDIUM : SEVERITY.LOW;
    reason = `the AI would have ${ai === VERDICT.DECLINE ? 'declined' : 'referred'} what the underwriter cleared`;
  } else {
    // neither cleared, but they differ (decline vs refer)
    klass = CLASS.PARTIAL;
    severity = SEVERITY.LOW;
    reason = `AI ${ai} vs underwriter ${hv} — neither a clear`;
  }

  const isDisagreement = klass !== CLASS.AGREE && klass !== CLASS.UNKNOWN;
  const highConf = s.confidence != null && s.confidence >= confGate;
  const reviewWorthy = klass === CLASS.FALSE_CLEAR || (isDisagreement && (severity === SEVERITY.HIGH || highConf));

  return {
    component: s.component,
    aiVerdict: ai,
    humanVerdict: hv,
    class: klass,
    severity,
    reviewWorthy,
    confidence: s.confidence,
    reason,
  };
}

/**
 * aggregateShadows(pairs, opts?) → {
 *   total, compared, agree, disagree,
 *   agreementRate,          // agree / compared (unknowns excluded from the denominator)
 *   falseClears, falseFlags, partial, unknown,
 *   reviewQueue: [compareToHuman(...) reviewWorthy rows, worst-severity first],
 *   byComponent: { [component]: { compared, agree, falseClears, falseFlags } },
 * }
 *   pairs: [{ shadow, human }]
 * The false-clear count is the release-gate's hard signal; agreementRate excludes
 * unknowns so a batch of unreadable verdicts can't inflate or deflate it.
 */
function aggregateShadows(pairs, opts = {}) {
  const list = Array.isArray(pairs) ? pairs : [];
  let compared = 0, agree = 0, falseClears = 0, falseFlags = 0, partial = 0, unknown = 0;
  const reviewQueue = [];
  const byComponent = {};
  for (const p of list) {
    if (!p) continue;
    const r = compareToHuman(p.shadow, p.human, opts);
    if (r.class === CLASS.UNKNOWN) { unknown++; continue; }
    compared++;
    const bc = byComponent[r.component] || (byComponent[r.component] = { compared: 0, agree: 0, falseClears: 0, falseFlags: 0 });
    bc.compared++;
    if (r.class === CLASS.AGREE) { agree++; bc.agree++; }
    else if (r.class === CLASS.FALSE_CLEAR) { falseClears++; bc.falseClears++; }
    else if (r.class === CLASS.FALSE_FLAG) { falseFlags++; bc.falseFlags++; }
    else if (r.class === CLASS.PARTIAL) partial++;
    if (r.reviewWorthy) reviewQueue.push(r);
  }
  const sevRank = { high: 0, medium: 1, low: 2, none: 3 };
  reviewQueue.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || String(a.component).localeCompare(String(b.component)));
  const disagree = compared - agree;
  return {
    total: list.length,
    compared,
    agree,
    disagree,
    agreementRate: compared > 0 ? +(agree / compared).toFixed(4) : 0,
    falseClears,
    falseFlags,
    partial,
    unknown,
    reviewQueue,
    byComponent,
  };
}

module.exports = {
  captureShadow,
  compareToHuman,
  aggregateShadows,
  canonicalVerdict,
  VERDICT,
  CLASS,
  SEVERITY,
  _internals: { num },
};
