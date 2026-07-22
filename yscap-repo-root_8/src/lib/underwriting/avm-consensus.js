'use strict';
/**
 * AVM Consensus — cross-check the appraisal ARV against multiple AVM sources
 * (HouseCanary / Clear Capital / ATTOM) and flag a material disagreement
 * BEFORE closing (owner-directed 2026-07-22).
 *
 * How it composes with the rest of Sovereign:
 *   * Every AVM connector (kind='avm') feeds the twin an api_verification
 *     observation of `appraisal.arv` via direct-source-hub.verifyFile.
 *   * This module reads all live observations for that fact and computes
 *     consensus math: median, mean, coefficient of variation, agreement
 *     score across ONLY the AVM sources.
 *   * Then compares the AVM median against the DOCUMENT appraisal
 *     observation (source_type='document', source_id='appraisal') and
 *     flags material disagreement.
 *
 * Threshold: DEFAULT_MATERIAL_PCT = 0.10 (10%) — if the AVM median differs
 * from the document appraisal by more than 10% of the document appraisal,
 * that's a material disagreement worth an underwriter's look. Configurable
 * via AVM_MATERIAL_PCT env var (0.05 = stricter, 0.20 = looser).
 *
 * Pure module for the math; the persist path spawns a finding via the same
 * document_findings table so the cockpit and cure engine pick it up.
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));
const twin = require('./twin');

const DEFAULT_MATERIAL_PCT = 0.10;
function materialPct() {
  const v = parseFloat(process.env.AVM_MATERIAL_PCT || '');
  return isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_MATERIAL_PCT;
}

// Pure: median of a numeric array, ignoring null/NaN.
function median(nums) {
  const xs = (nums || []).filter((n) => n != null && isFinite(n)).map(Number).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}
function mean(nums) {
  const xs = (nums || []).filter((n) => n != null && isFinite(n)).map(Number);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stddev(nums) {
  const xs = (nums || []).filter((n) => n != null && isFinite(n)).map(Number);
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * PURE — given an array of { source_id, value } AVM observations, produce
 * consensus stats. `value` is a number of dollars.
 * @returns {{count, median, mean, min, max, stddev, cv, agreementScore, sources}}
 *   agreementScore = 1 - min(cv, 1)  (1 = perfect agreement, 0 = wildly disagreeing)
 *   cv = coefficient of variation = stddev / mean
 */
function computeConsensus(avmObservations) {
  // Number(null) === 0 (finite!) so a `value: null` would slip through a naive
  // isFinite filter — guard against null/undefined/empty-string explicitly and
  // also reject 0 (a zero AVM is meaningless, definitely a missing-data signal).
  const list = (avmObservations || []).filter((o) => {
    if (!o || o.value == null || o.value === '') return false;
    const n = Number(o.value);
    return Number.isFinite(n) && n > 0;
  });
  if (!list.length) {
    return { count: 0, median: null, mean: null, min: null, max: null, stddev: 0, cv: null, agreementScore: null, sources: [] };
  }
  const vals = list.map((o) => Number(o.value));
  const _mean = mean(vals);
  const _stddev = stddev(vals);
  const cv = _mean > 0 ? _stddev / _mean : null;
  const agreementScore = cv == null ? null : Math.max(0, 1 - Math.min(1, cv));
  return {
    count: list.length,
    median: median(vals),
    mean: _mean,
    min: Math.min(...vals),
    max: Math.max(...vals),
    stddev: _stddev,
    cv,
    agreementScore,
    sources: list.map((o) => ({ source_id: o.source_id, value: o.value })),
  };
}

/**
 * PURE — compare AVM consensus to the document appraisal.
 * @param {number} consensusMedian — median of AVM values
 * @param {number} documentArv     — the appraisal's ARV
 * @param {number} thresholdPct    — material disagreement threshold (default 0.10)
 * @returns {{disagrees, diff, diffPct, message}}
 */
