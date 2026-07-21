'use strict';
/**
 * Auto-reader queue selection (pure).
 *
 * "Read and check every document automatically" (owner-directed 2026-07-20) means: for each document
 * the file already HAS — filed under a condition (the title commitment under the title condition, the
 * insurance binder under the insurance condition, …) — read + check it AS the type that condition
 * expects, with no per-document click. This module isolates the decision of WHICH documents to read
 * and AS WHAT type, so it can be unit-tested without a database or the paid Azure reader.
 *
 * A document is a candidate when: it's on the file, it maps (via the condition it's filed under, or
 * its doc_kind as a fallback) to a document type the reader can actually read, and it has NOT been
 * read yet (no current extraction). Everything else — the paid read, persistence, idempotency cache,
 * error handling — is the route's analyzeOneDocument.
 */
const { expectedDocTypeForCode } = require('./condition-map');

/**
 * @param {object} args
 *   documents   [{ id, condition_code, doc_kind, filename }] — current, non-rejected on-file docs
 *   analyzedIds Set|Array of document ids that already have a current extraction (skip these)
 *   isReadable  (docType) => boolean — whether the reader has a checker for this type (registry.get)
 * @returns {Array<{ id, expectedType, conditionCode, filename }>} the read queue, in input order
 */
function selectAutoReadQueue({ documents = [], analyzedIds = new Set(), isReadable = () => true } = {}) {
  const analyzed = analyzedIds instanceof Set ? analyzedIds : new Set(analyzedIds || []);
  const queue = [];
  for (const d of documents) {
    if (!d || !d.id) continue;
    // The condition the document is filed under says what type it should be; fall back to its
    // doc_kind. Never guess — a document with no mapped type is left for a human.
    const expectedType = expectedDocTypeForCode(d.condition_code) ||
      (d.doc_kind ? expectedDocTypeForCode(d.doc_kind) : null);
    if (!expectedType || !isReadable(expectedType)) continue;
    if (analyzed.has(d.id)) continue; // already read — the analyze-once cache would no-op it anyway
    queue.push({ id: d.id, expectedType, conditionCode: d.condition_code || null, filename: d.filename || null });
  }
  return queue;
}

module.exports = { selectAutoReadQueue };
