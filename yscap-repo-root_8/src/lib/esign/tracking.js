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
    sendEnabled: !!cfg.sendEnabled,
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
  // its filename. Scope the lookup by BOTH the file (application_id) AND the filename
  // so it can never bind to a doc outside the envelope's own file — belt-and-suspenders
  // even though the envelope UUID is already globally unique.
  const withEnv = envelopes.filter((e) => e.envelopeId && e.applicationId);
  if (withEnv.length) {
    const appIds = [...new Set(withEnv.map((e) => e.applicationId))];
    const names = withEnv.map((e) => `esign_certificate_${e.envelopeId}.pdf`);
    const certs = (await db.query(
      `SELECT id AS "documentId", filename, application_id AS "applicationId" FROM documents
        WHERE doc_kind = 'esign_certificate' AND application_id = ANY($1) AND filename = ANY($2)`,
      [appIds, names])).rows;
    const byKey = {};
    for (const c of certs) byKey[`${c.applicationId}::${c.filename}`] = c;
    for (const e of withEnv) {
      const c = byKey[`${e.applicationId}::esign_certificate_${e.envelopeId}.pdf`];
      if (c) e.certificate = { documentId: c.documentId, filename: c.filename };
    }
  }
}

/** Per-file: the send-gate + the two packages' envelopes (with signed-doc links). */
async function fileEsign(db, applicationId) {
  const g = await gate.esignSendGate(applicationId, { db });
  // dashboard() already attached e.documents (signed PDFs) + e.certificate via
  // attachSignedArtifacts — the per-file view reuses them directly.
  const { envelopes } = await dashboard(db, { where: 'AND a.id = $1', params: [applicationId] });
  const byPurpose = { term_sheet_package: [], heter_iska: [] };
  for (const e of envelopes) { (byPurpose[e.purpose] = byPurpose[e.purpose] || []).push(e); }
  return { gate: g, packages: byPurpose, envelopes };
}

module.exports = { esignPhase, waitingOn, dashboard, fileEsign };
