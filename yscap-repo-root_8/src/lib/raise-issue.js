'use strict';

// Raise an issue / request against a specific TRACK-RECORD line item or a vesting
// LLC (owner-directed 2026-07-12 — LOS-grade condition management).
//
// A staffer reviewing a track-record line item or an entity can post a request
// against it ("this HUD-1 doesn't match the sale price", "we need the amended
// operating agreement"). It becomes a REAL condition on the file, named by the
// entity (property address / LLC name) PLUS the reason, and visible to BOTH the
// internal team and the borrower (audience='both') — an "internal+external"
// condition. The borrower responds by uploading a document; staff accept/reject
// it through the normal document-review flow. The full reason is stored in the
// borrower-visible issue_reason so both sides always see why it was raised.
//
// Idempotent per (file, entity, reason) via a field_key marker
// ('issue:tr:<id>' / 'issue:llc:<id>'): re-raising the identical ask on the same
// line item reuses the row instead of stacking duplicates; a DIFFERENT reason on
// the same entity is a separate condition (a distinct ask). Reuses the dynamic-
// named-condition pattern from co-borrower.js.

const notify = require('./notify');

function clean(s) { return String(s == null ? '' : s).trim(); }

async function raiseEntityIssue({ appId, entityKind, entityId, entityName, reason, actorId }, client) {
  client = client || require('../db');
  const kind = entityKind === 'llc' ? 'llc' : 'track_record';
  const marker = `issue:${kind === 'llc' ? 'llc' : 'tr'}:${entityId}`;
  const cleanReason = clean(reason).slice(0, 500);
  if (!cleanReason) { const e = new Error('a reason is required'); e.status = 400; throw e; }
  const name = clean(entityName) || (kind === 'llc' ? 'the entity' : 'the property');
  const kindLabel = kind === 'llc' ? 'Entity' : 'Track record';
  // The condition NAME is the entity + the reason (owner-directed wording).
  const label = `${kindLabel} — ${name}: ${cleanReason}`.slice(0, 300);
  const raised = JSON.stringify({ kind, id: String(entityId), name });

  const app = (await client.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!app) { const e = new Error('application not found'); e.status = 404; throw e; }

  // Idempotent: an OPEN raised condition for the same entity + same reason is reused.
  const existing = (await client.query(
    `SELECT id FROM checklist_items
      WHERE application_id=$1 AND field_key=$2 AND COALESCE(issue_reason,'')=$3
        AND status <> 'satisfied' LIMIT 1`, [appId, marker, cleanReason])).rows[0];

  let itemId;
  if (existing) {
    await client.query(
      `UPDATE checklist_items
          SET label=$2, borrower_label=$2, hint=$3, borrower_hint=$3,
              issue_reason=$3, raised_entity=$4::jsonb, status='outstanding', updated_at=now()
        WHERE id=$1`,
      [existing.id, label, cleanReason, raised]);
    itemId = existing.id;
  } else {
    // origin_detail is a jsonb column (037) — store the raise provenance as JSON.
    const originDetail = JSON.stringify({ raisedAgainst: kind, entityId: String(entityId), entityName: name });
    const ins = await client.query(
      `INSERT INTO checklist_items
         (scope, application_id, label, borrower_label, hint, borrower_hint, audience, item_kind,
          is_required, category, field_key, status, created_by_kind, created_by_id,
          origin_kind, origin_detail, issue_reason, raised_entity, sort_order)
       VALUES ('application',$1,$2,$2,$3,$3,'both','document',true,'prior_to_docs',$4,'outstanding','staff',$5,
               'manual_custom',$6::jsonb,$3,$7::jsonb, 500)
       RETURNING id`,
      [appId, label, cleanReason, marker, actorId || null, originDetail, raised]);
    itemId = ins.rows[0].id;
  }

  // Tell the borrower a new item needs their attention on this file.
  if (app.borrower_id) {
    try {
      const ctx = await notify.fileContext(appId);
      await notify.notifyBorrower(app.borrower_id, {
        type: 'doc_requested',
        title: `${name} — a new item needs your attention`,
        body: `Your loan team added a condition on ${kind === 'llc' ? `entity "${name}"` : `property "${name}"`}: ${cleanReason}${ctx ? ` (${ctx.label})` : ''}`,
        meta: (ctx && ctx.meta) || undefined,
        applicationId: appId,
        link: `/app/${appId}`,
        ctaLabel: 'View the condition' });
    } catch (_) { /* best-effort */ }
  }
  return { itemId, reused: !!existing };
}

module.exports = { raiseEntityIssue };
