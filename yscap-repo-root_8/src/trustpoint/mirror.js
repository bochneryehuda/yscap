'use strict';
/**
 * TrustPoint MIRROR (phase 2 — blueprint §4): hydrate + upsert draws / service orders
 * for LINKED projects, react to genuine inbound transitions (staff notices + the
 * borrower's single-voice milestone emails — D5: PILOT is the only voice, TrustPoint
 * is never named to a borrower), archive the TrustPoint report PDF on approval
 * (staff-only), and drain the webhook inbox.
 *
 * GO-FORWARD discipline (mirrors the Sitewire reconcile): the first sight of a draw
 * BASELINES silently (status_synced claimed with no notification); only transitions
 * that happen while PILOT is watching notify. All reactions are atomic-claim guarded
 * so overlapping webhook drains + polls can never double-notify.
 */

const db = require('../db');
const client = require('./client');
const notify = require('../lib/notify');

const usd = (c) => c == null ? '—' : '$' + Math.floor(Number(c) / 100).toLocaleString('en-US');

async function audit(appId, tpDrawId, entity, entityId, field, oldV, newV, reacted) {
  try {
    await db.query(
      `INSERT INTO trustpoint_pull_field_change (application_id, tp_draw_id, entity, entity_id, field, old_value, new_value, reacted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [appId, tpDrawId || null, entity, entityId || null, field, oldV == null ? null : String(oldV).slice(0, 500), newV == null ? null : String(newV).slice(0, 500), !!reacted]);
  } catch (_) { /* best-effort audit */ }
}

/** The linked file for a TrustPoint project (null when unlinked/unknown/soft-deleted). */
async function linkFor(tpProjectId) {
  const r = await db.query(
    `SELECT l.application_id, l.baselined_at FROM trustpoint_project_links l
       JOIN applications a ON a.id = l.application_id AND a.deleted_at IS NULL
      WHERE l.tp_project_id=$1 AND l.application_id IS NOT NULL`, [tpProjectId]);
  return r.rows[0] || null;
}
async function linkedAppFor(tpProjectId) {
  const l = await linkFor(tpProjectId);
  return l ? l.application_id : null;
}

// ---- draw upsert (aggregate mirror) ----
const C = client.centsFromTp;
function drawRow(d) {
  return {
    number: d.number != null && Number.isFinite(Number(d.number)) ? Number(d.number) : null,
    name: d.name || d.draw_name || null,
    status: d.status || null,
    draw_type: d.type || null,
    requested_cents: C(d.requested_amount ?? d.amount_requested),
    approved_cents: C(d.approved_amount ?? d.amount_approved),
    disbursed_cents: C(d.disbursed_amount ?? d.amount_disbursed),
    to_disburse_cents: C(d.amount_to_disburse),
    holdback_cents: C(d.construction_holdback),
    borrower_equity_cents: C(d.borrower_equity),
    fees: Array.isArray(d.fees) ? JSON.stringify(d.fees) : null,
    // NULL (not an all-null object) when the payload carried none of the fields, so the
    // upsert's COALESCE protects previously-hydrated detail from thin webhook payloads
    // (phase-2 audit #2 — TrustPoint is the retainage SOR, never wipe the mirror).
    retainage: [d.retainage_release_requested, d.retainage_release_approved, d.retainage_requested_amount_holdback, d.retainage_approved_amount_holdback].some((v) => v !== undefined)
      ? JSON.stringify({
          release_requested: d.retainage_release_requested ?? null,
          release_approved: d.retainage_release_approved ?? null,
          requested_amount_holdback: d.retainage_requested_amount_holdback ?? null,
          approved_amount_holdback: d.retainage_approved_amount_holdback ?? null,
        }) : null,
    contingency: [d.contingency_total, d.contingency_used, d.contingency_used_rate].some((v) => v !== undefined)
      ? JSON.stringify({ total: d.contingency_total ?? null, used: d.contingency_used ?? null, used_rate: d.contingency_used_rate ?? null }) : null,
    inspector_allowance_rate: d.inspector_allowance_rate != null && Number.isFinite(Number(d.inspector_allowance_rate)) ? Number(d.inspector_allowance_rate) : null,
    inspector_recommendation_rate: d.inspector_recommendation_rate != null && Number.isFinite(Number(d.inspector_recommendation_rate)) ? Number(d.inspector_recommendation_rate) : null,
    lender_allowance_rate: d.lender_allowance_rate != null && Number.isFinite(Number(d.lender_allowance_rate)) ? Number(d.lender_allowance_rate) : null,
    coordinator_name: d.coordinator && (d.coordinator.name || [d.coordinator.first_name, d.coordinator.last_name].filter(Boolean).join(' ')) || null,
    submitted_at: d.submitted_at || null, approved_at: d.approved_at || null,
    completed_at: d.completed_at || null, disbursed_at: d.disbursed_at || null,
    tp_created_at: d.created_at || null,
    estimated_reimbursement_date: d.estimated_reimbursement_date || null,
  };
}

/**
 * Upsert a draw's aggregate mirror row. `detail` is a REST detail object when available,
 * else the thinner webhook payload (COALESCE keeps prior detail-only values). Returns
 * { prev, row } — prev is the pre-upsert mirror state (for the reaction).
 */
async function upsertDraw(appId, tpProjectId, tpDrawId, detail) {
  const prev = (await db.query(`SELECT status, status_synced, approved_cents, disbursed_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0] || null;
  const v = drawRow(detail || {});
  const r = await db.query(
    `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, name, status, draw_type,
        requested_cents, approved_cents, disbursed_cents, to_disburse_cents, holdback_cents, borrower_equity_cents,
        fees, retainage, contingency, inspector_allowance_rate, inspector_recommendation_rate, lender_allowance_rate,
        coordinator_name, submitted_at, approved_at, completed_at, disbursed_at, tp_created_at,
        estimated_reimbursement_date, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,now())
     ON CONFLICT (tp_draw_id) DO UPDATE SET
        application_id=EXCLUDED.application_id, tp_project_id=EXCLUDED.tp_project_id,
        status=COALESCE(EXCLUDED.status, trustpoint_draws.status),
        number=COALESCE(EXCLUDED.number, trustpoint_draws.number),
        name=COALESCE(EXCLUDED.name, trustpoint_draws.name),
        draw_type=COALESCE(EXCLUDED.draw_type, trustpoint_draws.draw_type),
        requested_cents=COALESCE(EXCLUDED.requested_cents, trustpoint_draws.requested_cents),
        approved_cents=COALESCE(EXCLUDED.approved_cents, trustpoint_draws.approved_cents),
        disbursed_cents=COALESCE(EXCLUDED.disbursed_cents, trustpoint_draws.disbursed_cents),
        to_disburse_cents=COALESCE(EXCLUDED.to_disburse_cents, trustpoint_draws.to_disburse_cents),
        holdback_cents=COALESCE(EXCLUDED.holdback_cents, trustpoint_draws.holdback_cents),
        borrower_equity_cents=COALESCE(EXCLUDED.borrower_equity_cents, trustpoint_draws.borrower_equity_cents),
        fees=COALESCE(EXCLUDED.fees, trustpoint_draws.fees),
        retainage=COALESCE(EXCLUDED.retainage, trustpoint_draws.retainage),
        contingency=COALESCE(EXCLUDED.contingency, trustpoint_draws.contingency),
        inspector_allowance_rate=COALESCE(EXCLUDED.inspector_allowance_rate, trustpoint_draws.inspector_allowance_rate),
        inspector_recommendation_rate=COALESCE(EXCLUDED.inspector_recommendation_rate, trustpoint_draws.inspector_recommendation_rate),
        lender_allowance_rate=COALESCE(EXCLUDED.lender_allowance_rate, trustpoint_draws.lender_allowance_rate),
        coordinator_name=COALESCE(EXCLUDED.coordinator_name, trustpoint_draws.coordinator_name),
        submitted_at=COALESCE(EXCLUDED.submitted_at, trustpoint_draws.submitted_at),
        approved_at=COALESCE(EXCLUDED.approved_at, trustpoint_draws.approved_at),
        completed_at=COALESCE(EXCLUDED.completed_at, trustpoint_draws.completed_at),
        disbursed_at=COALESCE(EXCLUDED.disbursed_at, trustpoint_draws.disbursed_at),
        estimated_reimbursement_date=COALESCE(EXCLUDED.estimated_reimbursement_date, trustpoint_draws.estimated_reimbursement_date),
        raw=COALESCE(EXCLUDED.raw, trustpoint_draws.raw),
        updated_at=now()
     RETURNING *`,
    [appId, tpProjectId, tpDrawId, v.number, v.name, v.status, v.draw_type,
     v.requested_cents, v.approved_cents, v.disbursed_cents, v.to_disburse_cents, v.holdback_cents, v.borrower_equity_cents,
     v.fees, v.retainage, v.contingency, v.inspector_allowance_rate, v.inspector_recommendation_rate, v.lender_allowance_rate,
     v.coordinator_name, v.submitted_at, v.approved_at, v.completed_at, v.disbursed_at, v.tp_created_at,
     v.estimated_reimbursement_date, detail ? ((x) => x.length > 100000 ? null : x)(JSON.stringify(detail)) : null]);
  return { prev, row: r.rows[0] };
}

// Best-effort tie to the Sitewire intake draw (same file, open, ~same requested total).
// Phase 3's coordinator UI confirms/corrects; never used for money on its own.
async function linkToSitewireIntake(appId, tpDrawRow) {
  try {
    if (!tpDrawRow || tpDrawRow.requested_cents == null) return;
    let swTied = !!tpDrawRow.sitewire_draw_id;
    if (!swTied) {
      const cand = (await db.query(
        `SELECT sitewire_draw_id FROM sitewire_draws
          WHERE application_id=$1 AND COALESCE(historical,false)=false
            AND status IN ('inspecting','pending','pending_capital_partner')
            AND ABS(COALESCE(total_requested_cents,0) - $2) <= 100`,
        [appId, tpDrawRow.requested_cents])).rows;
      if (cand.length === 1) {
        const tied = (await db.query(`UPDATE trustpoint_draws SET sitewire_draw_id=$2, updated_at=now() WHERE tp_draw_id=$1 AND sitewire_draw_id IS NULL RETURNING tp_draw_id`, [tpDrawRow.tp_draw_id, cand[0].sitewire_draw_id])).rows[0];
        // The coordinator's entry task is DONE the moment the entered draw mirrors back and
        // ties to its intake (blueprint §3 auto-complete; audit #13). Recorded as a returned
        // hand-off with the standard outcome, so the SLA nag stops and history reads right.
        if (tied) {
          swTied = true;
          await db.query(
            `UPDATE workflow_items SET status='returned', outcome_label='Entered in TrustPoint', returned_at=now(), updated_at=now()
              WHERE application_id=$1 AND submission_type='trustpoint_import' AND status IN ('open','in_progress')`, [appId]).catch(() => {});
          await db.query(
            `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, submission_type, outcome_label, note)
             SELECT id, application_id, 'returned', 'trustpoint_import', 'Entered in TrustPoint', 'Auto-completed — the draw appeared in TrustPoint and tied to this file.'
               FROM workflow_items WHERE application_id=$1 AND submission_type='trustpoint_import' AND outcome_label='Entered in TrustPoint' AND returned_at > now() - interval '1 minute'`, [appId]).catch(() => {});
        }
      }
    }
    // A portal-originated draw ties to its portal request the same way (phase 4) —
    // but ONLY when the draw is not the mirror of a live Sitewire intake (a TrustPoint
    // draw is one cycle: it belongs to the intake OR to a portal request, never both).
    if (!swTied) {
      try { await require('../lib/portal-draws').tieTrustpointDraw(appId, tpDrawRow); } catch (_) {}
    }
  } catch (_) { /* suggestion only */ }
}

// SSRF-guarded, HOST-PINNED download of a TrustPoint document URL. Reuses the
// media-archive public-https/private-ip guard on every hop; additionally the FIRST
// url must live on the TrustPoint base host (a hostile URL in a payload can never
// point PILOT's fetch elsewhere). Sends the Api-Key — the spec doesn't say whether
// document file URLs are pre-signed or key-authenticated (sandbox item Q-C), and the
// header is harmless on a pre-signed URL. 20s cap, 25MB cap.
async function fetchReportBytes(fileUrl) {
  const cfg = require('../config');
  const media = require('../sitewire/media-archive');
  const baseHost = new URL(cfg.trustpointBaseUrl).host;
  const u = new URL(fileUrl);
  if (u.host !== baseHost) throw new Error(`report url host ${u.host} is not the TrustPoint host`);
  await media.assertPublicHttps(fileUrl);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 20000);
  try {
    let current = fileUrl;
    for (let hop = 0; hop <= 3; hop++) {
      await media.assertPublicHttps(current);
      const hostOk = new URL(current).host === baseHost;
      const r = await fetch(current, { signal: ac.signal, redirect: 'manual', headers: hostOk ? { Authorization: `Api-Key ${cfg.trustpointApiKey}` } : {} });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new Error(`redirect ${r.status} with no location`);
        current = new URL(loc, current).href;
        continue;
      }
      if (!r.ok) throw new Error(`report fetch ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) throw new Error('report exceeds the 25MB cap');
      return buf;
    }
    throw new Error('too many redirects');
  } finally { clearTimeout(t); }
}

// ---- the TrustPoint report PDF → staff-only documents row (idempotent per draw+version) ----
async function archiveReport(appId, tpProjectId, tpDrawId) {
  try {
    const meta = await client.getDrawReport(tpProjectId, tpDrawId);
    const fileUrl = meta && meta.file;
    if (!fileUrl) return { archived: false, reason: 'no_report' };
    const already = (await db.query(
      `SELECT report_document_id FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    // idempotent by TrustPoint's own document id in the stored filename
    const docTag = String(meta.id || '').slice(0, 24) || 'latest';
    const filename = `trustpoint-draw-report-${tpDrawId.slice(0, 8)}-${docTag}.pdf`;
    const dup = (await db.query(
      `SELECT id FROM documents WHERE application_id=$1 AND filename=$2 AND is_current`, [appId, filename])).rows[0];
    if (dup) {
      if (!already || !already.report_document_id) await db.query(`UPDATE trustpoint_draws SET report_document_id=$2 WHERE tp_draw_id=$1`, [tpDrawId, dup.id]);
      return { archived: false, reason: 'already_archived', documentId: dup.id };
    }
    const bytes = await fetchReportBytes(fileUrl);
    if (!bytes || !bytes.length) return { archived: false, reason: 'empty' };
    const storage = require('../lib/storage');
    const saved = await storage.save(bytes, { filename, contentType: meta.mime_type || 'application/pdf' });
    const borrower = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
    const doc = (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',NULL,'draw_inspection_report','system','staff_only',true,'pending')
       RETURNING id`,
      [appId, borrower ? borrower.borrower_id : null, filename, meta.mime_type || 'application/pdf', bytes.length, saved.provider, saved.ref])).rows[0];
    await db.query(`UPDATE trustpoint_draws SET report_document_id=$2, updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId, doc.id]);
    return { archived: true, documentId: doc.id };
  } catch (e) {
    console.warn('[trustpoint] report archive failed (best-effort):', e && e.message);
    return { archived: false, reason: 'error' };
  }
}

