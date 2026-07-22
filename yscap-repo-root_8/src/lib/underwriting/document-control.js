'use strict';
/**
 * R6.12 — SharePoint document-control reconciliation (deterministic core).
 *
 * SharePoint is the controlled document MIRROR + integrity checker — NOT the
 * loan-data authority. For the whole-loan run it answers document-control
 * questions: is every current document mirrored, is its mirror integrity
 * verified, is any mirror corrupt or source-suspect, and is the signed term
 * sheet present in the signed location? Its findings are DOCUMENT-CONTROL
 * findings for the one run registry — they never alter loan economics.
 *
 * HARD RULE: read-only over document state. It reports mirror gaps; it never
 * moves, deletes, re-mirrors, or changes a document (the SharePoint sync owns
 * those, guarded). Missing loan economics are NOT inferred from folder names.
 *
 * Pure: no DB, no AI, no network. Consumes already-loaded `documents` rows with
 * their sharepoint_* mirror state (db/091 + db/115).
 */

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// A document is "deliberately not mirrored" (not a gap) when the sync recorded a
// benign skip reason (a superseded snapshot, duplicate bytes, etc.).
function isBenignSkip(reason) {
  const r = norm(reason);
  return r === 'superseded_snapshot' || r === 'duplicate' || r === 'duplicate_bytes' || r === 'not_current';
}

// Integrity verdicts that mean the mirror is BAD.
const BAD_INTEGRITY = new Set(['corrupt', 'source-suspect', 'source_suspect', 'local-missing', 'local_missing']);

/**
 * reconcileDocumentControl({ documents, mirrorEnabled }) → { findings, summary }.
 *   documents: current (is_current) document rows, each with:
 *     { id, doc_kind, filename, is_current, sharepoint_backup_ref,
 *       sharepoint_integrity, sharepoint_verified_at, sharepoint_skipped_reason }
 *   mirrorEnabled: is the SharePoint mirror configured/on? (when off, an
 *     un-mirrored doc is NOT a finding — nothing is expected to be mirrored).
 * Findings are document-control WARNINGS for the run registry (they surface a
 * control gap; they never block loan economics). A corrupt/source-suspect mirror
 * of a CURRENT document does block CTC (a bad controlled copy must be fixed
 * before closing).
 */
function reconcileDocumentControl(inputs) {
  const i = inputs || {};
  const docs = (i.documents || []).filter((d) => d && d.is_current !== false);
  const mirrorEnabled = i.mirrorEnabled !== false;
  const findings = [];
  let mirrored = 0, unmirrored = 0, corrupt = 0;

  for (const d of docs) {
    const hasMirror = !!d.sharepoint_backup_ref;
    const integrity = norm(d.sharepoint_integrity);
    const benignSkip = isBenignSkip(d.sharepoint_skipped_reason);

    if (BAD_INTEGRITY.has(integrity)) {
      corrupt += 1;
      findings.push(mk('sharepoint_mirror_integrity', 'warning', `${label(d)} mirror failed integrity`,
        `The controlled copy of "${label(d)}" is ${d.sharepoint_integrity}. It must be re-mirrored/replaced before closing.`,
        { subject: d.id, blocks_ctc: true }));
      continue;
    }
    if (hasMirror) { mirrored += 1; continue; }
    if (benignSkip) continue; // deliberately not mirrored — not a gap
    if (!mirrorEnabled) continue; // mirror off → nothing expected

    unmirrored += 1;
    findings.push(mk('sharepoint_not_mirrored', 'info', `${label(d)} not yet mirrored`,
      `"${label(d)}" has not been copied to the controlled document store yet.`, { subject: d.id }));
  }

  // Signed term sheet presence: if a term-sheet doc exists it should have a
  // verified mirror (the signed/current copy). A term sheet with a bad or absent
  // mirror is a control gap already covered above; here we note ABSENCE of any
  // term-sheet document at all is left to the condition system (not inferred).

  return {
    findings,
    summary: { total: docs.length, mirrored, unmirrored, corrupt, mirrorEnabled },
  };
}

function label(d) { return d.filename || d.doc_kind || 'a document'; }

function mk(code, severity, title, explanation, extra) {
  return Object.assign({
    code, severity, category: 'document_control', title, explanation, source: 'sharepoint',
    blocks_term_sheet: false, blocks_ctc: false, blocks_funding: false,
  }, extra || {});
}

module.exports = { reconcileDocumentControl, _internals: { isBenignSkip, BAD_INTEGRITY } };
