'use strict';
/**
 * R5.32 — the Mortgage Knowledge Graph store (investors + guideline_documents +
 * guideline_versions + guideline_rules). Schema in db/258_guideline_knowledge.sql.
 *
 * This is the storage floor for knowledge-driven underwriting: versioned investor
 * guidelines + state overlays + internal policies, each rule scoped + effective-
 * dated + citation-linked, so every eligibility/leverage/condition outcome is
 * explainable and reproducible against the exact rule version used at decision
 * time (R5.33 overlays/exceptions, R5.35 compiler+precedence, R5.36 models the
 * frozen Gold/Standard numbers WITHOUT changing them).
 *
 * Investor identity uses the SAME normalization as applications.lender /
 * sitewire_partner_links / normNoteBuyer (lowercase, strip non-alphanumerics),
 * so "Blue Lake" / "bluelake" resolve to one investor across every system.
 *
 * Every function takes a `client`. Pure helpers under `_internals`.
 */

const MATERIALITY = new Set(['info', 'warning', 'material', 'hard_stop']);
const APPROVAL_STATES = new Set(['draft', 'active', 'superseded']);

// SAME key form as conditions/field-registry.normNoteBuyer + sitewire label_norm.
function investorKey(raw) {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return s || null;
}

async function upsertInvestor(client, { name, channel, active, meta }) {
  const key = investorKey(name);
  if (!key) throw new Error('investor name required');
  const r = await client.query(
    `INSERT INTO investors (name, label_norm, channel, active, meta)
     VALUES ($1,$2,$3,COALESCE($4,true),$5::jsonb)
     ON CONFLICT (label_norm) DO UPDATE SET
       name = EXCLUDED.name,
       channel = COALESCE(EXCLUDED.channel, investors.channel),
       active = EXCLUDED.active,
       meta = investors.meta || EXCLUDED.meta,
       updated_at = now()
     RETURNING *`,
    [name, key, channel || null, active, JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function findInvestor(client, name) {
  const key = investorKey(name);
  if (!key) return null;
  const r = await client.query(`SELECT * FROM investors WHERE label_norm = $1`, [key]);
  return r.rows[0] || null;
}

async function createGuidelineDocument(client, { investorId, program, title, sourceRef, sourceSha256, publishedAt, meta }) {
  const r = await client.query(
    `INSERT INTO guideline_documents (investor_id, program, title, source_ref, source_sha256, published_at, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
    [investorId || null, program || null, title, sourceRef || null, sourceSha256 || null, publishedAt || null, JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function createVersion(client, { guidelineDocumentId, version, effectiveFrom, effectiveTo, approvalStatus, notes, sourceSha256 }) {
  const status = APPROVAL_STATES.has(approvalStatus) ? approvalStatus : 'draft';
  const r = await client.query(
    `INSERT INTO guideline_versions (guideline_document_id, version, effective_from, effective_to, approval_status, notes, source_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (guideline_document_id, version) DO UPDATE SET
       effective_from = COALESCE(EXCLUDED.effective_from, guideline_versions.effective_from),
       effective_to = COALESCE(EXCLUDED.effective_to, guideline_versions.effective_to),
       notes = COALESCE(EXCLUDED.notes, guideline_versions.notes)
     RETURNING *`,
    [guidelineDocumentId, version, effectiveFrom || null, effectiveTo || null, status, notes || null, sourceSha256 || null]);
  return r.rows[0];
}

// Activate a version — supersede the currently-active one for the same document
// (the partial-unique index guarantees only one active at a time). Atomic.
async function activateVersion(client, versionId, { staffId } = {}) {
  const cur = await client.query(`SELECT guideline_document_id FROM guideline_versions WHERE id=$1`, [versionId]);
  if (!cur.rowCount) throw new Error('version not found');
  const docId = cur.rows[0].guideline_document_id;
  await client.query(
    `UPDATE guideline_versions SET approval_status='superseded', superseded_by=$2, effective_to=COALESCE(effective_to, CURRENT_DATE)
      WHERE guideline_document_id=$1 AND approval_status='active' AND id<>$2`, [docId, versionId]);
  const r = await client.query(
    `UPDATE guideline_versions SET approval_status='active', approved_by=COALESCE($2, approved_by),
       effective_from=COALESCE(effective_from, CURRENT_DATE)
      WHERE id=$1 RETURNING *`, [versionId, staffId || null]);
  return r.rows[0];
}

async function addRule(client, {
  guidelineVersionId, ruleKey, scope, expression, outcome, materiality,
  exceptionAllowed, exceptionAuthority, effectiveFrom, effectiveTo, sourceEvidenceSpanId, meta,
}) {
  const m = MATERIALITY.has(materiality) ? materiality : 'material';
  const r = await client.query(
    `INSERT INTO guideline_rules
       (guideline_version_id, rule_key, scope, expression, outcome, materiality,
        exception_allowed, exception_authority, effective_from, effective_to, source_evidence_span_id, meta)
     VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb)
     ON CONFLICT (guideline_version_id, rule_key) DO UPDATE SET
       scope = EXCLUDED.scope, expression = EXCLUDED.expression, outcome = EXCLUDED.outcome,
       materiality = EXCLUDED.materiality, exception_allowed = EXCLUDED.exception_allowed,
       exception_authority = EXCLUDED.exception_authority, meta = EXCLUDED.meta
     RETURNING *`,
    [guidelineVersionId, ruleKey, JSON.stringify(scope || {}), JSON.stringify(expression || {}),
     JSON.stringify(outcome || {}), m, !!exceptionAllowed, exceptionAuthority || null,
     effectiveFrom || null, effectiveTo || null, sourceEvidenceSpanId || null, JSON.stringify(meta || {})]);
  return r.rows[0];
}

// The active rule set for an investor+program as of a date (for a decision run).
async function activeRules(client, { investorId, program, asOf } = {}) {
  const r = await client.query(
    `SELECT gr.*, gv.version, gv.effective_from AS ver_from, gd.program, gd.investor_id
       FROM guideline_rules gr
       JOIN guideline_versions gv ON gv.id = gr.guideline_version_id AND gv.approval_status='active'
       JOIN guideline_documents gd ON gd.id = gv.guideline_document_id
      WHERE ($1::uuid IS NULL OR gd.investor_id = $1)
        AND ($2::text IS NULL OR gd.program = $2)
        AND (gr.effective_from IS NULL OR gr.effective_from <= COALESCE($3::date, CURRENT_DATE))
        AND (gr.effective_to IS NULL OR gr.effective_to >= COALESCE($3::date, CURRENT_DATE))
      ORDER BY gr.rule_key`,
    [investorId || null, program || null, asOf || null]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// R5.33 — internal overlays / exceptions / decision snapshots.
// ---------------------------------------------------------------------------
const EXCEPTION_STATES = new Set(['pending', 'approved', 'denied', 'expired']);

async function recordOverlay(client, { ruleKey, scope, expression, outcome, materiality, precedenceTier, effectiveFrom, effectiveTo, staffId, notes, meta }) {
  const m = MATERIALITY.has(materiality) ? materiality : 'material';
  const r = await client.query(
    `INSERT INTO internal_overlays
       (rule_key, scope, expression, outcome, materiality, precedence_tier, effective_from, effective_to, created_by, notes, meta)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
    [ruleKey, JSON.stringify(scope || {}), JSON.stringify(expression || {}), JSON.stringify(outcome || {}),
     m, Number.isFinite(precedenceTier) ? precedenceTier : 50, effectiveFrom || null, effectiveTo || null,
     staffId || null, notes || null, JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function requestException(client, { applicationId, ruleKey, guidelineRuleId, overlayId, approvedValue, reason, compensatingFactors, meta }) {
  const r = await client.query(
    `INSERT INTO guideline_exceptions
       (application_id, rule_key, guideline_rule_id, overlay_id, approved_value, reason, compensating_factors, status, meta)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,'pending',$8::jsonb) RETURNING *`,
    [applicationId, ruleKey, guidelineRuleId || null, overlayId || null,
     JSON.stringify(approvedValue || {}), reason || null, compensatingFactors || null, JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function decideException(client, exceptionId, { status, staffId, expiresAt }) {
  if (!EXCEPTION_STATES.has(status)) throw new Error(`invalid exception status: ${status}`);
  const r = await client.query(
    `UPDATE guideline_exceptions
        SET status=$2,
            approved_by = CASE WHEN $2 IN ('approved','denied') THEN $3 ELSE approved_by END,
            approved_at = CASE WHEN $2='approved' THEN now() ELSE approved_at END,
            expires_at = COALESCE($4, expires_at)
      WHERE id=$1 RETURNING *`,
    [exceptionId, status, staffId || null, expiresAt || null]);
  return r.rows[0] || null;
}

async function activeExceptions(client, applicationId) {
  const r = await client.query(
    `SELECT * FROM guideline_exceptions
      WHERE application_id=$1 AND status='approved'
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY approved_at DESC NULLS LAST`, [applicationId]);
  return r.rows;
}

async function writeSnapshot(client, { applicationId, producedFor, investorId, program, snapshot, asOf, staffId }) {
  const r = await client.query(
    `INSERT INTO underwriting_context_snapshots
       (application_id, produced_for, investor_id, program, snapshot, as_of, created_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`,
    [applicationId, producedFor || null, investorId || null, program || null,
     JSON.stringify(snapshot || {}), asOf || null, staffId || null]);
  return r.rows[0];
}

module.exports = {
  upsertInvestor, findInvestor,
  createGuidelineDocument, createVersion, activateVersion, addRule, activeRules,
  recordOverlay, requestException, decideException, activeExceptions, writeSnapshot,
  MATERIALITY, APPROVAL_STATES, EXCEPTION_STATES,
  _internals: { investorKey },
};
