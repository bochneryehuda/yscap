/**
 * esign/tracking.js — the read model behind the internal "DocuSign" tracking
 * page (staff dashboard + per-file section). Pure derivation + two queries;
 * dependency-injected db so the phase/waiting-on logic is unit-testable.
 *
 * DocuSign has no native "awaiting counter-signature" status — we derive the
 * human-facing phase from the recipients + routing order (see
 * docs/DOCUSIGN-WORKFORCE-BUILD-SPEC.md §11).
 */
const gate = require('./gate');
const cfg = require('../../config').docusign;

const isSigned = (r) => !!(r.signedAt || r.status === 'completed' || r.status === 'signed');
const isDeclined = (r) => !!(r.declinedAt || r.status === 'declined');

/** Derived phase: draft | awaiting_borrower | awaiting_countersign | completed | declined | voided | error. */
function esignPhase(status, recipients, countersignRequired) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'completed';
  if (s === 'declined') return 'declined';
  if (s === 'voided') return 'voided';
  if (s === 'error') return 'error';
  if (s === 'not_sent') return 'draft';
  const recs = recipients || [];
  if (!countersignRequired) return 'awaiting_borrower';
  const order1 = recs.filter((r) => Number(r.routingOrder) === 1);
  const order1Done = order1.length > 0 && order1.every(isSigned);
  const adminPending = recs.some((r) => Number(r.routingOrder) >= 2 && !isSigned(r) && !isDeclined(r));
  if (order1Done && adminPending) return 'awaiting_countersign';
  return 'awaiting_borrower';
}

/** The next recipient we're waiting on (lowest routing order not yet done), or null. */
function waitingOn(recipients, phase) {
  if (['completed', 'declined', 'voided', 'draft', 'error'].includes(phase)) return null;
  const recs = (recipients || []).slice().sort((a, b) => Number(a.routingOrder) - Number(b.routingOrder));
  const pending = recs.find((r) => !isSigned(r) && !isDeclined(r));
  return pending ? { name: pending.name, role: pending.role, routingOrder: pending.routingOrder } : null;
}

const RECIP_JSON = `
  (SELECT json_agg(json_build_object(
     'id', r.id, 'role', r.role, 'name', r.name, 'email', r.email, 'routingOrder', r.routing_order,
     'status', r.status, 'sentAt', r.sent_at, 'deliveredAt', r.delivered_at, 'signedAt', r.signed_at,
     'declinedAt', r.declined_at, 'declineReason', r.decline_reason,
     'isCountersigner', r.is_countersigner, 'embedded', r.embedded)
     ORDER BY r.routing_order, r.role)
   FROM esign_recipients r WHERE r.envelope_row_id = e.id) AS recipients`;