// ---- reactions: staff notices + borrower single-voice milestones (D5) ----
// Statuses map: IN_REVIEW = submitted/awaiting; APPROVED; COMPLETED (poll-only).
// 'Returned' has no status of its own (draw returns to DRAFT) — reacted via the
// DRAW_REQUEST_RETURNED webhook event, not the status watermark.
async function reactDraw(appId, row, prev, { baseline = false, addrText = null } = {}) {
  const tpDrawId = row.tp_draw_id;
  const newStatus = row.status || null;
  if (!newStatus) return;
  const addr = addrText || (await db.query(`SELECT property_address->>'oneLine' AS a FROM applications WHERE id=$1`, [appId])).rows[0]?.a || 'the property';
  const nLabel = row.number == null ? '—' : row.number;
  const link = `/internal/app/${appId}/draws`;

  // Atomic watermark claim (same shape as the Sitewire reconcile) — one reactor wins.
  const won = (await db.query(
    `UPDATE trustpoint_draws SET status_synced=$2 WHERE tp_draw_id=$1 AND status_synced IS DISTINCT FROM $2 RETURNING tp_draw_id`,
    [tpDrawId, newStatus])).rowCount === 1;
  if (!won) return;
  // Only FORWARD transitions notify (audit #19): a stale read regressing the status and
  // re-advancing must never re-send the borrower approval email. Rank unknown = 0.
  const RANK = { DRAFT: 1, IN_REVIEW: 2, APPROVED: 3, COMPLETED: 4, DELETED: 5 };
  if (prev && prev.status_synced && (RANK[newStatus] || 0) <= (RANK[prev.status_synced] || 0)) {
    await audit(appId, tpDrawId, 'draw', tpDrawId, 'status_nonforward', prev.status_synced, newStatus, false);
    return;
  }
  const firstSight = !prev || prev.status_synced == null;
  // A BASELINE hydrate (a just-linked project's history) claims the watermark silently —
  // go-forward: PILOT never notifies for history it wasn't watching.
  if (baseline) { await audit(appId, tpDrawId, 'draw', tpDrawId, 'baseline', prev && prev.status_synced, newStatus, false); return; }
  await audit(appId, tpDrawId, 'draw', tpDrawId, firstSight ? 'first_status' : 'status', prev && prev.status_synced, newStatus, true);

  if (newStatus === 'IN_REVIEW') {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: 'Draw in review on TrustPoint',
      body: `Draw #${nLabel} for ${addr} (${usd(row.requested_cents)}) is now in TrustPoint's review pipeline.`,
      badge: { text: 'TrustPoint', tone: 'gold' }, applicationId: appId, link, inAppOnly: true,
    }).catch(() => {});
    // PRE-approval milestone snapshot — the derivation's "before" picture (phase 3 §6).
    try { await require('./lines').snapshotMilestones(appId, row.tp_project_id, tpDrawId, 'pre'); } catch (_) {}
  } else if (newStatus === 'APPROVED') {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: 'Draw approved on TrustPoint',
      body: `Draw #${nLabel} for ${addr} was approved: ${usd(row.approved_cents)} of ${usd(row.requested_cents)} requested${row.to_disburse_cents != null ? ` (net to release ${usd(row.to_disburse_cents)})` : ''}.`,
      badge: { text: 'Approved', tone: 'positive' }, applicationId: appId, link,
    }).catch(() => {});
    // Borrower milestone (single voice — borrower-safe wording, no platform names; the
    // 'draw' type is registered + BORROWER_MAJOR_EMAIL; notifyBorrower scrubs partners).
    await notify.notifyAppBorrowers(appId, {
      type: 'draw', title: 'Your draw was approved',
      body: `Good news — your draw request for ${addr} was approved: ${usd(row.approved_cents)} of the ${usd(row.requested_cents)} you requested. The release is being processed; we'll confirm the exact amount when the funds are sent.`,
      applicationId: appId, link: `/app/${appId}`,
    }).catch(() => {});
    await archiveReport(appId, row.tp_project_id, tpDrawId).catch(() => {});
    // Phase 3 §5A/§6: POST-approval snapshot → per-line derivation → Sitewire write-back.
    // Fully best-effort; each stage records why it waited (writeback_note) when it can't run.
    try { await require('./lines').snapshotMilestones(appId, row.tp_project_id, tpDrawId, 'post'); } catch (_) {}
    try { await require('./writeback').onTrustpointApproval(appId, tpDrawId); } catch (_) {}
    // A PORTAL-originated draw closes out into Sitewire as a HISTORICAL draw instead
    // of the live write-back (phase 4 §5B — needs the per-line amounts, so it runs
    // after the derive; re-triggered from the lines-save route as well).
    try { await require('../lib/portal-draws').onTrustpointApproval(appId, row); } catch (_) {}
  } else if (newStatus === 'COMPLETED') {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: 'Draw completed on TrustPoint',
      body: `Draw #${nLabel} for ${addr} is completed on TrustPoint${row.disbursed_cents != null ? ` (disbursed ${usd(row.disbursed_cents)})` : ''}.`,
      badge: { text: 'Completed', tone: 'positive' }, applicationId: appId, link, inAppOnly: true,
    }).catch(() => {});
  }
}

