'use strict';
/**
 * Credit-report import orchestrator (owner-directed 2026-07-22; co-borrower 2026-07-23;
 * MERGED / split imports 2026-07-27).
 *
 *   preview(appId)       — the borrower(s) that WILL be sent + the defaults
 *                          (soft · reissue · tri-merge · v3.4) + provider status.
 *                          With a co-borrower, returns BOTH borrowers, each with
 *                          their OWN reissue reference.
 *   importCredit(appId)  — pull/reissue via the shared login (or import downloaded
 *                          files) for the selected borrower(s), parse, store, write
 *                          each FICO back. Re-reads every borrower's PII server-side —
 *                          never trusts the client.
 *   fileCredit(appId)    — the latest parsed report + history + the per-borrower
 *                          summary (each middle score + the higher-of-two that prices
 *                          the deal) for the UI section. `scope` narrows it to ONE
 *                          borrower so the co-borrower's own condition shows THEIR
 *                          report instead of repeating the whole file's.
 *
 * TWO BORROWERS, THREE WAYS (owner-directed 2026-07-27 — "we need to be able to
 * import them together as a merged report … and we should also have the option to
 * split them and import two separate reports"):
 *   • MERGED   — ONE downloaded file covering both borrowers. It is split per
 *                borrower (parse.js segments it), stored as one report row EACH so
 *                each gets their own middle score and FICO, and the single physical
 *                PDF/XML is filed once and shared by both rows.
 *   • SEPARATE — one downloaded file PER borrower, imported in one action.
 *   • ONE      — a single borrower now; the other keeps their own credit condition
 *                so their credit is still required and can be imported on its own.
 * Imported TOGETHER (merged or separate), both reports land on the ONE file-level
 * credit condition — the file never ends up with the same condition twice.
 *
 * A LIVE pull is still ONE INDIVIDUAL transaction PER BORROWER (not a single MISMO
 * "Joint" request), so each borrower gets a clean, unambiguous middle score for the
 * higher-of-two rule. If a live response nonetheless comes back JOINT (reissuing a
 * joint reference does exactly that), it is sliced down to the borrower who was
 * pulled — never stored flat, which would put the other person's score on them.
 */
const db = require('../../db');
const C = require('../crypto');
const provider = require('./provider');
const { parseCreditXml, sliceForSegment } = require('./parse');
const { matchSegments } = require('./match');
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

// The shape parseCreditXml returns when there is no data file at all (PDF-only).
function emptyParse(reason, vendorReportId) {
  return {
    parseError: reason, version: null, bureausReturned: [], scores: [],
    middleScore: null, borrower: null, liabilities: [], inquiries: [], publicRecords: [], summary: null,
    reportDate: null, reportId: vendorReportId || null, borrowers: [], isMerged: false,
  };
}

/**
 * The reissue reference to use for ONE borrower.
 *
 * The reference identifies a SPECIFIC report at Xactus, so it belongs to the
 * borrower it was issued for. It used to be hard-wired to the primary, which meant
 * reissuing the CO-BORROWER on their own silently dropped the reference typed on
 * screen and failed with "a reissue needs the reference number" — the co-borrower
 * could not be imported independently at all (owner-reported 2026-07-27).
 */
function reissueRefFor(target, opts, targetCount) {
  const map = (opts.reissueReportIds && typeof opts.reissueReportIds === 'object') ? opts.reissueReportIds : null;
  const perBorrower = map ? String(map[target.borrowerId] || '').trim() : '';
  if (perBorrower) return perBorrower;                  // typed for THIS borrower
  const typed = opts.reissueReportId ? String(opts.reissueReportId).trim() : '';
  if (!typed) return null;
  // A single reference with a single borrower selected is that borrower's, whoever
  // they are. With several borrowers and one shared box it can only be the primary's.
  if (targetCount === 1 || target.role === 'primary') return typed;
  return null;
}

/**
 * Narrow a JOINT/merged parse down to the borrower this import is for.
 * Returns { parsed, segment, matchedBy } — or null when the document covers
 * several people and none of them is provably this borrower (we never store
 * someone else's scores under their name).
 */
function sliceForTarget(parsed, target) {
  if (!parsed || !parsed.isMerged || !(parsed.borrowers || []).length) return { parsed, segment: null, matchedBy: null };
  const row = target.row || {};
  const { pairs } = matchSegments(parsed.borrowers, [{
    borrowerId: target.borrowerId, role: target.role,
    firstName: row.first_name, lastName: row.last_name, ssnLast4: row.ssn_last4,
  }]);
  if (!pairs.length) return null;
  return { parsed: sliceForSegment(parsed, pairs[0].segment), segment: pairs[0].segment, matchedBy: pairs[0].matchedBy };
}