/** Cross-file (or single-file) envelope list with derived phase + waiting-on. */
async function dashboard(db, scope = { where: '', params: [] }) {
  const rows = (await db.query(
    `SELECT e.id, e.application_id AS "applicationId", e.purpose, e.status, e.envelope_id AS "envelopeId",
            e.countersign_required AS "countersignRequired", e.embedded,
            e.sent_at AS "sentAt", e.completed_at AS "completedAt", e.declined_at AS "declinedAt",
            e.voided_at AS "voidedAt", e.void_reason AS "voidReason", e.created_at AS "createdAt",
            e.last_error AS "lastError", e.dead_lettered_at AS "deadLetteredAt",
            COALESCE(a.property_address->>'oneLine',
                     NULLIF(concat_ws(', ', a.property_address->>'line1', a.property_address->>'city',
                                      a.property_address->>'state', a.property_address->>'zip'), '')) AS "propertyAddress",
            COALESCE(a.ys_loan_number, e.test_label) AS "loanNumber",
            e.is_test AS "isTest",
            b.first_name AS "firstName", b.last_name AS "lastName",
            ${RECIP_JSON}
       FROM esign_envelopes e
       LEFT JOIN applications a ON a.id = e.application_id
       LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE (e.is_test OR a.deleted_at IS NULL) ${scope.where}
      ORDER BY e.created_at DESC
      LIMIT 300`, scope.params)).rows;
  const envelopes = rows.map((r) => {
    const recipients = r.recipients || [];
    const phase = esignPhase(r.status, recipients, r.countersignRequired);
    return { ...r, recipients, phase, waitingOn: waitingOn(recipients, phase) };
  });
  const counts = { total: envelopes.length };
  for (const e of envelopes) counts[e.phase] = (counts[e.phase] || 0) + 1;
  // Things that need a human's attention now. An error/declined row counts ONLY
  // while it's still the LATEST envelope for its (file, purpose): a Retry/Re-issue
  // creates a newer envelope, which supersedes the old failure so it stops
  // counting (otherwise resolved dead-letters inflate the badge forever). Rows are
  // ordered created_at DESC, so the first one seen per key is the latest.
  // A test row has no (application_id, purpose) identity — every one shares
  // 'null:test' — so key each test by its own id (each is its own latest).
  const keyOf = (e) => (e.isTest ? `test:${e.id}` : `${e.applicationId}:${e.purpose}`);
  const latestByKey = new Map();
  for (const e of envelopes) { const k = keyOf(e); if (!latestByKey.has(k)) latestByKey.set(k, e.id); }
  // Voiding is deliberate (owner-directed 2026-07-20): a voided/cancelled package is
  // a resolved terminal state, NOT something to chase — it belongs in the
  // "Declined / voided" tab, never under "needs attention." Only a DECLINE (borrower
  // refused), a send ERROR, or a dead-letter genuinely needs a human.
  counts.needsAttention = envelopes.filter((e) =>
    (['declined', 'error'].includes(e.phase) || e.deadLetteredAt)
    && latestByKey.get(keyOf(e)) === e.id).length;
  counts.awaitingCountersign = envelopes.filter((e) => e.phase === 'awaiting_countersign').length;

  // Send-engine health — an ops signal so staff can tell "it's DocuSign / it's paused"
  // from "PILOT is broken" when packages sit without progress. Aggregate counts only
  // (no PII), so it's safe to compute globally regardless of the file scope.
  const sh = (await db.query(
    `SELECT
       count(*) FILTER (WHERE status='not_sent' AND application_id IS NOT NULL AND next_attempt_at IS NOT NULL AND next_attempt_at > now()) AS "backingOff",
       count(*) FILTER (WHERE status='not_sent' AND application_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) AND dead_lettered_at IS NULL) AS "queued",
       count(*) FILTER (WHERE status='error' AND dead_lettered_at IS NOT NULL AND application_id IS NOT NULL) AS "deadLettered",
       count(*) FILTER (WHERE sent_at > now() - interval '10 minutes' AND application_id IS NOT NULL) AS "sent10min"
     FROM esign_envelopes`)).rows[0];
  const sendHealth = {
    sendEnabled: require('../integrations/switches').on('DOCUSIGN_SEND_ENABLED'),
    breakerOpen: Number(sh.sent10min) >= cfg.maxSends10min,
    queued: Number(sh.queued),
    backingOff: Number(sh.backingOff),
    deadLettered: Number(sh.deadLettered),
  };
  await attachSignedArtifacts(db, envelopes);
  return { envelopes, counts, sendHealth };
}

/**
 * Attach the downloadable signed artifacts to each envelope IN PLACE, so both the
 * cockpit and the per-file view can offer download links + the legal record:
 *   e.documents   — the stored signed PDFs (one per package document, filed into
 *                   their conditions); the signed Heter Iska is included here (staff
 *                   can download it) — it is only excluded from TPR/SharePoint.
 *   e.certificate — the DocuSign Certificate of Completion (staff-only, one per
 *                   envelope, keyed by the envelope id in its filename), or null.
 */
