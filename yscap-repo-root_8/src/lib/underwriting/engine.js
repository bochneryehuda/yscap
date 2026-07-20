'use strict';
/**
 * Underwriting engine — the single flow that turns one uploaded document into an
 * extraction + findings: READ it (Azure Document Intelligence), UNDERSTAND it (Azure
 * OpenAI GPT-5, constrained to the document type's schema), then CHECK it against the
 * file (the type's pure findings module). The route persists what this returns; the
 * findings roll up per file and gate clear-to-close, exactly like the appraisal flow.
 *
 * Reader + analyzer are injected (default to the real ones) so the orchestration is
 * unit-testable with stubs — no keys, no network. Best-effort throughout: a read or
 * understand failure NEVER throws; it returns an 'error' extraction plus a single
 * "verify by hand" finding (never a false mismatch, never a guess onto the file).
 */
const docint = require('../ai/docint');
const azureOpenai = require('../ai/azure-openai');
const registry = require('./registry');
const { analyzePdf } = require('./pdf-forensics');
const { groundFields, groundingFinding } = require('./grounding');

// Turn a read/understand failure into a single, honest "verify by hand" finding — NEVER a false
// mismatch and never a guess onto the file. The `meta` (from the analyzer's classified result)
// lets the message name the OUTCOME so the underwriter knows why: blocked by a content filter
// (manual handling), temporarily unavailable (retry), or simply unreadable (re-scan / re-upload).
function verifyFinding(docType, reason, meta = {}) {
  let title = 'This document could not be read or understood automatically';
  let lead = 'Review it by hand and confirm the details on the file — nothing is filled in automatically.';
  if (meta.blocked || meta.outcome === 'content_filtered') {
    title = 'This document was blocked by a safety/content filter';
    lead = 'The AI declined to process this document, so it needs manual handling — review it by hand; nothing is filled in automatically.';
  } else if (meta.retryable || meta.outcome === 'transient') {
    title = 'The reader/analyzer was temporarily unavailable for this document';
    lead = 'This was a temporary problem (a timeout or the AI service being busy). Try analyzing again shortly, or review it by hand — nothing is filled in automatically.';
  } else if (meta.outcome === 'truncated') {
    title = 'This document was too large to finish reading in one pass';
    lead = 'The analyzer ran out of room before finishing. Try again, or review it by hand — nothing is filled in automatically.';
  }
  return {
    source: docType, code: 'needs_manual_review', severity: 'warning', status: 'open',
    field: 'document', blocksCtc: false,
    title,
    howTo: `${lead}${reason ? ` (Reason: ${reason})` : ''}`,
    actions: ['open_condition', 'request_revision', 'dismiss'],
    opensCondition: 'underwriting_review_cleared',
  };
}

/**
 * @param {object} args
 *   docType   registry key (e.g. 'government_id', 'purchase_contract')
 *   buffer|base64, mimeType   the document bytes
 *   subject   the data the checks compare against (a borrowers row, or the app file view)
 *   today     'YYYY-MM-DD' injected (no new Date() in date paths)
 * @param {{reader?, analyzer?}} deps  injectable for tests
 * @returns {Promise<{ok, extraction, findings, usage?, reason?}>}
 */
async function analyzeDocument({ docType, buffer, base64, mimeType, subject, today } = {}, deps = {}) {
  const reader = deps.reader || docint;
  const analyzer = deps.analyzer || azureOpenai;
  const entry = registry.get(docType);
  if (!entry) return { ok: false, reason: `unknown document type: ${docType}`, findings: [] };

  const baseExtraction = {
    docType, fields: {}, ocrEngine: null, aiModel: null,
    pageCount: null, confidence: null, status: 'error', reason: null,
  };

  // 0. FORENSIC scan of the raw bytes (advisory tampering signals) — independent of OCR/AI, so it
  // runs even if the read/understand later fails. Never throws, never blocks. In production the
  // caller passes a real Buffer; only fall back to decoding base64 (through the mandated
  // decodeUploadBase64 chokepoint, which strips a data: prefix and rejects garbage) for callers
  // that pass base64 only.
  let forensic = [];
  try {
    let buf = buffer;
    if (!buf && base64) { const { decodeUploadBase64 } = require('../upload-bytes'); buf = decodeUploadBase64(base64).buf; }
    if (buf) forensic = analyzePdf(buf, { docType }).findings || [];
  } catch (_) { forensic = []; }

  // 1. READ (OCR) — best-effort; GPT can still read a clean image/text if OCR is thin.
  const ocr = await reader.read({ buffer, base64, mimeType });
  baseExtraction.ocrEngine = ocr.ok ? 'document_intelligence' : null;
  baseExtraction.pageCount = ocr.ok ? (ocr.pageCount || null) : null;

  // 2. UNDERSTAND (extract fields to the type's schema).
  const ext = await analyzer.extract({
    system: 'You extract fields from lending documents precisely. Never guess — use null when a value is absent or unreadable.',
    instructions: entry.instructions,
    schema: entry.schema,
    ocrText: ocr.ok ? ocr.text : null,
    imageBase64: entry.image ? base64 : undefined,
    imageMime: mimeType,
  });
  if (!ext.ok) {
    const meta = { blocked: ext.blocked, retryable: ext.retryable || ext.retriable, truncated: ext.truncated, outcome: ext.outcome };
    return {
      ok: false, reason: ext.reason, outcome: ext.outcome || null,
      extraction: Object.assign(baseExtraction, { reason: ext.reason }),
      findings: [verifyFinding(docType, ext.reason, meta), ...forensic],
    };
  }

  // 3. GROUND — verify the AI's extracted values against what the OCR physically read. A value
  // whose text isn't in the document is likely a hallucination; we NEVER underwrite against a
  // value the document doesn't contain, so a critical value that's ABSENT from the OCR raises an
  // advisory to verify by hand. Only possible when we have OCR text to check against.
  const grounding = ocr.ok ? groundFields(ext.data, ocr.text) : null;
  const gFinding = grounding ? groundingFinding(docType, grounding) : null;

  // 4. CHECK → findings (pure) + the forensic tampering advisory + the grounding advisory.
  const findings = (entry.check(ext.data, subject, { today }) || []).concat(forensic, gFinding ? [gFinding] : []);
  const confidence = ext.data && ext.data.readable === false ? 'unreadable' : 'analyzed';
  return {
    ok: true,
    extraction: Object.assign(baseExtraction, {
      fields: ext.data, status: 'analyzed', confidence,
      grounding: grounding ? { score: grounding.score, checked: grounding.checked, confirmed: grounding.confirmed, unconfirmed: grounding.unconfirmed.length } : null,
    }),
    findings,
    usage: ext.usage || null,
  };
}

module.exports = { analyzeDocument, _verifyFinding: verifyFinding };