// Pull/upload → parse → store for ONE borrower. Throws userError on a hard failure.
async function importOne({ file, target, opts, pullType, requestType, version, isUpload, upload, targetCount, together }) {
  const bureaus = provider.ALL_BUREAUS;                    // always tri-merge
  const up = upload || {};
  let xml = (up.xml !== undefined ? up.xml : opts.xml) || null;
  let pdfBase64 = (up.pdfBase64 !== undefined ? up.pdfBase64 : opts.pdfBase64) || null;
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
    // A Reissue re-pulls an existing report by its reference number — each borrower's
    // own (see reissueRefFor), falling back to that borrower's last report on file.
    let reissueReportId = reissueRefFor(target, opts, targetCount);
    if (requestType === 'reissue' && !reissueReportId) reissueReportId = await priorReportId(file.id, target.borrowerId);
    const res = await provider.pull({ borrower: b, pullType, requestType, bureaus, version, reissueReportId, loanNumber: file.ys_loan_number });
    xml = res.xml; pdfBase64 = res.pdfBase64; vendorReportId = res.vendorReportId;
    if (!xml && !pdfBase64) throw userError('Xactus returned nothing for this request.');
  }

  const full = xml ? parseCreditXml(xml) : emptyParse('no data file returned', vendorReportId);

  // A JOINT response (reissuing a joint reference returns one) carries BOTH people.
  // Keep only the borrower this import is for — storing it flat would record the
  // other borrower's score against them.
  let parsed = full;
  let mergedNote = null;
  if (full.isMerged) {
    const cut = sliceForTarget(full, target);
    if (!cut) {
      throw userError(`This report covers ${full.borrowers.length} people and none of them matches ${nameOfRow(target.row, target.role)} — check you picked the right file, or import it as a merged report for both borrowers.`);
    }
    parsed = cut.parsed;
    mergedNote = { borrowerName: cut.segment.name, matchedBy: cut.matchedBy, borrowerCount: full.borrowers.length };
  }
  if (vendorReportId && !parsed.reportId) parsed.reportId = vendorReportId;

  // A live pull that OBTAINED a data file yet yielded zero scores AND zero
  // tradelines is almost certainly not a real credit report (an error/gateway page
  // returned with HTTP 200, or an unexpected layout) — flag it rather than let it
  // look like a clean success. An upload or a genuine thin/no-hit file is unaffected.
  // Naming the document's top element makes an error envelope obvious at a glance.
  const emptyLivePull = source === 'api' && !parsed.parseError
    && (!parsed.scores || parsed.scores.length === 0)
    && (!parsed.liabilities || parsed.liabilities.length === 0);
  if (emptyLivePull) {
    // Name what DID come back. A vendor error envelope or a gateway page answers 200
    // and parses fine — its own words ("login not authorized", "report not found for
    // reissue") are what tell staff what to fix.
    const shape = full.rootTag && full.rootTag !== 'CREDIT_RESPONSE' ? `it came back as <${full.rootTag}>` : null;
    const said = full.documentHint ? `it said: “${full.documentHint}”` : null;
    const why = [shape, said].filter(Boolean).join(' — ');
    parsed.parseError = why
      ? `no credit data recognized in the response (${why})`
      : 'no credit data recognized in the response';
  }

  const stored = await store.storeImport({
    file,
    // Imported TOGETHER → both reports sit on the ONE file-level credit condition
    // (the owner's ask: one condition, not the same condition twice). Imported on
    // their own, a co-borrower's report goes to their own split-out condition.
    borrower: {
      id: target.borrowerId,
      ssn_last4: (target.row && target.row.ssn_last4) || null,
      isCo: !together && target.role === 'co',
    },
    parsed, xml, pdfBase64,
    request: { pullType, requestType, bureaus, version }, actorId: opts.actorId, source,
    consentAttested: !isUpload && opts.consent === true,
    reuseDocs: up.reuseDocs || null,
    filenames: up.filenames || null,
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
    fromMergedReport: mergedNote,
    docs: { xmlDocId: stored.xmlDocId || null, pdfDocId: stored.pdfDocId || null },
  };
}

