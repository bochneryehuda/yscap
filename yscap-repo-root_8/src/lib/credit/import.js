'use strict';

/**
 * Credit order + import orchestration (Phase 1e).
 *
 * Ties the pure pieces together into the one billable operation: build a MISMO
 * request from an application's borrowers, POST it to Xactus under the acting
 * staffer's own credential, parse the response, score it, store the report +
 * per-bureau scores + the PDF, and — when every borrower has a usable score —
 * freeze each borrower's verified FICO. Bracket-reset of a cleared registration
 * happens automatically in the DB trigger (db/132) when the frozen score lands
 * in a different bracket than the loan was priced on.
 *
 * Hard rules honored here:
 *  - The POST is billable + non-idempotent: it is journaled BEFORE the call
 *    (credit_reports row, status 'ordering', idempotency key) and NEVER
 *    auto-retried. A reused idempotency key returns the prior journal row.
 *  - The verified FICO is written under the sanctioned reverify GUC
 *    (app.credit_reverify='on', transaction-local) so the freeze belt permits
 *    the import but blocks every other path.
 *  - Data comes from the XML, never the PDF (the PDF is stored for viewing only).
 *  - A frozen bureau / no-score / vendor error routes to manual review; the
 *    report is stored (never deleted), the condition can't be signed off.
 */
const db = require('../../db');
const crypto = require('../crypto');
const cfg = require('../../config');
const providers = require('./providers');
const credentials = require('./credentials');
const xactus = require('../integrations/xactus');
const { buildCreditRequest } = require('./mismo2-request');
const { parseCreditResponse, decodeReportPdf } = require('./mismo2-response');
const scoring = require('./scoring');
const storage = require('../storage');

// Xactus source type → { key for repositories flags, verified_fico_source label }.
const BUREAU = {
  Equifax:    { key: 'equifax',    label: 'equifax_beacon_5.0' },
  Experian:   { key: 'experian',   label: 'experian_fairisaac' },
  TransUnion: { key: 'transunion', label: 'transunion_ficoclassic04' },
};

function httpError(status, msg, extra) { const e = new Error(msg); e.status = status; if (extra) Object.assign(e, extra); return e; }

// ---- in-process circuit breaker (per provider) -----------------------------
// A run of network/5xx failures (vendor down) trips the breaker so we stop
// hammering — and, critically, stop placing billable calls that will fail. It
// only counts transport-level failures (retriable), never a clean data error.
const BREAKER = new Map(); // providerId -> { fails, openUntil }
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60 * 1000;
function breakerCheck(pid, nowMs) {
  const b = BREAKER.get(pid);
  if (b && b.openUntil && nowMs < b.openUntil) {
    throw httpError(503, 'The credit provider is temporarily unavailable — please try again shortly.', { kind: 'breaker_open' });
  }
}
function breakerFail(pid, nowMs) {
  const b = BREAKER.get(pid) || { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= BREAKER_THRESHOLD) { b.openUntil = nowMs + BREAKER_COOLDOWN_MS; b.fails = 0; }
  BREAKER.set(pid, b);
}
function breakerOk(pid) { BREAKER.delete(pid); }

// ---- borrower assembly (decrypt SSN, map address) --------------------------
function residenceOf(addr) {
  const a = addr && typeof addr === 'object' ? addr : {};
  const street = [a.line1, a.unit].filter(Boolean).join(' ').trim();
  return { streetAddress: street, city: a.city || '', state: a.state || '', postalCode: a.zip || a.postalCode || '' };
}

function borrowerForRequest(row, borrowerId) {
  const ssn = row.ssn_encrypted ? crypto.decryptSSN(row.ssn_encrypted) : null;
  return {
    borrowerId,
    firstName: row.first_name, middleName: '', lastName: row.last_name,  // no middle name stored
    ssn: ssn || '',
    residence: residenceOf(row.current_address),
    _dbId: row.id,
  };
}

