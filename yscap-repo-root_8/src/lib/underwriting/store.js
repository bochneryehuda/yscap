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
  'policynumber',
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
async function saveAnalysis(client, { documentId, applicationId, borrowerId, docType, extraction, findings, analyzedSha256, analyzerVersion, subjectHash } = {}) {
  if (!documentId) throw new Error('saveAnalysis requires a documentId');
  const appId = applicationId || null;
  const borId = borrowerId || null;
  const ext = extraction || {};

  // 1. Supersede the prior read of THIS document ON THIS FILE (keep it for history).
  //    CRITICAL: scope by application_id, exactly like findReusableExtraction's read. A
  //    profile-level document (a government ID, an operating agreement, an EIN letter) is
  //    stored with application_id IS NULL but is analyzed UNDER a specific file, so the same
  //    physical document can carry a CURRENT extraction + open findings on file A AND file B
  //    at once. Superseding by document_id alone would let analyzing it on file B wipe file A's
  //    current extraction and mark file A's open findings 'superseded' — silently dropping file
  //    A's fatals (e.g. an expired-ID block) and falsely opening its clear-to-close gate. The
  //    extraction row's application_id is the file it was analyzed under (= appId here), so we
  //    supersede only rows for THIS file.
  await client.query(
    `UPDATE document_extractions SET is_current = false, superseded = true, updated_at = now()
       WHERE document_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND is_current`, [documentId, appId]);
  await client.query(
    `UPDATE document_findings SET status = 'superseded'
       WHERE document_id = $1 AND application_id IS NOT DISTINCT FROM $2 AND status = 'open'`, [documentId, appId]);

  // 2. Insert the new extraction (PII-masked fields) + the idempotency fingerprint (the inputs
  // that determined this result: content hash, analyzer version, and the file-state hash).
  const safeFields = maskFields(ext.fields || {});
  const { rows } = await client.query(
    `INSERT INTO document_extractions
       (document_id, application_id, borrower_id, doc_type, fields, ocr_engine, ai_model, page_count, confidence, status, reason,
        analyzed_sha256, analyzer_version, subject_hash, second_look)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [documentId, appId, borId, docType, JSON.stringify(safeFields),
     ext.ocrEngine || null, ext.aiModel || null, ext.pageCount || null,
     ext.confidence || null, ext.status || 'analyzed', ext.reason || null,
     analyzedSha256 || null, analyzerVersion || null, subjectHash || null, !!ext.secondLook]);
  const extractionId = rows[0].id;

  // 2b. Loan Digital Twin (owner-directed 2026-07-21, Sovereign 1/4): for every
  // extracted field the twin's EXTRACTED_FIELD_MAP recognizes for this doc_type
  // (borrower_name from a government_id, property_address from a title, arv
  // from an appraisal, ...), record a fact observation and reconcile the
  // canonical fact. Best-effort — twin recording never blocks an extraction
  // from persisting. Uses the ORIGINAL unmasked fields (safeFields is masked
  // for storage; the twin records the real values behind its own audit trail).
  try {
    // R5.3 — resolve the source page of each field from the OCR page text, so
    // fact_observations record page_number (was always null). Heuristic text
    // match; a miss stays null (never a wrong page).
    const { makeFieldPager } = require('./evidence-page');
    const pageNumberFor = makeFieldPager(ext.fields || {}, ext.ocrPages || null);
    await require('./twin').recordFactsFromExtraction(client, {
      appId, documentId, docType, extractionId,
      fields: ext.fields || {},
      ocrEngine: ext.ocrEngine || null,
      aiModel: ext.aiModel || null,
      confidence: ext.confidence || null,
      pageNumberFor,
    });
  } catch (_) { /* twin is additive — never blocks the extraction */ }

  // 3. Insert findings. Runs through the promoted-rules applier FIRST
  // (R2.7, owner-directed 2026-07-22) — the self-training loop's tail:
  // super-admin promoted proposals (suppress_finding / downgrade_severity /
  // upgrade_severity) actually change how findings enter the file. Best-
  // effort — a rules-loading failure keeps every original finding untouched.
  const rulesRes = await require('./promoted-rules').applyPromotedRules(client, findings || []);
  const effectiveFindings = rulesRes.findings;
  const suppressedByRules = rulesRes.suppressed;
  // R5.3 — resolve a source page for each finding: prefer a page the check
  // already set (f.page / f.pageNumber), else locate the finding's doc-side
  // value in the OCR page text. Only ever ADDS a page pointer; a miss is null.
  const { pageNumberForValue } = require('./evidence-page');
  const findingIds = [];
  for (const f of (effectiveFindings || [])) {
    const actions = Array.isArray(f.actions) && f.actions.length ? JSON.stringify(f.actions) : null;
    let pageNumber = Number.isFinite(f.page) ? f.page : (Number.isFinite(f.pageNumber) ? f.pageNumber : null);
    if (pageNumber == null && ext.ocrPages && f.docValue != null) {
      pageNumber = pageNumberForValue(f.docValue, ext.ocrPages);
    }
    const { rows: fr } = await client.query(
      `INSERT INTO document_findings
         (application_id, borrower_id, document_id, extraction_id, source, code, severity, field, doc_value, file_value, title, how_to, blocks_ctc, suggested_actions, opens_condition, page_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [appId, borId, documentId, extractionId, f.source || docType, f.code,
       f.severity || 'warning', f.field || null, str(f.docValue), str(f.fileValue),
       f.title || null, f.howTo || null, !!f.blocksCtc, actions, f.opensCondition || null,
       pageNumber != null ? pageNumber : null]);
    findingIds.push(fr[0].id);
  }
  // Audit-log the suppressed set so a reviewer can inspect exactly what a
  // promoted 'suppress_finding' rule dropped (best-effort — never blocks).
  if (suppressedByRules && suppressedByRules.length) {
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system','pilot_suppressed_findings','application',$1,$2::jsonb)`,
        [appId, JSON.stringify({ documentId, extractionId, suppressed: suppressedByRules })]);
    } catch (_) { /* audit best-effort */ }
  }

  // 3b. Semantic-entity layer (Sovereign, owner-directed 2026-07-22): pattern-
  // based scan of the OCR text for party mentions, money, dates, addresses,
  // emails, phones, licenses. Best-effort — a failure never blocks the
  // extraction. The ocrText is threaded from engine.baseExtraction (truncated
  // at 200 KB); we don't persist the raw text itself, only the entities.
  try {
    if (ext.ocrText) {
      const entities = require('./semantic-entities').extract(ext.ocrText, {
        docType, pages: ext.ocrPages || null,
      });
      if (entities.length) {
        await require('./semantic-entities').persistFromExtraction(client, {
          appId, documentId, extractionId, entities,
        });
      }
    }
  } catch (_) { /* semantic entities are additive */ }

  // 4. Cure analysis (Sovereign 2/4, owner-directed 2026-07-21). If this
  // document is FILED under a specific checklist_item, and that item's
  // condition code carries a structured intent, produce a CURE PROOF:
  // check each satisfaction requirement one-by-one against the extracted
  // fields + the file's twin canonical facts, and spawn any new findings
  // the cure surfaced. Best-effort — a cure analysis failure never blocks
  // the extraction or its findings from persisting.
  try {
    if (appId && documentId) {
      const linkQ = await client.query(
        `SELECT d.checklist_item_id, ci.template_id, ct.code
           FROM documents d
           LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
           LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
          WHERE d.id = $1`, [documentId]);
      const link = linkQ.rows[0];
      if (link && link.checklist_item_id && link.code) {
        const cure = require('./cure');
        const twin = require('./twin');
        const intent = await cure.intentForCode(link.code, client);
        if (intent) {
          const twinRows = await twin.factsForFile(appId, client);
          const twinFacts = Object.fromEntries(twinRows.map((r) => [r.fact_key, r]));
          // R5.2 — build the real subject/expected context (loan amount, closing
          // date, required statement months, entity + borrower name) so the
          // FICO/months/closing/amount/name assertions actually run instead of
          // returning "unable_to_determine". loadCureContext is best-effort and
          // falls back to {} on any error, so a context failure never blocks the proof.
          const { subject, expected } = await cure.loadCureContext(appId, client);
          const analysis = cure.analyze({
            intent,
            extractionFields: ext.fields || {},
            twinFacts,
            subject,
            expected,
          });
          await cure.persistProof(client, {
            appId,
            checklistItemId: link.checklist_item_id,
            intentId: intent.id,
            documentId, extractionId,
            analysis,
          });
        }
      }
    }
  } catch (_) { /* cure is additive — never blocks the extraction */ }

  // 5. Assignment-fraud check (R3.15, owner-directed 2026-07-22). When THIS
  // extraction is for an assignment doc, run the non-arm's-length detector.
  // Enrich the assignee side (usually the borrower's LLC) with any address /
  // EIN / registered agent pulled from the file's operating_agreement or
  // ein_letter extractions so shared-EIN / shared-address signals can fire.
  // Best-effort — never blocks the extraction.
  try {
    if (docType === 'assignment' && appId && ext.fields) {
      const af = require('./assignment-fraud');
      // Pull sibling extractions to enrich the parties.
      const sib = await client.query(
        `SELECT doc_type, fields FROM document_extractions
          WHERE application_id=$1 AND status='ok' AND (doc_type='operating_agreement' OR doc_type='ein_letter')
          ORDER BY created_at DESC LIMIT 4`, [appId]);
      const oa = (sib.rows.find((r) => r.doc_type === 'operating_agreement') || {}).fields || {};
      const ein = (sib.rows.find((r) => r.doc_type === 'ein_letter') || {}).fields || {};
      const assignor = { name: ext.fields.assignorName };
      const assignee = {
        name: ext.fields.assigneeName,
        ein: oa.ein || ein.ein || null,
        address: oa.entityAddress || null,
        registeredAgent: oa.registeredAgent || null,
      };
      await af.analyzeAndRecord(client, {
        applicationId: appId, documentId,
        assignor, assignee,
        contractPrice: ext.fields.originalPurchasePrice,
        assignmentFee: ext.fields.assignmentFee,
      });
    }
  } catch (_) { /* assignment fraud is additive — never blocks the extraction */ }

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
  const updated = rows[0] || null;
  // Self-training capture (Sovereign 4/4, owner-directed 2026-07-21): every
  // resolve is a labeled example — dismiss = false-positive candidate, grant/
  // clear/decline = confirmed / condition / etc. Also compares the committee's
  // action (if it ran) with the human's decision so a persistent disagreement
  // pattern surfaces as a training_proposal. Best-effort — never blocks the
  // resolve.
  if (updated) {
    try {
      await require('./learning').captureFindingDecision(client, {
        finding: updated, action: v.action, actorId: by, note,
      });
    } catch (_) { /* learning capture is additive */ }
  }
  return updated;
}

