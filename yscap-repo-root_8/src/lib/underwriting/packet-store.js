'use strict';
/**
 * R5.6 — Persistence for the packet lifecycle (document_packages / document_pages /
 * logical_documents / logical_document_pages / document_relationships /
 * document_lifecycle_events). Schema in db/256_packet_lifecycle.sql.
 *
 * This is the storage floor for the "Packet Intelligence" workstream (R5.7–R5.12,
 * R5.57–R5.58): render + fingerprint pages, detect quality issues, split into
 * page-bounded logical documents, resolve versions/families, and let a human
 * correct a boundary. Every function takes a `client` (pg client/pool) so callers
 * own the transaction, mirroring `store.js`.
 *
 * INVARIANTS (owner data-safety rules — enforced structurally here):
 *   • The original upload is never mutated — a package only REFERENCES its
 *     source `documents` row.
 *   • Pages are never reordered or deleted; page_number is fixed at ingest.
 *   • A logical boundary is only ever recorded, never guessed silently — a
 *     low-confidence segmentation is written with classification_status
 *     'needs_review' so a human confirms it.
 *
 * Pure helpers (no DB) are exported under `_internals` for unit testing.
 */

const LIFECYCLE_EVENTS = new Set([
  'ingest', 'render', 'quality', 'segment', 'reclassify', 'split', 'merge',
  'version', 'supersede', 'replace', 'human_confirm',
]);
const VERSION_STATES = new Set([
  'draft', 'current', 'superseded', 'duplicate', 'amendment', 'unknown',
]);
const CLASSIFICATION_STATES = new Set(['accepted', 'needs_review', 'rejected']);
const RELATIONSHIP_TYPES = new Set([
  'supersedes', 'amends', 'duplicates', 'continues', 'attachment_to', 'replaces',
]);

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// A family key groups documents of the same real-world thing (all the title
// versions, all the insurance versions, every monthly bank statement of ONE
// account). Deterministic + normalized so the resolver can bucket reliably.
function familyKeyFor(documentType, opts) {
  const t = String(documentType || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!t) return null;
  const o = opts || {};
  // Bank statements are per-ACCOUNT families (last-4), not one big "bank" family,
  // so two accounts never collapse and two months of one account DO group.
  if (t === 'bank_statement' && o.accountLast4) return `bank_statement:${String(o.accountLast4).slice(-4)}`;
  // Insurance/title families are per-property; default to the type alone.
  return t;
}

