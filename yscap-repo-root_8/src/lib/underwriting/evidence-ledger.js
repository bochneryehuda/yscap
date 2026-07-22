'use strict';
/**
 * R5.13 / R5.14 — the evidence ledger. Persist a cited region (evidence_span)
 * and link it to a canonical fact, a finding / AI suggestion, or a condition
 * requirement. Schema in db/257_evidence_ledger.sql.
 *
 * This is the durable, audit-grade provenance floor the owner + review asked
 * for: every material fact / finding / clearance decision points at one or more
 * spans, each carrying the page, polygon, quote, and per-engine confidence.
 *
 * CITATION GUARD (R5.18 principle, enforced here): a link may only reference a
 * span that EXISTS and belongs to the same application — `linkFinding` /
 * `linkFact` verify the span before inserting, so a model that hallucinates a
 * span id gets a thrown error, never a dangling link. `assertSpanExists` is the
 * shared check.
 *
 * Every function takes a `client` (pg client/pool). Pure validators are under
 * `_internals` for unit testing.
 */

const SPAN_TYPES = new Set([
  'line', 'word', 'table_cell', 'selection_mark', 'signature', 'image_region',
  'api_response', 'guideline_citation',
]);
const SUPPORT_TYPES = new Set(['direct', 'corroborating', 'contradicting', 'derived_input']);
const FINDING_ROLES = new Set(['supports', 'conflicts', 'context']);
const REQUIREMENT_ROLES = new Set(['satisfies', 'fails', 'cannot_address']);
const SPAN_STATES = new Set(['active', 'superseded', 'invalid']);

function normSpanType(t) {
  const s = String(t || '').toLowerCase().trim();
  return SPAN_TYPES.has(s) ? s : 'line';
}
function normSupportType(t) {
  const s = String(t || '').toLowerCase().trim();
  return SUPPORT_TYPES.has(s) ? s : 'direct';
}
function normFindingRole(t) {
  const s = String(t || '').toLowerCase().trim();
  return FINDING_ROLES.has(s) ? s : 'supports';
}
function normRequirementRole(t) {
  const s = String(t || '').toLowerCase().trim();
  return REQUIREMENT_ROLES.has(s) ? s : 'satisfies';
}
// Clamp a confidence to [0,1] or null — never store a NaN / out-of-range value.
function clampConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

async function assertSpanExists(client, spanId, applicationId) {
  if (typeof spanId !== 'string' || !spanId) throw new Error('evidence: missing span id');
  const r = await client.query(
    `SELECT application_id FROM evidence_spans WHERE id = $1`, [spanId]);
  if (!r.rowCount) throw new Error(`evidence: cited span ${spanId} does not exist (hallucinated citation rejected)`);
  if (applicationId && r.rows[0].application_id !== applicationId) {
    throw new Error(`evidence: span ${spanId} belongs to a different application`);
  }
  return true;
}

async function recordSpan(client, {
  applicationId, documentId, pageId, logicalDocumentId, pageNumber, spanType,
  quote, normalizedValue, polygon, ocrEngine, ocrModelVersion, ocrConfidence,
  extractorEngine, extractorVersion, extractorConfidence, sourceSha256, analyzerVersion, meta,
}) {
  const r = await client.query(
    `INSERT INTO evidence_spans
       (application_id, document_id, page_id, logical_document_id, page_number, span_type,
        quote, normalized_value, polygon, ocr_engine, ocr_model_version, ocr_confidence,
        extractor_engine, extractor_version, extractor_confidence, source_sha256, analyzer_version, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
     RETURNING *`,
    [applicationId, documentId || null, pageId || null, logicalDocumentId || null,
     pageNumber ?? null, normSpanType(spanType), quote || null, normalizedValue || null,
     polygon ? JSON.stringify(polygon) : null, ocrEngine || null, ocrModelVersion || null,
     clampConfidence(ocrConfidence), extractorEngine || null, extractorVersion || null,
     clampConfidence(extractorConfidence), sourceSha256 || null, analyzerVersion || null,
     JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function linkFact(client, { factObservationId, evidenceSpanId, supportType, applicationId }) {
  await assertSpanExists(client, evidenceSpanId, applicationId);
  const r = await client.query(
    `INSERT INTO fact_evidence_links (fact_observation_id, evidence_span_id, support_type)
     VALUES ($1,$2,$3)
     ON CONFLICT (fact_observation_id, evidence_span_id, support_type) DO NOTHING
     RETURNING *`,
    [factObservationId, evidenceSpanId, normSupportType(supportType)]);
  return r.rows[0] || null;
}

async function linkFinding(client, { findingId, aiSuggestionId, evidenceSpanId, role, applicationId }) {
  if ((findingId && aiSuggestionId) || (!findingId && !aiSuggestionId)) {
    throw new Error('evidence: link exactly one of findingId / aiSuggestionId');
  }
  await assertSpanExists(client, evidenceSpanId, applicationId);
  const r = await client.query(
    `INSERT INTO finding_evidence_links (finding_id, ai_suggestion_id, evidence_span_id, role)
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [findingId || null, aiSuggestionId || null, evidenceSpanId, normFindingRole(role)]);
  return r.rows[0] || null;
}

async function linkRequirement(client, { clearanceProofId, requirementId, evidenceSpanId, evaluationRole, applicationId }) {
  await assertSpanExists(client, evidenceSpanId, applicationId);
  const r = await client.query(
    `INSERT INTO condition_requirement_evidence (clearance_proof_id, requirement_id, evidence_span_id, evaluation_role)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [clearanceProofId || null, String(requirementId), evidenceSpanId, normRequirementRole(evaluationRole)]);
  return r.rows[0];
}

// R5.19 preview — mark every span from a superseded source inactive (never deleted).
async function supersedeSpansForDocument(client, documentId) {
  const r = await client.query(
    `UPDATE evidence_spans SET status='superseded'
      WHERE document_id = $1 AND status='active' RETURNING id`, [documentId]);
  return r.rowCount;
}

// Read every active span cited by a fact observation (for the "click a fact →
// highlight" render, R5.17).
async function spansForFact(client, factObservationId) {
  const r = await client.query(
    `SELECT es.*, fel.support_type
       FROM fact_evidence_links fel
       JOIN evidence_spans es ON es.id = fel.evidence_span_id
      WHERE fel.fact_observation_id = $1 AND es.status = 'active'
      ORDER BY es.page_number NULLS LAST, es.created_at`, [factObservationId]);
  return r.rows;
}

module.exports = {
  recordSpan, linkFact, linkFinding, linkRequirement,
  assertSpanExists, supersedeSpansForDocument, spansForFact,
  SPAN_TYPES, SUPPORT_TYPES, FINDING_ROLES, REQUIREMENT_ROLES, SPAN_STATES,
  _internals: { normSpanType, normSupportType, normFindingRole, normRequirementRole, clampConfidence },
};