async function attachSignedArtifacts(db, envelopes) {
  for (const e of envelopes) { e.documents = []; e.certificate = null; }
  if (!envelopes.length) return;
  const docs = (await db.query(
    `SELECT ed.envelope_row_id AS "envelopeRowId", ed.doc_kind AS "docKind",
            d.id AS "documentId", d.filename
       FROM esign_envelope_docs ed
       JOIN documents d ON d.id = ed.completed_document_id
      WHERE ed.envelope_row_id = ANY($1) AND ed.completed_document_id IS NOT NULL
      ORDER BY ed.document_id`, [envelopes.map((e) => e.id)])).rows;
  const byEnv = {};
  for (const d of docs) (byEnv[d.envelopeRowId] = byEnv[d.envelopeRowId] || []).push(d);
  for (const e of envelopes) e.documents = byEnv[e.id] || [];

  // Certificate is a standalone staff-only doc keyed by the DocuSign envelope UUID in
  // its filename. The filename carries the globally-unique envelope UUID, so it's the
  // safe match key for BOTH a real file (application_id set) AND an app-less admin
  // self-test (application_id NULL) — we still re-verify the cert's application_id
  // equals the envelope's (both NULL for a test) as belt-and-suspenders so a cert can
  // never bind to a doc outside its own envelope.
  const withEnv = envelopes.filter((e) => e.envelopeId);
  if (withEnv.length) {
    const names = withEnv.map((e) => `esign_certificate_${e.envelopeId}.pdf`);
    const certs = (await db.query(
      `SELECT id AS "documentId", filename, application_id AS "applicationId" FROM documents
        WHERE doc_kind = 'esign_certificate' AND filename = ANY($1)`, [names])).rows;
    const byName = {};
    for (const c of certs) byName[c.filename] = c;   // filename is unique per envelope
    for (const e of withEnv) {
      const c = byName[`esign_certificate_${e.envelopeId}.pdf`];
      if (c && String(c.applicationId || '') === String(e.applicationId || '')) {
        e.certificate = { documentId: c.documentId, filename: c.filename };
      }
    }
  }
}

/**
 * The SECOND gate on a term-sheet send (owner-reported 2026-07-27). The e-sign
 * send-gate above only knows the appraisal/P&P/closing prerequisites; the
 * Encompass match gate blocks the term-sheet package independently, at the send
 * route. Because the panel never READ that gate, a file with every condition
 * signed off rendered "All prerequisites met" with no escape hatch on screen —
 * and then the send came back "Encompass has 7 unmatched field(s)", with no way
 * to act on it. Reading it here is what lets the panel show the real blocker AND
 * the override that clears it. Best-effort: `issuanceGate` already fails OPEN
 * (dormant with no Encompass loan, block:false on any error) and this extra
 * try/catch guarantees a reconcile problem can never break the e-sign panel.
 */
async function encompassSendBlock(applicationId) {
  try {
    const g = await require('../../encompass/reconcile').issuanceGate(applicationId);
    return {
      block: !!g.block, hasLoan: !!g.hasLoan,
      openBlocking: g.openBlocking || 0,
      openBlockingKeys: g.openBlockingKeys || [],
    };
  } catch (_) {
    return { block: false, hasLoan: false, openBlocking: 0, openBlockingKeys: [] };
  }
}

/**
 * A THIRD reason a term-sheet package can't send (owner-directed 2026-08-02):
 * the Term Sheet stored on the file PRINTS "INITIAL TERM SHEET — NOT FINAL".
 * The wording is drawn into the PDF at generation time, so orchestrate.js
 * refuses to mail one — and, exactly like the Encompass gate above, the panel
 * has to READ that here or the officer meets the refusal only after pressing
 * Send, with nothing on screen explaining it.
 *
 * The document query MIRRORS orchestrate.latestDocument so the panel and the
 * send can never disagree about WHICH sheet is being judged. Best-effort: a
 * read failure reports no block (the send still refuses — the panel is advisory
 * and must never break on it), and "no term sheet on the file at all" is left to
 * the orchestrator's own missing-document message rather than duplicated here.
 */
