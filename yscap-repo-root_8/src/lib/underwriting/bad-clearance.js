'use strict';
/**
 * Bad-clearance detector (R3.18, owner-directed 2026-07-22).
 *
 * Owner's ask: "if a condition was cleared that shouldn't have been cleared, in the
 * suggestion maybe to reopen the condition — it's not cleared correctly."
 *
 * Per file, walks every checklist_item that is SATISFIED / signed-off, pulls the
 * documents attached to it, runs each through the Azure Custom Classifier, and if
 * the dominant document type does not match the condition's expected type (per the
 * DOC_TYPE_TO_CONDITION_CODES map used by the wrong-condition detector), posts an
 * ai_suggestion asking a human to review + reopen if needed.
 *
 * Silent when the classifier is not configured (dormant per HARD RULE).
 * Silent below 0.75 confidence (never a false accusation).
 * Dedupe key '(condition_id)' so re-running never spams.
 */

const azc = require('../ai/azure-custom');
const wc = require('./wrong-condition');
const aiSug = require('./ai-suggestions');
const langfuse = require('../ai/langfuse');

/**
 * Scan a single file for bad clearances. Best-effort, DB-safe: any per-condition
 * failure is swallowed and never propagates.
 * @param {*} client pg client (transaction honored)
 * @param {string} appId
 * @param {{maxConditions?:number}} opts — safety cap on how many conditions to inspect per run
 * @returns {Promise<{scanned:number, flagged:number, dormant?:boolean}>}
 */
async function scanFile(client, appId, opts = {}) {
  if (!appId) return { scanned: 0, flagged: 0 };
  if (!azc.classifierConfigured()) return { scanned: 0, flagged: 0, dormant: true };

  const cap = Math.max(1, Math.min(200, Number(opts.maxConditions) || 25));
  // Only satisfied / signed-off items with an attached document that has bytes we can read.
  const rows = (await client.query(
    `SELECT ci.id AS condition_id, COALESCE(t.borrower_label, t.label) AS label, t.code,
            d.id AS document_id, d.storage_provider, d.storage_ref, d.filename, d.content_type
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
       JOIN documents d ON d.checklist_item_id = ci.id AND d.is_current AND d.review_status = 'accepted'
      WHERE ci.application_id = $1
        AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL)
        AND t.code IS NOT NULL
      ORDER BY ci.signed_off_at DESC NULLS LAST, ci.updated_at DESC
      LIMIT $2`, [appId, cap])).rows;

  let scanned = 0, flagged = 0;
  const trace = langfuse.trace({ name: 'bad-clearance:scan', appId, tags: ['bad-clearance'] });
  for (const row of rows) {
    try {
      // If the condition-code doesn't map to any known doc types, skip — we have no opinion.
      const expected = wc.CONDITION_CODE_TO_DOC_TYPES.get(row.code);
      if (!expected || !expected.size) continue;
      const storage = require('../storage');
      const bytes = await storage.read(row.storage_ref).catch(() => null);
      if (!bytes || !bytes.length) continue;
      scanned += 1;
      const cls = await azc.classify({ buffer: bytes, appId, documentId: row.document_id, trace });
      if (!cls.ok || !cls.segments || !cls.segments.length) continue;
      const dominant = cls.segments.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
      if (!dominant || (dominant.confidence || 0) < 0.75) continue;
      if (expected.has(dominant.docType)) continue;   // correct → nothing to do
      // Mismatch — post a REOPEN suggestion (kind='info' + proposed_action.type='reopen_condition').
      flagged += 1;
      await aiSug.record(client, {
        applicationId: appId, documentId: row.document_id, checklistItemId: row.condition_id,
        source: 'wrong_condition', kind: 'info',
        title: `This condition may have been cleared with the wrong document`,
        body: `"${row.label}" was cleared with "${row.filename}". PILOT reads that document as a ${prettyType(dominant.docType)} (${Math.round(dominant.confidence * 100)}% confident), which does not match what this condition expects. If the wrong document cleared this condition, a reviewer should reopen it and request the right one.`,
        confidence: dominant.confidence,
        traceUrl: trace.url ? trace.url() : null,
        evidence: {
          classifierType: dominant.docType, classifierConfidence: dominant.confidence,
          pages: dominant.pages || null,
          expectedTypes: Array.from(expected),
          conditionCode: row.code, conditionLabel: row.label,
        },
        proposedAction: {
          type: 'reopen_condition',
          checklistItemId: row.condition_id,
          reason: `Wrong document type — reads as ${dominant.docType}, expected one of ${Array.from(expected).join(', ')}.`,
        },
        dedupeKey: `bad-clearance:${row.condition_id}`,
      });
    } catch (_) { /* one bad condition never stops the scan */ }
  }
  trace.end({ output: { scanned, flagged } });
  return { scanned, flagged };
}

function prettyType(t) {
  return ({
    bank_statement: 'bank statement', insurance: 'homeowner\'s insurance page',
    operating_agreement: 'LLC operating agreement', drivers_license: 'driver\'s license',
    settlement: 'settlement statement', purchase_contract: 'purchase contract',
  }[t]) || t;
}

module.exports = { scanFile };
