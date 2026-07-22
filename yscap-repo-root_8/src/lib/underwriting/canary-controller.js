'use strict';
/**
 * R5.48 — Canary release + monitored production + auto-rollback (decision core, ADVISORY).
 *
 * When a new artifact version (a model, a prompt, a rule set) is released, it goes
 * out as a CANARY: a small share of live traffic runs the new brain while the rest
 * stays on the proven baseline. Something has to watch the canary's live metrics and
 * decide, deterministically, one of three things:
 *
 *   ROLLBACK   the canary is HURTING — its false-clear rate crossed the hard ceiling,
 *              or its error/disagreement rate regressed materially vs baseline. Pull
 *              it immediately. (A false clear — the AI clearing a loan a human would
 *              decline — is the signal that trips the fastest, at any sample size.)
 *   HOLD       not enough evidence yet (too few samples), or the metrics are within
 *              noise — keep watching, don't promote.
 *   PROMOTE    enough samples AND no breach AND (over a history) a stable run of clean
 *              checks — the canary is safe to widen.
 *
 * evaluateCanary() judges ONE observation window; decideRollout() applies the
 * promote-after-N-stable / rollback-on-any-breach policy across a sequence of them.
 *
 * Pure: no DB, no AI, no I/O, no deploys — it RECOMMENDS an action ops (or an
 * automated pipeline) applies; it rolls nothing back itself and changes no decision.
 * Advisory. Never throws. It reads metrics the monitoring layer supplies (it does
 * not compute them and never touches the clock, so it stays deterministic/replayable).
 */

const DECISION = Object.freeze({ PROMOTE: 'promote', HOLD: 'hold', ROLLBACK: 'rollback' });

// Default policy — deliberately conservative on the dangerous direction.
const DEFAULTS = Object.freeze({
  minSamples: 50,               // below this, HOLD (insufficient evidence to promote)
  maxFalseClearRate: 0,         // ANY false clear over baseline+this trips rollback (0 = zero tolerance)
  baselineFalseClearRate: 0,    // the baseline's own false-clear rate (canary must not exceed it + max)
  errorRegressionTolerance: 0.5, // canary error rate may be at most (1+tol)× baseline, over an absolute floor
  errorAbsoluteFloor: 0.02,     // ignore error regressions when both rates are under this (noise)
  disagreementRegressionTolerance: 0.5,
  disagreementAbsoluteFloor: 0.05,
  promoteAfterStableChecks: 3,  // consecutive clean (PROMOTE-eligible) windows before decideRollout promotes
});

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function rate(v) { const n = num(v); return n == null ? null : Math.max(0, n); }

/**
 * evaluateCanary(canary, baseline, opts?) → {
 *   decision: 'promote' | 'hold' | 'rollback',
 *   breaches: [{ metric, canary, baseline, threshold, reason }],   // rollback drivers
 *   reasons: [string],
 *   sampleSize,
 * }
 *   canary:   { sampleSize|n, falseClearRate, errorRate?, disagreementRate? }
 *   baseline: { falseClearRate?, errorRate?, disagreementRate? }
 * A ROLLBACK breach always wins (even below minSamples — a false clear is dangerous
 * at any volume). Otherwise, too few samples → HOLD; enough samples + no breach →
 * PROMOTE. Rates are treated as fractions (0..1). Never throws.
 */
