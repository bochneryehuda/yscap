'use strict';
/**
 * Credit-report import orchestrator (owner-directed 2026-07-22; co-borrower 2026-07-23).
 *
 *   preview(appId)       — the borrower(s) that WILL be sent + the defaults
 *                          (soft · reissue · tri-merge · v3.4) + provider status.
 *                          With a co-borrower, returns BOTH borrowers.
 *   importCredit(appId)  — pull/reissue via the shared login (or import a
 *                          downloaded XML+PDF) for the selected borrower(s), parse
 *                          each XML, store everything, write each FICO back. Re-reads
 *                          every borrower's PII server-side — never trusts the client.
 *                          Default = pull EVERY borrower on the file in one action;
 *                          a subset ("pull one now") auto-opens the other borrower's
 *                          own credit condition so their credit is still required.
 *   fileCredit(appId)    — the latest parsed report + history + the per-borrower
 *                          summary (each middle score + the higher-of-two that prices
 *                          the deal) for the UI section.
 *
 * A joint pull is modelled as ONE INDIVIDUAL transaction PER BORROWER (not a single
 * MISMO "Joint" request): the credit-report RESPONSE shape is only verified for a
 * single borrower, so splitting a joint response by borrower would be guessing. Two
 * individual pulls reuse the proven single-borrower parse/store/scoring per borrower
 * and give each a clean, unambiguous middle score for the higher-of-two rule.
 */
const db = require('../../db');
const C = require('../crypto');
const provider = require('./provider');
const { parseCreditXml } = require('./parse');
const store = require('./store');
const coCondition = require('./co-condition');

const PULL_TYPES = ['soft', 'hard'];
const REQUEST_TYPES = ['reissue', 'new'];

function userError(msg, status) { const e = new Error(msg); e.userMessage = msg; e.status = status || 422; return e; }
function roleWord(role) { return role === 'co' ? 'co-borrower’s' : 'borrower’s'; }
function nameOfRow(row, role) {
  return [row && row.first_name, row && row.last_name].filter(Boolean).join(' ')
    || (role === 'co' ? 'Co-borrower' : 'Borrower');
}

