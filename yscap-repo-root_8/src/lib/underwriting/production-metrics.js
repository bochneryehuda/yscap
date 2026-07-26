'use strict';
/**
 * #218 — STRICT production-metrics dashboard.
 *
 * The reliability report (reliability.js) computes accuracy / calibration / Brier
 * and, buried among them, the dangerous-miss rate. For a lender putting an AI
 * underwriter into production, two SAFETY numbers dwarf every accuracy stat and
 * must be the HEADLINE:
 *
 *   1. FALSE-CLEAR rate  — the AI said CLEAR but reality was NOT clear. The costly
 *      error: a real problem waved through. The release bar is ZERO (release-gate.js).
 *   2. MISSED-MATERIAL rate — the AI's finding set OMITTED a material issue a human
 *      later added. A near-miss even when the loan-level verdict happened to hold.
 *
 * This module recomputes both from the same scored outcomes and frames a blunt
 * production-readiness STATUS (green / amber / red / insufficient_data) against
 * strict thresholds — so "are we safe to run this live?" has one honest answer.
 *
 * PURE core; composes reliability.js. NEVER THROWS. The DB loader is best-effort.
 */
const reliability = require('./reliability');
const shadow = require('./shadow-decision');

const DEFAULT_THRESHOLDS = Object.freeze({
  falseClearMax: 0,        // ZERO false clears — the hard release bar.
  missedMaterialMax: 0.02, // ≤ 2% missed material findings.
  falseFlagWarn: 0.15,     // over-flagging above 15% is a nuisance-cost amber.
  minSample: 20,           // below this the numbers aren't trustworthy yet.
});

function rate(x, d) { return d > 0 ? x / d : null; }
function pickAi(r) { const o = r || {}; return o.verdict != null ? o.verdict : (o.aiVerdict != null ? o.aiVerdict : o.decision); }
function pickOutcome(r) { const o = r || {}; return o.outcome != null ? o.outcome : (o.human_outcome != null ? o.human_outcome : o.humanOutcome); }
function isMissedMaterial(r) { const o = r || {}; return o.missedMaterial === true || o.missed_material === true; }

/**
 * productionMetrics(records, opts?) → {
 *   sampleSize, headline:{ falseClearRate, missedMaterialRate },
 *   falseClears, falseClearRate, missedMaterial, missedMaterialRate,
 *   falseFlags, falseFlagRate, accuracy, ece, brierScore, byComponent,
 *   status:'green'|'amber'|'red'|'insufficient_data', thresholds, blockers:[...]
 * }  (PURE, NEVER THROWS)
 *   records: [{ verdict|aiVerdict|decision, outcome|human_outcome, component?,
 *               missedMaterial? }]
 */
function productionMetrics(records, opts = {}) {
  try {
    const list = Array.isArray(records) ? records : [];
    const t = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
    const rel = reliability.reliabilityReport(list.map((r) => ({
      aiVerdict: pickAi(r), confidence: r && r.confidence, component: r && r.component, outcome: pickOutcome(r),
    })));
    const scored = rel.scored || 0;
    const falseClears = rel.dangerousMisses || 0;
    const falseClearRate = rel.dangerousMissRate != null ? rel.dangerousMissRate : rate(falseClears, scored);

    let missedMaterial = 0; let falseFlags = 0;
    for (const r of list) {
      const s = reliability.scoreOutcome(pickAi(r), pickOutcome(r));
      if (s.correct === null) continue; // unscored — never counts against us
      if (isMissedMaterial(r)) missedMaterial += 1;
      // false FLAG = AI said NOT clear but reality was clear (over-flagging — a
      // nuisance cost, never dangerous). Tracked so we can see the trade-off.
      if (!s.correct && s.aiVerdict !== shadow.VERDICT.CLEAR && s.outcomeVerdict === shadow.VERDICT.CLEAR) falseFlags += 1;
    }
    const missedMaterialRate = rate(missedMaterial, scored);
    const falseFlagRate = rate(falseFlags, scored);

    const blockers = [];
    if (falseClears > t.falseClearMax) blockers.push(`${falseClears} false clear(s) — the release bar is ${t.falseClearMax}`);
    if (missedMaterialRate != null && missedMaterialRate > t.missedMaterialMax) {
      blockers.push(`missed-material rate ${(missedMaterialRate * 100).toFixed(1)}% exceeds ${(t.missedMaterialMax * 100).toFixed(0)}%`);
    }

    let status;
    if (scored < t.minSample) status = 'insufficient_data';
    else if (blockers.length) status = 'red';
    else if ((missedMaterialRate != null && missedMaterialRate > t.missedMaterialMax / 2) ||
             (falseFlagRate != null && falseFlagRate > t.falseFlagWarn)) status = 'amber';
    else status = 'green';

    return {
      sampleSize: scored,
      headline: { falseClearRate, missedMaterialRate },
      falseClears, falseClearRate,
      missedMaterial, missedMaterialRate,
      falseFlags, falseFlagRate,
      accuracy: rel.accuracy != null ? rel.accuracy : null,
      ece: rel.ece != null ? rel.ece : null,
      brierScore: rel.brierScore != null ? rel.brierScore : null,
      byComponent: rel.byComponent || {},
      status, blockers, thresholds: t,
    };
  } catch (_e) {
    return { sampleSize: 0, headline: { falseClearRate: null, missedMaterialRate: null },
      falseClears: 0, falseClearRate: null, missedMaterial: 0, missedMaterialRate: null,
      falseFlags: 0, falseFlagRate: null, accuracy: null, ece: null, brierScore: null,
      byComponent: {}, status: 'insufficient_data', blockers: [], thresholds: DEFAULT_THRESHOLDS };
  }
}

/**
 * loadProductionMetrics(client, { sinceDays, limit, thresholds }) → productionMetrics
 * Best-effort — reads the same scored shadow-decisions the reliability report uses,
 * plus the human_outcome's missed-material flag. Any DB error → insufficient_data.
 */
async function loadProductionMetrics(client, { sinceDays = 180, limit = 5000, thresholds } = {}) {
  if (!client) return productionMetrics([], { thresholds });
  try {
    const days = Number.isFinite(Number(sinceDays)) ? Math.max(1, Number(sinceDays)) : 180;
    const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50000, Number(limit))) : 5000;
    const r = await client.query(
      `SELECT candidate_decision, human_outcome
         FROM shadow_decisions
        WHERE human_outcome IS NOT NULL
          AND created_at >= now() - ($1::int * interval '1 day')
        ORDER BY created_at DESC
        LIMIT $2`, [days, cap]);
    const records = (r.rows || []).map((row) => {
      const cd = row.candidate_decision || {};
      const ho = row.human_outcome || {};
      return {
        aiVerdict: cd.verdict != null ? cd.verdict : cd.decision,
        confidence: cd.confidence,
        component: cd.component,
        outcome: ho.outcome != null ? ho.outcome : (ho.verdict != null ? ho.verdict : ho.decision),
        // the human_outcome marks when the reviewer added a material finding the AI missed.
        missedMaterial: ho.missedMaterial === true || ho.missed_material === true,
      };
    });
    return productionMetrics(records, { thresholds });
  } catch (_e) {
    return productionMetrics([], { thresholds });
  }
}

module.exports = { productionMetrics, loadProductionMetrics, DEFAULT_THRESHOLDS };