/** A DRAW_REQUEST_RETURNED webhook: the draw went back to the borrower/coordinator. */
async function reactReturned(appId, row, addrText) {
  const addr = addrText || 'the property';
  const nLabel = row && row.number != null ? row.number : '—';
  await notify.notifyAppStaff(appId, {
    type: 'draw_inbound', title: 'Draw returned on TrustPoint',
    body: `Draw #${nLabel} for ${addr} was returned in TrustPoint's review — something needs attention before it can be approved.`,
    badge: { text: 'Returned', tone: 'gold' }, applicationId: appId, link: `/internal/app/${appId}/draws`,
  }).catch(() => {});
  await notify.notifyAppBorrowers(appId, {
    type: 'draw', title: 'Your draw needs attention',
    body: `Your draw request for ${addr} needs a little more before it can be approved. Your loan team will reach out with exactly what's needed.`,
    applicationId: appId, link: `/app/${appId}`,
  }).catch(() => {});
}

// ---- service orders ----
async function upsertServiceOrder(appId, so) {
  const prev = (await db.query(`SELECT status, status_synced FROM trustpoint_service_orders WHERE tp_service_order_id=$1`, [so.id])).rows[0] || null;
  await db.query(
    `INSERT INTO trustpoint_service_orders (tp_service_order_id, application_id, tp_project_id, tp_draw_id, service_type, status,
        service_number, ordered_at, scheduled_at, completed_at, cancelled_at, inspector_allowance_rate, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,now())
     ON CONFLICT (tp_service_order_id) DO UPDATE SET
        application_id=EXCLUDED.application_id, tp_project_id=EXCLUDED.tp_project_id,
        status=COALESCE(EXCLUDED.status, trustpoint_service_orders.status),
        tp_draw_id=COALESCE(EXCLUDED.tp_draw_id, trustpoint_service_orders.tp_draw_id),
        service_number=COALESCE(EXCLUDED.service_number, trustpoint_service_orders.service_number),
        ordered_at=COALESCE(EXCLUDED.ordered_at, trustpoint_service_orders.ordered_at),
        scheduled_at=COALESCE(EXCLUDED.scheduled_at, trustpoint_service_orders.scheduled_at),
        completed_at=COALESCE(EXCLUDED.completed_at, trustpoint_service_orders.completed_at),
        cancelled_at=COALESCE(EXCLUDED.cancelled_at, trustpoint_service_orders.cancelled_at),
        inspector_allowance_rate=COALESCE(EXCLUDED.inspector_allowance_rate, trustpoint_service_orders.inspector_allowance_rate),
        raw=COALESCE(EXCLUDED.raw, trustpoint_service_orders.raw), updated_at=now()`,
    [so.id, appId, so.project_id || so.tp_project_id, so.draw_request_id || null, so.service_type || null, so.status || null,
     so.service_number || null, so.ordered_at || null, so.scheduled_at || null, so.completed_at || null, so.cancelled_at || null,
     so.inspector_allowance_rate != null && Number.isFinite(Number(so.inspector_allowance_rate)) ? Number(so.inspector_allowance_rate) : null,
     ((x) => x.length > 20000 ? null : x)(JSON.stringify(so))]);
  // Silent by default (in-app timeline data); a COMPLETED inspection gets one in-app staff note.
  if (so.status === 'COMPLETED' && (!prev || prev.status !== 'COMPLETED')) {
    await notify.notifyAppStaff(appId, {
      type: 'draw_inbound', title: `${so.service_type === 'INSPECTION' ? 'Inspection' : (so.service_type || 'Service order')} completed`,
      body: `TrustPoint marked the ${String(so.service_type || 'service order').toLowerCase().replace(/_/g, ' ')} complete${so.inspector_allowance_rate != null ? ` — overall progress ${so.inspector_allowance_rate}%` : ''}.`,
      applicationId: appId, link: `/internal/app/${appId}/draws`, inAppOnly: true,
    }).catch(() => {});
  }
}