function compareToAppraisal(consensusMedian, documentArv, thresholdPct = DEFAULT_MATERIAL_PCT) {
  if (consensusMedian == null || documentArv == null || documentArv <= 0) {
    return { disagrees: false, diff: null, diffPct: null, message: 'not enough data to compare' };
  }
  const diff = consensusMedian - documentArv;
  const diffPct = diff / documentArv;
  const abs = Math.abs(diffPct);
  const disagrees = abs > thresholdPct;
  const dir = diff > 0 ? 'HIGHER than' : 'LOWER than';
  const pct = Math.round(abs * 1000) / 10;
  const message = disagrees
    ? `AVM consensus (median $${Math.round(consensusMedian).toLocaleString('en-US')}) is ${pct}% ${dir} the appraisal ($${Math.round(documentArv).toLocaleString('en-US')})`
    : `AVM consensus (median $${Math.round(consensusMedian).toLocaleString('en-US')}) is within ${Math.round(thresholdPct * 100)}% of the appraisal ($${Math.round(documentArv).toLocaleString('en-US')})`;
  return { disagrees, diff, diffPct, message };
}

/**
 * DB — pull every live observation for a file's appraisal.arv, group by
 * AVM sources vs the document appraisal, and produce the full report.
 * Read-only. Returns null if the file has no appraisal on file yet.
 */
async function analyzeFileARV(appId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT source_type, source_id, value_json, raw_value, created_at
       FROM fact_observations
      WHERE application_id=$1 AND fact_key=$2 AND superseded_at IS NULL`,
    [appId, twin.FACT_KEYS.APPRAISAL_ARV]);
  if (!r.rows.length) return null;
  const avms = [];
  let doc = null;
  for (const o of r.rows) {
    const v = valueOf(o);
    if (v == null) continue;
    if (o.source_type === 'api_verification') avms.push({ source_id: o.source_id, value: v });
    if (o.source_type === 'document' && o.source_id === 'appraisal') doc = { value: v, at: o.created_at };
  }
  const consensus = computeConsensus(avms);
  const comparison = doc ? compareToAppraisal(consensus.median, doc.value, materialPct()) : null;
  return { consensus, appraisal: doc, comparison, thresholdPct: materialPct() };
}

function valueOf(observation) {
  if (observation.value_json && observation.value_json.value != null) {
    const n = Number(observation.value_json.value);
    if (isFinite(n)) return n;
  }
  if (observation.raw_value != null) {
    const n = parseFloat(String(observation.raw_value).replace(/[^0-9.\-]/g, ''));
    if (isFinite(n)) return n;
  }
  return null;
}

/**
 * DB — after computing analyzeFileARV, if the consensus disagrees materially,
 * spawn a document_findings row (source='avm_consensus') so the file view /
 * committee / cure engine all pick it up. Idempotent: dedupes on
 * (application_id, source='avm_consensus') — an existing OPEN finding is
 * updated with the fresh delta instead of being duplicated.
 */
async function persistFindingIfDisagreement(client, appId, report) {
  if (!report || !report.comparison || !report.comparison.disagrees) return null;
  const c = report.comparison;
  const cur = await client.query(
    `SELECT id FROM document_findings
      WHERE application_id=$1 AND source='avm_consensus' AND status='open'`, [appId]);
  const title = 'AVM consensus disagrees with the appraisal ARV';
  const howTo = 'Order a desk review or a second appraisal — three independent AVMs disagreeing with the file appraiser is a common signal of an inflated or stale valuation. If the disagreement is downward, consider reducing the loan size instead.';
  const docValue = `AVM median $${Math.round(report.consensus.median).toLocaleString('en-US')}`;
  const fileValue = `Appraisal ARV $${Math.round(report.appraisal.value).toLocaleString('en-US')}`;
  if (cur.rowCount) {
    await client.query(
      `UPDATE document_findings
          SET doc_value=$2, file_value=$3, how_to=$4, title=$5, updated_at=now()
        WHERE id=$1`, [cur.rows[0].id, docValue, fileValue, howTo, title]);
    return { id: cur.rows[0].id, action: 'updated', message: c.message };
  }
  const ins = await client.query(
    `INSERT INTO document_findings
       (application_id, source, code, severity, field, doc_value, file_value, title, how_to, blocks_ctc)
     VALUES ($1,'avm_consensus','avm_consensus_disagreement','warning','appraisal.arv',$2,$3,$4,$5,false)
     RETURNING id`,
    [appId, docValue, fileValue, title, howTo]);
  return { id: ins.rows[0].id, action: 'created', message: c.message };
}

module.exports = {
  DEFAULT_MATERIAL_PCT, materialPct,
  computeConsensus, compareToAppraisal, analyzeFileARV, persistFindingIfDisagreement,
  _internals: { median, mean, stddev, valueOf },
};