// Load the application's primary (+ optional co) borrower rows with what a
// request needs. Throws a 4xx when the file can't be ordered (missing SSN etc.).
async function loadOrderBorrowers(applicationId) {
  const app = (await db.query(
    `SELECT a.id, a.borrower_id, a.co_borrower_id FROM applications a WHERE a.id=$1`, [applicationId])).rows[0];
  if (!app) throw httpError(404, 'application not found');
  const ids = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, ssn_encrypted, current_address FROM borrowers WHERE id = ANY($1)`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const primaryRow = byId.get(app.borrower_id);
  if (!primaryRow) throw httpError(400, 'the primary borrower is missing');
  const out = [];
  out.push(borrowerForRequest(primaryRow, 'B1'));
  if (app.co_borrower_id && byId.get(app.co_borrower_id)) out.push(borrowerForRequest(byId.get(app.co_borrower_id), 'C1'));
  for (const b of out) {
    if (!b.ssn || String(b.ssn).replace(/\D/g, '').length !== 9) {
      throw httpError(400, `borrower ${b.firstName || ''} ${b.lastName || ''} has no SSN on file — a credit pull needs a full SSN`.trim());
    }
    const r = b.residence;
    if (!r.streetAddress || !r.city || !r.state || !r.postalCode) {
      throw httpError(400, `borrower ${b.firstName || ''} ${b.lastName || ''} is missing a complete current address`.trim());
    }
  }
  return { app, requestBorrowers: out };
}

// ---- scoring the parsed response -------------------------------------------
// For each response borrower compute its middle + which bureau produced it, then
// the loan representative = highest borrower middle. Returns a rich structure the
// persistence + freeze use.
function scoreParsed(parsed) {
  const perBorrower = parsed.borrowers.map((b) => {
    const mid = scoring.borrowerMiddle(b.scores);
    // The source bureau = the (usable) bureau whose value equals the middle.
    let sourceLabel = null;
    if (mid.middle != null) {
      const hit = mid.classified.find((c) => c.usable && c.value === mid.middle);
      sourceLabel = hit && BUREAU[hit.bureau] ? BUREAU[hit.bureau].label : 'xactus_mid';
    }
    return { reportBorrowerId: b.borrowerId, identity: b, middle: mid, sourceLabel };
  });
  const rep = scoring.loanRepresentative(perBorrower.map((p) => p.middle.middle));
  return { perBorrower, rep };
}

// Decide the report's disposition from the parse + scores.
//   'error'   — the whole request failed (no usable response)
//   'review'  — stored, but a human must clear it (frozen bureau / no score /
//               vendor per-bureau error / an excluded score)
//   'imported'— fully usable; freeze the verified FICOs
function assessReport(parsed, scored) {
  if (!parsed.ok && !(parsed.borrowers && parsed.borrowers.length)) {
    const first = parsed.errors && parsed.errors[0];
    return { decision: 'error', reason: first ? (first.description || (first.texts && first.texts[0]) || first.code || 'credit request failed') : 'credit request failed' };
  }
  const reasons = [];
  if (parsed.errors && parsed.errors.length) {
    for (const e of parsed.errors) {
      const t = e.description || (e.texts && e.texts.join('; ')) || e.code;
      if (t) reasons.push(String(t));
    }
  }
  for (const pb of scored.perBorrower) {
    if (pb.middle.noScore) reasons.push(`${pb.identity.firstName || pb.reportBorrowerId}: no usable score returned`);
    for (const c of pb.middle.classified) {
      if (c.reason === 'excluded') reasons.push(`${pb.identity.firstName || pb.reportBorrowerId}: ${c.bureau || 'a bureau'} excluded (${c.exclusionReason || 'frozen/blocked'})`);
    }
  }
  if (reasons.length) return { decision: 'review', reason: [...new Set(reasons)].join(' | ').slice(0, 1000) };
  return { decision: 'imported', reason: null };
}

// ---- persistence (transaction B) -------------------------------------------
async function persistImport({ reportRowId, applicationId, actorId, providerId, parsed, scored, assessment, rawXml, orderMeta }) {
  // Decode + write the PDF to storage BEFORE opening the transaction: disk I/O
  // is slow and must not hold a DB connection, and a bad/absent PDF must never
  // fail the import (the XML is the data). We keep the bytes to insert the
  // documents row inside the transaction (savepoint-guarded).
  let pdfSaved = null, pdfBytes = 0, pdfFilename = null;
  if (parsed.pdf && parsed.pdf.base64) {
    try {
      const { buf } = decodeReportPdf(parsed.pdf.base64);
      pdfFilename = `credit-report-${orderMeta.reportIdentifier || reportRowId}.pdf`;
      pdfSaved = await storage.save(buf, { filename: pdfFilename });
      pdfBytes = buf.length;
    } catch (_) { pdfSaved = null; /* PDF is non-critical */ }
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Link the stored PDF (savepoint-guarded: a documents-insert failure rolls
    // back just this and leaves pdfDocumentId null — it never poisons the import).
    let pdfDocumentId = null;
    if (pdfSaved) {
      try {
        await client.query('SAVEPOINT pdf_doc');
        const doc = await client.query(
          `INSERT INTO documents (application_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, source_type, visibility)
           VALUES ($1,$2,'application/pdf',$3,$4,$5,'staff',$6,'credit_report','staff_only') RETURNING id`,
          [applicationId, pdfFilename, pdfBytes, pdfSaved.provider, pdfSaved.ref, actorId]);
        pdfDocumentId = doc.rows[0].id;
        await client.query('RELEASE SAVEPOINT pdf_doc');
      } catch (_) { await client.query('ROLLBACK TO SAVEPOINT pdf_doc'); pdfDocumentId = null; }
    }

    // Update the journal row into its final state.
    await client.query(
      `UPDATE credit_reports
          SET credit_report_identifier=$2, report_type=$3, other_description=$4, request_type=$5, action_type=$6,
              first_issued_date = NULLIF($7,'')::date, last_updated_date = NULLIF($8,'')::date,
              xml_encrypted=$9, pdf_document_id=$10,
              representative_score=$11, representative_bracket=$12,
              status=$13, review_reason=$14, error_detail=$15::jsonb, completed_at=now()
        WHERE id=$1`,
      [reportRowId, parsed.reportIdentifier || null, parsed.reportType || null, parsed.otherDescription || null,
       orderMeta.requestType || null, orderMeta.action || null,
       parsed.firstIssuedDate || '', parsed.lastUpdatedDate || '',
       rawXml ? crypto.encryptSecret(rawXml) : null, pdfDocumentId,
       scored.rep.score, scored.rep.bracket,
       assessment.decision === 'imported' ? 'imported' : assessment.decision,
       assessment.reason, JSON.stringify(parsed.errors || [])]);

    // Per-bureau score rows (every score node, usable or not — full audit).
    await client.query(`DELETE FROM credit_scores WHERE credit_report_id=$1`, [reportRowId]);
    for (const pb of scored.perBorrower) {
      const dbBorrowerId = orderMeta.borrowerDbIdByReportId[pb.reportBorrowerId] || null;
      for (const c of pb.middle.classified) {
        await client.query(
          `INSERT INTO credit_scores (credit_report_id, borrower_id, report_borrower_id, bureau, model, value, raw_value, exclusion_reason, usable, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [reportRowId, dbBorrowerId, pb.reportBorrowerId, c.bureau, c.model,
           c.usable ? c.value : null, c.rawValue == null ? null : String(c.rawValue), c.exclusionReason, c.usable, c.reason]);
      }
    }

    // Freeze the verified FICO — ONLY on a fully-usable import. Under the
    // sanctioned reverify GUC (transaction-local) so the belt permits it and the
    // representative-aware reopen trigger fires on a bracket change.
    let froze = false;
    if (assessment.decision === 'imported') {
      await client.query(`SET LOCAL app.credit_reverify = 'on'`);
      for (const pb of scored.perBorrower) {
        const dbBorrowerId = orderMeta.borrowerDbIdByReportId[pb.reportBorrowerId];
        if (!dbBorrowerId || pb.middle.middle == null) continue;
        await client.query(
          `UPDATE borrowers
              SET verified_fico=$2, fico=$2, verified_fico_source=$3, verified_report_id=$4,
                  verified_pulled_at = NULLIF($5,'')::date, verified_imported_at=now(), verified_imported_by=$6,
                  fico_locked=true
            WHERE id=$1`,
          [dbBorrowerId, pb.middle.middle, pb.sourceLabel, parsed.reportIdentifier || null,
           parsed.firstIssuedDate || '', actorId]);
        froze = true;
      }
      // Capture the score the loan was priced on at import time (for the audit of
      // WHY registration reopened) — the representative pre-freeze == pr.inputs fico.
      await client.query(
        `UPDATE applications SET fico_used_for_pricing = COALESCE(fico_used_for_pricing, $2) WHERE id=$1`,
        [applicationId, scored.rep.score]);
    }

    await client.query('COMMIT');
    return { pdfDocumentId, froze };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already broken */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Order (or reissue) a credit report and import it.
 *
 * opts:
 *   applicationId (required), actorId (required staff id),
 *   product 'prequal'|'creditreport' (default 'prequal'),
 *   action  'Reissue'|'Submit'|'ForceNew'|'Upgrade'|'Unmerge' (default 'Reissue'),
 *   creditReportIdentifier (for Reissue/Upgrade/Unmerge),
 *   repositories { equifax, experian, transunion },
 *   providerKey|providerId (default provider),
 *   idempotencyKey (required — one intent bills at most once),
 *   nowMs (injectable clock for tests), transport (injectable fetch for tests)
 *
 * Returns a summary { reportId, status, representativeScore, representativeBracket,
 *   froze, reviewReason, borrowerScores[] }.
 */