// ---- full hydrate of one linked project's draws (poll + just-after-link) ----
async function hydrateProject(appId, tpProjectId, { baseline = false } = {}) {
  const draws = await client.listProjectDraws(tpProjectId);
  let n = 0;
  for (const d of draws) {
    try {
      let detail = d;
      try { detail = await client.getDraw(tpProjectId, d.id); } catch (_) {}
      const { prev, row } = await upsertDraw(appId, tpProjectId, String(d.id), detail);
      await linkToSitewireIntake(appId, row);
      await reactDraw(appId, row, prev, { baseline: baseline && (!prev || prev.status_synced == null) });
      n++;
    } catch (e) { console.warn(`[trustpoint] hydrate draw ${d && d.id} failed: ${e && e.message}`); }
  }
  try {
    const sos = await client.listServiceOrders({ project_id: tpProjectId });
    for (const so of sos) await upsertServiceOrder(appId, { ...so, project_id: tpProjectId });
  } catch (_) {}
  return { draws: n };
}

// ---- webhook inbox drain ----
const DRAW_EVENTS = new Set(['DRAW_REQUEST_CREATED', 'DRAW_REQUEST_SUBMITTED', 'DRAW_REQUEST_REVIEW_ADDED', 'DRAW_REQUEST_FINALIZED', 'DRAW_REQUEST_RETURNED', 'DRAW_REQUEST_DELETED']);
const SO_EVENTS = new Set(['SERVICE_ORDER_ORDERED', 'SERVICE_ORDER_COMPLETED', 'SERVICE_ORDER_CANCELLED']);

