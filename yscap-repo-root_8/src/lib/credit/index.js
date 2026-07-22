'use strict';
/**
 * Credit-report import orchestrator (owner-directed 2026-07-22).
 *
 *   preview(appId)       — the borrower info that WILL be sent + the defaults
 *                          (soft · reissue · tri-merge · v3.4) + provider status.
 *   importCredit(appId)  — pull/reissue via the shared login (or import a
 *                          downloaded XML+PDF), parse the XML, store everything,
 *                          write the FICO back. Re-reads the borrower PII
 *                          server-side — never trusts anything from the client.
 *   fileCredit(appId)    — the latest parsed report + history for the UI section.
 */
const db = require('../../db');
const C = require('../crypto');
const provider = require('./provider');
const { parseCreditXml } = require('./parse');
const store = require('./store');

const PULL_TYPES = ['soft', 'hard'];
const REQUEST_TYPES = ['reissue', 'new'];

function userError(msg, status) { const e = new Error(msg); e.userMessage = msg; e.status = status || 422; return e; }

async function loadForPull(appId) {
  const r = await db.query(
    `SELECT a.id, a.borrower_id, a.property_address, a.ys_loan_number,
            b.first_name, b.last_name, b.date_of_birth, b.ssn_encrypted, b.ssn_last4,
            b.current_address
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  if (!r.rows[0]) throw userError('File not found.', 404);
  return r.rows[0];
}

// The reference number of a prior completed report on this file — used to
// default a Reissue (re-pull an existing Xactus report without a new inquiry).
async function priorReportId(appId) {
  const r = await db.query(
    `SELECT vendor_report_id FROM credit_reports
      WHERE application_id=$1 AND vendor_report_id IS NOT NULL AND status='completed'
      ORDER BY pulled_at DESC LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].vendor_report_id : null;
}

// The borrower packet sent to Xactus. `includeSsn` decrypts the SSN (import
// only); the preview never decrypts it (it shows the masked last-4).
function borrowerToSend(row, { includeSsn }) {
  const addr = row.current_address || {};
  let ssn = null;
  if (includeSsn && row.ssn_encrypted) {
    try { ssn = C.decryptSSN(row.ssn_encrypted); } catch (_) { ssn = null; }
  }
  return {
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    dob: row.date_of_birth || null,           // already 'YYYY-MM-DD' (pg date parser)
    ssn,                                        // 9 bare digits, import only
    ssnLast4: row.ssn_last4 || null,
    address: {
      line1: addr.line1 || null, line2: addr.line2 || null,
      city: addr.city || null, state: addr.state || null, zip: addr.zip || null,
    },
  };
}

// What's missing that blocks a live pull (a downloaded-file import needs none of it).
function missingForPull(b) {
  const miss = [];
  if (!b.firstName) miss.push('first name');
  if (!b.lastName) miss.push('last name');
  if (!b.ssnLast4) miss.push('Social Security number');
  const a = b.address || {};
  if (!a.line1) miss.push('street address');
  if (!a.city) miss.push('city');
  if (!a.state) miss.push('state');
  if (!a.zip) miss.push('ZIP code');
  return miss;
}

async function preview(appId) {
  const row = await loadForPull(appId);
  const b = borrowerToSend(row, { includeSsn: false });
  // Prior report reference (pre-fills a Reissue). On a file's FIRST pull there is
  // none — so default the order to "brand-new" (a reissue with no reference would
  // otherwise 422 on the very first click). Once a report exists, default to the
  // faster Reissue.
  const prior = await priorReportId(appId);
  return {
    borrower: {
      firstName: b.firstName, lastName: b.lastName, dob: b.dob,
      hasSsn: !!row.ssn_encrypted,
      ssnMasked: row.ssn_last4 ? `•••-••-${row.ssn_last4}` : null,
      address: b.address,
    },
    defaults: { pullType: 'soft', requestType: prior ? 'reissue' : 'new', bureaus: provider.ALL_BUREAUS, version: provider.version() },
    options: {
      pullTypes: [
        { value: 'soft', label: 'Soft pull — pre-application', hint: 'A soft inquiry that does not affect the borrower’s score.' },
        { value: 'hard', label: 'Hard pull — full credit report', hint: 'A hard inquiry — a full report.' },
      ],
      requestTypes: [
        { value: 'reissue', label: 'Reissue an existing report', hint: 'Re-pull a report already on file (faster).' },
        { value: 'new', label: 'Order a brand-new report', hint: 'Order a fresh report.' },
      ],
    },
    provider: provider.status(),
    missing: missingForPull(b),
    canPull: missingForPull(b).length === 0,
    // Prior report reference (pre-fills a Reissue). Null on a file's first pull.
    reissueReportId: prior,
  };
}