/**
 * ONE downloaded file covering BOTH borrowers → a report row for EACH of them.
 *
 * The physical PDF/XML is filed ONCE (on the first borrower) and shared by the
 * second borrower's row, so the loan carries one copy of one report. Each borrower
 * still gets their OWN parsed slice: their scores, their middle score, their
 * tradelines, their FICO write-back.
 */
async function importMerged({ file, parsed, borrowers, opts, pullType, requestType, version }) {
  // Matching runs against EVERY borrower on the file (so the report's people are
  // recognised), but only the requested ones are imported when a subset was asked for.
  const wanted = Array.isArray(opts.borrowerIds) && opts.borrowerIds.length
    ? new Set(opts.borrowerIds.map(String)) : null;
  const roster = borrowers.map((b) => ({
    borrowerId: b.borrowerId, role: b.role,
    firstName: b.row && b.row.first_name, lastName: b.row && b.row.last_name,
    ssnLast4: b.row && b.row.ssn_last4,
  }));
  const matched = matchSegments(parsed.borrowers, roster);
  const unmatchedSegments = matched.unmatchedSegments;
  const unmatchedBorrowers = matched.unmatchedBorrowers;
  const pairs = wanted ? matched.pairs.filter((p) => wanted.has(String(p.borrower.borrowerId))) : matched.pairs;
  if (!pairs.length) {
    throw userError(`This merged report covers ${parsed.borrowers.length} people, but none of them matches the borrowers on this file (${parsed.borrowers.map((s) => s.name || 'unnamed').join(' and ')}). Check you picked the right file.`);
  }

  const results = [];
  let reuseDocs = null;
  for (const pair of pairs) {
    const target = borrowers.find((b) => String(b.borrowerId) === String(pair.borrower.borrowerId));
    if (!target) continue;
    const slice = sliceForSegment(parsed, pair.segment);
    const filenames = {
      xml: 'credit-report-merged.xml', pdf: 'credit-report-merged.pdf',
      xmlLabel: 'Credit report — merged, both borrowers (data)',
      pdfLabel: 'Credit report — merged, both borrowers',
    };
    try {
      const stored = await store.storeImport({
        file,
        // A merged report is ONE report for the file: both rows hang off the single
        // file-level credit condition.
        borrower: { id: target.borrowerId, ssn_last4: (target.row && target.row.ssn_last4) || null, isCo: false },
        parsed: slice, xml: opts.xml || null, pdfBase64: opts.pdfBase64 || null,
        request: { pullType, requestType, bureaus: provider.ALL_BUREAUS, version },
        actorId: opts.actorId, source: 'upload', consentAttested: false,
        reuseDocs, filenames,
      });
      // The first stored borrower files the documents; everyone else points at them.
      if (!reuseDocs && (stored.xmlDocId || stored.pdfDocId)) {
        reuseDocs = { xmlDocId: stored.xmlDocId || null, pdfDocId: stored.pdfDocId || null };
      }
      results.push({
        borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role),
        ok: true, source: 'upload',
        creditReportId: stored.creditReportId,
        middleScore: slice.middleScore,
        ficoWritten: stored.ficoWritten, ficoMismatch: stored.ficoMismatch, ficoUnverified: stored.ficoUnverified,
        parseError: slice.parseError || null,
        hasPdf: !!stored.pdfDocId, hasXml: !!stored.xmlDocId, pdfMissing: false,
        summary: slice.summary || null,
        bureausReturned: slice.bureausReturned || [],
        scores: slice.scores || [],
        fromMergedReport: { borrowerName: pair.segment.name, matchedBy: pair.matchedBy, borrowerCount: parsed.borrowers.length },
      });
    } catch (e) {
      results.push({
        borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role),
        ok: false, error: e.userMessage || e.message || 'Could not import for this borrower.',
      });
    }
  }

  return {
    results,
    merged: {
      isMerged: true,
      borrowerCount: parsed.borrowers.length,
      matched: pairs.map((p) => ({
        borrowerId: p.borrower.borrowerId, role: p.borrower.role,
        reportName: p.segment.name, matchedBy: p.matchedBy, verified: p.verified,
        middleScore: p.segment.middleScore,
      })),
      // Named, never silently dropped: someone in the report who is not on the file,
      // and someone on the file the report does not cover.
      unmatchedInReport: unmatchedSegments.map((s) => s.name || 'unnamed'),
      unmatchedOnFile: unmatchedBorrowers.map((b) => [b.firstName, b.lastName].filter(Boolean).join(' ') || 'borrower'),
      unattributedScores: (parsed.mergedUnattributedScores || []).length,
    },
  };
}