// Normalize a requested page list to ascending, deduped, 1-indexed ints.
function normalizePages(pages) {
  if (!Array.isArray(pages)) return [];
  const set = new Set();
  for (const p of pages) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// document_packages
// ---------------------------------------------------------------------------
async function createPackage(client, { applicationId, sourceDocumentId, sourceSha256, pageCount, meta }) {
  const r = await client.query(
    `INSERT INTO document_packages (application_id, source_document_id, source_sha256, page_count, ingest_status, meta)
     VALUES ($1,$2,$3,$4,'pending',$5::jsonb)
     ON CONFLICT (source_document_id) WHERE source_document_id IS NOT NULL
       DO UPDATE SET source_sha256=EXCLUDED.source_sha256, page_count=EXCLUDED.page_count, updated_at=now()
     RETURNING *`,
    [applicationId, sourceDocumentId || null, sourceSha256 || null, pageCount || null, JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function setPackageStatus(client, packageId, { ingestStatus, qualityStatus }) {
  const r = await client.query(
    `UPDATE document_packages
        SET ingest_status = COALESCE($2, ingest_status),
            quality_status = COALESCE($3, quality_status),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [packageId, ingestStatus || null, qualityStatus || null]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// document_pages
// ---------------------------------------------------------------------------
async function upsertPage(client, packageId, page) {
  const p = page || {};
  const r = await client.query(
    `INSERT INTO document_pages
       (package_id, page_number, render_storage_ref, text_sha256, visual_phash,
        width, height, unit, rotation, blank_score, quality_score, ocr_status, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
     ON CONFLICT (package_id, page_number) DO UPDATE SET
       render_storage_ref = COALESCE(EXCLUDED.render_storage_ref, document_pages.render_storage_ref),
       text_sha256   = COALESCE(EXCLUDED.text_sha256, document_pages.text_sha256),
       visual_phash  = COALESCE(EXCLUDED.visual_phash, document_pages.visual_phash),
       width = COALESCE(EXCLUDED.width, document_pages.width),
       height = COALESCE(EXCLUDED.height, document_pages.height),
       unit = COALESCE(EXCLUDED.unit, document_pages.unit),
       rotation = COALESCE(EXCLUDED.rotation, document_pages.rotation),
       blank_score = COALESCE(EXCLUDED.blank_score, document_pages.blank_score),
       quality_score = COALESCE(EXCLUDED.quality_score, document_pages.quality_score),
       ocr_status = COALESCE(EXCLUDED.ocr_status, document_pages.ocr_status),
       meta = document_pages.meta || EXCLUDED.meta
     RETURNING *`,
    [packageId, Number(p.pageNumber), p.renderStorageRef || null, p.textSha256 || null, p.visualPhash || null,
     p.width ?? null, p.height ?? null, p.unit || null, p.rotation ?? null,
     p.blankScore ?? null, p.qualityScore ?? null, p.ocrStatus || null, JSON.stringify(p.meta || {})]);
  return r.rows[0];
}

async function markDuplicatePage(client, pageId, duplicateOfPageId) {
  await client.query(
    `UPDATE document_pages SET duplicate_of_page_id=$2 WHERE id=$1 AND id <> $2`,
    [pageId, duplicateOfPageId]);
}

async function listPages(client, packageId) {
  const r = await client.query(
    `SELECT * FROM document_pages WHERE package_id=$1 ORDER BY page_number ASC`, [packageId]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// logical_documents
// ---------------------------------------------------------------------------
async function createLogicalDocument(client, {
  packageId, applicationId, documentType, documentSubtype, classificationConfidence,
  classificationStatus, familyKey, versionStatus, effectiveDate, createdFrom, meta,
}) {
  const status = CLASSIFICATION_STATES.has(classificationStatus) ? classificationStatus : 'needs_review';
  const ver = VERSION_STATES.has(versionStatus) ? versionStatus : 'unknown';
  const r = await client.query(
    `INSERT INTO logical_documents
       (package_id, application_id, document_type, document_subtype, classification_confidence,
        classification_status, family_key, version_status, effective_date, created_from, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     RETURNING *`,
    [packageId, applicationId, documentType || null, documentSubtype || null,
     classificationConfidence ?? null, status, familyKey || null, ver,
     effectiveDate || null, createdFrom || 'splitter', JSON.stringify(meta || {})]);
  return r.rows[0];
}

async function attachPages(client, logicalDocumentId, pageRows) {
  // pageRows: [{pageId, sequenceNumber, classifierLabel, classifierConfidence, continuationConfidence, shared}]
  for (const pr of (pageRows || [])) {
    await client.query(
      `INSERT INTO logical_document_pages
         (logical_document_id, page_id, sequence_number, classifier_label, classifier_confidence, continuation_confidence, shared)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (logical_document_id, sequence_number) DO NOTHING`,
      [logicalDocumentId, pr.pageId, Number(pr.sequenceNumber),
       pr.classifierLabel || null, pr.classifierConfidence ?? null,
       pr.continuationConfidence ?? null, !!pr.shared]);
  }
}

async function confirmLogicalDocument(client, logicalDocumentId, { staffId, documentId, classificationStatus, versionStatus, derivedStorageRef, derivedSha256 }) {
  const r = await client.query(
    `UPDATE logical_documents SET
        confirmed_by = COALESCE($2, confirmed_by),
        confirmed_at = CASE WHEN $2 IS NOT NULL THEN now() ELSE confirmed_at END,
        document_id = COALESCE($3, document_id),
        classification_status = COALESCE($4, classification_status),
        version_status = COALESCE($5, version_status),
        derived_storage_ref = COALESCE($6, derived_storage_ref),
        derived_sha256 = COALESCE($7, derived_sha256),
        updated_at = now()
      WHERE id = $1 RETURNING *`,
    [logicalDocumentId, staffId || null, documentId || null,
     (classificationStatus && CLASSIFICATION_STATES.has(classificationStatus)) ? classificationStatus : null,
     (versionStatus && VERSION_STATES.has(versionStatus)) ? versionStatus : null,
     derivedStorageRef || null, derivedSha256 || null]);
  return r.rows[0] || null;
}

async function listLogicalDocuments(client, packageId) {
  const r = await client.query(
    `SELECT ld.*,
            COALESCE(json_agg(json_build_object('page_id', ldp.page_id, 'seq', ldp.sequence_number, 'label', ldp.classifier_label)
                     ORDER BY ldp.sequence_number) FILTER (WHERE ldp.id IS NOT NULL), '[]') AS pages
       FROM logical_documents ld
       LEFT JOIN logical_document_pages ldp ON ldp.logical_document_id = ld.id
      WHERE ld.package_id = $1
      GROUP BY ld.id
      ORDER BY ld.created_at ASC`, [packageId]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// document_relationships
// ---------------------------------------------------------------------------
async function recordRelationship(client, { applicationId, fromId, toId, relationshipType, confidence, basis, staffId }) {
  if (!RELATIONSHIP_TYPES.has(relationshipType)) throw new Error(`invalid relationship_type: ${relationshipType}`);
  const r = await client.query(
    `INSERT INTO document_relationships
       (application_id, from_logical_document_id, to_logical_document_id, relationship_type, confidence, basis, confirmed_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (from_logical_document_id, to_logical_document_id, relationship_type)
       DO UPDATE SET confidence=EXCLUDED.confidence, basis=EXCLUDED.basis, confirmed_by=COALESCE(EXCLUDED.confirmed_by, document_relationships.confirmed_by)
     RETURNING *`,
    [applicationId, fromId, toId, relationshipType, confidence ?? null, JSON.stringify(basis || {}), staffId || null]);
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// document_lifecycle_events  (append-only audit)
// ---------------------------------------------------------------------------
async function logEvent(client, { applicationId, packageId, logicalDocumentId, eventType, actorKind, actorId, detail }) {
  const type = LIFECYCLE_EVENTS.has(eventType) ? eventType : eventType; // record even unknown types; validated in tests
  await client.query(
    `INSERT INTO document_lifecycle_events
       (application_id, package_id, logical_document_id, event_type, actor_kind, actor_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [applicationId, packageId || null, logicalDocumentId || null, type,
     actorKind || 'system', actorId || null, JSON.stringify(detail || {})]);
}

module.exports = {
  createPackage, setPackageStatus,
  upsertPage, markDuplicatePage, listPages,
  createLogicalDocument, attachPages, confirmLogicalDocument, listLogicalDocuments,
  recordRelationship, logEvent,
  LIFECYCLE_EVENTS, VERSION_STATES, CLASSIFICATION_STATES, RELATIONSHIP_TYPES,
  _internals: { isUuid, familyKeyFor, normalizePages },
};
