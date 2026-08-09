'use strict';
/**
 * TrustPoint IMPORT-TASK intake (physical-draw workflow phase 1, owner-directed 2026-07-24;
 * blueprint docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md §3).
 *
 * On a 'trustpoint'-routed file (Blue Lake physical), a draw the borrower submits in
 * Sitewire CANNOT be pushed to TrustPoint by machine (their public API has no draw
 * create/submit — verified twice). The workflow is therefore a coordinated HAND-OFF:
 * the moment PILOT first sees the submitted draw, it
 *   1) opens a `trustpoint_import` Workflow hand-off for the draw coordinator
 *      (sole active coordinator when there is exactly one, else the role inbox), and
 *   2) emails the coordinator + the draws@ desk ONE action email carrying a copy-ready
 *      per-line table (line name → requested $) so the manual TrustPoint entry takes
 *      minutes, with the standing instruction to enter it as a REGULAR workflow draw
 *      (TrustPoint's own "imported/historical" draws fire no webhooks — that would
 *      blind the phase-2 mirror).
 *
 * Idempotent + concurrency-safe: the sitewire_draws.tp_import_task_opened_at stamp is
 * claimed atomically (WHERE ... IS NULL), so overlapping reconcile passes can never
 * open two tasks or double-email for one draw. Best-effort throughout — a failure here
 * never breaks the reconcile mirror. GO-FORWARD by construction: callers only invoke
 * this from live inbound reactions (never from silent baselines of history).
 */

const db = require('../db');
const workflow = require('../lib/workflow');
const notify = require('../lib/notify');
const drawLabel = require('../lib/draw-label');   // "Draw 2" — the ONE way a draw is named in a subject

const usd = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Statuses that mean "the borrower actually submitted this draw" — drafting /
// pending_borrower draws are not ready to enter into TrustPoint yet.
const SUBMITTED_STATUSES = new Set(['inspecting', 'pending', 'pending_capital_partner', 'approved']);

/** The submitted per-line table for the email: [{ name, requested_cents }], media $0 gates skipped. */
async function drawLines(drawId) {
  const rows = (await db.query(
    `SELECT r.job_item_name, r.requested_cents, l.name AS link_name, l.is_media_item, l.sow_line_key
       FROM sitewire_draw_requests r
       LEFT JOIN sitewire_job_item_links l ON l.sitewire_job_item_id = r.sitewire_job_item_id
      WHERE r.sitewire_draw_id = $1
      ORDER BY r.sitewire_request_id`, [drawId])).rows;
  const lines = [];
  for (const r of rows) {
    const req = Number(r.requested_cents || 0);
    const isMedia = !!r.is_media_item || String(r.sow_line_key || '').indexOf('__media__') === 0;
    if (isMedia && req === 0) continue;      // photo/video gate placeholders — not money lines
    if (req === 0) continue;                 // $0 rider rows add noise to a manual-entry table
    lines.push({ name: r.job_item_name || r.link_name || 'Budget line', requested_cents: req });
  }
  return lines;
}

/**
 * Open the coordinator import task + email for a submitted draw on a trustpoint-routed
 * file. `platform` is passed by the caller (reconcile resolves it once per file) so this
 * module never re-resolves mid-poll. Returns { opened } / { skipped }. Never throws.
 */