async function processEvent(evt) {
  const p = evt.payload || {};
  let tpProjectId = evt.tp_project_id || p.project_id || null;
  // The delivery shape may omit project_id (the documented event schema carries only
  // draw_id/loan_id — audit #3). Resolve from what we already know before giving up.
  if (!tpProjectId && (evt.tp_draw_id || p.draw_id)) {
    const known = (await db.query(`SELECT tp_project_id FROM trustpoint_draws WHERE tp_draw_id=$1`, [String(evt.tp_draw_id || p.draw_id)])).rows[0];
    if (known) tpProjectId = known.tp_project_id;
  }
  if (!tpProjectId && (evt.loan_id || p.loan_id)) {
    const byLoan = (await db.query(`SELECT tp_project_id FROM trustpoint_project_links WHERE loan_external_id=$1 AND application_id IS NOT NULL`, [String(evt.loan_id || p.loan_id)])).rows;
    if (byLoan.length === 1) tpProjectId = byLoan[0].tp_project_id;
  }
  if (!tpProjectId) return { skipped: 'no_project' };
  const link = await linkFor(String(tpProjectId));
  const appId = link ? link.application_id : null;
  if (!appId) {
    // Just-in-time discovery: an event for an unknown/unlinked project seeds the linking
    // desk (park-and-replay: the row is left unprocessed=processed with a note; the next
    // poll after linking re-hydrates everything, so nothing is lost).
    try { await require('./discovery').noteUnknownProject(String(tpProjectId), evt.loan_id || p.loan_id || null); } catch (_) {}
    return { skipped: 'unlinked_project' };
  }
  const addr = (await db.query(`SELECT property_address->>'oneLine' AS a FROM applications WHERE id=$1`, [appId])).rows[0]?.a || 'the property';

  if (DRAW_EVENTS.has(evt.event)) {
    const tpDrawId = String(evt.tp_draw_id || p.draw_id || '');
    if (!tpDrawId) return { skipped: 'no_draw' };
    if (evt.event === 'DRAW_REQUEST_DELETED') {
      await db.query(`UPDATE trustpoint_draws SET status='DELETED', status_synced='DELETED', updated_at=now() WHERE tp_draw_id=$1`, [tpDrawId]);
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'deleted', null, 'DELETED', false);
      return { ok: true };
    }
    // hydrate the detail (webhook payloads are thin); fall back to the payload alone
    let detail = null;
    try { detail = await client.getDraw(tpProjectId, tpDrawId); } catch (_) {}
    const { prev, row } = await upsertDraw(appId, String(tpProjectId), tpDrawId, detail || { ...p, id: tpDrawId });
    await linkToSitewireIntake(appId, row);
    if (evt.event === 'DRAW_REQUEST_REVIEW_ADDED') {
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'review_added', null, `${p.review_action || ''} ${p.reviewed_by_team || ''}→${p.assigned_team || ''}`.trim(), false);
      return { ok: true };   // ticker data only — no notification per review hop
    }
    if (evt.event === 'DRAW_REQUEST_RETURNED') {
      await audit(appId, tpDrawId, 'draw', tpDrawId, 'returned', prev && prev.status, row.status, true);
      await reactReturned(appId, row, addr);
      return { ok: true };
    }
    await reactDraw(appId, row, prev, { addrText: addr, baseline: !link.baselined_at });
    return { ok: true };
  }
  if (SO_EVENTS.has(evt.event)) {
    const soId = String(evt.tp_service_order_id || p.service_order_id || '');
    if (!soId) return { skipped: 'no_service_order' };
    await upsertServiceOrder(appId, { ...p, id: soId, project_id: tpProjectId });
    return { ok: true };
  }
  if (evt.event === 'PROJECT_CHANGED') {
    for (const ch of (Array.isArray(p.changes) ? p.changes : [])) {
      await audit(appId, null, 'project', String(tpProjectId), ch.field || 'change', ch.old_value ?? ch.old, ch.new_value ?? ch.new, false);
    }
    return { ok: true };
  }
  return { skipped: 'unknown_event' };
}

