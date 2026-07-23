'use strict';
/**
 * #194 — Close the calibration loop: OUTCOME INGESTION + RELIABILITY REPORT.
 *
 * R5.47 (shadow-decision.js) captures the AI's would-be verdict alongside the
 * human's and classifies agree / false-clear / false-flag. But the loop was never
 * CLOSED: nothing recorded, once the real outcome was known, whether the AI's
 * shadow verdict turned out RIGHT, and nothing measured whether the AI's stated
 * CONFIDENCE is trustworthy. This module adds the two missing halves:
 *
 *   scoreOutcome(aiVerdict, outcome) — pure. Given the AI's shadow verdict and the
 *     later-known outcome (the underwriter's FINAL decision, or the realized loan
 *     result), was the AI correct? + a dangerousMiss flag (AI cleared, outcome not).
 *
 *   reliabilityReport(records) — pure. Over shadow decisions whose outcome is now
 *     known, computes accuracy, a Brier score, a 10-bucket CALIBRATION curve
 *     (confidence bin → predicted vs actual accuracy → gap), Expected Calibration
 *     Error, the dangerous-miss (false-clear-confirmed) rate, and per-component
 *     slices. This is the reliability/calibration diagram the review asks for.
 *
 * The DB helpers (ingestOutcome / loadReliabilityReport) are best-effort and
 * lazy-require pg, so the pure core loads + unit-tests without a database.
 *
 * ADVISORY ONLY. It scores the AI against reality to measure trustworthiness; it
 * changes no decision, clears no condition, promotes nothing. The release gate
 * (release-gate.js) is what CONSUMES a reliability signal — this only measures it.
 * Pure core never throws.
 */

const shadow = require('./shadow-decision');

/**
 * scoreOutcome(aiVerdict, outcome) → { correct: true|false|null, aiVerdict,
 *   outcomeVerdict, dangerousMiss }
 * Canonicalizes both sides through the shadow-decision vocabulary. `correct` is
 * null when the outcome is unknown/unreadable (never scored as wrong on missing
 * data). dangerousMiss = the AI said CLEAR but the outcome was NOT clear — the
 * confirmed false-clear, the only truly costly error. Never throws.
 */