// The file basics + both borrower ids.
async function loadFile(appId) {
  const r = await db.query(
    `SELECT a.id, a.borrower_id, a.co_borrower_id, a.property_address, a.ys_loan_number
       FROM applications a
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  if (!r.rows[0]) throw userError('File not found.', 404);
  return r.rows[0];
}

// One borrower's PII row (the columns borrowerToSend reads).
async function loadBorrower(borrowerId) {
  if (!borrowerId) return null;
  const r = await db.query(
    `SELECT id, first_name, last_name, date_of_birth, ssn_encrypted, ssn_last4, current_address, fico
       FROM borrowers WHERE id = $1`, [borrowerId]);
  return r.rows[0] || null;
}

// The borrowers credit is pulled for: primary always, then the co-borrower when
// present. Order = primary first.
async function fileBorrowers(appId) {
  const file = await loadFile(appId);
  const borrowers = [{ borrowerId: file.borrower_id, role: 'primary', row: (await loadBorrower(file.borrower_id)) || {} }];
  if (file.co_borrower_id) {
    borrowers.push({ borrowerId: file.co_borrower_id, role: 'co', row: (await loadBorrower(file.co_borrower_id)) || {} });
  }
  return { file, borrowers };
}

// The reference number of a prior completed report for a borrower on this file —
// used to default a Reissue (re-pull an existing Xactus report without a new
// inquiry). Scoped to the borrower so each borrower reissues their OWN report.
async function priorReportId(appId, borrowerId) {
  const r = await db.query(
    `SELECT vendor_report_id FROM credit_reports
      WHERE application_id=$1 AND ($2::uuid IS NULL OR borrower_id=$2)
        AND vendor_report_id IS NOT NULL AND status='completed'
      ORDER BY pulled_at DESC LIMIT 1`, [appId, borrowerId || null]);
  return r.rows[0] ? r.rows[0].vendor_report_id : null;
}

// The borrower packet sent to Xactus. `includeSsn` decrypts the SSN (import
// only); the preview never decrypts it (it shows the masked last-4).
function borrowerToSend(row, { includeSsn }) {
  const addr = (row && row.current_address) || {};
  let ssn = null;
  if (includeSsn && row && row.ssn_encrypted) {
    try { ssn = C.decryptSSN(row.ssn_encrypted); } catch (_) { ssn = null; }
  }
  return {
    firstName: (row && row.first_name) || null,
    lastName: (row && row.last_name) || null,
    dob: (row && row.date_of_birth) || null,   // already 'YYYY-MM-DD' (pg date parser)
    ssn,                                         // 9 bare digits, import only
    ssnLast4: (row && row.ssn_last4) || null,
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
  const { borrowers } = await fileBorrowers(appId);
  const shaped = [];
  for (const bb of borrowers) {
    const b = borrowerToSend(bb.row, { includeSsn: false });
    const miss = missingForPull(b);
    const prior = await priorReportId(appId, bb.borrowerId);
    shaped.push({
      borrowerId: bb.borrowerId, role: bb.role,
      name: nameOfRow(bb.row, bb.role),
      firstName: b.firstName, lastName: b.lastName, dob: b.dob,
      hasSsn: !!(bb.row && bb.row.ssn_encrypted),
      ssnMasked: bb.row && bb.row.ssn_last4 ? `•••-••-${bb.row.ssn_last4}` : null,
      address: b.address,
      missing: miss,
      canPull: miss.length === 0,
      reissueReportId: prior,
    });
  }
  const primary = shaped[0] || {};
  // The order ALWAYS defaults to Reissue (owner-directed). On a file's first pull
  // there is no prior reference to pre-fill — the reference field is then empty and
  // the screen guides the user to type it or switch to brand-new (a reissue with no
  // reference is rejected with a clear message, never a silent failure).
  return {
    // Every borrower on the file (primary first). The import screen shows them all
    // and pulls all by default; a per-borrower toggle drops one from this pull.
    borrowers: shaped,
    hasCoBorrower: shaped.length > 1,
    // Back-compat single-borrower fields (the primary) — the review card + the
    // gates below still read these.
    borrower: {
      firstName: primary.firstName, lastName: primary.lastName, dob: primary.dob,
      hasSsn: primary.hasSsn, ssnMasked: primary.ssnMasked, address: primary.address,
    },
    defaults: { pullType: 'soft', requestType: 'reissue', bureaus: provider.ALL_BUREAUS, version: provider.version() },
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
    missing: primary.missing || [],
    canPull: !!primary.canPull,
    // Prior report reference (pre-fills a Reissue). Null on a file's first pull.
    reissueReportId: primary.reissueReportId || null,
  };
}

// Pull/upload → parse → store for ONE borrower. Throws userError on a hard failure.
async function importOne({ file, target, opts, pullType, requestType, version, isUpload }) {
  const bureaus = provider.ALL_BUREAUS;                    // always tri-merge
  let xml = opts.xml || null;
  let pdfBase64 = opts.pdfBase64 || null;
  let source = 'api';
  let vendorReportId = null;

  if (isUpload) {
    // Import a report the team downloaded from Xactus (works today, no live call).
    source = 'upload';
    if (typeof xml === 'string' && /^(JVBER|%PDF-)/i.test(xml.trim())) {
      throw userError('That looks like a PDF in the report-data box. Put the PDF in the PDF box and the XML data file in the data box.');
    }
  } else {
    const b = borrowerToSend(target.row, { includeSsn: true });
    const miss = missingForPull(b);
    if (miss.length) throw userError(`Can’t pull credit yet — this file is missing the ${roleWord(target.role)} ${miss.join(', ')}.`);
    if (!b.ssn) throw userError(`The ${roleWord(target.role)} Social Security number couldn’t be read for this pull.`);
    // A Reissue re-pulls an existing report by its reference number. The hand-typed
    // reference in the modal is the PRIMARY's; each other borrower reissues their
    // OWN prior report on file.
    let reissueReportId = (target.role === 'primary' && opts.reissueReportId && String(opts.reissueReportId).trim()) || null;
    if (requestType === 'reissue' && !reissueReportId) reissueReportId = await priorReportId(file.id, target.borrowerId);
    const res = await provider.pull({ borrower: b, pullType, requestType, bureaus, version, reissueReportId, loanNumber: file.ys_loan_number });
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
    file, borrower: { id: target.borrowerId, ssn_last4: (target.row && target.row.ssn_last4) || null, isCo: target.role === 'co' },
    parsed, xml, pdfBase64,
    request: { pullType, requestType, bureaus, version }, actorId: opts.actorId, source,
    consentAttested: !isUpload && opts.consent === true,
  });

  return {
    ok: true, source,
    creditReportId: stored.creditReportId,
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

async function importCredit(appId, opts = {}) {
  const { file, borrowers } = await fileBorrowers(appId);
  const pullType = PULL_TYPES.includes(opts.pullType) ? opts.pullType : 'soft';
  const requestType = REQUEST_TYPES.includes(opts.requestType) ? opts.requestType : 'reissue';
  const version = (opts.version && String(opts.version).trim()) || provider.version();
  const isUpload = !!(opts.xml || opts.pdfBase64);

  // Which borrowers this import targets.
  let targets;
  if (isUpload) {
    // A downloaded file is for ONE borrower — the selected one, else the primary.
    const wantId = opts.borrowerId
      || (Array.isArray(opts.borrowerIds) && opts.borrowerIds.length === 1 && opts.borrowerIds[0])
      || file.borrower_id;
    targets = borrowers.filter((b) => String(b.borrowerId) === String(wantId));
    if (!targets.length) targets = [borrowers[0]];
  } else if (Array.isArray(opts.borrowerIds)) {
    // An EXPLICIT list selects exactly those borrowers. An empty [] means "none"
    // and is rejected (never silently promoted to "pull everyone") — only an
    // ABSENT borrowerIds falls through to the default of every borrower on the file.
    const want = new Set(opts.borrowerIds.map(String));
    targets = borrowers.filter((b) => want.has(String(b.borrowerId)));
    if (!targets.length) throw userError('Select at least one borrower to pull credit for.');
  } else {
    targets = borrowers;   // default: pull EVERY borrower on the file in one action
  }

  // FCRA consent gate for a LIVE pull — enforced HERE server-side (not just the UI
  // checkbox), BEFORE we decrypt any SSN, and recorded on the report row + audit
  // log. An upload of an already-obtained report needs no attestation.
  if (!isUpload && opts.consent !== true) {
    throw userError('Before pulling credit, confirm the borrower authorized it (permissible purpose). Check the authorization box and try again.');
  }

  const results = [];
  for (const target of targets) {
    try {
      const r = await importOne({ file, target, opts, pullType, requestType, version, isUpload });
      results.push({ borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role), ...r });
    } catch (e) {
      // With a single target, preserve single-borrower behavior — re-throw so the
      // caller returns the clear error. With more than one, one borrower's failure
      // must not lose the other's report: record it and carry on.
      if (targets.length === 1) throw e;
      results.push({ borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role), ok: false, error: e.userMessage || e.message || 'Could not import for this borrower.' });
    }
  }

  // Split flow: a co-borrower on the file who was NOT pulled here gets their OWN
  // credit condition so their credit is still required + can be pulled separately.
  let coConditionOpened = false;
  const co = borrowers.find((b) => b.role === 'co');
  if (co && !targets.some((t) => String(t.borrowerId) === String(co.borrowerId))) {
    const r = await coCondition.ensureCoBorrowerCreditCondition(appId, co.borrowerId).catch(() => null);
    coConditionOpened = !!(r && (r.created || r.updated || r.itemId));
  }

  const primaryResult = results.find((r) => r.role === 'primary' && r.ok !== false)
    || results.find((r) => r.ok !== false) || results[0] || {};
  const pulled = results.filter((r) => r.ok !== false).length;

  return {
    ok: pulled > 0,
    source: primaryResult.source || (isUpload ? 'upload' : 'api'),
    pulled,
    results,
    coConditionOpened,
    // Back-compat single-result fields (the primary / first successful pull) so the
    // existing success message keeps working for a single-borrower file.
    creditReportId: primaryResult.creditReportId,
    pullType, requestType,
    consentAttested: !isUpload && opts.consent === true,
    middleScore: primaryResult.middleScore != null ? primaryResult.middleScore : null,
    ficoWritten: primaryResult.ficoWritten,
    ficoMismatch: primaryResult.ficoMismatch,
    ficoUnverified: primaryResult.ficoUnverified,
    parseError: primaryResult.parseError || null,
    hasPdf: !!primaryResult.hasPdf, hasXml: !!primaryResult.hasXml,
    pdfMissing: primaryResult.pdfMissing,
    summary: primaryResult.summary || null,
    bureausReturned: primaryResult.bureausReturned || [],
    scores: primaryResult.scores || [],
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

// A borrower's representative score for the condition summary: their latest
// completed report's middle score. `middleScore` is REPORT-BACKED only — a
// borrower not yet pulled has middleScore=null and hasReport=false (their fico is
// returned separately for reference but never used as a stand-in middle score, so
// it can never drive the higher-of-two that prices the deal).
async function borrowerScore(appId, borrowerId) {
  if (!borrowerId) return { middleScore: null, hasReport: false, fico: null };
  const r = await db.query(
    `SELECT middle_score FROM credit_reports
      WHERE application_id=$1 AND borrower_id=$2 AND status='completed' AND middle_score IS NOT NULL
      ORDER BY pulled_at DESC LIMIT 1`, [appId, borrowerId]);
  const f = await db.query('SELECT fico FROM borrowers WHERE id=$1', [borrowerId]);
  const fico = (f.rows[0] && f.rows[0].fico != null) ? f.rows[0].fico : null;
  if (r.rows[0]) return { middleScore: r.rows[0].middle_score, hasReport: true, fico };
  return { middleScore: null, hasReport: false, fico };
}

async function fileCredit(appId) {
  // The report we DISPLAY is the latest COMPLETED one — a failed/empty live pull
  // (status='error', no PDF, no data) must never hide a good report already on
  // file. Fall back to the latest attempt only when nothing completed exists yet.
  const completed = await db.query(
    "SELECT * FROM credit_reports WHERE application_id=$1 AND status='completed' ORDER BY pulled_at DESC LIMIT 1", [appId]);
  const latest = await db.query(
    'SELECT * FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 1', [appId]);
  const displayRow = completed.rows[0] || null;   // only a real, completed report is displayed
  const latestRow = latest.rows[0] || null;
  // A most-recent attempt that FAILED (errored / no recognizable data) and is NOT
  // the displayed good report — surfaced so staff clearly see "the last pull didn't
  // return a report" while the good report (and its PDF) stays visible below.
  const lastAttempt = (latestRow && latestRow.status !== 'completed' && (!displayRow || latestRow.id !== displayRow.id))
    ? {
      id: latestRow.id, status: latestRow.status,
      reason: (latestRow.parsed && latestRow.parsed.parseError) || latestRow.error || null,
      pulledAt: latestRow.pulled_at, source: latestRow.source, pullType: latestRow.pull_type,
      // A failed/partial attempt can still have filed a real PDF (a PDF-only upload,
      // or a live pull that returned a PDF but unreadable data) — carry the doc ids
      // so the UI keeps that PDF reachable instead of orphaning it.
      pdfDocumentId: latestRow.pdf_document_id || null,
      xmlDocumentId: latestRow.xml_document_id || null,
    }
    : null;
  const hist = await db.query(
    `SELECT id, pulled_at, pull_type, request_type, source, status, middle_score, interface_version
       FROM credit_reports WHERE application_id=$1 ORDER BY pulled_at DESC LIMIT 25`, [appId]);

  // Per-borrower summary + the higher-of-two rule (the higher middle score prices
  // the deal). With a co-borrower, the condition shows both + which one is higher.
  const bq = await db.query(
    `SELECT a.borrower_id, a.co_borrower_id,
            pb.first_name AS p_first, pb.last_name AS p_last,
            cb.first_name AS c_first, cb.last_name AS c_last
       FROM applications a
       LEFT JOIN borrowers pb ON pb.id=a.borrower_id
       LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
      WHERE a.id=$1`, [appId]);
  const row = bq.rows[0] || {};
  const nm = (f, l, fb) => [f, l].filter(Boolean).join(' ') || fb;
  const pScore = await borrowerScore(appId, row.borrower_id);
  const cScore = row.co_borrower_id ? await borrowerScore(appId, row.co_borrower_id) : null;
  // Higher-of-two is computed over REPORT-BACKED middle scores only — an unpulled
  // borrower's fico never counts. `higherReady` is true only once every borrower on
  // the file has a report, so the UI can label it "prices the deal" (final) vs
  // "so far" (co-borrower still pending).
  const reportVals = [
    pScore.hasReport ? pScore.middleScore : null,
    cScore && cScore.hasReport ? cScore.middleScore : null,
  ].filter((v) => v != null);
  const allPulled = pScore.hasReport && (!row.co_borrower_id || (cScore && cScore.hasReport));
  const borrowers = {
    primary: {
      borrowerId: row.borrower_id, name: nm(row.p_first, row.p_last, 'Borrower'),
      middleScore: pScore.middleScore, hasReport: pScore.hasReport, fico: pScore.fico,
    },
    coBorrower: row.co_borrower_id
      ? {
        borrowerId: row.co_borrower_id, name: nm(row.c_first, row.c_last, 'Co-borrower'),
        middleScore: cScore.middleScore, hasReport: cScore.hasReport, fico: cScore.fico,
      }
      : null,
    higher: reportVals.length ? Math.max(...reportVals) : null,   // the score that prices the deal
    higherReady: !!allPulled,                                     // both borrowers pulled → final
    hasCoBorrower: !!row.co_borrower_id,
  };

  return {
    hasReport: !!displayRow,
    provider: provider.status(),
    report: displayRow ? shapeReport(displayRow, { full: true }) : null,
    lastAttempt,
    borrowers,
    history: hist.rows.map((r) => ({
      id: r.id, pulledAt: r.pulled_at, pullType: r.pull_type, requestType: r.request_type,
      source: r.source, status: r.status, middleScore: r.middle_score, version: r.interface_version,
    })),
  };
}

module.exports = { preview, importCredit, fileCredit, borrowerScore, PULL_TYPES, REQUEST_TYPES };
