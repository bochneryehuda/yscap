'use strict';
/**
 * File completeness / stipulations engine.
 *
 * Tie-out tells you whether the documents you HAVE agree; it says nothing about what is still
 * MISSING. This engine holds a required-document matrix per deal type and diffs it against the
 * file, producing a live outstanding-items (stipulation) list and a completeness percentage —
 * the "what's still needed to close" view every commercial platform leads with.
 *
 * Each required item is bucketed the way a real condition sheet is: by OWNER (who has to produce
 * it — borrower / title / appraiser / internal) and by GATING (Prior-to-Docs vs Prior-to-Funding).
 * Some items are CONDITIONAL — only required when the deal is an entity loan, an assignment, or in
 * a flood zone — so the list adapts to the file instead of demanding irrelevant paper.
 *
 * This is a VIEW (a stipulation list + counts), NOT a new set of document_findings — the file's
 * condition checklist already owns sign-off; this reports readiness against the ideal set. Pure:
 * no AI, no DB.
 *
 * Per-item status:
 *   missing      — nothing uploaded for this document anywhere on the file (truly not provided)
 *   on_file      — a document IS uploaded/attached to this document's condition but hasn't been read
 *                  yet (the reader will pick it up automatically). This is the critical distinction:
 *                  a file that HAS the document must never read as "missing" just because the AI
 *                  hasn't analyzed it yet.
 *   insufficient — analyzed but unusable (an open FATAL finding, or an error/unreadable read)
 *   received     — analyzed, present, but with open warnings (under review)
 *   cleared      — analyzed and clean (ties out, ready to clear its condition)
 */

// required: 'always' | 'if_entity' | 'if_assignment' | 'if_flood_zone'
// owner:    'borrower' | 'title' | 'appraiser' | 'internal'
// gating:   'PTD' (prior to docs) | 'PTF' (prior to funding)
const REQUIREMENTS = [
  { docType: 'government_id',      label: 'Government photo ID',            required: 'always',        owner: 'borrower',  gating: 'PTD' },
  { docType: 'purchase_contract',  label: 'Executed purchase contract',    required: 'always',        owner: 'borrower',  gating: 'PTD' },
  { docType: 'appraisal',          label: 'Appraisal (valuation)',         required: 'always',        owner: 'appraiser', gating: 'PTD' },
  { docType: 'bank_statement',     label: 'Bank statements (proof of funds)', required: 'always',     owner: 'borrower',  gating: 'PTD' },
  { docType: 'credit_report',      label: 'Credit report',                 required: 'always',        owner: 'internal',  gating: 'PTD' },
  { docType: 'background_report',  label: 'Background / OFAC screen',       required: 'always',        owner: 'internal',  gating: 'PTD' },
  { docType: 'title',              label: 'Title commitment',              required: 'always',        owner: 'title',     gating: 'PTF' },
  // The insurance CONDITION takes TWO documents: the binder/evidence AND proof the premium is paid.
  { docType: 'insurance',          label: 'Evidence of insurance (binder)', required: 'always',       owner: 'borrower',  gating: 'PTF' },
  { docType: 'insurance_invoice',  label: 'Insurance invoice (paid premium)', required: 'always',     owner: 'borrower',  gating: 'PTF' },
  { docType: 'flood',              label: 'Flood determination',           required: 'always',        owner: 'title',     gating: 'PTF' },
  // Entity (LLC) borrower stack.
  { docType: 'llc_formation',      label: 'Articles of Organization',      required: 'if_entity',     owner: 'borrower',  gating: 'PTD' },
  { docType: 'operating_agreement', label: 'Operating agreement',          required: 'if_entity',     owner: 'borrower',  gating: 'PTD' },
  { docType: 'ein_letter',         label: 'IRS EIN letter',                required: 'if_entity',     owner: 'borrower',  gating: 'PTD' },
  { docType: 'good_standing',      label: 'Certificate of good standing',  required: 'if_entity',     owner: 'borrower',  gating: 'PTF' },
  // Wholesale / assignment deals.
  { docType: 'assignment',         label: 'Assignment of contract',        required: 'if_assignment', owner: 'borrower',  gating: 'PTD' },
  // The settlement statement is a POST-CLOSING document only (owner-directed 2026-07-21) and is
  // NOT in the pre-close required-document matrix. When the post-closing module is built, add its
  // row back here as required:'always', owner:'title', gating:'PTF'. The reader/classifier/schema
  // are still registered so an uploaded settlement statement still reads for reference.
];

