'use strict';

// Raise an issue / request against a specific TRACK-RECORD line item or a vesting
// LLC (owner-directed 2026-07-12 — LOS-grade condition management).
//
// A staffer reviewing a track-record line item or an entity can flag it. Owner-
// directed (2026-08-04): RAISING AN ISSUE and POSTING A CONDITION are two
// DIFFERENT things and must not be conflated —
//   • RAISE AN ISSUE (postCondition=false, the default) is INTERNAL ONLY: an
//     audience='staff' item for the team to review. The borrower is NOT emailed
//     and does NOT see it. "This is just raising an issue for them to review."
//   • POST A CONDITION (postCondition=true, an explicit action) creates the
//     borrower-facing (audience='both') condition and notifies the borrower.
// Re-raising the same (file, entity, reason) reuses the row; clicking "Post a
// condition" on an issue that was raised internally UPGRADES it to borrower-facing
// and notifies then (and only then).
//
// ADDRESSING (owner-directed 2026-08-04, "a major issue"): a condition on a
// track-record item is a condition on the SUBJECT loan, ABOUT a property on the
// borrower's track record — it is NOT a condition on that track-record address.
// So every borrower-facing message leads with the subject loan (via the file
// context) and frames the track-record property as context, never as "the
// property" the condition is on.
//
// The borrower responds by uploading a document; staff accept/reject it through
// the normal document-review flow. The full reason is stored in issue_reason so
// both sides always see why it was raised.
//
// Idempotent per (file, entity, reason) via a field_key marker
// ('issue:tr:<id>' / 'issue:llc:<id>'): re-raising the identical ask on the same
// line item reuses the row instead of stacking duplicates; a DIFFERENT reason on
// the same entity is a separate condition (a distinct ask). Reuses the dynamic-
// named-condition pattern from co-borrower.js.

const notify = require('./notify');

function clean(s) { return String(s == null ? '' : s).trim(); }

async function raiseEntityIssue({ appId, entityKind, entityId, entityName, reason, actorId, requestKind, postCondition }, client) {
  client = client || require('../db');
  const kind = entityKind === 'llc' ? 'llc' : 'track_record';
  const marker = `issue:${kind === 'llc' ? 'llc' : 'tr'}:${entityId}`;
  const cleanReason = clean(reason).slice(0, 500);
  if (!cleanReason) { const e = new Error('a reason is required'); e.status = 400; throw e; }
  const name = clean(entityName) || (kind === 'llc' ? 'the entity' : 'the property');
  const kindLabel = kind === 'llc' ? 'Entity' : 'Track record';
  // A document REQUEST is always a real ask of the borrower, so it posts a
  // borrower-facing condition. A plain "raise an issue" is internal UNLESS the
  // caller explicitly asked to post a condition.
  const borrowerFacing = requestKind === 'doc_request' || !!postCondition;
  const audience = borrowerFacing ? 'both' : 'staff';
  // STAFF label — entity + reason (unchanged, so the desk still reads it clearly).
  const label = `${kindLabel} — ${name}: ${cleanReason}`.slice(0, 300);
  // BORROWER label — frames it as a track-record / entity item on THEIR loan, not
  // as a condition on that address (the #25 confusion the owner reported).
  const borrowerLabel = (kind === 'llc'
    ? `Entity document (${name}) — ${cleanReason}`
    : `Track-record item (${name}) — ${cleanReason}`).slice(0, 300);
  const raised = JSON.stringify({ kind, id: String(entityId), name });
  // A track-record condition links straight to its line item (093): uploads to
  // the condition land on the line too, and vice versa.
  const trackRecordId = kind === 'track_record' ? String(entityId) : null;

  const app = (await client.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!app) { const e = new Error('application not found'); e.status = 404; throw e; }

  // Idempotent: an OPEN raised condition for the same entity + same reason is reused.
  const existing = (await client.query(
    `SELECT id FROM checklist_items
      WHERE application_id=$1 AND field_key=$2 AND COALESCE(issue_reason,'')=$3
        AND status <> 'satisfied' LIMIT 1`, [appId, marker, cleanReason])).rows[0];

  let itemId;
  if (existing) {
    // Reuse the row. NOTE audience is only ever RAISED (staff→both when a condition
    // is posted), never lowered — an issue already shown to the borrower must not
    // silently go internal on a re-raise.
    await client.query(
      `UPDATE checklist_items
          SET label=$2, borrower_label=$3, hint=$4, borrower_hint=$4,
              audience = CASE WHEN $6 = 'both' THEN 'both' ELSE audience END,
              issue_reason=$4, raised_entity=$5::jsonb, track_record_id=$7, status='outstanding', updated_at=now()
        WHERE id=$1`,
      [existing.id, label, borrowerLabel, cleanReason, raised, audience, trackRecordId]);
    itemId = existing.id;
  } else {
    // origin_detail is a jsonb column (037) — store the raise provenance as JSON.
    const originDetail = JSON.stringify({ raisedAgainst: kind, entityId: String(entityId), entityName: name });
    const ins = await client.query(
      `INSERT INTO checklist_items
         (scope, application_id, label, borrower_label, hint, borrower_hint, audience, item_kind,
          is_required, category, field_key, status, created_by_kind, created_by_id,
          origin_kind, origin_detail, issue_reason, raised_entity, track_record_id, sort_order)
       VALUES ('application',$1,$2,$3,$4,$4,$5,'document',true,'prior_to_docs',$6,'outstanding','staff',$7,
               'manual_custom',$8::jsonb,$4,$9::jsonb,$10, 500)
       RETURNING id`,
      [appId, label, borrowerLabel, cleanReason, audience, marker, actorId || null, originDetail, raised, trackRecordId]);
    itemId = ins.rows[0].id;
  }

  // The borrower is told ONLY when this is a borrower-facing ask (a posted condition
  // or a document request) — never on a plain internal "raise an issue" (the #24
  // bombardment the owner reported). The message leads with THEIR loan and frames the
  // track-record / entity item as context, so it can never read as a condition on
  // that other address (#25).
  if (borrowerFacing && app.borrower_id) {
    try {
      const ctx = await notify.fileContext(appId);
      const asksDoc = requestKind === 'doc_request';
      const about = kind === 'llc' ? `the entity “${name}”` : `a property on your track record (“${name}”)`;
      await notify.notifyBorrower(app.borrower_id, {
        type: 'doc_requested',
        // No address in the title — enrichFileOpts appends the SUBJECT loan/street to
        // the email subject, so the borrower always sees which loan it's for.
        title: asksDoc ? 'A document was requested' : 'A new item needs your attention',
        body: `Your loan team ${asksDoc ? 'requested a document' : 'added a condition'} on your loan${ctx ? ` (${ctx.label})` : ''} — it concerns ${about}: ${cleanReason}`,
        meta: (ctx && ctx.borrowerMeta) || undefined,
        applicationId: appId,
        link: `/app/${appId}`,
        ctaLabel: asksDoc ? 'Upload the document' : 'View the condition' });
    } catch (_) { /* best-effort */ }
  }
  return { itemId, reused: !!existing, borrowerFacing };
}

module.exports = { raiseEntityIssue };
