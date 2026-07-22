'use strict';
/**
 * Package-splitter suggestion helper (owner-directed 2026-07-22, R3.4).
 *
 * Borrowers routinely upload one PDF containing several documents merged (bank
 * statement + insurance dec + driver's license + operating agreement, all in
 * one file). The Azure Custom Classifier (src/lib/ai/azure-custom.js) returns
 * per-page-range doc types + confidence. This module runs the classifier on
 * a candidate combined PDF and, when it finds ≥2 distinct doc types, posts
 * a single ai_suggestion (source='splitter', kind='info') offering to split
 * the file into the identified pieces. A human clicks "Split + file" (or
 * dismisses) on the AI Findings panel.
 *
 * Per the HARD RULE the AI never splits or files documents on its own. The
 * suggestion carries the exact page ranges + candidate condition codes; the
 * split action itself is a separate route (out of scope here) that a human
 * clicks. Dormant until the classifier id is set (AZURE_DOCINT_CLASSIFIER_ID).
 */

const azc = require('../ai/azure-custom');
const aiSug = require('./ai-suggestions');
const wc = require('./wrong-condition');
const langfuse = require('../ai/langfuse');

// Only meaningful for a PDF over a few pages — a 2-page single-doc upload isn't a package.
const MIN_PAGES_TO_CONSIDER = 5;

/**
 * @param {*} client pg client (transaction honored)
 * @param {{applicationId:string, documentId:string, buffer?:Buffer, base64?:string,
 *          pageCount?:number, staffId?:string}} args
 * @returns {Promise<{ok:boolean, reason?:string, segments?:number, suggestionId?:string}>}
 */
async function suggestSplit(client, {
  applicationId, documentId, buffer, base64, pageCount, staffId,
} = {}) {
  if (!applicationId || !documentId) return { ok: false, reason: 'applicationId + documentId required' };
  if (!azc.classifierConfigured()) return { ok: false, reason: 'classifier not configured' };
  // Only run when the doc is big enough that splitting could matter.
  if (pageCount != null && pageCount < MIN_PAGES_TO_CONSIDER) return { ok: false, reason: 'too small to split' };

  const trace = langfuse.trace({
    name: 'splitter:suggest', appId: applicationId, documentId, staffId,
    tags: ['splitter', 'suggest'],
  });
  let classifier;
  try {
    classifier = await azc.classify({ buffer, base64, appId: applicationId, documentId, trace });
  } catch (e) {
    trace.end({ output: { error: e && e.message } });
    return { ok: false, reason: (e && e.message) || 'classifier error' };
  }
  if (!classifier.ok) {
    trace.end({ output: { error: classifier.reason } });
    return { ok: false, reason: classifier.reason };
  }
  const segments = classifier.segments || [];
  // Only surface when the classifier saw 2+ different doc types (a real package).
  const distinctTypes = new Set(segments.map(s => s.docType).filter(Boolean));
  if (distinctTypes.size < 2) {
    trace.end({ output: { segments: segments.length, distinctTypes: distinctTypes.size } });
    return { ok: true, segments: segments.length, reason: 'single-type upload — no split needed' };
  }

  const rec = await aiSug.record(client, {
    applicationId, documentId,
    source: 'splitter', kind: 'info',
    title: `This looks like a combined PDF (${distinctTypes.size} different documents)`,
    body: `PILOT read the pages and detected ${segments.length} document(s) inside this upload:\n${segments.map((s, i) => `  ${i + 1}. ${prettyType(s.docType) || s.rawLabel} — page(s) ${s.pages.join(', ')} (${Math.round(s.confidence * 100)}% confident)`).join('\n')}\n\nSplitting the PDF into separate documents lets each one be filed under the right condition (and read by the matching field extractor).`,
    confidence: segments.reduce((a, s) => a + (s.confidence || 0), 0) / segments.length,
    traceUrl: trace.url ? trace.url() : null,
    evidence: {
      segments: segments.map(s => ({
        docType: s.docType, rawLabel: s.rawLabel, confidence: s.confidence, pages: s.pages,
        candidateConditionCodes: wc.conditionCodesForType(s.docType),
      })),
    },
    proposedAction: {
      type: 'split_and_file',
      segments: segments.map(s => ({
        docType: s.docType, pages: s.pages, confidence: s.confidence,
        candidateConditionCodes: wc.conditionCodesForType(s.docType),
      })),
    },
    dedupeKey: `splitter:${documentId}`,
  });
  trace.end({ output: { segments: segments.length, distinctTypes: distinctTypes.size, suggestionId: rec.id } });
  return { ok: true, segments: segments.length, suggestionId: rec.id };
}

function prettyType(t) {
  return ({
    bank_statement: 'bank statement',
    insurance: 'homeowner\'s insurance dec page',
    operating_agreement: 'LLC operating agreement',
    drivers_license: 'driver\'s license',
    settlement: 'settlement statement',
    purchase_contract: 'purchase contract',
  }[t]) || t;
}

module.exports = { suggestSplit, MIN_PAGES_TO_CONSIDER };