// The per-borrower downloaded files of a SPLIT import ("two separate reports"),
// normalized and validated against the borrowers actually on the file.
function normalizeFiles(list, borrowers) {
  const out = [];
  for (const f of (list || [])) {
    if (!f || typeof f !== 'object') continue;
    const target = borrowers.find((b) => String(b.borrowerId) === String(f.borrowerId));
    if (!target) continue;
    const xml = typeof f.xml === 'string' && f.xml.trim() ? f.xml : null;
    const pdfBase64 = typeof f.pdfBase64 === 'string' && f.pdfBase64.trim() ? f.pdfBase64 : null;
    if (!xml && !pdfBase64) continue;                   // a borrower with no file chosen is simply not imported
    if (out.some((o) => String(o.target.borrowerId) === String(target.borrowerId))) continue;
    out.push({ target, xml, pdfBase64 });
  }
  return out;
}

async function importCredit(appId, opts = {}) {
  const { file, borrowers } = await fileBorrowers(appId);
  const pullType = PULL_TYPES.includes(opts.pullType) ? opts.pullType : 'soft';
  const requestType = REQUEST_TYPES.includes(opts.requestType) ? opts.requestType : 'reissue';
  // The interface version is FROZEN (owner-directed: "nobody can change that field").
  // Enforced SERVER-side — the client's value is ignored, not just locked in the UI —
  // so a direct API call can't send anything other than the configured version.
  const version = provider.version();
  // A SPLIT import ("two separate reports") carries one file per borrower; a single
  // xml/pdf is either a merged report covering both, or one borrower's own report.
  const splitFiles = Array.isArray(opts.files) ? normalizeFiles(opts.files, borrowers) : [];
  if (Array.isArray(opts.files) && opts.files.length && !splitFiles.length) {
    throw userError('Choose the downloaded file for at least one borrower on this file.');
  }
  const isUpload = splitFiles.length > 0 || !!(opts.xml || opts.pdfBase64);

  // Which borrowers this import targets.
  let targets;
  if (splitFiles.length) {
    targets = splitFiles.map((f) => f.target);
  } else if (isUpload) {
    // A downloaded file is for ONE borrower — the selected one, else the primary —
    // UNLESS it turns out to be a merged report covering both (handled below).
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

  // Is this ONE downloaded file that actually covers BOTH borrowers? The user can
  // say so (merged:true), and we also detect it — a file naming two people is a
  // merged report whether or not anyone ticked a box. `merged:false` forces the old
  // single-borrower behaviour.
  let mergedInfo = null;
  let mergedDocument = false;      // one uploaded document imported for several borrowers
  let results = [];
  const singleUpload = !splitFiles.length && isUpload;
  const mergedParse = (singleUpload && opts.merged !== false && typeof opts.xml === 'string' && opts.xml.trim())
    ? parseCreditXml(opts.xml) : null;

  if (mergedParse && mergedParse.isMerged && borrowers.length > 1) {
    const out = await importMerged({ file, parsed: mergedParse, borrowers, opts, pullType, requestType, version });
    results = out.results;
    mergedInfo = out.merged;
    targets = results.filter((r) => r.ok !== false)
      .map((r) => borrowers.find((b) => String(b.borrowerId) === String(r.borrowerId)))
      .filter(Boolean);
  } else {
    if (opts.merged === true && singleUpload) {
      // The user said "this one file covers both borrowers". Honour it when the file
      // really can cover both (a PDF is the same document for each of them), and say
      // plainly when it can't rather than importing something misleading.
      if (borrowers.length < 2) {
        throw userError('This file has only one borrower, so there is nobody to split a merged report between. Import it for that borrower instead.');
      }
      if (mergedParse && !mergedParse.isMerged && !mergedParse.parseError && (mergedParse.scores || []).length) {
        const who = mergedParse.borrower && [mergedParse.borrower.firstName, mergedParse.borrower.lastName].filter(Boolean).join(' ');
        throw userError(`This data file only covers ${who || 'one borrower'}, so it can’t be split between two. Import it for that one borrower, or choose “a separate file for each borrower”.`);
      }
      // PDF-only (no data file to split): the same report document is filed for each
      // selected borrower — one copy, both rows — with no scores until a data file lands.
      targets = borrowers.filter((b) => !Array.isArray(opts.borrowerIds) || opts.borrowerIds.map(String).includes(String(b.borrowerId)));
      if (!targets.length) targets = borrowers;
      mergedDocument = targets.length > 1;
    }
    // Imported TOGETHER (every borrower on the file in one action) → one condition
    // holds them all. A partial import keeps the co-borrower's own condition.
    const together = targets.length > 1;
    // One physical document imported for several borrowers is filed ONCE: the first
    // borrower stores it, the rest point at the same PDF/XML.
    let sharedDocs = null;
    for (const target of targets) {
      const upload = splitFiles.length
        ? (() => { const f = splitFiles.find((x) => x.target === target); return { xml: f.xml, pdfBase64: f.pdfBase64 }; })()
        : (together && isUpload ? { reuseDocs: sharedDocs } : null);
      try {
        const r = await importOne({
          file, target, opts, pullType, requestType, version, isUpload,
          upload, targetCount: targets.length, together,
        });
        if (together && isUpload && !splitFiles.length && !sharedDocs && r.docs && (r.docs.xmlDocId || r.docs.pdfDocId)) {
          sharedDocs = r.docs;
        }
        results.push({ borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role), ...r });
      } catch (e) {
        // With a single target, preserve single-borrower behavior — re-throw so the
        // caller returns the clear error. With more than one, one borrower's failure
        // must not lose the other's report: record it and carry on.
        if (targets.length === 1) throw e;
        results.push({ borrowerId: target.borrowerId, role: target.role, name: nameOfRow(target.row, target.role), ok: false, error: e.userMessage || e.message || 'Could not import for this borrower.' });
      }
    }
  }

  // Split flow: a co-borrower on the file who was NOT imported here gets their OWN
  // credit condition so their credit is still required + can be imported separately.
  // Imported together, the opposite is true — one condition covers both, so a
  // leftover empty co-borrower condition is cleared instead of standing as a
  // duplicate of the same condition (owner-reported 2026-07-27).
  let coConditionOpened = false;
  let coConditionClosed = false;
  const co = borrowers.find((b) => b.role === 'co');
  const coImported = !!(co && results.some((r) => r.ok !== false && String(r.borrowerId) === String(co.borrowerId)));
  const primaryImported = results.some((r) => r.ok !== false && r.role === 'primary');
  if (co && !targets.some((t) => String(t.borrowerId) === String(co.borrowerId))) {
    const r = await coCondition.ensureCoBorrowerCreditCondition(appId, co.borrowerId).catch(() => null);
    coConditionOpened = !!(r && (r.created || r.updated || r.itemId));
  } else if (co && coImported && primaryImported) {
    // Both borrowers landed on the file-level condition — fold the split-out one back
    // in: anything already filed on it moves across, then it goes. A condition a human
    // signed off is left alone.
    const target = await store.creditConditionItemId(appId, { isCo: false }).catch(() => null);
    const r = await coCondition.absorbCoBorrowerCreditCondition(appId, target).catch(() => null);
    coConditionClosed = !!(r && r.absorbed);
  }

  // Credit-condition auto-sign-off RETIRED (owner-directed 2026-07-24). PILOT used to
  // auto-clear the credit condition(s) once every covered borrower had a report + PDF
  // (gated OFF by default). PILOT no longer signs off a Condition Center condition
  // itself — a human clears it; creditCompleteness() now feeds the ADVISORY overlay
  // instead (pilot-advice-engine). The sign-off pass is no longer called here.

  const primaryResult = results.find((r) => r.role === 'primary' && r.ok !== false)
    || results.find((r) => r.ok !== false) || results[0] || {};
  const pulled = results.filter((r) => r.ok !== false).length;

  return {
    ok: pulled > 0,
    source: primaryResult.source || (isUpload ? 'upload' : 'api'),
    pulled,
    results,
    coConditionOpened,
    coConditionClosed,
    // How the file(s) were read: one merged report split between the borrowers, two
    // separate reports imported together, or a single borrower's report.
    merged: mergedInfo,
    importMode: (mergedInfo || mergedDocument) ? 'merged'
      : (splitFiles.length > 1 ? 'separate' : (splitFiles.length === 1 ? 'one' : (isUpload ? 'one' : 'live'))),
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
    // Set when this report is ONE borrower's side of a merged/joint document, so the
    // screen can say so instead of looking like a report that mysteriously omits the
    // other borrower's accounts.
    mergedSource: p.mergedSource || null,
  };
}

