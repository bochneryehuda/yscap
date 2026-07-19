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
const outcomes = require('./outcomes');
const storage = require('../storage');

// Xactus source type → { key for repositories flags, verified_fico_source label }.
const BUREAU = {
  Equifax:    { key: 'equifax',    label: 'equifax_beacon_5.0' },
  Experian:   { key: 'experian',   label: 'experian_fairisaac' },
  TransUnion: { key: 'transunion', label: 'transunion_ficoclassic04' },
};

function httpError(status, msg, extra) { const e = new Error(msg); e.status = status; if (extra) Object.assign(e, extra); return e; }

// Append-only black-box event (observability). Best-effort — a logging failure
// must NEVER affect the billable operation. No PII / no raw XML / no secret here.
function logEvent(ev) {
  db.query(
    `INSERT INTO credit_order_events (report_id, application_id, correlation_id, actor_id, provider_id, phase, action, outcome, http_status, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ev.reportId || null, ev.applicationId || null, ev.correlationId || null, ev.actorId || null, ev.providerId || null,
     ev.phase, ev.action || null, ev.outcome || null, ev.httpStatus || null, ev.latencyMs == null ? null : ev.latencyMs])
    .catch(() => {});
}

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
  // Whole request failed (no usable response) — map the vendor code to a friendly
  // reason via the outcome catalog.
  if (!parsed.ok && !(parsed.borrowers && parsed.borrowers.length)) {
    const first = parsed.errors && parsed.errors[0];
    const d = first ? outcomes.describeError(first) : null;
    return { decision: 'error', reason: (d && d.message) || (first && (first.description || first.code)) || 'credit request failed' };
  }
  // Otherwise summarize per-bureau conditions + vendor errors into one actionable
  // reason. Any block/review-severity outcome routes to manual review.
  const s = outcomes.summarizeOutcome(parsed, scored);
  if (s.reason) return { decision: 'review', reason: s.reason, severity: s.severity, owners: s.owners };
  return { decision: 'imported', reason: null };
}

// ---- internal credit-report condition wiring -------------------------------
// The import outcome flows onto the file's credit checklist items (the pull
// checkpoint, the "scores verified" checkpoint, and the "Credit report"
// condition). imported -> evidence received (a human still signs off); review ->
// flagged 'issue' with the reason (can't be signed off until cleared). Never
// overrides a human sign-off. Runs inside the import transaction.
const CREDIT_CONDITION_CODES = ['rtl_p3_credit', 'rtl_p3_credit2', 'rtl_cond_credit'];
async function wireCreditCondition(client, applicationId, decision, note) {
  if (decision === 'imported') {
    await client.query(
      `UPDATE checklist_items ci
          SET status='received',
              notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END,
              updated_at=now()
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND t.code = ANY($3)
          AND ci.application_id=$1 AND ci.signed_off_at IS NULL
          AND ci.status IN ('outstanding','requested','issue')`,
      [applicationId, note, CREDIT_CONDITION_CODES]);
  } else if (decision === 'review') {
    await client.query(
      `UPDATE checklist_items ci
          SET status='issue',
              notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END,
              updated_at=now()
         FROM checklist_templates t
        WHERE t.id = ci.template_id AND t.code = ANY($3)
          AND ci.application_id=$1 AND ci.signed_off_at IS NULL
          AND ci.status <> 'issue'`,
      [applicationId, note, CREDIT_CONDITION_CODES]);
  }
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

    // Per-bureau (partial-merge) status for the "N of 3 bureaus" view.
    const bureauStatus = outcomes.bureauStatus(parsed, scored);

    // Update the journal row into its final state.
    await client.query(
      `UPDATE credit_reports
          SET credit_report_identifier=$2, report_type=$3, other_description=$4, request_type=$5, action_type=$6,
              first_issued_date = NULLIF($7,'')::date, last_updated_date = NULLIF($8,'')::date,
              xml_encrypted=$9, pdf_document_id=$10,
              representative_score=$11, representative_bracket=$12,
              status=$13, review_reason=$14, error_detail=$15::jsonb, bureau_status=$16::jsonb, completed_at=now()
        WHERE id=$1`,
      [reportRowId, parsed.reportIdentifier || null, parsed.reportType || null, parsed.otherDescription || null,
       orderMeta.requestType || null, orderMeta.action || null,
       parsed.firstIssuedDate || '', parsed.lastUpdatedDate || '',
       rawXml ? crypto.encryptSecret(rawXml) : null, pdfDocumentId,
       scored.rep.score, scored.rep.bracket,
       assessment.decision === 'imported' ? 'imported' : assessment.decision,
       assessment.reason, JSON.stringify(parsed.errors || []), JSON.stringify(bureauStatus)]);

    // Per-bureau score rows (every score node, usable or not — full audit).
    await client.query(`DELETE FROM credit_scores WHERE credit_report_id=$1`, [reportRowId]);
    for (const pb of scored.perBorrower) {
      const dbBorrowerId = orderMeta.borrowerDbIdByReportId[pb.reportBorrowerId] || null;
      for (const c of pb.middle.classified) {
        await client.query(
          `INSERT INTO credit_scores (credit_report_id, borrower_id, report_borrower_id, bureau, model, value, raw_value, exclusion_reason, usable, reason, factors)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [reportRowId, dbBorrowerId, pb.reportBorrowerId, c.bureau, c.model,
           c.usable ? c.value : null, c.rawValue == null ? null : String(c.rawValue), c.exclusionReason, c.usable, c.reason,
           JSON.stringify(Array.isArray(c.factors) ? c.factors : [])]);
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

    // Wire the internal credit-report condition to the outcome.
    const condNote = assessment.decision === 'imported'
      ? `[auto] Credit report imported from Xactus and FICO verified (representative ${scored.rep.score ?? 'n/a'}). Review and sign off.`
      : `[auto] Credit report needs manual review: ${assessment.reason || 'see report'}. It cannot be signed off until cleared.`;
    await wireCreditCondition(client, applicationId, assessment.decision, condNote);

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

  // Idempotency REPLAY: a reused key replays only a COMPLETED outcome, never a
  // transient failure. Replaying an 'error'/'in_doubt' as a terminal answer would
  // poison a legitimate retry; those return their real state (no re-bill), and a
  // fresh key (per click) re-orders cleanly.
  const prior = (await db.query(
    `SELECT id, status, representative_score, representative_bracket, review_reason
       FROM credit_reports WHERE idempotency_key=$1`, [idempotencyKey])).rows[0];
  if (prior) {
    if (prior.status === 'ordering') throw httpError(409, 'an order with this key is already in progress');
    if (prior.status === 'imported' || prior.status === 'review') {
      return { reportId: prior.id, status: prior.status, representativeScore: prior.representative_score,
        representativeBracket: prior.representative_bracket, reviewReason: prior.review_reason, deduped: true };
    }
    return { reportId: prior.id, status: prior.status, reviewReason: prior.review_reason, deduped: true };
  }

  const product = opts.product || 'prequal';
  const action = opts.action || 'Reissue';

  // In-flight dedup window: a double-click that DIDN'T reuse the key must not place
  // two billable orders for the same file + action. Return the in-flight one.
  const inflight = (await db.query(
    `SELECT id FROM credit_reports
      WHERE application_id=$1 AND action_type=$2 AND status='ordering'
        AND ordered_at > now() - ($3 || ' seconds')::interval
      ORDER BY ordered_at DESC LIMIT 1`, [applicationId, action, String(cfg.xactus.dedupWindowSec)])).rows[0];
  if (inflight) return { reportId: inflight.id, status: 'ordering', deduped: true, inflight: true };

  // Spend/volume circuit breaker (billable-path guard) — cap pulls per 10 min.
  const spend = (await db.query(
    `SELECT count(*) FILTER (WHERE ordered_by=$1)::int AS mine, count(*)::int AS total
       FROM credit_reports WHERE ordered_at > now() - interval '10 minutes'`, [actorId])).rows[0];
  if (spend.mine >= cfg.xactus.maxPulls10minUser) {
    throw httpError(429, `credit pull limit reached (${cfg.xactus.maxPulls10minUser} in 10 min) — pause and check for a stuck loop before retrying`, { kind: 'spend_limit_user' });
  }
  if (spend.total >= cfg.xactus.maxPulls10minGlobal) {
    throw httpError(429, 'company-wide credit pull limit reached for the moment — please retry shortly', { kind: 'spend_limit_global' });
  }

  const credential = await credentials.getUsable(actorId, provider.id);
  if (!credential) throw httpError(400, `set up your ${provider.displayName} login before pulling credit`);

  const { app, requestBorrowers } = await loadOrderBorrowers(applicationId);
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
  const evBase = { reportId: reportRowId, applicationId, correlationId: requestId, actorId, providerId: provider.id, action };
  logEvent({ ...evBase, phase: 'journal' });

  breakerCheck(provider.id, clock);

  let resp;
  const postStart = clock;
  try {
    resp = await xactus.orderReport({
      requestXml,
      operatorIdentifier: credential.operatorIdentifier,
      secret: credential.secret,
      timeoutMs: cfg.xactus.timeoutMs,
      transport: opts.transport,
    });
    breakerOk(provider.id);
    logEvent({ ...evBase, phase: 'post', outcome: 'ok', httpStatus: resp.httpStatus, latencyMs: (typeof opts.nowMs === 'number' ? 0 : Date.now() - postStart) });
  } catch (e) {
    // Mark the credential invalid on an auth failure so the officer is told to fix it.
    if (e.kind === 'auth') { try { await credentials.markStatus(actorId, provider.id, 'invalid'); } catch (_) {} }
    if (e.retriable) breakerFail(provider.id, clock);
    // A timeout/network failure is an UNKNOWN OUTCOME, not an error: the vendor may
    // have generated and BILLED the report. Mark it 'in_doubt' (completed_at stays
    // NULL) so it goes to reconciliation, NOT 'error' (which reads as "nothing
    // happened" and would invite a blind, double-billing re-order). Only a real
    // HTTP 4xx / auth / parse failure — where the vendor definitively did not
    // produce a billable report — is a terminal 'error'.
    const inDoubt = e.kind === 'timeout' || e.kind === 'network' || e.kind === 'http' && e.httpStatus >= 500;
    const finalStatus = inDoubt ? 'in_doubt' : 'error';
    const reason = inDoubt
      ? `unknown outcome (${e.kind}) — the vendor may have processed and billed this. Verify in Xactus before re-ordering.`
      : `order failed: ${e.message}`;
    await db.query(
      `UPDATE credit_reports SET status=$4, review_reason=$2, error_detail=$3::jsonb,
              completed_at = CASE WHEN $4='in_doubt' THEN NULL ELSE now() END
        WHERE id=$1`,
      [reportRowId, reason, JSON.stringify({ kind: e.kind || 'error', httpStatus: e.httpStatus || null, retriable: !!e.retriable }), finalStatus]);
    logEvent({ ...evBase, phase: finalStatus, outcome: e.kind || 'error', httpStatus: e.httpStatus, latencyMs: (typeof opts.nowMs === 'number' ? 0 : Date.now() - postStart) });
    throw httpError(e.kind === 'auth' ? 401 : 502, `credit order failed: ${e.message}`,
      { kind: e.kind, retriable: !!e.retriable, inDoubt, reportId: reportRowId });
  }

  // Parse + score + assess.
  let parsed;
  try { parsed = parseCreditResponse(resp.body); }
  catch (e) {
    await db.query(
      `UPDATE credit_reports SET status='error', review_reason=$2, error_detail=$3::jsonb, xml_encrypted=$4, completed_at=now() WHERE id=$1`,
      [reportRowId, `unreadable credit response: ${e.message}`, JSON.stringify({ parse: true }), crypto.encryptSecret(resp.body)]);
    logEvent({ ...evBase, phase: 'parse', outcome: 'parse_error' });
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
  logEvent({ ...evBase, phase: 'persist', outcome: assessment.decision });

  // Push the verified FICO out to ClickUp (owner: locked in ClickUp in/out). A
  // no-op when ClickUp sync is disabled; best-effort — never fails the import.
  if (persisted.froze) {
    try { await require('../../clickup/enqueue').enqueueClickupPush(applicationId, ['fico']); } catch (_) { /* sync reconciles anyway */ }
  }

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