async function maybeOpenImportTask(appId, { drawId, drawNumber, status, addrText, platform } = {}) {
  try {
    if (platform !== 'trustpoint') return { skipped: 'not_trustpoint' };
    if (!SUBMITTED_STATUSES.has(String(status || ''))) return { skipped: 'not_submitted' };

    // Cheap pre-check so ordinary re-polls don't open a transaction per draw.
    const seen = (await db.query(
      `SELECT tp_import_task_opened_at FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
    if (!seen) return { skipped: 'no_mirror_row' };
    if (seen.tp_import_task_opened_at) return { skipped: 'already_opened' };

    // Resolve everything failable BEFORE claiming (the draw-setup-notify C-9 lesson:
    // a claim taken before a failed resolution permanently strands the send/task).
    const lines = await drawLines(drawId);
    const total = lines.reduce((s, l) => s + l.requested_cents, 0);
    const nLabel = drawNumber == null ? '—' : drawNumber;

    // Route to the sole active draw coordinator when there is exactly one; otherwise land
    // the hand-off in the draw_coordinator ROLE inbox (workflow.js role-inbox semantics)
    // so it is never lost — unlike onFunded's draw_setup (informational), this task is
    // load-bearing: the draw does not exist in TrustPoint until a human enters it.
    let toStaffId = null;
    try {
      const coords = await workflow.candidatesForRole('draw_coordinator');
      if (coords.length === 1) toStaffId = coords[0].id;
    } catch (_) {}

    // Claim + task creation are ONE transaction: the stamp can never exist without its
    // workflow item (a post-claim insert failure rolls the claim back too), and two
    // overlapping polls serialize on the row lock — exactly one wins, the other sees
    // 0 rows and skips. Emails go out only after COMMIT (best-effort, never re-sent
    // for this draw because the stamp is durable).
    // The line table can be legitimately EMPTY on the first sight (the per-draw detail
    // read failed that poll) — say so instead of shipping a $0.00 table (audit #9).
    const noteLines = lines.length
      ? lines.slice(0, 12).map((l) => `${l.name}: ${usd(l.requested_cents)}`).join(' · ')
      : 'Line amounts are not mirrored yet — open the draw in Sitewire for the line-by-line figures.';
    // submitItem supersedes any live same-type hand-off on the file — if one exists, the
    // replaced draw may still be unentered; point the coordinator at the desk (audit #6).
    let supersedeNote = '';
    try {
      const live = await db.query(
        `SELECT 1 FROM workflow_items WHERE application_id=$1 AND submission_type='trustpoint_import' AND status IN ('open','in_progress') LIMIT 1`, [appId]);
      if (live.rows[0]) supersedeNote = ' This replaces an earlier entry task on this file — check the draw desk for any other submitted draw still to enter.';
    } catch (_) {}
    const client = await db.getClient();
    let item = null;
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        `UPDATE sitewire_draws SET tp_import_task_opened_at = now()
          WHERE sitewire_draw_id = $1 AND tp_import_task_opened_at IS NULL
          RETURNING sitewire_draw_id`, [drawId]);
      if (!claim.rows[0]) { await client.query('ROLLBACK'); return { skipped: 'already_opened' }; }
      item = await workflow.submitItem(client, {
        appId, submissionType: 'trustpoint_import', fromStaffId: null,
        toStaffId, toRole: 'draw_coordinator', priority: 1, auto: true,
        note: `Draw #${nLabel} (${usd(total)} requested) needs to be entered into TrustPoint as a REGULAR workflow draw — never their "imported/historical draw" option.${supersedeNote} ${noteLines}`.slice(0, 1000),
      });
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }

    // ONE action email: the coordinator (or the whole assigned team when no sole
    // coordinator exists) + the draws@ desk copy with the per-line table.
    const opts = {
      type: 'trustpoint_import',
      // The draw leads the subject; the title stops repeating the number inside the sentence.
      // A draw the platform never numbered carries no tag rather than a guessed one, so the
      // fallback title keeps saying what it always did.
      title: drawLabel.drawLabel(drawNumber) ? 'A draw needs to be entered into TrustPoint'
        : `Draw #${nLabel} needs to be entered into TrustPoint`,
      drawTag: drawLabel.drawLabel(drawNumber),
      body: `A draw was submitted for ${addrText || 'the property'} (${usd(total)} requested across ${lines.length} line${lines.length === 1 ? '' : 's'}). `
        + 'This file\'s draws are administered on TrustPoint — enter it there as a REGULAR workflow draw (never TrustPoint\'s "imported draw" option, which sends no updates back). '
        + 'The line-by-line amounts are in your Workflow item and the desk email.',
      badge: { text: 'Enter in TrustPoint', tone: 'gold' },
      applicationId: appId, link: '/internal/workflow', ctaLabel: 'Open my Workflow',
    };
    try {
      if (toStaffId) await notify.notifyStaff(toStaffId, opts);
      else await notify.notifyAppStaff(appId, opts);
    } catch (_) {}

    // Desk email (draws@) with the copy-ready table + per-file reply-to — mirrors the
    // request-draw desk pattern (borrower.js #68). Best-effort.
    try {
      const mail = require('../lib/email/catalog');
      const { fileReplyTo } = require('../lib/file-address');
      const row = (await db.query(
        `SELECT ys_loan_number, property_address->>'oneLine' AS addr FROM applications WHERE id=$1`, [appId])).rows[0] || {};
      await mail.deliver(
        mail.trustpointImport({
          drawNumber: nLabel, drawTag: drawLabel.drawLabel(drawNumber),
          propertyLabel: row.addr || addrText || null,
          loanNumber: row.ys_loan_number || null, lines, totalCents: total,
        }),
        ['draws@yscapgroup.com'], { replyTo: fileReplyTo(appId), applicationId: appId, type: 'trustpoint_import', audience: 'staff' });
    } catch (_) {}

    return { opened: true, itemId: item && item.id, lines: lines.length };
  } catch (e) {
    // The stamp+task transaction rolled back, so the stamp is still NULL — the reconcile
    // sweep (reconcileOne's trustpoint pass) retries on the next poll. Park a deduped
    // review row too, so a REPEATEDLY failing open is a visible card, never a silent
    // console line (never-silently-drop; phase-1 audit #3).
    console.warn('[sitewire] trustpoint-intake failed (the reconcile sweep will retry):', e && e.message);
    try {
      await require('./orchestrator').park({
        appId, dedupe: `tpimport:${drawId}`,
        reason: `sitewire_reconcile_draw_error: could not open the TrustPoint entry task for draw ${drawId} — ${String(e && e.message).slice(0, 160)}. It retries automatically each poll; if this card persists, open the task by hand from the Workflow screen.`,
      });
    } catch (_) {}
    return { skipped: 'error' };
  }
}

module.exports = { maybeOpenImportTask, drawLines, SUBMITTED_STATUSES, _usd: usd };
