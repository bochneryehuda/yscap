'use strict';
/**
 * P0 — Extraction + finding accuracy aggregator (deterministic, ADVISORY).
 *
 * The companion to routing-telemetry (which scores the OCR read). This scores
 * what the AI DID with the read: how accurate is each extracted FIELD, and how
 * often does a human AGREE with each finding CODE. It answers the rest of the
 * owner's Gap-1 questions — "how accurate is each extracted field, which
 * conditions are false positives, which finding codes have the lowest human
 * agreement, how many bad clearances caught vs missed."
 *
 * The raw signal already exists in the platform: every time a human confirms or
 * corrects an extracted value (the digital twin), and every time a human decides
 * a finding (accept / dismiss / correct-severity). This turns a stream of those
 * into the scoreboard. Pure: no DB, no I/O — the persistence layer feeds it rows.
 * Advisory: it measures, it never changes a decision or auto-tunes a threshold.
 */

function rate(n, d) { return d > 0 ? +(n / d).toFixed(4) : 0; }

/**
 * fieldAccuracy(events) → { byField:{...}, byDocType:{...}, totals:{...} }.
 * events: extraction-review rows { docType, field, extracted, confirmed,
 *   corrected?:bool }. A row is CORRECT when the human confirmed the extracted
 *   value (corrected=false or extracted===confirmed); WRONG when corrected.
 * Per field + per docType: reviews, corrections, accuracy (1 − correctionRate).
 */
function fieldAccuracy(events) {
  const list = Array.isArray(events) ? events : [];
  const byField = {};
  const byDocType = {};
  const totals = { reviews: 0, corrections: 0 };

  for (const e of list) {
    if (!e) continue;
    const wrong = e.corrected === true || (e.corrected == null && e.extracted != null && e.confirmed != null && String(e.extracted) !== String(e.confirmed));
    const fieldKey = `${e.docType || 'unknown'}.${e.field || 'unknown'}`;
    totals.reviews++;
    if (wrong) totals.corrections++;

    const f = byField[fieldKey] || (byField[fieldKey] = { docType: e.docType || 'unknown', field: e.field || 'unknown', reviews: 0, corrections: 0 });
    f.reviews++;
    if (wrong) f.corrections++;

    const dt = byDocType[e.docType || 'unknown'] || (byDocType[e.docType || 'unknown'] = { reviews: 0, corrections: 0 });
    dt.reviews++;
    if (wrong) dt.corrections++;
  }

  for (const k of Object.keys(byField)) { const f = byField[k]; f.correctionRate = rate(f.corrections, f.reviews); f.accuracy = +(1 - f.correctionRate).toFixed(4); }
  for (const k of Object.keys(byDocType)) { const d = byDocType[k]; d.correctionRate = rate(d.corrections, d.reviews); d.accuracy = +(1 - d.correctionRate).toFixed(4); }
  return { byField, byDocType, totals };
}

/**
 * findingAgreement(events) → { byCode:{...}, totals:{...} }.
 * events: finding-decision rows { code, decision } where decision ∈
 *   'accepted' | 'dismissed' | 'severity_changed' | 'fixed'. Human AGREEMENT =
 *   the finding was real (accepted / fixed / severity_changed — all confirm the
 *   AI was onto something); DISMISSED = a false positive. Per code: decisions,
 *   dismissals, agreementRate, falsePositiveRate.
 */
function findingAgreement(events) {
  const list = Array.isArray(events) ? events : [];
  const byCode = {};
  const totals = { decisions: 0, dismissed: 0 };
  const isFalsePositive = (d) => String(d || '').toLowerCase() === 'dismissed';

  for (const e of list) {
    if (!e) continue;
    const code = e.code || 'unknown';
    const fp = isFalsePositive(e.decision);
    totals.decisions++;
    if (fp) totals.dismissed++;
    const c = byCode[code] || (byCode[code] = { code, decisions: 0, dismissed: 0 });
    c.decisions++;
    if (fp) c.dismissed++;
  }

  for (const k of Object.keys(byCode)) {
    const c = byCode[k];
    c.falsePositiveRate = rate(c.dismissed, c.decisions);
    c.agreementRate = +(1 - c.falsePositiveRate).toFixed(4);
  }
  return { byCode, totals };
}

/**
 * worstOffenders(agg, { minReviews, limit }) → ranked lists a human should look
 * at first: the FIELDS most often corrected and the finding CODES most often
 * dismissed (the noisiest false-positive codes). Advisory — a review queue, not
 * an auto-mute.
 */
function worstOffenders(fieldAgg, findingAgg, opts = {}) {
  const minReviews = opts.minReviews != null ? opts.minReviews : 10;
  const limit = opts.limit != null ? opts.limit : 10;
  const fields = Object.values((fieldAgg && fieldAgg.byField) || {})
    .filter((f) => f.reviews >= minReviews && f.corrections > 0)
    .sort((a, b) => b.correctionRate - a.correctionRate || b.reviews - a.reviews)
    .slice(0, limit);
  const codes = Object.values((findingAgg && findingAgg.byCode) || {})
    .filter((c) => c.decisions >= minReviews && c.dismissed > 0)
    .sort((a, b) => b.falsePositiveRate - a.falsePositiveRate || b.decisions - a.decisions)
    .slice(0, limit);
  return { fields, codes };
}

module.exports = { fieldAccuracy, findingAgreement, worstOffenders };