function evaluateCanary(canary, baseline, opts = {}) {
  const o = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };
  const c = canary && typeof canary === 'object' ? canary : {};
  const b = baseline && typeof baseline === 'object' ? baseline : {};
  const sampleSize = (() => { const n = num(c.sampleSize != null ? c.sampleSize : c.n); return n == null || n < 0 ? 0 : Math.floor(n); })();

  const breaches = [];
  const reasons = [];

  // 1. FALSE CLEAR — the hard, always-checked ceiling. The canary's false-clear rate
  //    may not exceed the baseline's by more than maxFalseClearRate.
  const cFalse = rate(c.falseClearRate);
  const bFalse = rate(b.falseClearRate != null ? b.falseClearRate : o.baselineFalseClearRate) || 0;
  if (cFalse != null) {
    const ceiling = bFalse + o.maxFalseClearRate;
    if (cFalse > ceiling) {
      breaches.push({ metric: 'falseClearRate', canary: cFalse, baseline: bFalse, threshold: ceiling, reason: `false-clear rate ${cFalse} exceeds the ceiling ${ceiling}` });
    }
  }

  // 2. ERROR RATE regression — only when the canary rate clears an absolute floor
  //    (so tiny rates on tiny samples don't trip it) AND regresses beyond tolerance.
  regressionBreach('errorRate', rate(c.errorRate), rate(b.errorRate), o.errorRegressionTolerance, o.errorAbsoluteFloor, breaches);
  // 3. DISAGREEMENT (vs underwriters) regression — same shape.
  regressionBreach('disagreementRate', rate(c.disagreementRate), rate(b.disagreementRate), o.disagreementRegressionTolerance, o.disagreementAbsoluteFloor, breaches);

  let decision;
  if (breaches.length) {
    decision = DECISION.ROLLBACK;
    for (const br of breaches) reasons.push(br.reason);
  } else if (sampleSize < o.minSamples) {
    decision = DECISION.HOLD;
    reasons.push(`only ${sampleSize} samples (need ${o.minSamples} to promote)`);
  } else {
    decision = DECISION.PROMOTE;
    reasons.push(`no breaches over ${sampleSize} samples`);
  }

  return { decision, breaches, reasons, sampleSize };
}

// Push a regression breach when `c` regresses past (1+tol)×`b` AND `c` is over the floor.
function regressionBreach(metric, c, b, tol, floor, breaches) {
  if (c == null) return;
  const base = b == null ? 0 : b;
  if (c < floor) return; // under the noise floor — never a breach
  const ceiling = base * (1 + tol);
  if (c > ceiling && c > base) {
    breaches.push({ metric, canary: c, baseline: base, threshold: ceiling, reason: `${metric} ${c} regressed past ${ceiling} (baseline ${base})` });
  }
}

/**
 * decideRollout(history, opts?) → {
 *   decision: 'promote' | 'hold' | 'rollback',
 *   stableChecks,      // trailing consecutive PROMOTE-eligible windows
 *   reason,
 *   lastBreaches,      // breaches from the most recent window (if any)
 * }
 *   history: [canaryEval | { canary, baseline }]  — a time-ordered sequence, OLDEST
 *            first. Entries may be raw {canary,baseline} pairs (evaluated here) or
 *            the outputs of evaluateCanary().
 * Policy: ANY rollback breach in the MOST RECENT window → ROLLBACK now (don't wait).
 * Else PROMOTE only after `promoteAfterStableChecks` consecutive PROMOTE windows at
 * the tail. Otherwise HOLD. A single bad window resets the stable streak. Never throws.
 */
function decideRollout(history, opts = {}) {
  const o = { ...DEFAULTS, ...(opts && typeof opts === 'object' ? opts : {}) };
  const list = Array.isArray(history) ? history : [];
  const evals = list.map((h) => {
    if (h && h.decision && Array.isArray(h.breaches)) return h; // already an eval
    const hh = h && typeof h === 'object' ? h : {};
    return evaluateCanary(hh.canary, hh.baseline, o);
  });

  if (evals.length === 0) {
    return { decision: DECISION.HOLD, stableChecks: 0, reason: 'no observations yet', lastBreaches: [] };
  }
  const last = evals[evals.length - 1];
  if (last.decision === DECISION.ROLLBACK) {
    return { decision: DECISION.ROLLBACK, stableChecks: 0, reason: 'the most recent window breached — rolling back', lastBreaches: last.breaches };
  }
  // count trailing consecutive PROMOTE-eligible windows
  let stable = 0;
  for (let i = evals.length - 1; i >= 0; i--) {
    if (evals[i].decision === DECISION.PROMOTE) stable++;
    else break;
  }
  if (stable >= o.promoteAfterStableChecks) {
    return { decision: DECISION.PROMOTE, stableChecks: stable, reason: `${stable} consecutive clean windows (need ${o.promoteAfterStableChecks})`, lastBreaches: [] };
  }
  return { decision: DECISION.HOLD, stableChecks: stable, reason: `${stable}/${o.promoteAfterStableChecks} clean windows so far`, lastBreaches: [] };
}

module.exports = {
  evaluateCanary,
  decideRollout,
  DECISION,
  DEFAULTS,
  _internals: { num, rate, regressionBreach },
};
