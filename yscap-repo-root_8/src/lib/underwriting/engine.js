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

function verifyFinding(docType, reason) {
  return {
    source: docType, code: 'needs_manual_review', severity: 'warning', status: 'open',
    field: 'document', blocksCtc: false,
    title: 'This document could not be read or understood automatically',
    howTo: `Review it by hand and confirm the details on the file — nothing is filled in automatically.${reason ? ` (Reason: ${reason})` : ''}`,
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
  // runs even if the read/understand later fails. Never throws, never blocks.
  let forensic = [];
  try {
    const buf = buffer || (base64 ? Buffer.from(base64, 'base64') : null);
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
    return {
      ok: false, reason: ext.reason,
      extraction: Object.assign(baseExtraction, { reason: ext.reason }),
      findings: [verifyFinding(docType, ext.reason), ...forensic],
    };
  }

  // 3. CHECK → findings (pure) + the forensic tampering advisory.
  const findings = (entry.check(ext.data, subject, { today }) || []).concat(forensic);
  const confidence = ext.data && ext.data.readable === false ? 'unreadable' : 'analyzed';
  return {
    ok: true,
    extraction: Object.assign(baseExtraction, {
      fields: ext.data, status: 'analyzed', confidence,
    }),
    findings,
    usage: ext.usage || null,
  };
}

module.exports = { analyzeDocument, _verifyFinding: verifyFinding };
