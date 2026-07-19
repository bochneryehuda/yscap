'use strict';
/**
 * Persistence for the underwriting engine — save what a document analysis produced
 * (an extraction + its findings) and read the roll-up for a file. Mirrors how the
 * appraisal import persists (supersede prior, insert new, derive the summary).
 *
 * PII discipline (GLBA — from the security research): we do NOT store full government-ID
 * numbers, bank account numbers, routing numbers, or SSNs inside the `fields` jsonb. The
 * `maskFields` step keeps only a masked last-4 for display/search; the match result is
 * what underwriting needs, not the raw identifier. Full sensitive values, if ever needed,
 * belong in the existing encrypted/tokenized columns, never in a jsonb blob.
 *
 * Every function takes a `client` (a pg client/pool) so callers control the transaction.
 */

// Field keys whose values are sensitive identifiers — masked to last-4 before storage.
const SENSITIVE_KEYS = new Set([
  'documentnumber', 'idnumber', 'licensenumber', 'passportnumber',
  'accountnumber', 'routingnumber', 'ssn', 'taxid', 'ein', 'cardnumber',
]);

function maskValue(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  if (!s) return v;
  const last4 = s.slice(-4);
  return s.length > 4 ? `***${last4}` : '***';
}

// Deep-mask any sensitive key anywhere in the extracted fields (objects + arrays).
function maskFields(fields) {
  if (Array.isArray(fields)) return fields.map(maskFields);
  if (fields && typeof fields === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(fields)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase()) && val != null && typeof val !== 'object') {
        out[k] = maskValue(val);
      } else {
        out[k] = maskFields(val);
      }
    }
    return out;
  }
  return fields;
}

function str(v) {
  if (v == null) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Save one document analysis: supersede the document's prior current extraction + open
 * findings, insert the new extraction, then its findings. Returns the new ids.
 * @param {import('pg').ClientBase} client
 */
async function saveAnalysis(client, { documentId, applicationId, borrowerId, docType, extraction, findings } = {}) {
  if (!documentId) throw new Error('saveAnalysis requires a documentId');
  const appId = applicationId || null;
  const borId = borrowerId || null;
  const ext = extraction || {};

  // 1. Supersede the prior read of THIS document (keep it for history).
  await client.query(
    `UPDATE document_extractions SET is_current = false, superseded = true, updated_at = now()
       WHERE document_id = $1 AND is_current`, [documentId]);
  await client.query(
    `UPDATE document_findings SET status = 'superseded'
       WHERE document_id = $1 AND status = 'open'`, [documentId]);

  // 2. Insert the new extraction (PII-masked fields).
  const safeFields = maskFields(ext.fields || {});
  const { rows } = await client.query(
    `INSERT INTO document_extractions
       (document_id, application_id, borrower_id, doc_type, fields, ocr_engine, ai_model, page_count, confidence, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [documentId, appId, borId, docType, JSON.stringify(safeFields),
     ext.ocrEngine || null, ext.aiModel || null, ext.pageCount || null,
     ext.confidence || null, ext.status || 'analyzed', ext.reason || null]);
  const extractionId = rows[0].id;

  // 3. Insert findings.
  const findingIds = [];
  for (const f of (findings || [])) {
    const { rows: fr } = await client.query(
      `INSERT INTO document_findings
         (application_id, borrower_id, document_id, extraction_id, source, code, severity, field, doc_value, file_value, title, how_to, blocks_ctc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [appId, borId, documentId, extractionId, f.source || docType, f.code,
       f.severity || 'warning', f.field || null, str(f.docValue), str(f.fileValue),
       f.title || null, f.howTo || null, !!f.blocksCtc]);
    findingIds.push(fr[0].id);
  }

  return { extractionId, findingIds };
}

// fatal-first roll-up for the badge + the clear-to-close gate (matches appraisal summarize()).
function rollup(findings) {
  const open = (findings || []).filter((f) => (f.status || 'open') === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && (f.blocks_ctc ?? f.blocksCtc)),
  };
}

/**
 * Resolve one finding the way an underwriter chose (post a condition, request a document,
 * fix the file, clear, dismiss, grant an exception, decline). Records who/what/when so the
 * decision is auditable. post_condition/request_document keep the finding OPEN (and still
 * CTC-blocking if fatal) until the follow-up clears; the rest close it.
 * @returns {Promise<object|null>} the updated finding row, or null if not found/already closed
 */
async function resolveFinding(client, { findingId, action, note, value, by } = {}) {
  const { validateResolution } = require('./actions');
  const v = validateResolution(action, { note, value });
  if (!v.ok) throw new Error(v.reason);
  const status = v.outcome; // 'open' | 'resolved' | 'dismissed'
  const terminal = status !== 'open';
  const { rows } = await client.query(
    `UPDATE document_findings
        SET status = $2,
            resolution = $3,
            resolution_note = $4,
            resolution_value = $5,
            resolved_by = CASE WHEN $6 THEN $7 ELSE resolved_by END,
            resolved_at = CASE WHEN $6 THEN now() ELSE resolved_at END
      WHERE id = $1 AND status IN ('open')
      RETURNING *`,
    [findingId, status, v.action, note || null, value != null ? String(value) : null, terminal, by || null]);
  return rows[0] || null;
}

/** Open findings + roll-up for a whole loan file (all its documents). */
async function getFileFindings(client, applicationId) {
  const { rows } = await client.query(
    `SELECT * FROM document_findings
       WHERE application_id = $1 AND status = 'open'
       ORDER BY (CASE severity WHEN 'fatal' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END), created_at`,
    [applicationId]);
  return { findings: rows, summary: rollup(rows) };
}

module.exports = { saveAnalysis, resolveFinding, getFileFindings, rollup, maskFields, _internals: { maskValue } };