async function drainInbox(limit = 50) {
  // The switch gates the whole MIRROR (its label says so): while off, deliveries sit in
  // the inbox untouched and drain when it turns back on (audit #4).
  if (!client.enabled()) return { skipped: 'off' };
  const rows = (await db.query(
    `SELECT * FROM trustpoint_webhook_events WHERE processed_at IS NULL AND attempts < 3 ORDER BY received_at LIMIT $1`, [limit])).rows;
  let ok = 0, failed = 0;
  for (const evt of rows) {
    // claim so overlapping drains never double-process
    const claim = await db.query(
      `UPDATE trustpoint_webhook_events SET processed_at=now(), attempts=attempts+1 WHERE id=$1 AND processed_at IS NULL RETURNING id`, [evt.id]);
    if (!claim.rows[0]) continue;
    try { await processEvent(evt); ok++; }
    catch (e) {
      failed++;
      // TrustPoint never redelivers — a TRANSIENT failure must not eat the event (audit
      // #11): release the claim so the next drain retries, up to the attempts cap.
      await db.query(`UPDATE trustpoint_webhook_events SET processed_at=NULL, process_error=$2 WHERE id=$1`, [evt.id, String(e && e.message).slice(0, 500)]).catch(() => {});
    }
  }
  return { ok, failed, drained: rows.length };
}

module.exports = { upsertDraw, reactDraw, reactReturned, upsertServiceOrder, hydrateProject, processEvent, drainInbox, archiveReport, linkedAppFor, linkFor, linkToSitewireIntake, _drawRow: drawRow };