/**
 * Idempotency lookup: is there already a CURRENT extraction of this exact document whose
 * inputs (content hash + doc type + analyzer version + file-state hash) all match what we're
 * about to analyze? If so, re-analysis would spend a paid Azure read+GPT call for a result we
 * already have — the caller returns the stored extraction + its open findings instead.
 * Only matches when a real content hash is present (legacy docs with no sha256 always re-run).
 * @returns {Promise<object|null>} the reusable current extraction row, or null.
 */
async function findReusableExtraction(client, { documentId, applicationId, docType, analyzedSha256, analyzerVersion, subjectHash } = {}) {
  if (!documentId || !docType || !analyzedSha256) return null;
  // Scope to THIS application: a profile-level document (an ID, an operating agreement) can be
  // analyzed under two files of the same borrower. Its findings + CTC gate live per-application,
  // so file B must NOT reuse file A's extraction — otherwise B's gate never sees A's fatals.
  const { rows } = await client.query(
    `SELECT * FROM document_extractions
       WHERE document_id = $1 AND is_current AND status = 'analyzed'
         AND application_id IS NOT DISTINCT FROM $2
         AND doc_type = $3 AND analyzed_sha256 = $4
         AND analyzer_version IS NOT DISTINCT FROM $5
         AND subject_hash IS NOT DISTINCT FROM $6
       LIMIT 1`,
    [documentId, applicationId || null, docType, analyzedSha256, analyzerVersion || null, subjectHash || null]);
  return rows[0] || null;
}

/** The currently-open findings tied to one extraction (for the idempotency short-circuit). */
async function findingsForExtraction(client, extractionId) {
  const { rows } = await client.query(
    `SELECT * FROM document_findings WHERE extraction_id = $1 AND status = 'open'
      ORDER BY (CASE severity WHEN 'fatal' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END), created_at`,
    [extractionId]);
  return rows;
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

module.exports = { saveAnalysis, resolveFinding, getFileFindings, rollup, maskFields,
  findReusableExtraction, findingsForExtraction, _internals: { maskValue } };
