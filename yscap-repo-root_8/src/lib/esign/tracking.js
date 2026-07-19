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
            a.ys_loan_number AS "loanNumber",
            b.first_name AS "firstName", b.last_name AS "lastName",
            ${RECIP_JSON}
       FROM esign_envelopes e
       JOIN applications a ON a.id = e.application_id
       LEFT JOIN borrowers b ON b.id = a.borrower_id
      WHERE a.deleted_at IS NULL ${scope.where}
      ORDER BY e.created_at DESC
      LIMIT 300`, scope.params)).rows;
  const envelopes = rows.map((r) => {
    const recipients = r.recipients || [];
    const phase = esignPhase(r.status, recipients, r.countersignRequired);
    return { ...r, recipients, phase, waitingOn: waitingOn(recipients, phase) };
  });
  const counts = { total: envelopes.length };
  for (const e of envelopes) counts[e.phase] = (counts[e.phase] || 0) + 1;
  // things that need a human's attention now
  counts.needsAttention = envelopes.filter((e) => ['declined', 'error'].includes(e.phase) || e.deadLetteredAt).length;
  counts.awaitingCountersign = envelopes.filter((e) => e.phase === 'awaiting_countersign').length;
  return { envelopes, counts };
}

/** Per-file: the send-gate + the two packages' envelopes. */
async function fileEsign(db, applicationId) {
  const g = await gate.esignSendGate(applicationId, { db });
  const { envelopes } = await dashboard(db, { where: 'AND a.id = $1', params: [applicationId] });
  const byPurpose = { term_sheet_package: [], heter_iska: [] };
  for (const e of envelopes) { (byPurpose[e.purpose] = byPurpose[e.purpose] || []).push(e); }
  return { gate: g, packages: byPurpose, envelopes };
}

module.exports = { esignPhase, waitingOn, dashboard, fileEsign };