function applies(req, flags) {
  switch (req.required) {
    case 'always': return true;
    case 'if_entity': return !!flags.isEntity;
    case 'if_assignment': return !!flags.isAssignment;
    case 'if_flood_zone': return !!flags.floodZone;
    default: return false;
  }
}

// Status of one required doc from its extraction + that doc's open findings. `attached` is the set
// of docTypes that have a real document UPLOADED to their condition (even if not yet read), so an
// un-analyzed-but-present document reads as 'on_file', never a false 'missing'.
function statusFor(docType, byType, findingsByType, attached) {
  const ext = byType.get(docType);
  if (!ext) return (attached && attached.has(docType)) ? 'on_file' : 'missing';
  const st = ext.status || 'analyzed';
  const conf = ext.confidence || null;
  const open = (findingsByType.get(docType) || []).filter((f) => (f.status || 'open') === 'open');
  if (st === 'error' || conf === 'unreadable' || open.some((f) => f.severity === 'fatal')) return 'insufficient';
  if (open.some((f) => f.severity === 'warning')) return 'received';
  return 'cleared';
}

/**
 * @param {{isEntity?, isAssignment?, floodZone?, dealType?}} flags
 * @param {Array<{doc_type,status,confidence}>} extractions  current extractions
 * @param {Array<{source,severity,status}>} findings          open findings
 * @returns {{ stipulations, counts, completenessPct, outstanding, ctcBlockers, docsComplete }}
 */
function assessCompleteness(flags = {}, extractions = [], findings = [], attached = new Set()) {
  const attachedSet = attached instanceof Set ? attached : new Set(attached || []);
  const byType = new Map();
  const typeByDocId = new Map();   // which document a finding was raised on -> its doc type
  for (const e of extractions) {
    if (!byType.has(e.doc_type)) byType.set(e.doc_type, e);
    if (e.document_id) typeByDocId.set(e.document_id, e.doc_type);
  }
  // Group findings by the DOCUMENT they were raised on, not by `source` — some findings (a PDF
  // tampering scan) carry a non-docType source (e.g. 'fraud_scan') but a real document_id, and
  // must still count against that document's stipulation. Fall back to source when there's no
  // document link (or the doc isn't a current extraction).
  const findingsByType = new Map();
  for (const f of findings) {
    const t = (f.document_id && typeByDocId.get(f.document_id)) || f.source;
    if (!findingsByType.has(t)) findingsByType.set(t, []);
    findingsByType.get(t).push(f);
  }

  // Program-aware labeling (AUS, Item 11): when the file is registered, the bank-statement
  // stipulation states the program's required month count (Gold 2 / Standard 1 / Manual N) so the
  // "what's still needed" list reflects the program it's underwritten against. Label only — the
  // month count is resolved by the caller from the canonical liquidity rule; gating is unchanged.
  const bankMonths = Number(flags.bankStmtMonths);
  const stipulations = [];
  for (const req of REQUIREMENTS) {
    if (!applies(req, flags)) continue;
    const status = statusFor(req.docType, byType, findingsByType, attachedSet);
    let label = req.label;
    if (req.docType === 'bank_statement' && Number.isFinite(bankMonths) && bankMonths > 0) {
      label = `Bank statements — ${bankMonths} month${bankMonths === 1 ? '' : 's'} (proof of funds)`;
    }
    stipulations.push({ docType: req.docType, label, owner: req.owner, gating: req.gating, status });
  }

  const counts = { total: stipulations.length, cleared: 0, received: 0, insufficient: 0, on_file: 0, missing: 0 };
  for (const s of stipulations) counts[s.status] += 1;
  const completenessPct = counts.total ? Math.round((counts.cleared / counts.total) * 100) : 100;
  const outstanding = stipulations.filter((s) => s.status !== 'cleared');
  // Prior-to-funding items that are not cleared block clear-to-close. (An on_file-but-unread PTF
  // document is still not cleared, so it stays a blocker until it's read and ties out — but the
  // stipulation now says "on file, being read", not the false "missing".)
  const ctcBlockers = stipulations.filter((s) => s.gating === 'PTF' && s.status !== 'cleared');
  const docsComplete = outstanding.length === 0;
  // TRULY missing = nothing uploaded at all (the real "go get this document" list, distinct from
  // "uploaded, just not read yet"). Surfaced separately so the desk can show an honest ask.
  const trulyMissing = stipulations.filter((s) => s.status === 'missing');

  return { stipulations, counts, completenessPct, outstanding, ctcBlockers, docsComplete, trulyMissing };
}

module.exports = { assessCompleteness, REQUIREMENTS, _internals: { applies, statusFor } };
