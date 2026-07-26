'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — RS-2: the CLASSIFICATION stage, wired for real.
 *
 * The V2 processor recorded classification as `pending` with the note "classifier stage not yet
 * wired" on every single read. That note was accurate when it was written and dishonest by the time
 * it shipped: a trained Azure custom classifier has existed since R3.2, V1 already uses it (the
 * package splitter, the wrong-condition detector), and V2 simply never called it. A stage that
 * always records the same placeholder is not a stage — it is a hole with a label on it.
 *
 * WHAT CLASSIFICATION IS FOR HERE. The route plan and the read both take the document's family on
 * FAITH: whatever slot the document was uploaded into is assumed to be what it is. Classification is
 * the first stage that reads the document and says what it ACTUALLY is. That makes it the origin of
 * one of the most valuable advisory signals in the pipeline — "the file says this is a purchase
 * contract, the document reads like a bank statement" — which is exactly the mis-filed-document
 * class V1 catches late, by hand, via the wrong-condition detector.
 *
 * NEVER-FABRICATE (the governing discipline of this module):
 *   - No classifier configured    → the stage is NOT_APPLICABLE. It is not "pending" (nothing is
 *                                   coming), not "completed" (nothing was classified), and not
 *                                   "failed" (nothing is broken — the model simply is not trained).
 *   - Classifier ran, no segments → FAILED, and NOT retryable. A document the model cannot place
 *                                   will not be placeable on the tenth attempt; retrying burns a
 *                                   paid vendor call to reach the same answer.
 *   - Classifier threw / errored  → FAILED_RETRYABLE. A network blip is worth another attempt.
 *   - Classifier ran, segments    → COMPLETED, with the detected types + page ranges.
 * The family COMPARISON is likewise never guessed: with no expected family, or a detected type the
 * comparison does not recognize, the verdict is 'unknown' — never a silent "matches".
 *
 * ADVISORY ONLY. This records a V2 stage + artifact. It writes no condition, no status, no finding,
 * and no loan-file field; it never re-files a document or changes what a borrower or officer sees.
 * A family mismatch recorded here is a fact for the shadow surface, not an action.
 *
 * PURE + never-throws, except `classifyDocument`, which makes the one vendor call and catches
 * everything itself.
 */

/**
 * The stage outcomes this module can produce. These are not free text — `document_pipeline_stages`
 * has a CHECK constraint (db/307) and `recordStage`'s write is wrapped in a swallow-everything
 * catch, so a status outside the constraint is not an error anyone sees: the row is simply never
 * written, and the stage looks like it never ran. Every value here must be in that constraint.
 */
const OUTCOME = Object.freeze({
  COMPLETED: 'completed',
  // 'failed_terminal', not 'failed' — 'failed' is NOT in the CHECK constraint. It also carries the
  // right meaning (terminal, not worth retrying) and gets an `ended_at` stamp from recordStage.
  FAILED: 'failed_terminal',
  FAILED_RETRYABLE: 'failed_retryable',
  NOT_APPLICABLE: 'not_applicable',
});

function str(v) { return v == null ? null : String(v); }
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }

/**
 * PURE — normalize one classifier segment into the compact shape we record. Keeps only the
 * document TYPE and its PAGE NUMBERS: no text, no field values, no PII ever reaches the artifact.
 */
function normalizeSegment(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const docType = str(seg.docType) || null;
  const rawLabel = str(seg.rawLabel) || null;
  if (!docType && !rawLabel) return null;
  const pages = Array.isArray(seg.pages)
    ? Array.from(new Set(seg.pages.filter((p) => Number.isFinite(p)))).sort((a, b) => a - b)
    : [];
  return { docType, rawLabel, confidence: num(seg.confidence), pages };
}

/**
 * PURE — the segment the document is most likely to BE, by page coverage first and confidence
 * second. Page coverage leads deliberately: on a package, the type that occupies the most pages is
 * the document, while a single high-confidence page is a rider or a cover sheet. Returns null when
 * there is nothing to choose from.
 */
function dominantSegment(segments) {
  // A segment covering ZERO pages can never be the dominant type: a claim supported by no page is
  // not evidence that the document IS that type. (The real vendor already filters these out; this
  // keeps the contract true for any other classifier injected later.)
  const list = Array.isArray(segments) ? segments.filter((s) => s && Array.isArray(s.pages) && s.pages.length > 0) : [];
  if (!list.length) return null;
  let best = null;
  for (const s of list) {
    const pages = Array.isArray(s.pages) ? s.pages.length : 0;
    const conf = num(s.confidence) || 0;
    if (!best) { best = { s, pages, conf }; continue; }
    if (pages > best.pages || (pages === best.pages && conf > best.conf)) best = { s, pages, conf };
  }
  return best ? best.s : null;
}

