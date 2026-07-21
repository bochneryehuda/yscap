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
// Multi-engine OCR router (owner-directed 2026-07-21): Azure Document Intelligence
// remains the PRIMARY engine; Google Document AI is a CHALLENGER that runs only
// when Azure returns an empty read (a scanned PDF where Azure's OCR silently
// failed to segment the page). The router keeps the same return shape as the
// single-engine reader, plus an `engineSequence`/`engine` pair recording which
// engine actually produced the text — surfaced onto the extraction so a finding
// can honestly say "read by Google after Azure returned nothing."
const docint = require('../ai/ocr-router');
const azureOpenai = require('../ai/azure-openai');
const registry = require('./registry');
const { analyzePdf } = require('./pdf-forensics');
const { groundFields, groundingFinding } = require('./grounding');

// The extractor's system prompt — shared by the first read and the vision SECOND-LOOK so both
// speak to the model identically.
const EXTRACT_SYSTEM = 'You extract fields from lending documents precisely. Never guess — use null when a value is absent or unreadable.';
// Backup / second-look OCR (owner-directed 2026-07-21): when the first read of a document comes back
// low-confidence (the model flagged it unreadable) and we have IMAGE bytes we did NOT already send,
// give it a fresh set of eyes — re-run the extract WITH the image (a vision re-read). Default on;
// UW_SECOND_LOOK_ENABLED=0 turns it off (it costs one extra paid model call, only on a bad read).
const SECOND_LOOK_ENABLED = process.env.UW_SECOND_LOOK_ENABLED !== '0';

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

  // Belt-and-suspenders: the AI clients + resilience layer provably never throw (a transient
  // give-up returns a classified {ok:false}), and the pure grounding/check steps are null-safe,
  // so this catch should be unreachable. But analyzeDocument's never-throw contract is load-
  // bearing — the whole desk depends on a read NEVER crashing an analyze — so we net any surprise
  // throw here and return the SAME honest error extraction + needs_manual_review finding as a
  // transient give-up, rather than letting it propagate. (audit 2026-07-20)
  try {
  // 1. READ (OCR) — best-effort; GPT can still read a clean image/text if OCR is thin.
  // The router tries Azure first and falls back to Google Document AI when Azure
  // returns nothing. ocr.engine names the WINNER; ocr.engineSequence lists every
  // engine actually tried, so the extraction records both.
  const ocr = await reader.read({ buffer, base64, mimeType });
  baseExtraction.ocrEngine = ocr.ok ? (ocr.engine || 'document_intelligence') : null;
  baseExtraction.ocrEngineSequence = Array.isArray(ocr.engineSequence) ? ocr.engineSequence.slice() : null;
  baseExtraction.pageCount = ocr.ok ? (ocr.pageCount || null) : null;

  // 2. UNDERSTAND (extract fields to the type's schema).
  let ext = await analyzer.extract({
    system: EXTRACT_SYSTEM,
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

  // 2b. SECOND-LOOK — a BACKUP read when the first came back low-confidence. The first read of a
  // text-schema document uses the OCR text only; if the model flags it `readable:false` and we have
  // real IMAGE bytes we did NOT already send (the analyzer only attaches image/* — Azure rejects a
  // PDF as an image), re-run the extract WITH the image so a vision model can read what the OCR
  // mangled (a faxed/photographed ID, a skewed scan). ONE retry only (cost), and we keep it ONLY if
  // it read BETTER — a real read (readable !== false) replaces the unreadable one; otherwise the
  // original stands. Best-effort: never throws (analyzer.extract returns a classified {ok:false}),
  // and a failed/no-better retry leaves the honest "unreadable" first result untouched.
  let secondLook = false;
  const firstUnreadable = !!(ext.data && ext.data.readable === false);
  const haveImageBytes = !!base64 && /^image\//i.test(mimeType || '');
  if (SECOND_LOOK_ENABLED && firstUnreadable && haveImageBytes && !entry.image) {
    const retry = await analyzer.extract({
      system: EXTRACT_SYSTEM,
      instructions: entry.instructions,
      schema: entry.schema,
      ocrText: ocr.ok ? ocr.text : null,
      imageBase64: base64,
      imageMime: mimeType,
    });
    if (retry && retry.ok && retry.data && retry.data.readable !== false) {
      ext = retry;
      secondLook = true;
    }
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
      fields: ext.data, status: 'analyzed', confidence, secondLook,
      grounding: grounding ? { score: grounding.score, checked: grounding.checked, confirmed: grounding.confirmed, unconfirmed: grounding.unconfirmed.length } : null,
    }),
    findings,
    usage: ext.usage || null,
  };
  } catch (err) {
    const reason = `unexpected error while analyzing this document (${(err && err.message) || 'unknown'})`;
    return {
      ok: false, reason, outcome: 'error',
      extraction: Object.assign(baseExtraction, { reason }),
      findings: [verifyFinding(docType, reason, { outcome: 'error' }), ...forensic],
    };
  }
}

module.exports = { analyzeDocument, _verifyFinding: verifyFinding };
