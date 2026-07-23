'use strict';
/**
 * #191 activation 1 — clearance PREVIEW composition (pure).
 *
 * "Would the documents on this condition clear it?" — composes the SAME
 * deterministic pieces the extraction pipeline records proofs with:
 * cure.analyze (per document) + clearance-outcome.aggregate — into one
 * advisory preview. PURE: no DB, no AI, no writes. The route loads the
 * intent / documents / twin facts / context and calls previewDocuments;
 * persistence (persistProof) and sign-off (signOffGate) are untouched.
 */

const cure = require('./cure');
const outcomeLib = require('./clearance-outcome');

/**
 * previewDocuments({ intent, documents, twinFacts, subject, expected }) → {
 *   documents: [{ documentId, docType, filename, result, summary, requirements,
 *                 signals, outcome, clears, outcomeReason, unmet }],
 *   overall:   { clears, outcome, reason },
 * }
 * documents in: [{ documentId, docType, filename, fields }] — the condition's
 * CURRENT analyzed extractions (rejected documents excluded by the caller).
 * overall prefers a clearing document, else the first for context. NOTE: this
 * is the ANALYSIS-level answer only — slot-gated conditions (insurance,
 * appraisal docs, fraud) additionally require every slot filled; the ROUTE
 * overlays that check from signOffGate's slot rules (which stay the authority).
 */
function previewDocuments({ intent, documents = [], twinFacts = {}, subject = {}, expected = {} } = {}) {
  const acceptable = intent && Array.isArray(intent.acceptable_evidence)
    ? intent.acceptable_evidence.map(String) : [];
  const out = (documents || []).map((row) => {
    const analysis = cure.analyze({ intent, extractionFields: row.fields || {}, twinFacts, subject, expected });
    const signals = {
      wrongDocument: acceptable.length > 0 && !acceptable.includes(String(row.docType)),
      unreadable: !!(row.fields && row.fields.readable === false),
    };
    const outcome = outcomeLib.aggregate(analysis.requirements, signals);
    return {
      documentId: row.documentId || null, docType: row.docType || null, filename: row.filename || null,
      result: analysis.result, summary: analysis.summary, requirements: analysis.requirements,
      signals, outcome: outcome.outcome, clears: outcome.clears,
      outcomeReason: outcome.reason, unmet: outcome.unmet,
    };
  });
  const best = out.find((d) => d.clears) || out[0] || null;
  const overall = out.length === 0
    ? { clears: false, outcome: 'no_documents', reason: 'No current analyzed documents are attached to this condition yet.' }
    : { clears: !!(best && best.clears), outcome: best ? best.outcome : 'unable_to_determine', reason: best ? best.outcomeReason : null };
  return { documents: out, overall };
}

module.exports = { previewDocuments };