// A borrower's representative score for the condition summary.
//   hasReport   — a report was actually PULLED (a completed row exists — even a
//                 thin/no-hit file that returned no score). This is "pulled", NOT
//                 "has a score", so a genuinely-pulled no-score borrower reads
//                 "no score" instead of the misleading "not pulled yet".
//   middleScore — that latest completed report's middle score (null on a no-hit).
//                 A null score is still excluded from the higher-of-two that prices
//                 the deal (fileCredit filters null), and fico is never a stand-in.
async function borrowerScore(appId, borrowerId) {
  if (!borrowerId) return { middleScore: null, hasReport: false, fico: null };
  const r = await db.query(
    `SELECT middle_score FROM credit_reports
      WHERE application_id=$1 AND borrower_id=$2 AND status='completed'
      ORDER BY pulled_at DESC LIMIT 1`, [appId, borrowerId]);
  const f = await db.query('SELECT fico FROM borrowers WHERE id=$1', [borrowerId]);
  const fico = (f.rows[0] && f.rows[0].fico != null) ? f.rows[0].fico : null;
  if (r.rows[0]) return { middleScore: r.rows[0].middle_score, hasReport: true, fico };
  return { middleScore: null, hasReport: false, fico };
}

/**
 * The credit section for a file.
 *
 * `scope` narrows it to ONE borrower: the co-borrower's own credit condition shows
 * THEIR report, their history and their last attempt — instead of repeating the
 * whole file's credit section a second time under a second condition (which read as
 * a duplicate, owner-reported 2026-07-27).
 *
 * @param {string} appId
 * @param {object} [opts] { scope: 'file' | 'primary' | 'co', borrowerId }
 */