/** Canonicalize a document-family name through the classifier's OWN vocabulary. Injectable so the
    pure tests never need the vendor module; falls back to identity if it cannot be loaded. */
function canonicalFamily(name, normalize) {
  const s = str(name);
  if (!s) return null;
  let fn = normalize;
  if (typeof fn !== 'function') {
    try { fn = require('../lib/ai/azure-custom').normalizeType; } catch (_e) { fn = null; }
  }
  if (typeof fn === 'function') {
    try { const c = fn(s); if (c) return String(c).trim().toLowerCase(); } catch (_e) { /* fall through */ }
  }
  return null;
}

/**
 * PURE — does what the classifier READ match the family the document was filed under?
 *
 * Returns 'match' | 'mismatch' | 'unknown'.
 *
 * BOTH SIDES ARE CANONICALIZED, and that is the whole subtlety (audit 2026-07-26). The DETECTED
 * side arrives already normalized through the classifier's `normalizeType`; the EXPECTED side is
 * the raw pipeline family from the checklist condition map. Those two vocabularies are NOT the same
 * — the ID condition expects `government_id` while the classifier's canonical label is
 * `drivers_license` (the module even carries `photo_id -> drivers_license` as a known alias). A
 * naive string compare therefore reported EVERY correctly-filed, correctly-classified driver's
 * licence as "reads as a different type than the one it was filed under": a fabricated
 * disagreement, and precisely the signal this stage exists to produce.
 *
 * A family the classifier's vocabulary does not contain is 'unknown', never 'mismatch' — the model
 * could not have emitted that label under any circumstances, so its silence proves nothing. Same
 * for a missing side: a document filed with no declared family cannot disagree with anything.
 */
function familyVerdict(expectedFamily, detectedType, normalize) {
  const exp = canonicalFamily(expectedFamily, normalize);
  const got = canonicalFamily(detectedType, normalize);
  if (!exp || !got) return 'unknown';
  return exp === got ? 'match' : 'mismatch';
}

/**
 * PURE — turn a classifier response into the stage OUTCOME + the artifact meta to record.
 *
 * @param {object|null} res  the `classifyDocument` result: {available, ok, reason, segments}
 * @param {object} opts      { expectedFamily }
 * @returns {{status, detail, artifact}}
 *   status   — one of OUTCOME, for safeStage()
 *   detail   — the small object recorded ON the stage row (why it landed there)
 *   artifact — the compact classification artifact, or null when there is nothing to record
 */
function summarizeClassification(res, opts = {}) {
  const expectedFamily = str(opts && opts.expectedFamily) || null;

  // Not available: no trained classifier in this environment. Say exactly that, so nobody reads a
  // silent stage as "the document was checked and it was fine".
  if (!res || res.available === false) {
    return {
      status: OUTCOME.NOT_APPLICABLE,
      detail: {
        note: 'no trained document classifier is configured, so the document was not classified — its family is still the one it was filed under',
        reason: (res && str(res.reason)) || null,
        expectedFamily,
      },
      artifact: null,
    };
  }

  // The call failed. Retryable: this is a vendor/transport failure, not a verdict about the document.
  if (!res.ok) {
    return {
      status: OUTCOME.FAILED_RETRYABLE,
      detail: {
        note: 'the document classifier could not be reached or returned an error',
        reason: str(res.reason) || null,
        expectedFamily,
      },
      artifact: null,
    };
  }

  const segments = (Array.isArray(res.segments) ? res.segments : []).map(normalizeSegment).filter(Boolean);

  // Ran clean and placed nothing. That IS the result — and it is a failure of this stage, because a
  // document nobody can identify has not been classified. Not retryable: the same bytes through the
  // same model produce the same answer, and each retry is a paid call.
  if (!segments.length) {
    return {
      status: OUTCOME.FAILED,
      detail: {
        note: 'the classifier read the document but could not place it as any known type — nothing to classify it as',
        expectedFamily,
        segmentCount: 0,
      },
      artifact: { expectedFamily, detectedFamily: null, familyMatch: 'unknown', segmentCount: 0, segments: [], pageCount: 0 },
    };
  }

  const dominant = dominantSegment(segments);
  const detectedFamily = dominant ? dominant.docType : null;
  const familyMatch = familyVerdict(expectedFamily, detectedFamily, opts && opts.normalizeType);
  const pageCount = new Set(segments.flatMap((s) => s.pages)).size;

  const artifact = {
    expectedFamily,
    detectedFamily,
    detectedRawLabel: dominant ? dominant.rawLabel : null,
    detectedConfidence: dominant ? num(dominant.confidence) : null,
    familyMatch,
    segmentCount: segments.length,
    pageCount,
    // The full per-type page map — this is what makes a PACKAGE visible (RS-3 builds on it).
    segments: segments.slice(0, 50),
  };

  return {
    status: OUTCOME.COMPLETED,
    detail: {
      note: familyMatch === 'mismatch'
        ? 'the document reads as a different type than the one it was filed under'
        : 'the document was classified',
      expectedFamily,
      detectedFamily,
      familyMatch,
      segmentCount: segments.length,
    },
    artifact,
  };
}