function scoreOutcome(aiVerdict, outcome) {
  let ai; let ov;
  try { ai = shadow.canonicalVerdict(aiVerdict); } catch (_e) { ai = shadow.VERDICT.UNKNOWN; }
  try { ov = shadow.canonicalVerdict(outcome); } catch (_e) { ov = shadow.VERDICT.UNKNOWN; }
  if (ai === shadow.VERDICT.UNKNOWN || ov === shadow.VERDICT.UNKNOWN) {
    return { correct: null, aiVerdict: ai, outcomeVerdict: ov, dangerousMiss: false };
  }
  const correct = ai === ov;
  const dangerousMiss = !correct && ai === shadow.VERDICT.CLEAR && ov !== shadow.VERDICT.CLEAR;
  return { correct, aiVerdict: ai, outcomeVerdict: ov, dangerousMiss };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp01(n) { return n == null ? null : Math.max(0, Math.min(1, n)); }

// Ten fixed calibration bins [0,0.1), … , [0.9,1.0] (1.0 lands in the last bin).
const BUCKETS = 10;
function bucketIndex(conf) {
  const i = Math.floor(conf * BUCKETS);
  return i >= BUCKETS ? BUCKETS - 1 : (i < 0 ? 0 : i);
}
function bucketLabel(i) {
  const lo = (i / BUCKETS).toFixed(1);
  const hi = ((i + 1) / BUCKETS).toFixed(1);
  return `${lo}-${hi}`;
}

/**
 * reliabilityReport(records, opts?) → {
 *   n, scored, unscored, accuracy,
 *   brierScore,                 // mean (confidence - correct)^2 over scored-with-confidence; null if none
 *   confidenceScored,           // scored records that carried a confidence
 *   calibration: [{ bucket, n, avgConfidence, accuracy, gap }],   // only non-empty bins
 *   ece,                        // Expected Calibration Error = Σ (n_b/N)·|acc_b − conf_b|; null if no confidence
 *   dangerousMisses, dangerousMissRate,   // confirmed false clears / scored
 *   byComponent: { [component]: { scored, correct, accuracy, dangerousMisses } },
 * }
 *   records: [{ verdict|aiVerdict|decision, confidence?, outcome|human_outcome, component? }]
 * Only records with a KNOWN outcome are scored (accuracy/Brier/calibration exclude
 * unknowns, so a batch of pending files can't skew the numbers). Pure, never throws.
 */
function reliabilityReport(records, opts = {}) {
  try {
    const list = Array.isArray(records) ? records : [];
    let scored = 0; let correctN = 0; let dangerousMisses = 0;
    let brierSum = 0; let confScored = 0; let eceWeightedSum = 0;
    const byComponent = {};
    const bins = Array.from({ length: BUCKETS }, () => ({ n: 0, confSum: 0, correct: 0 }));

    for (const rec of list) {
      if (!rec) continue;
      const aiRaw = rec.aiVerdict != null ? rec.aiVerdict : (rec.verdict != null ? rec.verdict : rec.decision);
      const outcomeRaw = rec.outcome != null ? rec.outcome : rec.human_outcome;
      const s = scoreOutcome(aiRaw, outcomeRaw);
      if (s.correct == null) continue;                 // unknown outcome — not scored
      scored++;
      const isCorrect = s.correct ? 1 : 0;
      correctN += isCorrect;
      if (s.dangerousMiss) dangerousMisses++;
      const comp = rec.component != null ? String(rec.component) : '(overall)';
      const bc = byComponent[comp] || (byComponent[comp] = { scored: 0, correct: 0, accuracy: 0, dangerousMisses: 0 });
      bc.scored++; bc.correct += isCorrect; if (s.dangerousMiss) bc.dangerousMisses++;

      const conf = clamp01(num(rec.confidence));
      if (conf != null) {
        confScored++;
        brierSum += (conf - isCorrect) * (conf - isCorrect);
        const b = bins[bucketIndex(conf)];
        b.n++; b.confSum += conf; b.correct += isCorrect;
      }
    }

    for (const comp of Object.keys(byComponent)) {
      const bc = byComponent[comp];
      bc.accuracy = bc.scored > 0 ? +(bc.correct / bc.scored).toFixed(4) : 0;
    }

    const calibration = [];
    for (let i = 0; i < BUCKETS; i++) {
      const b = bins[i];
      if (!b.n) continue;
      const avgConfidence = +(b.confSum / b.n).toFixed(4);
      const accuracy = +(b.correct / b.n).toFixed(4);
      calibration.push({ bucket: bucketLabel(i), n: b.n, avgConfidence, accuracy, gap: +(accuracy - avgConfidence).toFixed(4) });
      eceWeightedSum += b.n * Math.abs(accuracy - avgConfidence);
    }

    return {
      n: list.length,
      scored,
      unscored: list.length - scored,
      accuracy: scored > 0 ? +(correctN / scored).toFixed(4) : 0,
      brierScore: confScored > 0 ? +(brierSum / confScored).toFixed(4) : null,
      confidenceScored: confScored,
      calibration,
      ece: confScored > 0 ? +(eceWeightedSum / confScored).toFixed(4) : null,
      dangerousMisses,
      dangerousMissRate: scored > 0 ? +(dangerousMisses / scored).toFixed(4) : 0,
      byComponent,
    };
  } catch (_e) {
    return { n: 0, scored: 0, unscored: 0, accuracy: 0, brierScore: null, confidenceScored: 0, calibration: [], ece: null, dangerousMisses: 0, dangerousMissRate: 0, byComponent: {} };
  }
}

// ---------------------------------------------------------------------------
// DB helpers (best-effort). Lazy-require pg so the pure core loads without a DB.
// ---------------------------------------------------------------------------

/**
 * ingestOutcome(client, { applicationId, component, outcome, at }) → count filled.
 * Closes the loop: stamps the now-known outcome onto the OPEN shadow_decisions for
 * a file (those whose human_outcome is not yet set) so reliabilityReport can score
 * them. `outcome` is the underwriter's final decision or the realized result
 * (any spelling scoreOutcome understands). Best-effort: returns 0 and never throws
 * on a missing table / DB error. When `component` is given, only matching shadows
 * are stamped (the candidate_decision's component); otherwise every open shadow on
 * the file is stamped.
 */
async function ingestOutcome(client, { applicationId, component, outcome, at } = {}) {
  if (!client || !applicationId || outcome == null) return 0;
  const payload = JSON.stringify({ outcome: String(outcome), component: component != null ? String(component) : null, at: at != null ? String(at) : null });
  try {
    const r = await client.query(
      `UPDATE shadow_decisions
          SET human_outcome = $2::jsonb
        WHERE application_id = $1
          AND human_outcome IS NULL
          AND ($3::text IS NULL OR candidate_decision->>'component' = $3)`,
      [applicationId, payload, component != null ? String(component) : null]);
    return r.rowCount || 0;
  } catch (_e) { return 0; }
}

/**
 * loadReliabilityReport(client, { sinceDays, limit }) → reliabilityReport over the
 * shadow decisions whose outcome is known. Best-effort: an empty-but-valid report
 * on any DB error. Maps each row's candidate_decision (verdict + confidence +
 * component) and human_outcome (the realized outcome) into a report record.
 */
async function loadReliabilityReport(client, { sinceDays = 180, limit = 5000 } = {}) {
  const empty = reliabilityReport([]);
  if (!client) return empty;
  try {
    const days = Number.isFinite(Number(sinceDays)) ? Math.max(1, Number(sinceDays)) : 180;
    const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50000, Number(limit))) : 5000;
    const r = await client.query(
      `SELECT candidate_decision, human_outcome
         FROM shadow_decisions
        WHERE human_outcome IS NOT NULL
          AND created_at >= now() - ($1::int * interval '1 day')
        ORDER BY created_at DESC
        LIMIT $2`,
      [days, cap]);
    const records = (r.rows || []).map((row) => {
      const cd = row.candidate_decision || {};
      const ho = row.human_outcome || {};
      return {
        aiVerdict: cd.verdict != null ? cd.verdict : cd.decision,
        confidence: cd.confidence,
        component: cd.component,
        outcome: ho.outcome != null ? ho.outcome : ho.verdict != null ? ho.verdict : ho.decision,
      };
    });
    return reliabilityReport(records);
  } catch (_e) { return empty; }
}

module.exports = {
  scoreOutcome,
  reliabilityReport,
  ingestOutcome,
  loadReliabilityReport,
  _internals: { bucketIndex, bucketLabel, num, clamp01, BUCKETS },
};