async function termSheetStampBlock(db, applicationId) {
  /* THE STORED SHEET IS WHAT GOES OUT, so its stamp is a real send blocker again
     (owner-directed 2026-08-14). Between 2026-08-06 and 2026-08-14 this reported a
     hard-coded `{ final: true, block: false, canFinalize: false }` because the
     sender was building its own sheet — which ALSO switched off the panel's
     "Finalize & send" / "Finalize now" buttons, since both are gated on `block` +
     `canFinalize`. The buttons were still in the bundle, just permanently
     unreachable. Reporting the truth here is what turns them back on. */
  try {
    const r = await db.query(
      `SELECT id, term_sheet_final, created_at
         FROM documents
        WHERE application_id = $1 AND doc_kind = 'term_sheet'
          AND COALESCE(review_status,'') <> 'rejected'
        ORDER BY is_current DESC NULLS LAST, created_at DESC
        LIMIT 1`, [applicationId]);
    const doc = r.rows[0];
    // Is the FILE ready to produce a FINAL term sheet RIGHT NOW? — the same rule the
    // studio uses when it stamps one (every send requirement met EXCEPT the P&P
    // sign-off, which is the registration itself). This is what lets the panel offer
    // to finalize the sheet ON THE SPOT (owner-directed 2026-08-04: "that button …
    // should be the button that is generating the final term sheet after all the
    // conditions are met") instead of only pointing staff back to Products & Pricing.
    let stamp = { final: false, blockers: [], unreadable: true };
    try { stamp = await require('./term-sheet-stamp').termSheetStamp(applicationId, { db }); } catch (_) { /* fail closed → canFinalize false */ }
    const blockers = (stamp.blockers || []).map((b) => ({ code: b.code, label: b.label, reason: b.reason }));
    const final = !!(doc && doc.term_sheet_final === true);
    // canFinalize: the file may be stamped final now, and it is not already final.
    const canFinalize = !!stamp.final && !final;
    if (!doc) return { onFile: false, final: false, block: false, message: null, canFinalize, blockers };
    return {
      onFile: true, final, block: !final, generatedAt: doc.created_at,
      message: final ? null : require('./term-sheet-stamp').REGENERATE_MESSAGE,
      canFinalize, blockers,
    };
  } catch (_) {
    return { onFile: false, final: false, block: false, message: null, canFinalize: false, blockers: [] };
  }
}

/** Per-file: the send-gate + the two packages' envelopes (with signed-doc links). */
async function fileEsign(db, applicationId) {
  const g = await gate.esignSendGate(applicationId, { db });
  // dashboard() already attached e.documents (signed PDFs) + e.certificate via
  // attachSignedArtifacts — the per-file view reuses them directly.
  const { envelopes } = await dashboard(db, { where: 'AND a.id = $1', params: [applicationId] });
  const byPurpose = { term_sheet_package: [], heter_iska: [], noo_affidavit: [] };
  for (const e of envelopes) { (byPurpose[e.purpose] = byPurpose[e.purpose] || []).push(e); }
  // The non-owner-occupied certification package is offered ONLY on a file that vests
  // in an individual's name — i.e. one carrying the cond_noo_affidavit_individual
  // condition (db/417, rule-driven off individual vesting). An already-started NOO
  // envelope also keeps the package visible so its card can be managed after the file
  // is (say) re-linked to an entity and the condition retracts.
  const nooApplicable = !!(await db.query(
    `SELECT 1 FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = 'cond_noo_affidavit_individual' LIMIT 1`,
    [applicationId])).rows.length || byPurpose.noo_affidavit.length > 0;
  // Surface the file's YS loan number so the per-file view can offer an inline
  // backfill when it's missing — the term-sheet package prints the loan number on
  // the disclosure, so a file with no loan number can't send until one is entered.
  const meta = (await db.query(`SELECT ys_loan_number FROM applications WHERE id = $1`, [applicationId])).rows[0] || {};
  // The reason options for the "request an exception to send before clear-to-close"
  // form (one source of truth — the server validates against the same set).
  const exceptionReasonCodes = require('../loan-exceptions').reasonCodesFor('esign_before_ctc');
  // The Encompass match gate — a SEPARATE reason the term-sheet package can't
  // send, enforced at the send route. The panel needs it to tell the truth about
  // readiness and to offer the admin override instead of a dead end.
  const encompass = await encompassSendBlock(applicationId);
  const termSheet = await termSheetStampBlock(db, applicationId);
  return { gate: g, packages: byPurpose, envelopes, loanNumber: meta.ys_loan_number || null, exceptionReasonCodes, encompass, termSheet, nooApplicable };
}

module.exports = { esignPhase, waitingOn, dashboard, fileEsign, encompassSendBlock, termSheetStampBlock };
