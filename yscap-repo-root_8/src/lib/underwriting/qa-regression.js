'use strict';
/**
 * R5.65 — QA miss → evaluation case (deterministic core).
 *
 * Closes the QA loop: a genuine miss the nightly QA desk audit (R5.64) finds
 * becomes a labeled regression fixture (R5.42 evaluation_cases), so a future
 * artifact candidate MUST reproduce the correct outcome or fail the gate
 * (R5.46). This is the pure converter — it maps a QA miss to an evaluation_case
 * payload, tagged with the error taxonomy (R5.43) + a risk tier.
 *
 * NOT every QA signal is a model error. A duplicate open condition is a data-
 * cleanliness issue, not a decision the model got wrong — those are NOT turned
 * into fixtures. Only misses that represent a real decision error become cases:
 *   fatal_advanced          a file advanced with an OPEN fatal finding — a
 *                           missed-fatal / dangerous signal (high risk)
 *   cleared_without_evidence a document condition cleared with no current
 *                           document — a false-clear signal (high risk)
 *
 * Pure: no DB, no AI. The caller inserts the returned payload into
 * evaluation_cases (deduped by dedupe_key). Uses error-taxonomy for the cause.
 */

const taxonomy = require('./error-taxonomy');

// Which QA miss kinds become fixtures + how they map to an expected outcome +
// primary error cause + risk tier.
const MISS_MAP = {
  fatal_advanced: {
    expected: 'block_advance_until_fatal_resolved',
    primaryCause: 'condition_aggregation',   // the aggregation let a fatal through
    riskTier: 'high',
    label: 'A file advanced to approved/CTC/funded with an open fatal finding.',
  },
  cleared_without_evidence: {
    expected: 'not_cleared_without_current_document',
    primaryCause: 'condition_requirement',   // a requirement cleared with no evidence
    riskTier: 'high',
    label: 'A document condition was cleared with no current document attached.',
  },
  // duplicate_condition is intentionally NOT here — it's a data-cleanliness
  // issue, not a decision error, so it never becomes a regression fixture.
};

function isFixtureWorthy(missKind) {
  return Object.prototype.hasOwnProperty.call(MISS_MAP, missKind);
}

/**
 * toEvaluationCase(miss) — miss: { kind, applicationId, snapshot?, detail? }
 * Returns an evaluation_cases payload, or null if the miss kind is not a
 * decision error (e.g. duplicate_condition).
 */
function toEvaluationCase(miss) {
  const m = miss || {};
  const spec = MISS_MAP[m.kind];
  if (!spec) return null;
  // A stable dedupe key so the SAME miss on the SAME file makes ONE fixture.
  const dedupeKey = `qa:${m.kind}:${m.applicationId || 'unknown'}`;
  return {
    input_snapshot: m.snapshot || {},
    expected: { outcome: spec.expected, detail: m.detail || null },
    risk_tier: spec.riskTier,
    label_source: `qa_miss:${m.kind}`,
    // Machine-readable + human labels for the fixture.
    primary_cause: taxonomy.isValidCause(spec.primaryCause) ? spec.primaryCause : null,
    label: spec.label,
    dedupe_key: dedupeKey,
    meta: { application_id: m.applicationId || null, qa_kind: m.kind },
  };
}

// Convert a batch of QA misses → the fixtures worth persisting (drops the
// non-decision-error ones + dedupes by key).
function fixturesFromMisses(misses) {
  const out = [];
  const seen = new Set();
  for (const m of (misses || [])) {
    const c = toEvaluationCase(m);
    if (!c) continue;
    if (seen.has(c.dedupe_key)) continue;
    seen.add(c.dedupe_key);
    out.push(c);
  }
  return out;
}

module.exports = { toEvaluationCase, fixturesFromMisses, isFixtureWorthy, MISS_MAP };