async function orderAndImport(opts = {}) {
  const { applicationId, actorId } = opts;
  if (!applicationId) throw httpError(400, 'applicationId required');
  if (!actorId) throw httpError(400, 'actorId required');
  const idempotencyKey = opts.idempotencyKey && String(opts.idempotencyKey).trim();
  if (!idempotencyKey) throw httpError(400, 'idempotencyKey required');
  // Injectable clock for the breaker (tests pass nowMs; prod uses the wall clock).
  const clock = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();

  const provider = opts.providerId != null ? await providers.getById(opts.providerId)
    : opts.providerKey ? await providers.getByKey(opts.providerKey) : await providers.getDefault();
  if (!provider) throw httpError(400, 'no credit provider is configured');
  if (!provider.enabled) throw httpError(400, `${provider.displayName} is not enabled`);

  // Idempotency: a reused key returns the prior outcome, never a second order.
  const prior = (await db.query(
    `SELECT id, status, representative_score, representative_bracket, review_reason
       FROM credit_reports WHERE idempotency_key=$1`, [idempotencyKey])).rows[0];
  if (prior) {
    if (prior.status === 'ordering') throw httpError(409, 'an order with this key is already in progress');
    return { reportId: prior.id, status: prior.status, representativeScore: prior.representative_score,
      representativeBracket: prior.representative_bracket, reviewReason: prior.review_reason, deduped: true };
  }

  const credential = await credentials.getUsable(actorId, provider.id);
  if (!credential) throw httpError(400, `set up your ${provider.displayName} login before pulling credit`);

  const { app, requestBorrowers } = await loadOrderBorrowers(applicationId);

  const product = opts.product || 'prequal';
  const action = opts.action || 'Reissue';
  const requestId = `ys-${applicationId}-${idempotencyKey}`.slice(0, 80);
  const requestType = requestBorrowers.length > 1 ? 'Joint' : 'Individual';

  const requestXml = buildCreditRequest({
    requestingPartyName: cfg.xactus.requestingPartyName,
    submittingPartyName: cfg.xactus.submittingPartyName,
    lenderCaseIdentifier: String(applicationId),
    requestId,
    product, action,
    creditReportIdentifier: opts.creditReportIdentifier,
    repositories: opts.repositories,
    borrowers: requestBorrowers,
  });

  // Journal the order BEFORE the billable POST (reserves the idempotency key).
  const journal = await db.query(
    `INSERT INTO credit_reports
       (application_id, provider_id, ordered_by, credential_id, action_type, report_type, request_type,
        request_id, idempotency_key, status, ordered_at)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,'ordering',now()) RETURNING id`,
    [applicationId, provider.id, actorId, action, product === 'prequal' ? 'Other' : 'Merge', requestType, requestId, idempotencyKey]);
  const reportRowId = journal.rows[0].id;

  breakerCheck(provider.id, clock);

  let resp;
  try {
    resp = await xactus.orderReport({
      requestXml,
      operatorIdentifier: credential.operatorIdentifier,
      secret: credential.secret,
      timeoutMs: cfg.xactus.timeoutMs,
      transport: opts.transport,
    });
    breakerOk(provider.id);
  } catch (e) {
    // Mark the credential invalid on an auth failure so the officer is told to fix it.
    if (e.kind === 'auth') { try { await credentials.markStatus(actorId, provider.id, 'invalid'); } catch (_) {} }
    if (e.retriable) breakerFail(provider.id, clock);
    // Record the failed order (never delete/reuse the journal row silently).
    await db.query(
      `UPDATE credit_reports SET status='error', review_reason=$2, error_detail=$3::jsonb, completed_at=now() WHERE id=$1`,
      [reportRowId, `order failed: ${e.message}`, JSON.stringify({ kind: e.kind || 'error', httpStatus: e.httpStatus || null, retriable: !!e.retriable })]);
    throw httpError(e.kind === 'auth' ? 401 : 502, `credit order failed: ${e.message}`, { kind: e.kind, retriable: !!e.retriable, reportId: reportRowId });
  }

  // Parse + score + assess.
  let parsed;
  try { parsed = parseCreditResponse(resp.body); }
  catch (e) {
    await db.query(
      `UPDATE credit_reports SET status='error', review_reason=$2, error_detail=$3::jsonb, xml_encrypted=$4, completed_at=now() WHERE id=$1`,
      [reportRowId, `unreadable credit response: ${e.message}`, JSON.stringify({ parse: true }), crypto.encryptSecret(resp.body)]);
    throw httpError(502, `credit response could not be read: ${e.message}`, { reportId: reportRowId });
  }
  const scored = scoreParsed(parsed);
  const assessment = assessReport(parsed, scored);

  const borrowerDbIdByReportId = {};
  for (const b of requestBorrowers) borrowerDbIdByReportId[b.borrowerId] = b._dbId;

  const persisted = await persistImport({
    reportRowId, applicationId, actorId, providerId: provider.id,
    parsed, scored, assessment, rawXml: resp.body,
    orderMeta: { reportIdentifier: parsed.reportIdentifier, requestType, action, borrowerDbIdByReportId },
  });

  return {
    reportId: reportRowId,
    status: assessment.decision === 'imported' ? 'imported' : assessment.decision,
    representativeScore: scored.rep.score,
    representativeBracket: scored.rep.bracket,
    froze: persisted.froze,
    reviewReason: assessment.reason,
    pdfDocumentId: persisted.pdfDocumentId,
    borrowerScores: scored.perBorrower.map((pb) => ({
      reportBorrowerId: pb.reportBorrowerId,
      name: [pb.identity.firstName, pb.identity.lastName].filter(Boolean).join(' '),
      middle: pb.middle.middle,
      bracket: pb.middle.bracket,
      noScore: pb.middle.noScore,
      bureaus: pb.middle.classified.map((c) => ({ bureau: c.bureau, value: c.usable ? c.value : null, usable: c.usable, reason: c.reason })),
    })),
  };
}

module.exports = {
  orderAndImport, scoreParsed, assessReport, residenceOf, loadOrderBorrowers,
  _breaker: { BREAKER, breakerCheck, breakerFail, breakerOk },
};