async function importCredit(appId, opts = {}) {
  const row = await loadForPull(appId);
  const pullType = PULL_TYPES.includes(opts.pullType) ? opts.pullType : 'soft';
  const requestType = REQUEST_TYPES.includes(opts.requestType) ? opts.requestType : 'reissue';
  const bureaus = provider.ALL_BUREAUS;                    // always tri-merge
  const version = (opts.version && String(opts.version).trim()) || provider.version();

  let xml = opts.xml || null;
  let pdfBase64 = opts.pdfBase64 || null;
  let source = 'api';
  let vendorReportId = null;

  if (xml || pdfBase64) {
    // Import a report the team downloaded from Xactus (works today, no live call).
    source = 'upload';
    if (typeof xml === 'string' && /^(JVBER|%PDF-)/i.test(xml.trim())) {
      // guard against a PDF put in the XML slot (raw %PDF- or base64 JVBER…)
      throw userError('That looks like a PDF in the report-data box. Put the PDF in the PDF box and the XML data file in the data box.');
    }
  } else {
    // Live pull/reissue via the shared login. A live pull OBTAINS a consumer
    // report from the bureaus, so it REQUIRES an explicit permissible-purpose /
    // borrower-consent attestation (FCRA). Enforced HERE server-side — not just by
    // the UI checkbox — BEFORE we decrypt the SSN, and recorded on the report row
    // + audit log. (An upload of an already-obtained report needs no attestation.)
    if (opts.consent !== true) {
      throw userError('Before pulling credit, confirm the borrower authorized it (permissible purpose). Check the authorization box and try again.');
    }
    const b = borrowerToSend(row, { includeSsn: true });
    const miss = missingForPull(b);
    if (miss.length) throw userError(`Can’t pull credit yet — this file is missing the borrower’s ${miss.join(', ')}.`);
    if (!b.ssn) throw userError('The borrower’s Social Security number couldn’t be read for this pull.');
    // A Reissue re-pulls an existing report by its reference number: use the one
    // the caller entered, else the last completed report on this file.
    let reissueReportId = (opts.reissueReportId && String(opts.reissueReportId).trim()) || null;
    if (requestType === 'reissue' && !reissueReportId) reissueReportId = await priorReportId(appId);
    const res = await provider.pull({ borrower: b, pullType, requestType, bureaus, version, reissueReportId, loanNumber: row.ys_loan_number });
    xml = res.xml; pdfBase64 = res.pdfBase64; vendorReportId = res.vendorReportId;
    if (!xml && !pdfBase64) throw userError('Xactus returned nothing for this request.');
  }

  const parsed = xml ? parseCreditXml(xml) : {
    parseError: 'no data file returned', version: null, bureausReturned: [], scores: [],
    middleScore: null, borrower: null, liabilities: [], inquiries: [], publicRecords: [], summary: null,
    reportDate: null, reportId: vendorReportId || null,
  };
  if (vendorReportId && !parsed.reportId) parsed.reportId = vendorReportId;

  // A live pull that OBTAINED a data file yet yielded zero scores AND zero
  // tradelines is almost certainly not a real credit report (an error/gateway page
  // returned with HTTP 200, or an unexpected layout) — flag it rather than let it
  // look like a clean success. An upload or a genuine thin/no-hit file is unaffected.
  const emptyLivePull = source === 'api' && !parsed.parseError
    && (!parsed.scores || parsed.scores.length === 0)
    && (!parsed.liabilities || parsed.liabilities.length === 0);
  if (emptyLivePull) parsed.parseError = parsed.parseError || 'no credit data recognized in the response';

  const stored = await store.storeImport({
    app: row, parsed, xml, pdfBase64,
    request: { pullType, requestType, bureaus, version }, actorId: opts.actorId, source,
    consentAttested: opts.consent === true,
  });

  return {
    ok: true, source,
    creditReportId: stored.creditReportId,
    pullType, requestType,
    consentAttested: opts.consent === true,
    middleScore: parsed.middleScore,
    ficoWritten: stored.ficoWritten,
    ficoMismatch: stored.ficoMismatch,
    ficoUnverified: stored.ficoUnverified,
    parseError: parsed.parseError || null,
    hasPdf: !!stored.pdfDocId, hasXml: !!stored.xmlDocId,
    pdfMissing: source === 'api' && !stored.pdfDocId,
    summary: parsed.summary || null,
    bureausReturned: parsed.bureausReturned || [],
    scores: parsed.scores || [],
  };
}

// Shape a credit_reports row (+ its parsed jsonb) for the UI section.
function shapeReport(r, { full }) {
  const p = r.parsed || {};
  const base = {
    id: r.id, pulledAt: r.pulled_at, pullType: r.pull_type, requestType: r.request_type,
    source: r.source, version: r.interface_version, status: r.status, error: r.error,
    vendorReportId: r.vendor_report_id, reportDate: r.report_date, middleScore: r.middle_score,
    scores: r.scores || p.scores || [], summary: r.summary || p.summary || null,
    bureausReturned: p.bureausReturned || [],
    pdfDocumentId: r.pdf_document_id, xmlDocumentId: r.xml_document_id,
  };
  if (!full) return base;
  return {
    ...base,
    borrower: p.borrower || null,
    liabilities: p.liabilities || [],
    inquiries: p.inquiries || [],
    publicRecords: p.publicRecords || [],
    parseError: p.parseError || null,
  };
}

async function fileCredit(appId) {
  const latest = await db.query(
    'SELECT * FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 1', [appId]);
  const hist = await db.query(
    `SELECT id, pulled_at, pull_type, request_type, source, status, middle_score, interface_version
       FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 25`, [appId]);
  return {
    hasReport: latest.rows.length > 0,
    provider: provider.status(),
    report: latest.rows[0] ? shapeReport(latest.rows[0], { full: true }) : null,
    history: hist.rows.map((r) => ({
      id: r.id, pulledAt: r.pulled_at, pullType: r.pull_type, requestType: r.request_type,
      source: r.source, status: r.status, middleScore: r.middle_score, version: r.interface_version,
    })),
  };
}

module.exports = { preview, importCredit, fileCredit, PULL_TYPES, REQUEST_TYPES };