/**
 * Run the classifier over the document bytes. NEVER THROWS.
 *
 * @param {object} args
 *   classifier — the classifier module (default require('../lib/ai/azure-custom')). Must expose
 *                `classifierConfigured()` and `classify({buffer|base64, appId, documentId})`.
 *   request    — { buffer?, base64? } the SAME bytes the read used (never re-loaded, never re-fetched)
 *   documentId / loanId — passed through for the vendor trace only
 * @returns {Promise<{available:boolean, ok:boolean, reason:string|null, segments:Array}>}
 */
async function classifyDocument(args = {}) {
  const { request, documentId, loanId } = args;

  // SPEND GATE. This is a SECOND full-document Azure Document Intelligence call on top of the OCR
  // read, and the credential that would enable it (AZURE_DOCINT_CLASSIFIER_ID) is one the owner sets
  // for V1's package splitter — so without its own switch, turning on V2 reading would silently
  // double the per-document vendor bill for someone who opted into nothing. Mirrors the deliberate
  // separate switch on the read itself. `enabled:true` bypasses it for tests (no vendor involved).
  if (args.enabled !== true) {
    let on = false;
    try { on = !!(require('../config').pipeline || {}).v2ClassifyEnabled; } catch (_e) { on = false; }
    if (!on) return { available: false, ok: false, reason: 'document classification is switched off (UW_PIPELINE_V2_CLASSIFY)', segments: [] };
  }

  let classifier = args.classifier;
  if (classifier === undefined) {
    try { classifier = require('../lib/ai/azure-custom'); } catch (_e) { classifier = null; }
  }

  // No classifier module, or no trained classifier in this environment → not available. This is the
  // ordinary state until the owner trains the model in Azure; it is not an error anywhere.
  let configured = false;
  try { configured = !!(classifier && typeof classifier.classifierConfigured === 'function' && classifier.classifierConfigured()); } catch (_e) { configured = false; }
  if (!configured) return { available: false, ok: false, reason: 'no trained document classifier is configured', segments: [] };

  const hasBytes = !!(request && (request.buffer || request.base64));
  if (!hasBytes) {
    // A configured classifier with nothing to read is a real gap, not a not-applicable: the read
    // path only reaches here when it HAD bytes, so losing them between stages is a defect worth
    // retrying rather than silently passing over.
    return { available: true, ok: false, reason: 'no document bytes were available to classify', segments: [] };
  }

  try {
    const out = await classifier.classify({
      buffer: request.buffer, base64: request.base64,
      appId: loanId || undefined, documentId: documentId || undefined,
    });
    if (!out || out.ok !== true) {
      const why = (out && str(out.reason)) || 'the classifier returned no result';
      return { available: true, ok: false, reason: why.slice(0, 300), segments: [] };
    }
    if (!Array.isArray(out.segments)) {
      // A response that is "ok" but carries no segments ARRAY is a malformed vendor payload, not a
      // verdict about the document. Coercing it to [] would read as "the classifier could not place
      // this" and bucket a vendor problem as permanently unplaceable.
      return { available: true, ok: false, reason: 'the classifier returned a malformed response', segments: [] };
    }
    return { available: true, ok: true, reason: null, segments: out.segments };
  } catch (e) {
    return { available: true, ok: false, reason: (e && e.message) ? String(e.message).slice(0, 300) : 'the classifier threw', segments: [] };
  }
}

module.exports = {
  OUTCOME,
  classifyDocument,
  summarizeClassification,
  _internals: { normalizeSegment, dominantSegment, familyVerdict },
};