async function fileCredit(appId, opts = {}) {
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

  // Which borrower this view is scoped to (null = the whole file).
  let scopeId = null;
  let scopeKind = 'file';
  if (opts.borrowerId && [row.borrower_id, row.co_borrower_id].some((x) => String(x) === String(opts.borrowerId))) {
    scopeId = opts.borrowerId;
    scopeKind = String(row.co_borrower_id) === String(opts.borrowerId) ? 'co' : 'primary';
  } else if (opts.scope === 'co' && row.co_borrower_id) {
    scopeId = row.co_borrower_id; scopeKind = 'co';
  } else if (opts.scope === 'primary' && row.borrower_id) {
    scopeId = row.borrower_id; scopeKind = 'primary';
  }
  const scope = {
    kind: scopeKind,
    borrowerId: scopeId,
    name: scopeKind === 'co' ? nm(row.c_first, row.c_last, 'Co-borrower')
      : (scopeKind === 'primary' ? nm(row.p_first, row.p_last, 'Borrower') : null),
  };
  // Every query below is borrower-scoped when a scope is set; `$2 IS NULL` keeps the
  // unscoped (whole-file) behaviour exactly as it was.
  const args = [appId, scopeId];

  // The report we DISPLAY is the latest COMPLETED one — a failed/empty live pull
  // (status='error', no PDF, no data) must never hide a good report already on
  // file. Fall back to the latest attempt only when nothing completed exists yet.
  const completed = await db.query(
    `SELECT * FROM credit_reports
      WHERE application_id=$1 AND status='completed' AND ($2::uuid IS NULL OR borrower_id=$2)
      ORDER BY pulled_at DESC LIMIT 1`, args);
  const latest = await db.query(
    `SELECT * FROM credit_reports
      WHERE application_id=$1 AND ($2::uuid IS NULL OR borrower_id=$2)
      ORDER BY pulled_at DESC LIMIT 1`, args);
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
    `SELECT id, pulled_at, pull_type, request_type, source, status, middle_score, interface_version, borrower_id
       FROM credit_reports
      WHERE application_id=$1 AND ($2::uuid IS NULL OR borrower_id=$2)
      ORDER BY pulled_at DESC LIMIT 25`, args);

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
    scope,
    history: hist.rows.map((r) => ({
      id: r.id, pulledAt: r.pulled_at, pullType: r.pull_type, requestType: r.request_type,
      source: r.source, status: r.status, middleScore: r.middle_score, version: r.interface_version,
      borrowerId: r.borrower_id,
    })),
  };
}

module.exports = { preview, importCredit, fileCredit, borrowerScore, PULL_TYPES, REQUEST_TYPES };
