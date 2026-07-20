'use strict';
/**
 * Sitewire draw desk (staff) + admin setup. Mounted at /api/sitewire.
 * Draw-desk actions require the `manage_draws` capability (Draw Coordinator / processor /
 * LO / admin); setup actions (rules, directory sync, manual push, settings) require
 * `platform_setup`. Every Sitewire write goes through the guarded orchestrator/client —
 * never a raw call from a route. Non-see-all staff are scoped to their assigned files.
 */
const express = require('express');
// safe-router forwards any async-handler rejection to the global JSON error middleware
// (fast generic 500/503) instead of hanging the request — Express 4 does not catch
// rejected promises from async handlers, and several draw-desk handlers await a DB read
// before their own try/catch (a transient DB error or an out-of-range :id would hang).
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const client = require('../sitewire/client');
const orchestrator = require('../sitewire/orchestrator');
const reconcile = require('../sitewire/reconcile');
const rollupMod = require('../sitewire/rollup');
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const T = require('../sitewire/transforms');
const rehab = require('../lib/rehab-budget');
const { sanitizeDateOnly } = require('../lib/fields'); // strict YYYY-MM-DD validation for date inputs
const notify = require('../lib/notify');
const { enqueueSitewirePush } = require('../sitewire/enqueue');
const { buildXlsx } = require('../lib/xlsx');
const mediaArchive = require('../sitewire/media-archive');
const drawReport = require('../sitewire/draw-report');
const storage = require('../lib/storage');
const { setMediaHeaders } = require('../lib/media-headers');
const { serveDocument } = require('../lib/serve-document');
const { computeRelease, waiverGate } = require('../sitewire/money');

// Resolve the retainage % for a file: per-file override on the link, else the global default.
// Clamped to [0,100] so a nonsensical setting can't distort the client-side net preview either.
async function retainagePctFor(appId) {
  try {
    const clamp = (n) => Math.min(100, Math.max(0, Number(n) || 0));
    const link = (await db.query(`SELECT retainage_pct FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
    if (link && link.retainage_pct != null) return clamp(link.retainage_pct);
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='retainage_pct'`)).rows[0];
    return clamp(s && s.value);
  } catch (_) { return 0; }
}
// Lien waivers are OFF by default. A specific PROJECT can turn them on (per-file override on the
// link), else the global `require_lien_waivers` setting applies — most projects don't use them.
async function lienGateEnabled(appId) {
  try {
    if (appId) {
      const link = (await db.query(`SELECT require_lien_waivers FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
      if (link && link.require_lien_waivers != null) return !!link.require_lien_waivers;
    }
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='require_lien_waivers'`)).rows[0];
    return !!(s && (s.value === true || s.value === 'true'));
  } catch (_) { return false; }
}

router.use(requireAuth, requireStaff);

// a funded file is past clear-to-close; a SOW change after CTC must net to zero
const phaseFor = (status) => (String(status) === 'funded' ? 'after_ctc' : 'before_ctc');
// applications.id / change_requests.id are UUIDs. A malformed value makes Postgres throw
// 22P02, and an async-handler rejection in Express 4 doesn't reach the error middleware —
// the request would hang. Guard the UUID params up front so bad input returns 404 (audit F1).
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

async function variancePct() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='variance_pct'`); const v = Number(r.rows[0] && r.rows[0].value); return Number.isFinite(v) && v >= 0 ? v : 10; } catch (_) { return 10; }
}
const buildReallocationCells = rollupMod.buildReallocationCells;

// scope helper: see_all_files -> everything; else only assigned files
function fileScope(req, alias, startIdx) {
  if (can(req.actor, 'see_all_files')) return { where: '', params: [] };
  return { where: ` AND ${assigneeExistsSql(alias, '$' + startIdx)}`, params: [req.actor.id] };
}
async function canSeeFile(req, appId) {
  if (!isUuid(appId)) return false; // malformed id can never own a file (audit F1 — avoid 22P02 hang)
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`, [appId, req.actor.id]);
  return r.rowCount > 0;
}

// ---- GET /api/sitewire/draws — desk dashboard (mirrored draws, scoped) ----
router.get('/draws', requirePermission('manage_draws'), async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    const rows = (await db.query(
      `SELECT d.sitewire_draw_id, d.application_id, d.number, d.status, d.total_requested_cents, d.total_approved_cents,
              d.submitted_at, d.approved_at, d.updated_at, d.pdf_src,
              a.ys_loan_number, a.property_address->>'oneLine' AS address,
              COALESCE(pl.lifecycle_state, 'active') AS lifecycle_state,
              (SELECT count(*) FROM draw_disbursements dd WHERE dd.sitewire_draw_id=d.sitewire_draw_id AND dd.funded_status='released') AS released_count
         FROM sitewire_draws d JOIN applications a ON a.id=d.application_id
         LEFT JOIN sitewire_property_links pl ON pl.application_id=d.application_id AND pl.matched_by='created'
        WHERE a.deleted_at IS NULL${sc.where}
        ORDER BY d.updated_at DESC NULLS LAST LIMIT 300`, sc.params)).rows;
    res.json({ draws: rows });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /api/sitewire/files/:id — one file's Sitewire state (link, draws, requests, ledger) ----
router.get('/files/:id', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const link = (await db.query(`SELECT * FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0] || null;
    const draws = (await db.query(`SELECT * FROM sitewire_draws WHERE application_id=$1 ORDER BY number DESC NULLS LAST`, [appId])).rows;
    const requests = (await db.query(
      `SELECT r.* FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id WHERE d.application_id=$1`, [appId])).rows;
    const ledger = (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    res.json({ link, draws, requests, ledger });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /api/sitewire/files/:id/findings/:drawId — pull full findings (photos + notes) ----
router.get('/files/:id/findings/:drawId', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  // the draw MUST be one PILOT mirrored for THIS file (only-ours + IDOR guard) — never
  // fetch an arbitrary Sitewire draw id the caller supplies.
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [req.params.drawId, req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  try {
    const findings = await reconcile.fetchDrawFindings(req.params.drawId);
    res.json(findings);
  } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- Durable inspector media (phase 2a): pull Sitewire's EXPIRING photo/video/PDF URLs into PILOT
// storage so the gallery + branded reports never break. Best-effort + idempotent. manage_draws + IDOR. ----
router.post('/files/:id/draws/:drawId/archive-media', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [req.params.drawId, req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  try {
    const r = await mediaArchive.archiveDrawMedia(req.params.id, req.params.drawId);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: 'Could not archive the inspection media — please try again.' }); }
});

// how many media are already archived for a draw (for the gallery's "✓ archived" indicator).
router.get('/files/:id/draws/:drawId/archived-media', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const rows = await mediaArchive.archivedMediaFor(req.params.id, req.params.drawId);
    res.json({ count: rows.length, media: rows });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---- GET /files/:id/draws/:drawId/media/:mediaId — stream a DURABLE inspection photo/video (staff) ----
// PILOT's own stored copy, so the staff gallery never breaks when Sitewire's pre-signed link expires.
// manage_draws + canSeeFile + the media must belong to this file's draw (IDOR).
router.get('/files/:id/draws/:drawId/media/:mediaId', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId) || !/^\d{1,18}$/.test(String(req.params.mediaId))) return res.status(404).end();
  if (!(await canSeeFile(req, req.params.id))) return res.status(404).end();
  const m = (await db.query(
    `SELECT storage_ref, content_type, kind FROM draw_media WHERE id=$1 AND application_id=$2 AND sitewire_draw_id=$3 AND kind IN ('image','video')`,
    [req.params.mediaId, req.params.id, req.params.drawId])).rows[0];
  if (!m || !m.storage_ref) return res.status(404).end();
  let buf; try { buf = await storage.read(m.storage_ref); } catch (_) { return res.status(404).end(); }
  if (!buf || !buf.length) return res.status(404).end();
  setMediaHeaders(res, m.content_type);   // safe-type allowlist + sandbox CSP (never serve a dangerous type inline)
  return res.end(buf);
});

// ---- PILOT-branded inspection reports (phase 2b) ----
// Turn the persisted inspector findings + the DURABLE archived photos into a branded PDF the coordinator
// can file and the borrower can see. mode=staff (full: fee/net + GPS) | mode=borrower (borrower-safe: no
// partner name, no fee/net, no GPS). Idempotent + cached by a version hash: an unchanged draw reuses the
// stored `documents` row; a change mints a fresh one and supersedes the old. manage_draws + canSeeFile +
// (per-draw) IDOR draw-owns-file.
async function generateAndServeReport(req, res, { sitewireDrawId, scope }) {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const mode = req.query.mode === 'borrower' ? 'borrower' : 'staff';
  try {
    // Shared load -> build -> store+supersede -> cache-by-version (draw-report.js); the deliver path pre-builds
    // via the same helper, so an already-delivered draw's report streams straight from the cached row here.
    const r = await drawReport.buildOrGetReportDoc(appId, { sitewireDrawId, scope, mode });
    if (!r || !r.doc) {
      return res.status(404).json({ error: 'No draw data to report on yet — start a draw and deliver findings first.' });
    }
    return serveDocument(res, r.doc, { inline: true });
  } catch (e) { res.status(500).json({ error: 'Could not build the report — please try again.' }); }
}
// per-draw report
router.get('/files/:id/draws/:drawId/report', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [req.params.drawId, req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  return generateAndServeReport(req, res, { sitewireDrawId: req.params.drawId, scope: 'draw' });
});
// whole-project report (cumulative across all draws)
router.get('/files/:id/report', requirePermission('manage_draws'), async (req, res) => {
  return generateAndServeReport(req, res, { sitewireDrawId: null, scope: 'project' });
});

// ---- POST /api/sitewire/files/:id/reconcile — pull now ----
router.post('/files/:id/reconcile', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  try { res.json(await reconcile.reconcileOne(req.params.id)); } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- POST /api/sitewire/files/:id/lifecycle — finish the draw process / mark paid off / re-open ----
// The Draw Coordinator closes a project out from the desk. Records the PILOT-side lifecycle state and (when
// writes are on) deactivates the property in Sitewire so no further draws can be submitted. manage_draws +
// canSeeFile + go-forward-only (only a PILOT-managed file can be closed out — enforced in the orchestrator).
router.post('/files/:id/lifecycle', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const state = String((req.body && req.body.state) || '').trim();
  if (!orchestrator.LIFECYCLE_STATES.has(state)) return res.status(400).json({ error: 'Pick a valid state: finished, paid_off, or active.' });
  try {
    const r = await orchestrator.setPropertyLifecycle(appId, state, req.actor && req.actor.id);
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire yet — start the draw process first.' });
    if (r.error === 'invalid_state') return res.status(400).json({ error: 'Pick a valid state: finished, paid_off, or active.' });
    if (r.parked) return res.status(502).json({ error: 'Couldn’t sync to Sitewire — a review was opened. Please try again shortly.', parked: r.parked });
    res.json(r);
  } catch (e) { res.status(502).json({ error: 'Couldn’t update the project status right now — please try again shortly.' }); }
});

// ---- POST /api/sitewire/files/:id/reset-draw — delete/unlink the property + start over (re-push) ----
// Owner-directed 2026-07-20 (a testing control): Sitewire has no delete API, so this deactivates the property
// there and unlinks it here (tombstoning its id so the re-push skips only this copy), clearing the mirrored
// draw rows so the "Start the draw process" card — with all push options — reappears. The money ledger is
// KEPT. manage_draws + canSeeFile + go-forward-only (only a PILOT-created file can be reset).
router.post('/files/:id/reset-draw', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await orchestrator.resetDrawSetup(appId, req.actor && req.actor.id);
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire — there’s nothing to reset.' });
    res.json(r);
  } catch (e) { console.warn('[sitewire] reset-draw error:', e && e.message); res.status(500).json({ error: 'Couldn’t reset the draw setup right now — please try again shortly.' }); }
});

// ---- GET /files/:id/notifications — the DRAW file's email/notification center (staff) ----
// The draw coordinator's per-file email section: every DRAW-RELATED notification PILOT sent about this file
// (who it went to, when, delivery status, full content) plus the borrower's email REPLIES we've received.
// Scoped to draw items ONLY (type draw%/sow_%) so it stays the coordinator's draw inbox, not the whole file's
// notification history. Sitewire does not expose the emails IT sends, so this is PILOT's own trail.
// manage_draws + canSeeFile.
router.get('/files/:id/notifications', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const sent = (await db.query(
      `SELECT n.id, n.recipient_kind, n.type, n.title, n.body, n.link, n.read_at, n.email_status, n.emailed_at, n.created_at,
              COALESCE(s.full_name, NULLIF(TRIM(COALESCE(b.first_name,'') || ' ' || COALESCE(b.last_name,'')), '')) AS recipient_name,
              COALESCE(s.email, b.email) AS recipient_email,
              se.id IS NOT NULL AS has_full_email,
              COALESCE(array_length(se.to_emails,1),0) AS recipient_count,
              COALESCE(jsonb_array_length(se.attachments),0) AS attachment_count
         FROM notifications n
         LEFT JOIN staff_users s ON s.id = n.staff_id
         LEFT JOIN borrowers b ON b.id = n.borrower_id
         LEFT JOIN LATERAL (SELECT id, to_emails, attachments FROM sent_emails se2 WHERE se2.notification_id=n.id ORDER BY se2.created_at DESC LIMIT 1) se ON true
        WHERE n.application_id = $1 AND (n.type LIKE 'draw%' OR n.type LIKE 'sow_%')
        ORDER BY n.created_at DESC
        LIMIT 300`, [appId])).rows;
    let replies = [];
    try {
      replies = (await db.query(
        `SELECT id, from_email, subject, forwarded_count, status, created_at
           FROM inbound_file_emails WHERE application_id=$1 ORDER BY created_at DESC LIMIT 100`, [appId])).rows;
    } catch (_) { /* inbound table optional */ }
    res.json({ sent, replies });
  } catch (e) { console.warn('[sitewire] notifications route error:', e && e.message); res.status(500).json({ error: 'Could not load the notifications for this file.' }); }
});

// ---- GET /files/:id/messages/:notificationId — the FULL rendered email (design + recipients + attachments) ----
// Opens a draw notification in full: the exact branded HTML we sent, every recipient, the reply-to, and the
// attachment list. Go-forward: only messages sent after the capture shipped have a stored copy (has_full_email).
// manage_draws + canSeeFile + the notification must belong to THIS file (IDOR).
router.get('/files/:id/messages/:notificationId', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.notificationId))) return res.status(404).json({ error: 'not found' });
  try {
    const e = (await db.query(
      `SELECT id, subject, from_email, to_emails, reply_to, html, body_text, attachments, status, created_at, audience, recipient_kind
         FROM sent_emails WHERE notification_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [req.params.notificationId, appId])).rows[0];
    if (!e) return res.status(404).json({ error: 'no_capture' });
    // never expose the storage ref to the client — attachments are downloaded by INDEX through the route below.
    const attachments = (Array.isArray(e.attachments) ? e.attachments : []).map((a, i) => ({ index: i, filename: a.filename, content_type: a.content_type, size: a.size, downloadable: !!a.storage_ref }));
    res.json({ id: e.id, subject: e.subject, from: e.from_email, to: e.to_emails || [], reply_to: e.reply_to, html: e.html, text: e.body_text, attachments, status: e.status, created_at: e.created_at, audience: e.audience });
  } catch (err) { console.warn('[sitewire] message route error:', err && err.message); res.status(500).json({ error: 'Could not open this message.' }); }
});

// ---- GET /files/:id/messages/:notificationId/attachments/:idx — stream a captured attachment ----
router.get('/files/:id/messages/:notificationId/attachments/:idx', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.notificationId)) || !/^\d{1,3}$/.test(String(req.params.idx))) return res.status(404).json({ error: 'not found' });
  try {
    const e = (await db.query(
      `SELECT attachments FROM sent_emails WHERE notification_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [req.params.notificationId, appId])).rows[0];
    const a = e && Array.isArray(e.attachments) ? e.attachments[Number(req.params.idx)] : null;
    if (!a || !a.storage_ref) return res.status(404).json({ error: 'attachment not found' });
    const storage = require('../lib/storage');
    let buf;
    try { buf = await storage.read(a.storage_ref); } catch (_) { buf = null; } // a missing blob → 404, not a 500
    if (!buf) return res.status(404).json({ error: 'attachment bytes missing' });
    res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename || 'attachment').replace(/[^\w.\- ]+/g, '_')}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'Could not download this attachment.' }); }
});

// ---- POST /files/:id/messages/reply — the coordinator sends/relies to the borrower from the draw box ----
// A direct borrower message from the draw desk: emails the borrower (borrower-safe scrub applies), logs the
// notification, and captures the sent email so it appears right back in this thread. The borrower's reply
// forwards to the team (file+<appId>@ reply-to) and lands in "Replies received". manage_draws + canSeeFile.
router.post('/files/:id/messages/reply', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Type a message to send.' });
  if (body.length > 8000) return res.status(400).json({ error: 'That message is too long.' });
  const subject = req.body && req.body.subject ? String(req.body.subject).slice(0, 200) : 'A message about your draw';
  try {
    const ids = await notify.notifyAppBorrowers(appId, {
      type: 'draw_message', major: true,
      title: subject, body,
      badge: { text: 'From your loan team', tone: 'teal' },
      applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws',
    });
    const sent = (ids || []).filter(Boolean).length;
    if (!sent) return res.status(409).json({ error: 'This file has no borrower to message.' });
    res.json({ ok: true, sent });
  } catch (e) { console.warn('[sitewire] reply route error:', e && e.message); res.status(500).json({ error: 'Could not send your message — please try again.' }); }
});

// ---- GET /files/:id/borrower-status — Sitewire's borrower-invite state (live read) ----
router.get('/files/:id/borrower-status', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await orchestrator.getBorrowerInviteStatus(req.params.id)); }
  catch (e) { res.status(500).json({ error: 'Could not read the borrower status from Sitewire right now.' }); }
});

// ---- GET /files/:id/quick-notify-statuses — Sitewire's pipeline status labels ----
router.get('/files/:id/quick-notify-statuses', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json({ statuses: await orchestrator.listQuickNotifyStatuses() }); }
  catch (e) { res.status(500).json({ error: 'Could not load the pipeline statuses.' }); }
});

// ---- POST /files/:id/draws/:drawId/quick-notify — set a draw's Sitewire pipeline status ----
router.post('/files/:id/draws/:drawId/quick-notify', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(String(drawId))) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await orchestrator.setDrawQuickNotify(appId, drawId, req.body ? req.body.status_id : null);
    if (r.error === 'draw_not_on_file') return res.status(404).json({ error: 'That draw is not on this file.' });
    if (r.error === 'writes_off') return res.status(409).json({ error: 'Sitewire writing is off — turn it on to change the pipeline status.' });
    if (r.error === 'bad_status') return res.status(400).json({ error: 'Pick a valid pipeline status.' });
    if (r.error === 'clear_unsupported') return res.status(400).json({ error: 'Pick a pipeline status — it can be moved between statuses but not cleared back to none.' });
    if (r.error === 'transient') return res.status(502).json({ error: 'Sitewire is briefly unavailable — please try again shortly.' });
    if (r.error) return res.status(502).json({ error: 'Could not update the pipeline status in Sitewire — please try again.' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Could not update the pipeline status right now.' }); }
});

// ---- GET /files/:id/sitewire-documents — the Sitewire property's own documents (live read) ----
router.get('/files/:id/sitewire-documents', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await orchestrator.getSitewireDocuments(req.params.id)); }
  catch (e) { res.status(500).json({ error: 'Could not load the Sitewire documents.' }); }
});

// ---- POST /files/:id/resend-invite — (re)send Sitewire's borrower invite ----
router.post('/files/:id/resend-invite', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await orchestrator.resendBorrowerInvite(req.params.id);
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire yet — start the draw process first.' });
    if (r.error === 'no_borrower_email') return res.status(409).json({ error: 'This file has no borrower email to invite.' });
    if (r.error === 'writes_off') return res.status(409).json({ error: 'Sitewire writing is off — turn it on to send the invite.' });
    if (r.error === 'transient') return res.status(502).json({ error: 'Sitewire is briefly unavailable — please try again shortly.' });
    if (r.error) return res.status(502).json({ error: 'Couldn’t send the invite through Sitewire — please try again shortly.' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Couldn’t send the invite right now — please try again shortly.' }); }
});

// ---- POST /api/sitewire/files/:id/push — manual birth push (admin/setup, guarded) ----
router.post('/files/:id/push', requirePermission('platform_setup'), async (req, res) => {
  // scope like every other per-file route — platform_setup alone (e.g. the software_setup persona) must
  // not be able to birth a file it has no relationship to into Sitewire.
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await orchestrator.pushFile(req.params.id, { force: !!req.body.force })); }
  catch (e) { if (e.status === 422) return res.status(422).json({ error: e.message }); console.warn('[sitewire] push error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- GET /files/:id/draw-setup — what the coordinator sees before starting the draw process ----
// Everything that WILL be pushed + the resolved inspection method/fee + whether the prerequisites
// are met + any errors already parked for manual review. Read-only.
router.get('/files/:id/draw-setup', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const a = await orchestrator.loadFile(appId);
    if (!a) return res.status(404).json({ error: 'file not found' });
    const link = await orchestrator.getLink(appId);
    const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
    const cp = await orchestrator.resolveCapitalPartnerId(a.lender);
    // resolve by the note-buyer label first so a "handled externally" partner is recognized even when
    // it isn't in the Sitewire directory (external partners usually aren't).
    const rule = await orchestrator.resolveRule(a.lender, cp.id, program);
    const insp = orchestrator.resolveInspection(link, rule);
    const budgetDollars = await rehab.requiredRehabBudget(appId).catch(() => null);
    const addr = T.addressForSitewire(a.property_address);
    const addressReady = !!(addr && addr.street && addr.city && addr.state && addr.zip);
    const openReviews = Number((await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE application_id=$1 AND field_key='sitewire' AND status='open'`, [appId])).rows[0].c) || 0;
    const prereqs = {
      funded: a.status === 'funded',
      loan_number: !!a.ys_loan_number,
      budget: budgetDollars != null && Number(budgetDollars) > 0,
      scope_of_work: !!(a.sow_payload && a.sow_payload.state),
      address: addressReady,
      capital_partner: !!cp.id,
    };
    const cpName = cp.id ? (await db.query(`SELECT name FROM sitewire_capital_partners WHERE sitewire_id=$1`, [cp.id])).rows[0] : null;
    // Unit count preview (owner-directed 2026-07-20 — "use physical building units"). The count PUSHED to
    // Sitewire = the physical building count = the LARGER of the file's unit count and the Scope of Work's.
    // A disagreement is surfaced (not an error): units with no work simply carry no budget lines.
    const hasSow = !!(a.sow_payload && a.sow_payload.state);
    const sowUnits = M.unitCount(a.sow_payload && a.sow_payload.state);
    const fileUnits = (a.units != null && Number(a.units) > 0) ? Number(a.units) : 0;
    const physicalUnits = Math.max(1, fileUnits, sowUnits);
    res.json({
      started: !!(link && link.sitewire_property_id),
      state: link ? link.state : null,
      started_at: link ? link.draw_setup_started_at : null,
      program,
      capital_partner: { id: cp.id != null ? Number(cp.id) : null, name: (cpName && cpName.name) || null, candidate: cp.candidate != null ? Number(cp.candidate) : null, candidate_name: cp.candidateName || null, ambiguous: !!cp.ambiguous },
      inspection: {
        method: insp.method, fee_kind: insp.feeKind, fee_cents: Number(insp.feeCents),
        rule_fee_cents: Number(insp.ruleFeeCents), fee_overridden: !!insp.overridden,
        allow_virtual: insp.allowVirtual, allow_physical: insp.allowPhysical,
        can_switch: insp.allowVirtual && insp.allowPhysical,
        default_method: (rule && rule.inspection_method) || 'mobile',
        chosen_override: link ? link.inspection_method : null,
        fee_virtual_cents: rule ? Number(rule.fee_cents_virtual) : null,
        fee_physical_cents: rule && rule.fee_cents_physical != null ? Number(rule.fee_cents_physical) : null,
      },
      requires: { sitewire_inspector: !!(rule && rule.require_sitewire_inspector), capital_partner_approval: !!(rule && rule.require_capital_partner_approval) },
      // disagree only once a SOW exists (before that, sowUnits defaults to 1 and would falsely flag)
      units: { file: fileUnits || null, sow: hasSow ? sowUnits : null, physical: physicalUnits, disagree: hasSow && fileUnits > 0 && fileUnits !== sowUnits },
      // handled externally = this capital partner runs draws in its own system; PILOT never pushes it.
      handled_externally: !!(rule && rule.handled_externally),
      prereqs,
      open_reviews: openReviews,
      can_start: !(rule && rule.handled_externally) && Object.values(prereqs).every(Boolean),
      switches: { enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun },
    });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /files/:id/start-draw — the draw coordinator STARTS the draw lifecycle ----
// Picks/confirms the inspection method (within what the rule allows), records who started it, and
// pushes the property + budget + Scope of Work + fees to Sitewire (read-after-write + park-on-error
// via the guarded orchestrator). This is the button that begins everything after funding.
router.post('/files/:id/start-draw', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const a = await orchestrator.loadFile(appId);
    if (!a) return res.status(404).json({ error: 'file not found' });
    if (a.status !== 'funded') return res.status(409).json({ error: 'the draw process starts once the loan is funded' });
    const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
    const cp = await orchestrator.resolveCapitalPartnerId(a.lender);
    const rule = await orchestrator.resolveRule(a.lender, cp.id, program);
    // HANDLED EXTERNALLY: this capital partner runs its draws in its own system — the file is never
    // pushed to Sitewire, so there is nothing to start here (never guess around the owner's rule).
    if (rule && rule.handled_externally) {
      return res.status(422).json({ error: 'This capital partner is handled externally — its draws run in the partner\'s own system and are not pushed to Sitewire.' });
    }
    // validate a coordinator-chosen method against what the file's rule allows (never guess)
    const body = req.body || {};
    let chosen = null;
    if (body.inspection_method != null) {
      chosen = body.inspection_method === 'traditional' ? 'traditional' : body.inspection_method === 'mobile' ? 'mobile' : null;
      if (!chosen) return res.status(400).json({ error: 'inspection_method must be mobile (virtual) or traditional (physical)' });
      if (rule) {
        if (chosen === 'mobile' && rule.allow_virtual === false) return res.status(422).json({ error: 'virtual inspection is not allowed for this program/partner' });
        if (chosen === 'traditional' && rule.allow_physical === false) return res.status(422).json({ error: 'on-site inspection is not allowed for this program/partner' });
      }
    }
    // The coordinator may set a per-file draw FEE (integer cents), overriding the rule's fee for this
    // file. A fee EQUAL to the chosen method's rule fee clears the override (the rule stays authoritative);
    // a bad/blank value leaves the fee untouched. Never guess — reject an out-of-range amount up front.
    let feeOverride; // undefined = don't touch the stored override
    if (body.fee_cents != null && body.fee_cents !== '') {
      const fc = Math.round(Number(body.fee_cents));
      if (!Number.isFinite(fc) || fc < 0 || fc > 10000000) return res.status(400).json({ error: 'The draw fee must be a dollar amount between $0 and $100,000.' });
      // Compare against the rule fee for the file's EFFECTIVE method — the coordinator's new pick, else
      // the already-stored per-file method, else the rule default — so "fee == default → clear override"
      // matches what resolveInspection will actually charge (never the wrong method's fee).
      const existingLink = await orchestrator.getLink(appId);
      const methodForFee = chosen || (existingLink && existingLink.inspection_method) || (rule && rule.inspection_method) || 'mobile';
      const ruleFee = rule ? (methodForFee === 'traditional' ? (rule.fee_cents_physical != null ? Number(rule.fee_cents_physical) : Number(rule.fee_cents_virtual)) : Number(rule.fee_cents_virtual)) : 29900;
      feeOverride = (fc === Number(ruleFee)) ? null : fc;
    }
    // ensure a link row exists to carry the coordinator's choice + who/when started
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, inspection_method, draw_setup_started_at, draw_setup_started_by)
       VALUES ($1,'created','pending',$2,now(),$3)
       ON CONFLICT (application_id) DO UPDATE SET inspection_method=COALESCE($2, sitewire_property_links.inspection_method),
         draw_setup_started_at=COALESCE(sitewire_property_links.draw_setup_started_at, now()), draw_setup_started_by=COALESCE(sitewire_property_links.draw_setup_started_by, $3), updated_at=now()`,
      [appId, chosen, req.actor.id]);
    // apply the fee override separately so we can CLEAR it (COALESCE in the upsert can't express "set to null")
    if (feeOverride !== undefined) {
      await db.query(`UPDATE sitewire_property_links SET fee_cents_override=$2, updated_at=now() WHERE application_id=$1`, [appId, feeOverride]);
      await orchestrator.journal({ appId, entity: 'settings', field: 'draw_fee_cents', newValue: feeOverride == null ? '(rule default)' : String(feeOverride), source: 'coordinator_start', changed: true }).catch(() => {});
    }
    // Record the draw-start as a visible team notification so it shows in the file's Draw messages box
    // ("when the draw is being pushed / registered"). Fires once per Start; best-effort.
    notify.notifyAppStaff(appId, {
      type: 'draw_started', title: 'Draw process started',
      body: `The draw process was started for this file — property, construction budget, Scope of Work and fees ${cfg.sitewireEnabled ? 'were pushed to Sitewire.' : 'will push to Sitewire once it is turned on.'}`,
      badge: { text: 'Draw started', tone: 'teal' }, applicationId: appId, link: `/internal/app/${appId}/draws`,
      // Owner-directed 2026-07-20: a confirmation of an action the coordinator
      // just took is IN-APP ONLY — no whole-team email. It shows on the draw desk.
      inAppOnly: true,
    }).catch(() => {});
    // push everything now (guarded). When Sitewire is off, the link row above (draw_setup_started_at)
    // is the durable birth record — the worker's stranded-birth backfill enqueues the push the moment
    // the switch is turned on, so nothing is lost while staged off.
    if (!cfg.sitewireEnabled) {
      return res.json({ ok: true, started: true, pushed: false, note: 'Draw setup recorded. Sitewire is currently off — it will push automatically when turned on.' });
    }
    // Push now for immediate read-after-write feedback. A guard failure comes back as
    // { parked } (handled by the coordinator's review list). A TRANSIENT throw (network /
    // circuit) must not be lost — enqueue a durable retry (the worker drains it) so the
    // coordinator's Start is as reliable as the borrower's request-a-draw path (audit L1).
    try {
      const result = await orchestrator.pushFile(appId, {});
      return res.json({ ok: true, started: true, result });
    } catch (e) {
      await enqueueSitewirePush(appId, 'push_file').catch(() => {});
      return res.status(202).json({ ok: true, started: true, queued: true, note: 'Draw setup saved. Sitewire is briefly unavailable — the push will retry automatically.' });
    }
  } catch (e) { if (e.status === 422) return res.status(422).json({ error: e.message }); console.warn('[sitewire] start-draw error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /api/sitewire/requests/:reqId/approve — set approved_cents on a draw line ----
router.post('/requests/:reqId/approve', requirePermission('manage_draws'), async (req, res) => {
  if (!cfg.sitewireEnabled || !cfg.sitewireOutboundEnabled) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const reqId = req.params.reqId;
  if (!/^\d+$/.test(reqId)) return res.status(404).json({ error: 'request not found' });
  const approvedCents = Math.round(Number(req.body.approved_cents));
  const lenderComments = req.body.lender_comments || undefined;
  if (!Number.isFinite(approvedCents) || approvedCents < 0) return res.status(400).json({ error: 'approved_cents must be a non-negative whole number of cents' });
  // scope: the request must belong to a file the actor can see
  const own = (await db.query(
    `SELECT r.sitewire_request_id, r.requested_cents, d.application_id FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id WHERE r.sitewire_request_id=$1`, [reqId])).rows[0];
  if (!own || !(await canSeeFile(req, own.application_id))) return res.status(403).json({ error: 'forbidden' });
  // G-APPRV: never exceed requested without an explicit override
  if (approvedCents > own.requested_cents && !req.body.override) {
    return res.status(422).json({ error: `approved ${T.usd(approvedCents)} exceeds requested ${T.usd(own.requested_cents)} — pass override:true to allow` });
  }
  try {
    await orchestrator.circuitCheck(1);
    const body = { approved_cents: approvedCents };
    if (lenderComments) body.lender_comments = lenderComments;
    const r = await client.updateRequest(reqId, body);
    if (!(r && r.__dryrun)) {
      // read-after-write + mirror update
      let saved = approvedCents;
      try { const fresh = await client.getRequest(reqId); if (fresh && fresh.approved_cents != null) saved = fresh.approved_cents; } catch (_) {}
      await db.query(`UPDATE sitewire_draw_requests SET approved_cents=$2, lender_comments=COALESCE($3,lender_comments), updated_at=now() WHERE sitewire_request_id=$1`, [reqId, saved, lenderComments || null]);
      await orchestrator.journal({ appId: own.application_id, entity: 'request', entityId: Number(reqId), field: 'approved_cents', newValue: approvedCents, source: 'push' });
      return res.json({ ok: true, approved_cents: saved });
    }
    res.json({ dryrun: true, approved_cents: approvedCents });
  } catch (e) {
    // A genuine Sitewire refusal (422 bad value / 403 not authorized) shows its specific reason and is NOT
    // parked for retry — retrying won't change a "no". Matches the draw-transition route's 422/403 handling.
    if (e.status === 422 || e.status === 403) return res.status(e.status).json({ error: `Sitewire ${e.status === 403 ? 'refused this approval' : 'rejected'}: ${JSON.stringify(e.body || {}).slice(0, 200)}` });
    // G1: a TRANSIENT/outage failure (5xx, network, circuit open, auth blip) must never silently drop a
    // money decision if the coordinator walks away — capture the intended approval as a retryable review
    // row, then return a clean, generic 502 (never the raw internal error).
    if (e.retryable || e.code === 'SITEWIRE_CIRCUIT_OPEN' || (e.status >= 500 && e.status <= 599)) {
      try { await orchestrator.park({ appId: own.application_id, dedupe: `approve:${reqId}`, reason: `sitewire_approve_failed: could not set the approved amount ${T.usd(approvedCents)} on draw line ${reqId} — Sitewire was briefly unavailable. Retry when it's back.`, current: String(approvedCents) }); } catch (_) {}
      return res.status(502).json({ error: 'Sitewire is briefly unavailable — we saved this approval to retry. Please try again in a moment.' });
    }
    res.status(502).json({ error: 'Could not save this approval to Sitewire — please try again.' });
  }
});

// ---- POST /api/sitewire/draws/:drawId/:action — approve / amend / reopen ----
router.post('/draws/:drawId/:action', requirePermission('manage_draws'), async (req, res) => {
  if (!cfg.sitewireEnabled || !cfg.sitewireOutboundEnabled) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const { drawId, action } = req.params;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!client.DRAW_TRANSITIONS.has(action)) return res.status(400).json({ error: 'action must be approve, amend, or reopen' });
  const own = (await db.query(`SELECT application_id FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
  if (!own || !(await canSeeFile(req, own.application_id))) return res.status(403).json({ error: 'forbidden' });
  try {
    await orchestrator.circuitCheck(1);
    const r = await client.drawTransition(drawId, action);
    if (!(r && r.__dryrun)) {
      await orchestrator.journal({ appId: own.application_id, entity: 'draw', entityId: Number(drawId), field: action, newValue: r && r.status, source: 'push' });
      await reconcile.reconcileOne(own.application_id).catch(() => {});
    }
    res.json({ ok: true, status: r && r.status });
  } catch (e) {
    if (e.status === 422 || e.status === 403) return res.status(e.status).json({ error: `Sitewire ${action} refused: ${JSON.stringify(e.body || {}).slice(0, 200)}` });
    // G1: a TRANSIENT/outage failure must not silently drop the transition — park it (retryable) so the
    // coordinator's ${action} isn't lost, then return a clean generic 502 (never the raw internal error).
    if (e.retryable || e.code === 'SITEWIRE_CIRCUIT_OPEN' || (e.status >= 500 && e.status <= 599)) {
      try { await orchestrator.park({ appId: own.application_id, dedupe: `draw${action}:${drawId}`, reason: `sitewire_draw_transition_failed: could not ${action} draw ${drawId} — Sitewire was briefly unavailable. Retry when it's back.` }); } catch (_) {}
      return res.status(502).json({ error: 'Sitewire is briefly unavailable — we saved this for retry. Please try again in a moment.' });
    }
    res.status(502).json({ error: `Could not ${action} this draw in Sitewire — please try again.` });
  }
});

// ---- POST /api/sitewire/disbursements — record a release in OUR ledger (net = approved - fee) ----
router.post('/disbursements', requirePermission('manage_draws'), async (req, res) => {
  const { application_id, sitewire_draw_id } = req.body;
  // ownership FIRST (never do work for a file the actor can't see), then validate the money —
  // a NaN/garbage amount must 400, never be coerced to $0 and recorded (audit E-NAN-MONEY-DISB).
  if (!application_id || !(await canSeeFile(req, application_id))) return res.status(403).json({ error: 'forbidden' });
  const approvedRaw = Number(req.body.approved_cents), feeRaw = Number(req.body.fee_cents);
  if (!Number.isFinite(approvedRaw) || approvedRaw < 0 || !Number.isFinite(feeRaw) || feeRaw < 0) {
    return res.status(400).json({ error: 'approved_cents and fee_cents must be non-negative whole numbers of cents' });
  }
  const approved = Math.round(approvedRaw);
  const fee = Math.round(feeRaw);
  const feeKind = ['virtual', 'physical'].includes(req.body.fee_kind) ? req.body.fee_kind : null;
  // Validate a supplied date up front — a malformed value hitting the `date` column throws Postgres 22007;
  // reject it as a clean 400 instead. Blank/absent = no date (allowed).
  let releaseDate = req.body.release_date == null || req.body.release_date === '' ? null : sanitizeDateOnly(req.body.release_date);
  if (req.body.release_date && !releaseDate) return res.status(400).json({ error: 'The release date must be a valid calendar date (YYYY-MM-DD).' });
  const fundedStatus = ['pending', 'released', 'held'].includes(req.body.funded_status) ? req.body.funded_status : 'pending';
  // A draw release MUST name its draw (audit F-2 — a deliberate money-route change). A release with no draw
  // id left sitewire_draw_id NULL, which (a) forced the overdue monitor into an over-broad NULL-match
  // suppression that silenced genuinely-overdue OTHER draws on a rare multi-draw file, and (b) let the
  // lien-waiver gate be side-stepped. Every kind='draw' disbursement now binds to exactly ONE draw on this
  // file, so the monitor can match a release to its finding precisely. (Retainage-release rows are a
  // separate route/kind with no draw id — unaffected.)
  if (sitewire_draw_id == null || sitewire_draw_id === '') return res.status(400).json({ error: 'Select which draw this release is for.' });
  if (!/^\d+$/.test(String(sitewire_draw_id))) return res.status(400).json({ error: 'invalid draw id' });
  // it must belong to THIS file (never store a draw id from another file — the lien gate reads that draw's waivers).
  const own = (await db.query(`SELECT total_approved_cents FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [sitewire_draw_id, application_id])).rows[0];
  if (!own) return res.status(400).json({ error: 'that draw is not on this file' });
  const drawId = sitewire_draw_id;
  // M1: don't record a release larger than what the lender actually approved on this draw (unless overridden) —
  // the ledger (and retainage) should never exceed the real approved figure.
  const drawApproved = Number(own.total_approved_cents) || 0;
  if (drawApproved > 0 && approved > drawApproved && !req.body.override) {
    return res.status(422).json({ error: `${T.usd(approved)} is more than the ${T.usd(drawApproved)} approved on this draw — pass override:true to record it anyway.` });
  }
  // H1: a draw is released once — block a duplicate ledger row up front (the db/148 unique index is the
  // belt-and-suspenders). A duplicate would double-count into the retainage pool.
  const dup = await db.query(`SELECT 1 FROM draw_disbursements WHERE sitewire_draw_id=$1 AND kind='draw'`, [drawId]);
  if (dup.rowCount) return res.status(409).json({ error: 'A release is already recorded for this draw — correct the existing entry instead of adding another.' });
  try {
    // retainage: hold a % of the approved amount; net = approved − fee − retainage held
    const pct = await retainagePctFor(application_id);
    const split = computeRelease({ approvedCents: approved, feeCents: fee, retainagePct: pct });
    if (!split.ok) return res.status(422).json({ error: split.violation });
    // lien-waiver gate: the release already named its draw (required above), so we check exactly that draw's
    // waivers. Block the release if any required waiver is still outstanding (never guessed).
    if (fundedStatus === 'released' && await lienGateEnabled(application_id)) {
      const waivers = (await db.query(`SELECT status, tier, party_name, kind FROM draw_lien_waivers WHERE sitewire_draw_id=$1`, [drawId])).rows;
      const gate = waiverGate(waivers, { enabled: true });
      if (!gate.ok) return res.status(409).json({ error: `Lien waivers still outstanding: ${gate.missing.join('; ')}. Mark them received or waived before releasing.`, missing: gate.missing });
    }
    const row = (await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, fee_kind, retainage_held_cents, net_release_cents, release_date, funded_status, kind, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draw',$10,$11) RETURNING *`,
      [application_id, drawId, approved, fee, feeKind, split.retainage_held_cents, split.net_release_cents, releaseDate, fundedStatus, req.body.note ? String(req.body.note).slice(0, 2000) : null, req.actor.id])).rows[0];
    // Milestone → borrower (owner-directed 2026-07-20): a construction draw was
    // released. Tell them the NET amount actually on its way (approved − fee −
    // retainage), only on an actual release. type 'draw' emails the borrower.
    if (fundedStatus === 'released' && split.net_release_cents > 0) {
      try {
        const amt = '$' + (split.net_release_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await notify.notifyAppBorrowers(application_id, {
          type: 'draw',
          title: `Your construction draw has been released`,
          hero: { label: 'Released to you', value: amt, sub: 'typically arrives in 1–2 business days', tone: 'positive' },
          badge: { text: 'Draw released', tone: 'positive' },
          body: `Your loan team has released a construction draw of ${amt} on your file. Depending on your bank, funds typically take 1–2 business days to arrive.`,
          lines: ['Questions about this draw? Just reply to this email or reach your loan officer.'],
          applicationId: application_id, link: `/app/${application_id}`, ctaLabel: 'View your draws' });
      } catch (_) { /* milestone email is best-effort */ }
    }
    res.json({ ok: true, disbursement: row });
  } catch (e) {
    // db/148 unique index — a second draw release raced past the pre-check
    if (e.code === '23505') return res.status(409).json({ error: 'A release is already recorded for this draw.' });
    res.status(500).json({ error: 'Could not record this release — please try again.' });
  }
});

// ---- POST /files/:id/retainage-release — release the accumulated retainage at completion ----
router.post('/files/:id/retainage-release', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  // Validate the date before opening the money transaction (a bad date would 22007 → 500 mid-txn).
  const relDate = req.body.release_date == null || req.body.release_date === '' ? null : sanitizeDateOnly(req.body.release_date);
  if (req.body.release_date && !relDate) return res.status(400).json({ error: 'The release date must be a valid calendar date (YYYY-MM-DD).' });
  const relNote = req.body.note ? String(req.body.note).slice(0, 2000) : 'Retainage released at completion';
  // Serialize with a per-file transaction lock so two concurrent releases can't both read the
  // same "already released" and double-pay the holdback (audit #2 — this is real money).
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sw-retrel:${appId}`]);
    const held = Number((await client.query(`SELECT COALESCE(sum(retainage_held_cents),0) h FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].h) || 0;
    const already = Number((await client.query(`SELECT COALESCE(sum(net_release_cents),0) r FROM draw_disbursements WHERE application_id=$1 AND kind='retainage_release'`, [appId])).rows[0].r) || 0;
    const toRelease = held - already;
    if (toRelease <= 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'no retainage is being held to release' }); }
    const row = (await client.query(
      `INSERT INTO draw_disbursements (application_id, approved_cents, fee_cents, retainage_held_cents, net_release_cents, release_date, funded_status, kind, note, created_by)
       VALUES ($1,$2,0,0,$2,$3,'released','retainage_release',$4,$5) RETURNING *`,
      [appId, toRelease, relDate, relNote, req.actor.id])).rows[0];
    await client.query('COMMIT');
    // Milestone → borrower: the completion retainage has been released.
    try {
      const amt = '$' + (toRelease / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      await notify.notifyAppBorrowers(appId, {
        type: 'draw',
        title: `Your held-back retainage has been released`,
        hero: { label: 'Retainage released', value: amt, sub: 'your construction is complete', tone: 'positive' },
        badge: { text: 'Complete', tone: 'positive' },
        body: `With your construction complete, the retainage held back across your draws — ${amt} — has now been released.`,
        applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws' });
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, disbursement: row, released_cents: toRelease });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: 'Could not release the retainage — please try again.' }); }
  finally { client.release(); }
});

// ---- lien waivers (per draw) ----
router.get('/files/:id/waivers', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const rows = (await db.query(`SELECT * FROM draw_lien_waivers WHERE application_id=$1 ORDER BY created_at DESC`, [req.params.id])).rows;
  res.json({ waivers: rows });
});
router.post('/files/:id/waivers', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const kind = ['conditional', 'unconditional'].includes(b.kind) ? b.kind : 'conditional';
  const scope = ['progress', 'final'].includes(b.scope) ? b.scope : 'progress';
  const tier = ['gc', 'subcontractor', 'supplier'].includes(b.tier) ? b.tier : 'gc';
  // amount is informational (not moved money), but reject garbage/negative rather than silently → $0.
  let amt = 0;
  if (b.amount_cents != null && b.amount_cents !== '') {
    const a = Number(b.amount_cents);
    if (!Number.isFinite(a) || a < 0) return res.status(400).json({ error: 'The waiver amount must be a non-negative dollar amount (in cents).' });
    amt = Math.round(a);
  }
  // if a draw is named, it MUST belong to THIS file — never store a draw id from another file (the lien
  // gate + packet key on the draw id only, so a foreign draw id would block/leak the other file's draw).
  let waiverDrawId = null;
  if (b.sitewire_draw_id != null && b.sitewire_draw_id !== '') {
    if (!/^\d+$/.test(String(b.sitewire_draw_id))) return res.status(400).json({ error: 'invalid draw id' });
    const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [b.sitewire_draw_id, appId]);
    if (!own.rowCount) return res.status(400).json({ error: 'that draw is not on this file' });
    waiverDrawId = b.sitewire_draw_id;
  }
  try {
    const row = (await db.query(
      `INSERT INTO draw_lien_waivers (application_id, sitewire_draw_id, kind, scope, tier, party_name, amount_cents, status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'required',$8,$9) RETURNING *`,
      [appId, waiverDrawId, kind, scope, tier, b.party_name ? String(b.party_name).slice(0, 200) : null, amt, b.note ? String(b.note).slice(0, 2000) : null, req.actor.id])).rows[0];
    res.json({ ok: true, waiver: row });
  } catch (e) { res.status(500).json({ error: 'Could not save the lien waiver — please try again.' }); }
});
router.patch('/waivers/:wid', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.wid)) return res.status(404).json({ error: 'not found' });
  const status = ['required', 'received', 'waived', 'na'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status must be required, received, waived, or na' });
  const w = (await db.query(`SELECT application_id FROM draw_lien_waivers WHERE id=$1`, [req.params.wid])).rows[0];
  if (!w || !(await canSeeFile(req, w.application_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`UPDATE draw_lien_waivers SET status=$2, received_at=CASE WHEN $2 IN ('received','waived') THEN now() ELSE NULL END, note=COALESCE($3,note), updated_at=now() WHERE id=$1`, [req.params.wid, status, req.body.note ? String(req.body.note).slice(0, 2000) : null]);
  res.json({ ok: true, status });
});

// ---- GET /files/:id/gl-export — the release ledger as a GL/accounting Excel workbook ----
router.get('/files/:id/gl-export', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const rows = (await db.query(
      `SELECT d.created_at, d.release_date, d.sitewire_draw_id, d.kind, d.approved_cents, d.fee_cents, d.retainage_held_cents, d.net_release_cents, d.funded_status,
              a.ys_loan_number, a.property_address->>'oneLine' AS address
         FROM draw_disbursements d JOIN applications a ON a.id=d.application_id
        WHERE d.application_id=$1 ORDER BY d.created_at`, [req.params.id])).rows;
    const c = (x) => Math.round(Number(x || 0)) / 100;
    const out = [['Loan', 'Property', 'Recorded', 'Release date', 'Draw', 'Type', 'Approved', 'Fee', 'Retainage held', 'Net release', 'Status']];
    for (const r of rows) out.push([r.ys_loan_number || '', r.address || '', new Date(r.created_at).toISOString().slice(0, 10), r.release_date || '', r.sitewire_draw_id ? '#' + r.sitewire_draw_id : '', r.kind, c(r.approved_cents), c(r.fee_cents), c(r.retainage_held_cents), c(r.net_release_cents), r.funded_status]);
    const buf = buildXlsx(out, 'GL Export');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="draw-gl-${req.params.id}.xlsx"`);
    res.send(buf);
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- inspection + fee rules (admin/setup) ----
router.get('/rules', requirePermission('platform_setup'), async (req, res) => {
  const rules = (await db.query(`SELECT r.*, cp.name AS capital_partner_name FROM sitewire_inspection_rules r LEFT JOIN sitewire_capital_partners cp ON cp.sitewire_id=r.capital_partner_id ORDER BY r.partner_label NULLS FIRST, r.capital_partner_id NULLS FIRST`)).rows;
  // The rule-builder dropdown + the note-buyer link table list ONLY the note buyers actually on files
  // we are actively using — NOT the whole Sitewire directory (owner-directed 2026-07-20: "we shouldn't
  // have such a big list of investors to set up rules; the only investors we should need are ones that
  // are part of files we are actively using"). The full directory stays available in GET /capital-partners
  // as the link picker's TARGET list. A note buyer that already has a rule is kept too, so an existing
  // rule is never orphaned out of the builder.
  const dir = (await db.query(`SELECT sitewire_id, name, on_our_lender FROM sitewire_capital_partners`)).rows;
  // "Actively using" = alive files (not soft-deleted, not declined/withdrawn). FUNDED files COUNT —
  // draws happen AFTER funding, so a funded construction file is exactly the one that needs a draw
  // rule (do NOT reuse ACTIVE_FILE_SQL from staff.js, which excludes funded).
  const used = (await db.query(
    `SELECT DISTINCT btrim(lender) AS lender FROM applications
      WHERE lender IS NOT NULL AND btrim(lender) <> '' AND deleted_at IS NULL
        AND status NOT IN ('declined','withdrawn')`)).rows.map((r) => r.lender);
  const links = (await db.query(`SELECT label_norm, sitewire_id FROM sitewire_partner_links`)).rows;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const linkByNorm = new Map(links.map((l) => [l.label_norm, l.sitewire_id == null ? null : Number(l.sitewire_id)]));
  // Directory lookup for ENRICHMENT ONLY — a used label that matches the directory shows its Sitewire
  // id + on_our_lender flag; the directory no longer SEEDS rows on its own. On a duplicate directory
  // name (same investor under two Sitewire ids), keep the one attached to OUR lender so the enriched
  // id matches what the resolver binds to.
  const dirByNorm = new Map();
  for (const d of dir) {
    const k = norm(d.name); if (!k) continue;
    const ex = dirByNorm.get(k);
    if (!ex || (!ex.on_our_lender && d.on_our_lender)) dirByNorm.set(k, d);
  }
  const byNorm = new Map();
  const addLabel = (label, inUse) => {
    const k = norm(label); if (!k) return;
    let ex = byNorm.get(k);
    if (!ex) {
      const d = dirByNorm.get(k);
      ex = d
        ? { label: d.name, sitewire_id: Number(d.sitewire_id), directory_id: Number(d.sitewire_id), on_our_lender: !!d.on_our_lender, in_directory: true, in_use: false }
        : { label, sitewire_id: null, directory_id: null, on_our_lender: false, in_directory: false, in_use: false };
      byNorm.set(k, ex);
    }
    if (inUse) ex.in_use = true;
  };
  for (const l of used) addLabel(l, true);
  // Keep any note buyer that already has a rule, even if it has since dropped off the active files —
  // otherwise its still-active rule would be invisible in the builder while resolveRule keeps using it.
  for (const r of rules) if (r.partner_label) addLabel(r.partner_label, false);
  // Enrich each partner with its smart-link state so the UI can show Linked / Exact / Suggested.
  const partners = [];
  for (const p of byNorm.values()) {
    const k = norm(p.label);
    const linked = linkByNorm.has(k) ? linkByNorm.get(k) : undefined; // undefined = no link row; null = "no Sitewire partner"
    p.linked_sitewire_id = linked === undefined ? null : linked;
    p.has_link = linked !== undefined;
    // If not exact and not linked, offer the resolver's best candidate as a one-click suggestion.
    if (!p.in_directory && !p.has_link) {
      try {
        const m = await orchestrator.resolveCapitalPartnerId(p.label);
        if (m && m.candidate != null) { p.suggested_sitewire_id = Number(m.candidate); p.suggested_name = m.candidateName || null; }
      } catch (_) { /* suggestion is best-effort */ }
    }
    partners.push(p);
  }
  partners.sort((a, b) => a.label.localeCompare(b.label));
  res.json({ rules, partners });
});
router.post('/rules', requirePermission('platform_setup'), async (req, res) => {
  const b = req.body || {};
  // A rule is keyed by the NOTE-BUYER label (the dropdown value). Resolve the Sitewire directory id
  // from that label best-effort — a partner not in the directory (external one) simply has no id, and
  // that's fine: the label is the key and handled-externally rules don't push at all.
  const partnerLabel = (b.partner_label != null && String(b.partner_label).trim() !== '') ? String(b.partner_label).trim() : null;
  let cpId = b.capital_partner_id || null;
  if (partnerLabel && !cpId) {
    try { const m = await orchestrator.resolveCapitalPartnerId(partnerLabel); cpId = m.id || null; } catch (_) { cpId = null; }
  }
  const handledExternally = !!b.handled_externally;
  // "Handled externally" must NAME a partner. A global-default rule (no partner_label) marked
  // handled-externally would make resolveRule's last-resort fallback return handled_externally for
  // EVERY unmatched file — silently stopping all Sitewire pushes portfolio-wide with no park/alert.
  // Never allow that (owner's never-guess / never-silently-drop rule); reject it up front.
  if (handledExternally && !partnerLabel) {
    return res.status(400).json({ error: 'Pick a specific capital partner before marking a rule “handled externally” — the global default can’t be handled externally.' });
  }
  const method = b.inspection_method === 'traditional' ? 'traditional' : 'mobile';
  // allow_virtual / allow_physical say which methods this program MAY use (both = coordinator can switch).
  // Default each to true when absent. Never let a rule forbid its own default method — that would leave a
  // program with no legal inspection method and block the push; force-allow the chosen default.
  let allowVirtual = b.allow_virtual !== false;
  let allowPhysical = b.allow_physical !== false;
  if (method === 'mobile') allowVirtual = true; else allowPhysical = true;
  // Fees are integer cents. Virtual falls back to $299 when blank/garbage. Physical is nullable
  // (a null physical fee falls back to the virtual fee at push time) — a non-numeric value must
  // become null, never NaN (which Postgres would reject as a 500). An explicit 0 is honored.
  const vFee = Number(b.fee_cents_virtual);
  // Honor an explicit 0 (a free virtual inspection) — only blank/garbage falls back to $299,
  // matching the physical-fee handling below. A typed 0 must never be silently reset to $299.
  const feeVirtual = Number.isFinite(vFee) && vFee >= 0 ? Math.round(vFee) : 29900;
  const pRaw = b.fee_cents_physical;
  const pFee = Number(pRaw);
  // A negative physical fee is invalid → null (falls back to the virtual fee downstream), matching the
  // virtual guard above. Never store a negative fee — it would push a negative processing_fee_cents.
  const feePhysical = pRaw == null || pRaw === '' || !Number.isFinite(pFee) || pFee < 0 ? null : Math.round(pFee);
  try {
    const row = (await db.query(
      `INSERT INTO sitewire_inspection_rules (capital_partner_id, partner_label, program, inspection_method, require_sitewire_inspector, require_capital_partner_approval, allow_reallocation, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, handled_externally)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO UPDATE SET capital_partner_id=EXCLUDED.capital_partner_id, partner_label=COALESCE(EXCLUDED.partner_label, sitewire_inspection_rules.partner_label), inspection_method=EXCLUDED.inspection_method, require_sitewire_inspector=EXCLUDED.require_sitewire_inspector, require_capital_partner_approval=EXCLUDED.require_capital_partner_approval, allow_reallocation=EXCLUDED.allow_reallocation, fee_cents_virtual=EXCLUDED.fee_cents_virtual, fee_cents_physical=EXCLUDED.fee_cents_physical, allow_virtual=EXCLUDED.allow_virtual, allow_physical=EXCLUDED.allow_physical, handled_externally=EXCLUDED.handled_externally, updated_at=now()
       RETURNING *`,
      [cpId, partnerLabel, b.program || null, method, b.require_sitewire_inspector !== false, !!b.require_capital_partner_approval, !!b.allow_reallocation, feeVirtual, feePhysical, allowVirtual, allowPhysical, handledExternally])).rows[0];
    res.json({ ok: true, rule: row });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /capital-partners — the Sitewire directory, for the smart-link picker ----
router.get('/capital-partners', requirePermission('platform_setup'), async (req, res) => {
  const rows = (await db.query(`SELECT sitewire_id, name, on_our_lender FROM sitewire_capital_partners ORDER BY on_our_lender DESC, name`)).rows;
  // Collapse duplicate investor NAMES so the picker never lists the same investor twice (owner-directed
  // 2026-07-20: "make sure we are not having duplicate investor names"). Sitewire can carry one partner
  // under two ids; ORDER BY on_our_lender DESC puts the one attached to our lender first, so the first
  // row seen for a name is the one we keep. Genuinely distinct names (different investors) all remain.
  const seen = new Set();
  const partners = [];
  for (const r of rows) {
    const k = String(r.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    partners.push({ sitewire_id: Number(r.sitewire_id), name: r.name, on_our_lender: !!r.on_our_lender });
  }
  res.json({ partners });
});

// ---- POST /partner-links — confirm (or clear) the note-buyer → Sitewire-partner link ----
// The smart-link chokepoint: a rule for a note buyer whose name differs from Sitewire's directory
// ("Fidelis" vs "Fidelis Investments LLC") pushes to the right partner ONLY because a human confirmed
// this link. sitewire_id null = an explicit "no Sitewire partner" (handled externally). Nothing guessed.
router.post('/partner-links', requirePermission('platform_setup'), async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'A note-buyer name is required.' });
  const labelNorm = label.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!labelNorm) return res.status(400).json({ error: 'That note-buyer name has no letters or numbers to match on.' });
  let sitewireId = null;
  if (b.sitewire_id != null && b.sitewire_id !== '') {
    const n = Number(b.sitewire_id);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Pick a Sitewire capital partner (or “not in Sitewire”).' });
    // Only allow linking to a partner that actually exists in the synced directory — never a made-up id.
    const ok = (await db.query(`SELECT 1 FROM sitewire_capital_partners WHERE sitewire_id=$1`, [n])).rowCount;
    if (!ok) return res.status(400).json({ error: 'That Sitewire partner isn’t in the synced directory — sync the directory first.' });
    sitewireId = n;
  }
  const actorId = (req.actor && isUuid(req.actor.id)) ? req.actor.id : null;
  try {
    await db.query(
      `INSERT INTO sitewire_partner_links (label_norm, label, sitewire_id, confirmed_by, confirmed_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now())
       ON CONFLICT (label_norm) DO UPDATE SET label=EXCLUDED.label, sitewire_id=EXCLUDED.sitewire_id, confirmed_by=EXCLUDED.confirmed_by, updated_at=now()`,
      [labelNorm, label, sitewireId, actorId]);
    res.json({ ok: true, label, sitewire_id: sitewireId });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- refresh the capital-partner directory + staff<->Sitewire-user map ----
router.post('/sync-directory', requirePermission('platform_setup'), async (req, res) => {
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  try {
    const cp = await reconcile.syncCapitalPartners();
    const staff = await reconcile.syncStaffUsers();
    res.json({ ok: true, capital_partners: cp.count, staff_matched: staff.matched });
  } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- settings (wire turnaround hours, variance) ----
router.get('/settings', requirePermission(['manage_draws', 'platform_setup']), async (req, res) => {
  const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});
router.patch('/settings', requirePermission('platform_setup'), async (req, res) => {
  const allowed = new Set(['wire_turnaround_hours', 'variance_pct', 'stale_days', 'no_draw_days', 'pacing_gap_pct', 'front_load_pct', 'first_draw_max_pct', 'retainage_pct', 'require_lien_waivers']);
  const PCT = new Set(['variance_pct', 'pacing_gap_pct', 'front_load_pct', 'first_draw_max_pct', 'retainage_pct']);
  const DAYS = new Set(['stale_days', 'no_draw_days']);
  // Validate + coerce each value BEFORE storing — never persist garbage a reader must defensively clamp
  // (a stored "banana" / 500% / negative is a latent surprise). `undefined` = invalid → 400.
  const coerce = (k, v) => {
    if (k === 'require_lien_waivers') {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      return undefined;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (PCT.has(k)) return n <= 100 ? n : undefined;              // percentages: 0..100
    if (k === 'wire_turnaround_hours') return n <= 8760 ? Math.round(n) : undefined; // ≤ 1 year of hours
    if (DAYS.has(k)) return n <= 3650 ? Math.round(n) : undefined; // ≤ 10 years of days
    return Math.round(n);
  };
  const updates = [];
  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;
    const val = coerce(k, req.body[k]);
    if (val === undefined) return res.status(400).json({ error: `Invalid value for “${k}”. Percentages must be 0–100; hours/days a non-negative whole number; lien-waivers on/off.` });
    await db.query(`INSERT INTO sitewire_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(val)]);
    updates.push(k);
  }
  res.json({ ok: true, updated: updates });
});

// ---- Per-reason resolution actions for a Sitewire review (owner-directed 2026-07-20) ----
// Each parked reason gets the action(s) that ACTUALLY fix its cause, so a resolution isn't a no-op that
// loops: an advisory note only "acknowledges" (never re-pushes — that was the loop); GO-FORWARD ONLY means
// there is NO adopt/link of a pre-existing property, so the "loan already in Sitewire" collision (and every
// other blocker) offers "retry" — for the collision, a warned "delete it in Sitewire, then push a fresh
// copy" — or "dismiss" (keep separate). See src/sitewire/review-actions.js (single source of truth).
const { SITEWIRE_DUPE, sitewireReasonClass, sitewireAllowedActions } = require('../sitewire/review-actions');
router.post('/reviews/:id/:action', requirePermission('manage_draws'), async (req, res) => {
  const { id, action } = req.params;
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'not found' });
  if (!['retry', 'dismiss', 'acknowledge', 'restore', 'accept'].includes(action)) return res.status(400).json({ error: 'action must be retry, acknowledge, restore, accept, or dismiss' });
  const row = (await db.query(`SELECT id, application_id, reason, current_value FROM sync_review_queue WHERE id=$1 AND field_key='sitewire' AND status='open'`, [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'review not found (or already resolved)' });
  if (!row.application_id || !(await canSeeFile(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
  const reasonClass = sitewireReasonClass(row.reason);
  // dismiss is always allowed; any other action must match the reason's action set (no acknowledging a
  // blocker away without fixing it, no retrying an advisory into the loop).
  if (action !== 'dismiss' && !sitewireAllowedActions(reasonClass).includes(action)) {
    return res.status(400).json({ error: `That action isn't available for this review. Options: ${sitewireAllowedActions(reasonClass).join(', ')}.` });
  }
  try {
    if (action === 'dismiss') {
      await db.query(`UPDATE sync_review_queue SET status='rejected', resolved_by=$2, resolved_at=now(), resolution_note='dismissed' WHERE id=$1`, [id, req.actor.id]);
      return res.json({ ok: true, dismissed: true });
    }
    if (action === 'acknowledge') {
      // Advisory: just close it — NO push (this is what STOPS the units-note retry loop). The advisory was
      // informational; the push already proceeded past it.
      await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note='acknowledged' WHERE id=$1`, [id, req.actor.id]);
      return res.json({ ok: true, acknowledged: true });
    }
    if (action === 'accept') {
      // Two-sided drift: the coordinator accepts SITEWIRE's value — close the review with no push. PILOT
      // does not silently mutate its own record; accepting just stops flagging the divergence. (The
      // coordinator handles any downstream, e.g. re-registering a genuinely changed budget.)
      await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note='accepted Sitewire value' WHERE id=$1`, [id, req.actor.id]);
      return res.json({ ok: true, accepted: true });
    }
    if (action === 'restore') {
      // Two-sided budget drift: re-push PILOT's budget to Sitewire, overwriting the drift. Routes through
      // the SAME guarded push machinery as every other write (never a raw call) by re-queuing push_file.
      const dead = await db.query(
        `UPDATE sync_queue SET status='queued', attempts=0, run_after=now(), updated_at=now()
          WHERE entity_type='application' AND entity_id=$1 AND target='sitewire' AND direction='push' AND status='dead' RETURNING id`, [row.application_id]);
      if (!dead.rows.length) await enqueueSitewirePush(row.application_id, 'push_file').catch(() => {});
      await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note='restoring PILOT budget to Sitewire' WHERE id=$1`, [id, req.actor.id]);
      return res.json({ ok: true, restored: true });
    }
    // action === 'retry'. If this file has a still-open loan-number COLLISION review (a pre-existing Sitewire
    // property carries this loan), block retrying a DIFFERENT review — the push can't create the property while
    // the collision stands, so it would just re-park (the loop the owner reported). Retrying the collision review
    // ITSELF is allowed (id<>$2 excludes it): that is the go-forward "I deleted it in Sitewire — push a fresh
    // copy" path, which creates a brand-new PILOT-managed property once the pre-existing one is gone.
    const blocker = (await db.query(
      `SELECT id FROM sync_review_queue WHERE application_id=$1 AND field_key='sitewire' AND status='open' AND id<>$2
         AND split_part(reason,':',1) = $3 LIMIT 1`, [row.application_id, id, SITEWIRE_DUPE])).rows[0];
    if (blocker) return res.status(409).json({ error: 'This loan is already on a property in Sitewire that PILOT didn’t create. Resolve that review first — either delete the property in Sitewire and push a fresh copy, or keep them separate — retrying now would just hit that block again.' });
    const dead = await db.query(
      `UPDATE sync_queue SET status='queued', attempts=0, run_after=now(), updated_at=now()
        WHERE entity_type='application' AND entity_id=$1 AND target='sitewire' AND direction='push' AND status='dead' RETURNING id`, [row.application_id]);
    if (!dead.rows.length) await enqueueSitewirePush(row.application_id, 'push_file').catch(() => {});
    await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1`,
      [id, req.actor.id, dead.rows.length ? `retried ${dead.rows.length} push job(s)` : 're-queued a fresh push']);
    return res.json({ ok: true, retried: dead.rows.length, requeued: !dead.rows.length });
  } catch (e) { res.status(500).json({ error: 'Could not resolve this review — please try again.' }); }
});

// ---- health/status (setup screen) ----
router.get('/status', requirePermission(['manage_draws', 'platform_setup']), async (req, res) => {
  try {
    const linked = (await db.query(`SELECT count(*)::int c FROM sitewire_property_links WHERE sitewire_property_id IS NOT NULL`)).rows[0].c;
    const draws = (await db.query(`SELECT count(*)::int c FROM sitewire_draws`)).rows[0].c;
    const openReviews = (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE field_key='sitewire' AND status='open'`)).rows[0].c;
    res.json({ enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun, linked_files: linked, mirrored_draws: draws, open_reviews: openReviews });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ===================================================================================
//  UNIFIED ROLLUP + PORTFOLIO (draws ↔ Scope of Work ↔ construction budget — one view)
// ===================================================================================

// ---- GET /files/:id/rollup — the unified per-line/per-unit picture for a file ----
router.get('/files/:id/rollup', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    // friendly SOW labels from the saved Scope of Work (never required)
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, appId, { sowState });
    // Go-forward only (owner-directed 2026-07-20): PILOT surfaces/follows ONLY a property IT pushed
    // (matched_by='created'). A pre-existing hand-entered Sitewire property is never adopted or followed.
    const link = (await db.query(`SELECT l.*, cs.full_name AS coordinator_name FROM sitewire_property_links l LEFT JOIN staff_users cs ON cs.id=l.coordinator_staff_id WHERE l.application_id=$1 AND l.matched_by='created'`, [appId])).rows[0] || null;
    // Birth-phase setup status lives ON THE FILE (link.raw.setup_status), never the global error queue
    // (go-forward only). It tells the draw section what happened on the last push attempt for a not-yet-
    // managed file: a loan-number collision with a pre-existing Sitewire property (preexisting → the
    // "already in Sitewire — not managed" banner), or another setup blocker (no SOW, budget mismatch, …).
    const setupStatus = (link && link.raw && link.raw.setup_status) ? link.raw.setup_status : null;
    const preexisting = !!(setupStatus && setupStatus.preexisting_property_id);
    const draws = (await db.query(`SELECT sitewire_draw_id, number, name, status, risk_level, risk_flags, submitted_at, approved_at, pdf_src, quick_notify_status_id, coordinator_id FROM sitewire_draws WHERE application_id=$1 ORDER BY number DESC NULLS LAST`, [appId])).rows;
    const requests = (await db.query(
      `SELECT r.sitewire_request_id, r.sitewire_draw_id, r.sitewire_job_item_id, r.job_item_name, r.requested_cents, r.approved_cents, r.inspection_count, r.lender_comments
         FROM sitewire_draw_requests r JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id WHERE d.application_id=$1 ORDER BY r.sitewire_request_id`, [appId])).rows;
    const ledger = (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    const findings = (await db.query(`SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [appId])).rows;
    const changeRequests = (await db.query(
      `SELECT cr.id, cr.status, cr.reason, cr.created_at, cr.decided_at, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status, d.deltas
         FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id
        WHERE cr.application_id=$1 AND cr.field='sow_reallocation' ORDER BY cr.created_at DESC`, [appId])).rows;
    // merge risk flags onto the rollup draw summaries
    const riskByDraw = new Map(draws.map((d) => [Number(d.sitewire_draw_id), { level: d.risk_level, flags: d.risk_flags, pdf_src: d.pdf_src, quick_notify_status_id: d.quick_notify_status_id, coordinator_id: d.coordinator_id }]));
    for (const d of rollup.draws) { const r = riskByDraw.get(d.sitewire_draw_id); if (r) { d.risk_level = r.level; d.risk_flags = r.flags; d.pdf_src = r.pdf_src; d.quick_notify_status_id = r.quick_notify_status_id; d.coordinator_id = r.coordinator_id; } }
    // retainage held vs released + the lien-waiver register (roadmap money model)
    const held = Number((await db.query(`SELECT COALESCE(sum(retainage_held_cents),0) h FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].h) || 0;
    const rlsd = Number((await db.query(`SELECT COALESCE(sum(net_release_cents),0) r FROM draw_disbursements WHERE application_id=$1 AND kind='retainage_release'`, [appId])).rows[0].r) || 0;
    const waivers = (await db.query(`SELECT id, sitewire_draw_id, kind, scope, tier, party_name, amount_cents, status, received_at FROM draw_lien_waivers WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    const retainage = { pct: await retainagePctFor(appId), held_cents: held, released_cents: rlsd, holding_cents: Math.max(0, held - rlsd) };
    // lien waivers are OFF by default and only surface once turned on (globally OR for this
    // project) — the panel shows only when enabled or already in use.
    const lienWaiversEnabled = await lienGateEnabled(appId);
    res.json({ rollup, link, draws, requests, ledger, findings, change_requests: changeRequests, retainage, waivers,
      lien_waivers_enabled: lienWaiversEnabled, lien_waivers_file_override: link ? link.require_lien_waivers : null,
      // go-forward-only status for the draw-section banner: preexisting = blocked on a pre-existing
      // Sitewire property PILOT didn't create; setup_status = the last birth-phase outcome (inline, not a
      // global error row); managed_since = when PILOT pushed (born) this property.
      preexisting, setup_status: setupStatus, managed_since: link ? link.pushed_at : null, go_live_date: cfg.sitewireGoLiveDate,
      // so the desk can show a proactive read-only banner + disable write buttons when writes are off
      // (an approve/release/finding write 503s unless BOTH the master switch and the write gate are on).
      switches: { enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun } });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /portfolio — exposure / pacing dashboard across the actor's files ----
router.get('/portfolio', requirePermission('manage_draws'), async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    // per-file budget (frozen) + drawn (approved on approved draws) + pending-approval counts
    const rows = (await db.query(
      `SELECT a.id AS application_id, a.ys_loan_number, a.property_address->>'oneLine' AS address, a.status,
              a.actual_closing, a.term, a.lender,
              l.sitewire_property_id, COALESCE(l.lifecycle_state,'active') AS lifecycle_state, l.lifecycle_at,
              COALESCE((SELECT sum(ji.budgeted_cents) FROM sitewire_job_item_links ji WHERE ji.application_id=a.id AND ji.state<>'deleted' AND ji.is_media_item=false),0) AS budget_cents,
              COALESCE((SELECT sum(r.approved_cents) FROM sitewire_draw_requests r JOIN sitewire_draws d2 ON d2.sitewire_draw_id=r.sitewire_draw_id WHERE d2.application_id=a.id AND d2.status='approved'),0) AS drawn_cents,
              COALESCE((SELECT sum(d3.total_requested_cents) FROM sitewire_draws d3 WHERE d3.application_id=a.id AND d3.status NOT IN ('approved','drafting')),0) AS pending_requested_cents,
              (SELECT count(*) FROM sitewire_draws d4 WHERE d4.application_id=a.id AND d4.status='pending') AS pending_count,
              (SELECT count(*) FROM sitewire_draws d6 WHERE d6.application_id=a.id) AS draw_count,
              (SELECT max(greatest(coalesce(d7.approved_at,d7.submitted_at,d7.updated_at), d7.updated_at)) FROM sitewire_draws d7 WHERE d7.application_id=a.id) AS last_activity_at,
              (SELECT count(*) FROM sitewire_draws d5 WHERE d5.application_id=a.id AND d5.risk_level='high') AS high_risk_count,
              (SELECT count(*) FROM draw_findings df WHERE df.application_id=a.id AND df.status='accepted' AND df.wire_due_at < now()
                 AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.sitewire_draw_id=df.sitewire_draw_id AND dd.funded_status='released')) AS overdue_wire_count
         FROM sitewire_property_links l JOIN applications a ON a.id=l.application_id
        WHERE a.deleted_at IS NULL AND l.sitewire_property_id IS NOT NULL AND l.matched_by='created'${sc.where}`, sc.params)).rows;
    let budget = 0, drawn = 0, pendingReq = 0, pendingCount = 0, highRisk = 0;
    const files = rows.map((r) => {
      const b = Number(r.budget_cents) || 0, dr = Number(r.drawn_cents) || 0;
      budget += b; drawn += dr; pendingReq += Number(r.pending_requested_cents) || 0;
      pendingCount += Number(r.pending_count) || 0; highRisk += Number(r.high_risk_count) || 0;
      return { application_id: r.application_id, ys_loan_number: r.ys_loan_number, address: r.address, status: r.status,
        // partner is the STAFF-ONLY note-buyer / capital-partner label (never sent to a borrower surface;
        // this route is manage_draws-gated). Used for the by-partner exposure rollup below.
        partner: (r.lender && String(r.lender).trim()) || null,
        budget_cents: b, drawn_cents: dr, remaining_cents: b - dr, pct_complete: b > 0 ? Math.round((dr / b) * 1000) / 10 : 0,
        pending_requested_cents: Number(r.pending_requested_cents) || 0, pending_count: Number(r.pending_count) || 0, high_risk_count: Number(r.high_risk_count) || 0,
        funded_on: r.actual_closing || null, term: r.term || null, draw_count: Number(r.draw_count) || 0,
        last_activity_at: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
        lifecycle_state: r.lifecycle_state || 'active',
        lifecycle_at: r.lifecycle_at ? new Date(r.lifecycle_at).toISOString() : null,
        wire_overdue: Number(r.overdue_wire_count) > 0 };
    });
    // early-warning monitoring (advisory, computed from real data only). A finished / paid-off project is
    // intentionally done, so it must NOT raise stale / behind-pace / overdue alerts — assess ACTIVE files only.
    const activeFiles = files.filter((f) => f.lifecycle_state === 'active');
    let alerts = { files: [], summary: { by_code: {}, flagged: 0, total: activeFiles.length } };
    try {
      const s = await reconcile.settingsMap();
      const monitor = require('../sitewire/monitor');
      alerts = monitor.assessPortfolioAlerts(activeFiles, {
        nowMs: Date.now(),
        staleDays: Number(s.stale_days) || 30, noDrawDays: Number(s.no_draw_days) || 45, pacingGapPct: Number(s.pacing_gap_pct) || 25,
      });
    } catch (_) {}
    const alertByFile = {};
    for (const af of alerts.files) alertByFile[af.application_id] = af.alerts;
    for (const f of files) f.alerts = (f.lifecycle_state === 'active') ? (alertByFile[f.application_id] || []) : [];

    // ---- Coordinator analytics (2026-07-20) ----
    // (1) BY-PARTNER exposure rollup — where the desk's committed capital sits per note-buyer / capital
    //     partner. Staff-only labels; an unmatched file rolls up under "Unassigned". Active projects only for
    //     the flagged/overdue counts (a finished project isn't "at risk").
    const partnerMap = new Map();
    for (const f of files) {
      const key = f.partner || 'Unassigned';
      let p = partnerMap.get(key);
      if (!p) { p = { partner: key, files: 0, budget_cents: 0, drawn_cents: 0, remaining_cents: 0, pending_requested_cents: 0, pending_count: 0, flagged: 0, wire_overdue: 0 }; partnerMap.set(key, p); }
      p.files += 1;
      p.budget_cents += f.budget_cents; p.drawn_cents += f.drawn_cents; p.remaining_cents += f.remaining_cents;
      p.pending_requested_cents += f.pending_requested_cents; p.pending_count += f.pending_count;
      if ((f.alerts || []).length) p.flagged += 1;
      if (f.wire_overdue && f.lifecycle_state === 'active') p.wire_overdue += 1;
    }
    const byPartner = [...partnerMap.values()]
      .map((p) => ({ ...p, pct_complete: p.budget_cents > 0 ? Math.round((p.drawn_cents / p.budget_cents) * 1000) / 10 : 0 }))
      .sort((a, b) => b.remaining_cents - a.remaining_cents);

    // (2) HEALTH panel — a one-glance read of the active portfolio's condition.
    const finishedCount = files.filter((f) => f.lifecycle_state !== 'active').length;
    const overdueFiles = files.filter((f) => f.wire_overdue && f.lifecycle_state === 'active').length;
    const health = {
      active: activeFiles.length,
      finished: finishedCount,
      flagged: alerts.summary.flagged,
      on_track: Math.max(0, activeFiles.length - alerts.summary.flagged),
      wire_overdue_files: overdueFiles,
      high_risk_files: files.filter((f) => f.high_risk_count > 0 && f.lifecycle_state === 'active').length,
      pending_count: pendingCount,
    };

    res.json({ totals: { files: files.length, budget_cents: budget, drawn_cents: drawn, remaining_cents: budget - drawn,
      pct_complete: budget > 0 ? Math.round((drawn / budget) * 1000) / 10 : 0, pending_requested_cents: pendingReq, pending_count: pendingCount, high_risk_count: highRisk,
      flagged: alerts.summary.flagged, alert_codes: alerts.summary.by_code },
      by_partner: byPartner, health,
      files: files.sort((a, b) => (b.alerts.length - a.alerts.length) || b.pending_count - a.pending_count || b.remaining_cents - a.remaining_cents) });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// Assemble a file's complete draw audit trail (examiner-ready) from every source we record:
// our write journal, the Sitewire draw lifecycle events, the money ledger, findings accept/
// dispute, and Scope-of-Work reallocations. Time-ordered, newest first. Read-only.
async function buildDrawActivity(appId) {
  const ev = [];
  // A date-only value ('YYYY-MM-DD', e.g. a release_date) must NOT be run through new Date().toISOString()
  // — that stamps UTC midnight and the browser then renders the PREVIOUS calendar day (the repo's date
  // rule). Keep date-only values as the calendar string and tag them so the UI formats them as a day.
  const push = (at, kind, summary, actor, dateOnly) => {
    if (!at) return;
    ev.push({ at: dateOnly ? String(at).slice(0, 10) : new Date(at).toISOString(), date_only: !!dateOnly, kind, summary, actor: actor || null });
  };
  // 1) our guarded writes to Sitewire (journal)
  for (const w of (await db.query(`SELECT entity, field, source, created_at FROM sitewire_write_log WHERE application_id=$1 ORDER BY created_at DESC LIMIT 500`, [appId])).rows) {
    push(w.created_at, 'write', `PILOT ${w.source || 'push'}: ${w.entity || 'record'}${w.field ? ' · ' + w.field : ''}`);
  }
  // 2) Sitewire draw lifecycle events (draw_events come back unsorted — we sort by occurred_at)
  for (const d of (await db.query(`SELECT number, events FROM sitewire_draws WHERE application_id=$1`, [appId])).rows) {
    for (const e of (Array.isArray(d.events) ? d.events : [])) {
      push(e.occurred_at, 'draw', `Draw #${d.number ?? '—'}: ${String(e.event || 'event').replace(/_/g, ' ')}`, e.actor || (e.actor_role) || null);
    }
  }
  // 3) money released (our ledger)
  for (const l of (await db.query(`SELECT sitewire_draw_id, net_release_cents, release_date, funded_status, created_at, created_by FROM draw_disbursements WHERE application_id=$1`, [appId])).rows) {
    // release_date is a date-only column → keep it a calendar day (dateOnly); fall back to the true
    // created_at instant when no release date was recorded.
    push(l.release_date || l.created_at, 'money', `Release recorded: net ${T.usd(l.net_release_cents)} (${l.funded_status})${l.sitewire_draw_id ? ' · draw #' + l.sitewire_draw_id : ''}`, null, !!l.release_date);
  }
  // 4) findings accept/dispute lifecycle
  for (const f of (await db.query(`SELECT sitewire_draw_id, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at FROM draw_findings WHERE application_id=$1`, [appId])).rows) {
    push(f.delivered_at, 'findings', `Findings delivered to borrower (draw #${f.sitewire_draw_id})`);
    push(f.accepted_at, 'findings', `Borrower ACCEPTED findings (${f.accepted_via || 'portal'})`);
    push(f.disputed_at, 'findings', 'Borrower DISPUTED findings');
    push(f.resolved_at, 'findings', 'Dispute resolved');
  }
  // 5) Scope-of-Work reallocations
  for (const c of (await db.query(`SELECT status, reason, created_at, decided_at FROM change_requests WHERE application_id=$1 AND field='sow_reallocation'`, [appId])).rows) {
    push(c.created_at, 'reallocation', `Scope-of-Work change requested${c.reason ? ': ' + c.reason : ''}`);
    if (c.status === 'approved') push(c.decided_at, 'reallocation', 'Scope-of-Work change applied');
  }
  // 6) INBOUND changes PILOT observed on the Sitewire side (bidirectional Phase 1) — the other half of
  //    the two-way trail: what changed in Sitewire, not just what PILOT pushed. Baseline rows are the
  //    go-forward cutover and aren't interesting to a reader, so they're skipped.
  const IN_LABEL = { status: 'status', total_approved_cents: 'approved total', approved_cents: 'approved', new_draw: 'new draw request' };
  const usdCents = (v) => { const n = Number(v); return Number.isFinite(n) ? T.usd(n) : v; };
  for (const p of (await db.query(
    `SELECT sitewire_draw_id, field, old_value, new_value, occurred_at FROM sitewire_pull_field_change
       WHERE application_id=$1 AND field <> 'baseline' ORDER BY occurred_at DESC LIMIT 500`, [appId])).rows) {
    const money = /cents$/.test(p.field);
    const oldV = money ? usdCents(p.old_value) : String(p.old_value == null ? '—' : p.old_value).replace(/_/g, ' ');
    const newV = money ? usdCents(p.new_value) : String(p.new_value == null ? '—' : p.new_value).replace(/_/g, ' ');
    const label = IN_LABEL[p.field] || p.field;
    const summary = p.field === 'new_draw'
      ? `Sitewire: a new draw request came in (draw #${p.sitewire_draw_id})`
      : `Sitewire changed ${label} on draw #${p.sitewire_draw_id}: ${oldV} → ${newV}`;
    push(p.occurred_at, 'inbound', summary);
  }
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return ev;
}

// Assemble a per-draw PACKET (Built/Rabbet "draw packaging"): cover + schedule of values with
// % complete + this draw's per-line requested/approved + inspection findings + lien waivers, as
// one Excel workbook. Read-only, assembled from persisted data (no live Sitewire call needed).
async function buildDrawPacket(appId, drawId) {
  const c = (x) => Math.round(Number(x || 0)) / 100;
  const a = (await db.query(`SELECT ys_loan_number, property_address->>'oneLine' AS address FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  const draw = (await db.query(`SELECT number, status, submitted_at, approved_at, total_requested_cents, total_approved_cents FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId])).rows[0] || {};
  const rollup = await rollupMod.loadRollup(db, appId);
  // this draw's requests keyed to their SOW line (via the crosswalk)
  const reqRows = (await db.query(
    `SELECT r.requested_cents, r.approved_cents, r.inspection_count, ji.sow_line_key, ji.name
       FROM sitewire_draw_requests r LEFT JOIN sitewire_job_item_links ji ON ji.sitewire_job_item_id=r.sitewire_job_item_id AND ji.application_id=$2
      WHERE r.sitewire_draw_id=$1`, [drawId, appId])).rows;
  const reqByLine = {};
  for (const r of reqRows) { const k = r.sow_line_key || r.name; const x = reqByLine[k] || { req: 0, appr: 0 }; x.req += Number(r.requested_cents) || 0; x.appr += Number(r.approved_cents) || 0; reqByLine[k] = x; }
  const findings = (await db.query(
    `SELECT fl.name, fl.requested_cents, fl.approved_cents, fl.not_approved_cents, fl.photo_count, fl.video_count, fl.inspector_comments
       FROM draw_finding_lines fl JOIN draw_findings f ON f.id=fl.finding_id WHERE f.sitewire_draw_id=$1 ORDER BY fl.id`, [drawId])).rows;
  const waivers = (await db.query(`SELECT tier, party_name, kind, scope, amount_cents, status FROM draw_lien_waivers WHERE sitewire_draw_id=$1 ORDER BY id`, [drawId])).rows;

  const rows = [];
  rows.push(['DRAW PACKET']);
  rows.push(['Loan', a.ys_loan_number || '', 'Property', a.address || '']);
  rows.push(['Draw #', draw.number ?? '', 'Status', draw.status || '', 'Submitted', draw.submitted_at ? String(draw.submitted_at).slice(0, 10) : '', 'Approved', draw.approved_at ? String(draw.approved_at).slice(0, 10) : '']);
  rows.push([]);
  rows.push(['SCHEDULE OF VALUES']);
  rows.push(['Line item', 'Budget', 'Drawn to date', 'This draw requested', 'This draw approved', 'Remaining', '% complete']);
  for (const l of rollup.lines.filter((x) => x.kind === 'line' || x.kind === 'contingency' || x.kind === 'gc')) {
    const q = reqByLine[l.sow_line_key] || { req: 0, appr: 0 };
    rows.push([l.label, c(l.budgeted), c(l.drawn), c(q.req), c(q.appr), c(l.remaining), l.pct_complete]);
  }
  rows.push(['TOTAL', c(rollup.project.budget), c(rollup.project.drawn), c(draw.total_requested_cents), c(draw.total_approved_cents), c(rollup.project.remaining), rollup.project.pct_complete]);
  if (findings.length) {
    rows.push([]); rows.push(['INSPECTION FINDINGS']);
    rows.push(['Line item', 'Requested', 'Approved', 'Not approved', 'Photos', 'Videos', 'Inspector note']);
    for (const f of findings) rows.push([f.name || '', c(f.requested_cents), c(f.approved_cents), c(f.not_approved_cents), Number(f.photo_count) || 0, Number(f.video_count) || 0, f.inspector_comments || '']);
  }
  if (waivers.length) {
    rows.push([]); rows.push(['LIEN WAIVERS']);
    rows.push(['Tier', 'Party', 'Type', 'Scope', 'Amount', 'Status']);
    for (const w of waivers) rows.push([w.tier, w.party_name || '', w.kind, w.scope, c(w.amount_cents), w.status]);
  }
  return rows;
}

// ---- GET /files/:id/draws/:drawId/packet — the draw packet as an Excel workbook ----
router.get('/files/:id/draws/:drawId/packet', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [req.params.drawId, req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  try {
    const buf = buildXlsx(await buildDrawPacket(req.params.id, req.params.drawId), `Draw ${req.params.drawId}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="draw-packet-${req.params.drawId}.xlsx"`);
    res.send(buf);
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /files/:id/activity — the draw audit trail (examiner-ready) ----
router.get('/files/:id/activity', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json({ activity: await buildDrawActivity(req.params.id) }); }
  catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /files/:id/activity/export — audit trail as an Excel workbook ----
router.get('/files/:id/activity/export', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const activity = await buildDrawActivity(req.params.id);
    const rows = [['When', 'Type', 'Detail', 'Who']];
    for (const a of activity) rows.push([a.at, a.kind, a.summary, a.actor || '']);
    const buf = buildXlsx(rows, 'Draw Activity');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="draw-activity-${req.params.id}.xlsx"`);
    res.send(buf);
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /files/:id/lien-waivers-setting — turn the lien-waiver workflow on/off for THIS project ----
// A compliance control, so it needs platform_setup (like the global setting) and is journaled —
// a draw coordinator must not be able to quietly switch the gate off and then release (audit #4).
router.post('/files/:id/lien-waivers-setting', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  // true = on for this project, false = off for this project, null = inherit the global setting
  const v = req.body.enabled === null ? null : req.body.enabled === true ? true : req.body.enabled === false ? false : undefined;
  if (v === undefined) return res.status(400).json({ error: 'enabled must be true, false, or null (inherit global)' });
  // upsert so the setting persists even before the file has a link row (else a plain UPDATE is a
  // silent no-op that still returns 200 — the "returned 200 but didn't save" class).
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, matched_by, state, require_lien_waivers)
     VALUES ($1,'created','pending',$2)
     ON CONFLICT (application_id) DO UPDATE SET require_lien_waivers=$2, updated_at=now()`,
    [appId, v]);
  await orchestrator.journal({ appId, entity: 'settings', field: 'require_lien_waivers', newValue: v, source: 'review_resolve', changed: true }).catch(() => {});
  res.json({ ok: true, require_lien_waivers: v });
});

// ---- GET /project?loan=<ys_loan_number> — look up a funded file to enable advanced features on ----
// Powers the admin "turn on retainage / lien waivers for a specific project" form. Returns the file
// plus its CURRENT per-project overrides (null = inherits the global default / off).
router.get('/project', requirePermission('platform_setup'), async (req, res) => {
  const loan = String(req.query.loan || '').trim();
  if (!loan) return res.status(400).json({ error: 'enter a loan number' });
  const a = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address->>'oneLine' AS address, a.status,
            l.retainage_pct, l.require_lien_waivers
       FROM applications a LEFT JOIN sitewire_property_links l ON l.application_id=a.id
      WHERE upper(a.ys_loan_number)=upper($1) AND a.deleted_at IS NULL LIMIT 1`, [loan])).rows[0];
  // 404 (not 403) when the actor can't see the file, so a scoped setup user can't use this to probe
  // whether a loan number exists on someone else's file — same response as a genuinely-missing loan.
  if (!a || !(await canSeeFile(req, a.id))) return res.status(404).json({ error: `no file found for loan number "${loan}"` });
  res.json({ application_id: a.id, ys_loan_number: a.ys_loan_number, address: a.address, status: a.status,
    retainage_pct: a.retainage_pct != null ? Number(a.retainage_pct) : null, require_lien_waivers: a.require_lien_waivers });
});

// ---- POST /files/:id/advanced-settings — enable/adjust the OPT-IN features for ONE project ----
// Retainage % and the lien-waiver gate are off by default and not in the standard workflow; this is
// how an admin turns them on for a specific file. Upserts the link row so it works even before the
// file is pushed to Sitewire. platform_setup + journaled (a coordinator can't quietly change these).
router.post('/files/:id/advanced-settings', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  // retainage_pct: a number 0..100, or null to inherit the global default
  let ret; // undefined = don't touch
  if ('retainage_pct' in b) {
    if (b.retainage_pct === null || b.retainage_pct === '') ret = null;
    else { const n = Number(b.retainage_pct); if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'retainage % must be a number between 0 and 100 (or blank to inherit)' }); ret = n; }
  }
  // require_lien_waivers: true/false/null(inherit)
  let lw;
  if ('require_lien_waivers' in b) lw = b.require_lien_waivers === null ? null : b.require_lien_waivers === true ? true : b.require_lien_waivers === false ? false : undefined;
  if (ret === undefined && lw === undefined) return res.status(400).json({ error: 'nothing to change' });
  // upsert the link row so this works before the file is pushed (matched_by/state satisfy the CHECKs)
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, matched_by, state, retainage_pct, require_lien_waivers)
     VALUES ($1,'created','pending',$2,$3)
     ON CONFLICT (application_id) DO UPDATE SET
       retainage_pct = ${ret === undefined ? 'sitewire_property_links.retainage_pct' : '$2'},
       require_lien_waivers = ${lw === undefined ? 'sitewire_property_links.require_lien_waivers' : '$3'},
       updated_at=now()`,
    [appId, ret === undefined ? null : ret, lw === undefined ? null : lw]);
  if (ret !== undefined) await orchestrator.journal({ appId, entity: 'settings', field: 'retainage_pct', newValue: ret, source: 'review_resolve', changed: true }).catch(() => {});
  if (lw !== undefined) await orchestrator.journal({ appId, entity: 'settings', field: 'require_lien_waivers', newValue: lw, source: 'review_resolve', changed: true }).catch(() => {});
  res.json({ ok: true, retainage_pct: ret, require_lien_waivers: lw });
});

// ---- POST /files/:id/coordinator — set the per-file draw-coordinator (admin override) ----
router.post('/files/:id/coordinator', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const staffId = req.body.coordinator_staff_id || null;
  if (staffId && !isUuid(staffId)) return res.status(400).json({ error: 'unknown staff user' });
  if (staffId) { const ok = (await db.query(`SELECT 1 FROM staff_users WHERE id=$1 AND is_active`, [staffId])).rowCount; if (!ok) return res.status(400).json({ error: 'unknown staff user' }); }
  // upsert so a coordinator can be set before the file has a link row (a plain UPDATE would be a
  // silent 200 no-op otherwise).
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, matched_by, state, coordinator_staff_id)
     VALUES ($1,'created','pending',$2)
     ON CONFLICT (application_id) DO UPDATE SET coordinator_staff_id=$2, updated_at=now()`,
    [appId, staffId]);
  res.json({ ok: true });
});

// ===================================================================================
//  FINDINGS — deliver to the borrower; decide disputed lines (Workflow B)
// ===================================================================================

// ---- POST /files/:id/findings/:drawId/deliver — persist + send findings to the borrower ----
router.post('/files/:id/findings/:drawId/deliver', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  // Never re-deliver over a finding the borrower has already acted on — persisting would wipe
  // their acceptance / dispute evidence and leave a stale wire deadline (audit F2). Re-pulling
  // a still-'delivered' finding to refresh photos is fine.
  const existing = (await db.query(`SELECT status FROM draw_findings WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
  if (existing && ['accepted', 'disputed', 'resolved'].includes(existing.status) && !req.body.force) {
    return res.status(409).json({ error: `these findings were already ${existing.status} by the borrower — re-delivering would erase that. Pass force:true only if you intend to reset it.` });
  }
  try {
    const f = (await db.query(`SELECT a.property_address->>'oneLine' AS address, b.id AS borrower_id, b.email AS borrower_email FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0] || {};
    const deliveredTo = { borrower: f.borrower_email || null };
    const result = await reconcile.persistDrawFindings(appId, drawId, deliveredTo);
    // notify borrower (portal + email) + the loan team + coordinator. The email links to the
    // token accept page (`/draw-accept/:token`) so the borrower can review + one-click accept
    // straight from the email, or sign in there to dispute a line (research doc §14).
    const addr = f.address || 'your property';
    const acceptLink = result.reply_token ? `/draw-accept/${result.reply_token}` : `/app/${appId}`;
    // notifyAppBorrowers (not notifyBorrower) so a co-borrower who can see the file
    // ALSO gets the "results ready" email — the primary-only send made the
    // co-borrower first hear of it via the later reminder (owner-reported audit).
    if (f.borrower_id) {
      // Build the FULL findings email: the one-key-fact hero (approved of requested), a per-line
      // grid (what the inspector approved on each line), the photo/video count, and TWO actions —
      // Accept (releases the draw) + Push back (opens the review page in dispute mode). All
      // borrower-safe: line names scrubbed here (defense-in-depth) and again in notifyBorrower.
      const scrub = require('../lib/borrower-safe').scrubText;
      const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
      const flines = (await db.query(
        `SELECT name, requested_cents, approved_cents, not_approved_cents, photo_count, video_count FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [result.id])).rows;
      const totReq = flines.reduce((s, l) => s + (Number(l.requested_cents) || 0), 0);
      const totAppr = flines.reduce((s, l) => s + (Number(l.approved_cents) || 0), 0);
      const photos = flines.reduce((s, l) => s + (Number(l.photo_count) || 0), 0);
      const videos = flines.reduce((s, l) => s + (Number(l.video_count) || 0), 0);
      const CAP = 14; // keep the email readable — a huge draw links out to the full page for the rest
      const meta = [{ label: 'Property', value: addr }];
      for (const l of flines.slice(0, CAP)) {
        meta.push({ label: scrub(l.name) || 'Line item',
          value: Number(l.not_approved_cents) > 0 ? `${usd(l.approved_cents)} approved of ${usd(l.requested_cents)}` : `${usd(l.approved_cents)} approved` });
      }
      if (flines.length > CAP) meta.push({ label: `+ ${flines.length - CAP} more line item(s)`, value: 'open the results to see them all' });
      const pv = [];
      if (photos) pv.push(`${photos} photo${photos === 1 ? '' : 's'}`);
      if (videos) pv.push(`${videos} video${videos === 1 ? '' : 's'}`);
      const disputeLink = result.reply_token ? `/draw-accept/${result.reply_token}?tab=dispute` : `/app/${appId}`;
      await notify.notifyAppBorrowers(appId, {
        type: 'draw_findings', title: 'Your draw inspection results are ready',
        badge: { text: 'Action needed', tone: 'action' },
        hero: { label: 'Approved for release', value: usd(totAppr), sub: `of ${usd(totReq)} requested`, tone: 'positive' },
        body: `Your inspection is complete${pv.length ? ` — ${pv.join(' and ')} on file` : ''}. Here is what the inspector approved on each line. When you’re ready, accept to release your draw — or push back on any line you disagree with.`,
        meta,
        callout: { title: 'What happens when you accept', body: 'Accepting releases your draw — your funds are typically wired within a day or two. Want to look first? Open the results to see every photo and download your inspection report (PDF).', tone: 'action' },
        applicationId: appId, link: acceptLink, ctaLabel: 'Review & accept',
        cta2Label: 'Push back on a line', cta2Link: disputeLink }).catch(() => {});
    }
    // In-app only (owner-directed 2026-07-20): a confirmation that the coordinator
    // just delivered findings is not a whole-team EMAIL — the borrower's own
    // "results ready" email (above) is the real send; this is a desk marker.
    await notify.notifyAppStaff(appId, { type: 'draw_findings', title: 'Draw findings delivered to borrower', inAppOnly: true,
      body: `Inspection findings for ${addr} were delivered to the borrower to accept or dispute.`, applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    // Auto-deliver artifacts: durably archive the inspector's (expiring) media NOW and pre-build the PILOT +
    // borrower-safe reports, so the durable photos + both branded PDFs are ready the instant findings land —
    // never dependent on a later manual "archive" click (a report built pre-archive had zero photos). Fully
    // best-effort: it never throws or reverses the delivery just completed. (drawReport.autoDeliverArtifacts.)
    // Bounded on the response path: we await up to a short budget so the common (fast) case confirms
    // "reports ready", but a slow/unreachable media CDN can NEVER hang this delivery request (the archive is
    // a sequential per-item fetch with only a per-item timeout). Past the budget the work keeps running in the
    // background to completion (every step is idempotent + independently caught) — we just answer promptly.
    const work = drawReport.autoDeliverArtifacts(appId, drawId).catch(() => ({ archived: 0, reports: [] }));
    const budgetMs = Number(process.env.DRAW_AUTODELIVER_BUDGET_MS) || 20000;
    // .unref() so the budget timer never keeps the event loop alive on the fast path (work wins → the timer
    // is still armed but must not hold the process); it only resolves an already-settled race if it fires.
    const artifacts = await Promise.race([work, new Promise((r) => { const t = setTimeout(() => r({ archived: 0, reports: [], pending: true }), budgetMs); if (t.unref) t.unref(); })]);
    res.json({ ok: true, ...result, media_archived: artifacts.archived, reports_ready: artifacts.reports, reports_pending: !!artifacts.pending });
  } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- GET /findings/:findingId — full finding detail (staff) ----
router.get('/findings/:findingId', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await canSeeFile(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  const lines = (await db.query(`SELECT * FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows
    // Never leak internal storage refs to the client: replace the raw dispute_media (which holds
    // storage_ref) with a safe descriptor the UI turns into a serving URL. Borrower dispute evidence
    // is fetched byte-by-byte through the guarded /dispute-media/:idx route below.
    .map((l) => {
      const ev = Array.isArray(l.dispute_media) ? l.dispute_media : [];
      const dispute_evidence = ev.map((m, idx) => ({ idx, filename: (m && m.filename) || `evidence ${idx + 1}`, kind: (m && m.kind) || 'file', content_type: (m && m.content_type) || null }));
      const { dispute_media, ...rest } = l;
      return { ...rest, dispute_evidence };
    });
  // Never hand the borrower's no-login reply_token to a staff client — it is the borrower's own
  // accept/dispute capability, and a staffer must act as staff, not impersonate the borrower (audit L1).
  const { reply_token, ...findingSafe } = f;
  res.json({ finding: findingSafe, lines });
});

// ---- GET /findings/lines/:lineId/dispute-media/:idx — serve one borrower dispute-evidence file (staff) ----
// The borrower attached these when they pushed back on a line. Streamed from PILOT's durable storage
// after the manage_draws + file-visibility + line-belongs-to-file checks. GPS was stripped on upload.
router.get('/findings/lines/:lineId/dispute-media/:idx', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d{1,18}$/.test(String(req.params.lineId)) || !/^\d{1,4}$/.test(String(req.params.idx))) return res.status(404).end();
  const row = (await db.query(
    `SELECT dfl.dispute_media, df.application_id
       FROM draw_finding_lines dfl JOIN draw_findings df ON df.id=dfl.finding_id
      WHERE dfl.id=$1`, [req.params.lineId])).rows[0];
  if (!row || !(await canSeeFile(req, row.application_id))) return res.status(404).end();
  const ev = Array.isArray(row.dispute_media) ? row.dispute_media : [];
  const m = ev[Number(req.params.idx)];
  if (!m || !m.storage_ref) return res.status(404).end();
  let buf; try { buf = await storage.read(m.storage_ref); } catch (_) { return res.status(404).end(); }
  if (!buf || !buf.length) return res.status(404).end();
  setMediaHeaders(res, m.content_type);   // borrower-uploaded evidence: type is server-derived, but clamp on serve too
  return res.end(buf);
});

// ---- POST /findings/:findingId/lines/:lineId/decide — admin decides a disputed line ----
router.post('/findings/:findingId/lines/:lineId/decide', requirePermission('manage_draws'), async (req, res) => {
  const { findingId, lineId } = req.params;
  if (!/^\d+$/.test(findingId) || !/^\d+$/.test(lineId)) return res.status(404).json({ error: 'not found' });
  const decision = req.body.decision === 'approved' ? 'approved' : req.body.decision === 'rejected' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: 'decision must be approved or rejected' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [findingId])).rows[0];
  if (!f || !(await canSeeFile(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  const line = (await db.query(`SELECT * FROM draw_finding_lines WHERE id=$1 AND finding_id=$2`, [lineId, findingId])).rows[0];
  if (!line) return res.status(404).json({ error: 'line not found' });
  if (line.dispute_status !== 'open') return res.status(409).json({ error: 'line is not under an open dispute' });

  // On APPROVE, push the borrower's desired approved amount back to Sitewire (guarded) — or
  // fall back to a processor-confirm note if writes are off. Never guessed.
  let pushed = false, pushNote = null;
  if (decision === 'approved' && line.dispute_desired_cents != null && line.sitewire_request_id) {
    if (cfg.sitewireEnabled && cfg.sitewireOutboundEnabled) {
      try {
        await orchestrator.circuitCheck(1);
        const desired = Math.round(Number(line.dispute_desired_cents));
        const r = await client.updateRequest(line.sitewire_request_id, { approved_cents: desired, lender_comments: `Dispute approved (PILOT): ${req.body.note || ''}`.slice(0, 240) });
        if (!(r && r.__dryrun)) {
          let saved = desired; try { const fresh = await client.getRequest(line.sitewire_request_id); if (fresh && fresh.approved_cents != null) saved = fresh.approved_cents; } catch (_) {}
          await db.query(`UPDATE sitewire_draw_requests SET approved_cents=$2, updated_at=now() WHERE sitewire_request_id=$1`, [line.sitewire_request_id, saved]);
          await orchestrator.journal({ appId: f.application_id, entity: 'request', entityId: Number(line.sitewire_request_id), field: 'approved_cents', newValue: saved, source: 'dispute' });
          pushed = true;
        } else pushNote = 'writes are in dry-run — Sitewire not changed';
      } catch (e) { pushNote = `Sitewire push failed (${e.message}); confirm the new amount by hand`; }
    } else pushNote = 'Sitewire writes are off — a processor must confirm the new amount by hand';
  }
  await db.query(`UPDATE draw_finding_lines SET dispute_status=$2, lender_comments=COALESCE($3,lender_comments), dispute_decided_by=$4, dispute_decided_at=now(), approved_cents=CASE WHEN $2='approved' AND dispute_desired_cents IS NOT NULL THEN dispute_desired_cents ELSE approved_cents END, not_approved_cents=CASE WHEN $2='approved' AND dispute_desired_cents IS NOT NULL THEN GREATEST(0, requested_cents - dispute_desired_cents) ELSE not_approved_cents END, updated_at=now() WHERE id=$1`,
    [lineId, decision, req.body.note || null, req.actor.id]);
  // if no more open disputes, mark the finding resolved AND close the loop back to the borrower
  const openLeft = (await db.query(`SELECT count(*)::int c FROM draw_finding_lines WHERE finding_id=$1 AND dispute_status='open'`, [findingId])).rows[0].c;
  if (openLeft === 0) {
    await db.query(`UPDATE draw_findings SET status='resolved', resolved_at=now(), updated_at=now() WHERE id=$1`, [findingId]);
    // Tell the borrower the OUTCOME of the dispute they raised — designed + borrower-safe (only the amounts
    // they can already see; no fee/net/partner). This closes the dispute loop (previously staff decided
    // silently and the borrower was never told).
    try {
      const scrub = require('../lib/borrower-safe').scrubText;
      const decided = (await db.query(
        `SELECT name, dispute_status, approved_cents, dispute_desired_cents FROM draw_finding_lines
          WHERE finding_id=$1 AND dispute_status IN ('approved','rejected') ORDER BY id`, [findingId])).rows;
      const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
      const approvedN = decided.filter((l) => l.dispute_status === 'approved').length;
      // scrub the line NAME (defense-in-depth for the frozen never-expose-a-partner rule — the meta label
      // isn't scrubbed by the notify chokepoint) and only say "now $X" when the amount actually changed.
      const meta = decided.map((l) => ({ label: scrub(l.name) || 'Line item',
        value: l.dispute_status === 'approved'
          ? (l.dispute_desired_cents != null ? `Approved — now ${usd(l.approved_cents)}` : 'Approved on review')
          : `Reviewed — kept at ${usd(l.approved_cents)}` }));
      await notify.notifyAppBorrowers(f.application_id, {
        type: 'draw_dispute_resolved', title: 'We reviewed your draw dispute',
        badge: { text: 'Reviewed', tone: approvedN ? 'positive' : 'neutral' },
        body: approvedN
          ? `We reviewed the item(s) you flagged on your inspection results — ${approvedN} of ${decided.length} ${approvedN === 1 ? 'was' : 'were'} approved for a higher amount, and the rest were reviewed and kept as-is. Your updated results are in your portal.`
          : 'We reviewed the item(s) you flagged on your inspection results. After review they were kept as-is. The full details are in your portal.',
        meta, applicationId: f.application_id, link: `/app/${f.application_id}`, ctaLabel: 'View your draw' }).catch(() => {});
    } catch (_) { /* notification is best-effort — the decision is already recorded */ }
  }
  res.json({ ok: true, decision, pushed, note: pushNote, disputes_open: openLeft });
});

// ===================================================================================
//  SOW CHANGE REQUESTS / BUDGET REALLOCATION (Workflow A)
// ===================================================================================

// ---- GET /files/:id/change-requests — list SOW change requests for a file ----
router.get('/files/:id/change-requests', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const rows = (await db.query(
    `SELECT cr.*, d.deltas, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status
       FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id
      WHERE cr.application_id=$1 AND cr.field='sow_reallocation' ORDER BY cr.created_at DESC`, [req.params.id])).rows;
  res.json({ change_requests: rows });
});

// Explode a proposed Scope of Work AND reconcile it to the file's frozen budget (the same target the
// crosswalk's CURRENT budgets were reconciled to at birth), so a ≤$1 per-cell percentage-rounding
// drift can't make a genuine net-zero reallocation read as non-net-zero and get wrongly rejected.
// Falls back to a raw explode when the frozen budget isn't known.
function reconciledExplode(rollup, state) {
  const raw = M.explodeSow(state, {});
  const budgetCents = Number(rollup && rollup.project && rollup.project.budget) || 0;
  return budgetCents > 0 ? M.reconcileToBudget(raw, budgetCents) : raw;
}

// ---- POST /files/:id/change-requests — create + validate a SOW reallocation ----
router.post('/files/:id/change-requests', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const proposedPayload = req.body.proposed_payload;
  if (!proposedPayload || !proposedPayload.state) return res.status(400).json({ error: 'proposed_payload (the new Scope of Work) is required' });
  try {
    const a = (await db.query(`SELECT status FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!a) return res.status(404).json({ error: 'file not found' });
    const rollup = await rollupMod.loadRollup(db, appId);
    // Reconcile the proposed explosion to the frozen budget BEFORE building cells — the same way
    // the birth push does (orchestrator) and the way the crosswalk's `before` budgets were set.
    // Otherwise a ≤$1 per-cell percentage-rounding drift makes a genuine net-zero move read as
    // non-net-zero and get wrongly rejected (esp. Gold Standard's 5% contingency).
    const ex = reconciledExplode(rollup, proposedPayload.state);
    const cells = buildReallocationCells(rollup, ex.items);
    const phase = phaseFor(a.status);
    const plan = planReallocation(cells, { phase, variancePct: await variancePct() });
    // persist the change request (both versions live on record)
    const oldCells = cells.map((c) => ({ key: c.key, label: c.label, cents: c.budget_cents }));
    const newCells = cells.map((c) => ({ key: c.key, label: c.label, cents: c.new_cents }));
    const cr = (await db.query(
      `INSERT INTO change_requests (application_id, field, field_label, old_value, new_value, reason, status, requested_by_kind, requested_by_id)
       VALUES ($1,'sow_reallocation','Scope of Work reallocation',$2,$3,$4,'pending','staff',NULL) RETURNING id`,
      [appId, JSON.stringify(oldCells), JSON.stringify(newCells), req.body.reason ? String(req.body.reason).slice(0, 2000) : null])).rows[0];
    await db.query(
      `INSERT INTO sow_change_request_details (change_request_id, application_id, proposed_payload, deltas, net_zero, after_ctc, needs_capital_partner, capital_partner_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cr.id, appId, JSON.stringify(proposedPayload), JSON.stringify(plan.cells), plan.totals.net_zero, phase === 'after_ctc', plan.needs_capital_partner, plan.needs_capital_partner ? 'pending' : null]);
    res.json({ ok: true, change_request_id: cr.id, plan });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /change-requests/:crId/capital-partner — record capital-partner decision ----
router.post('/change-requests/:crId/capital-partner', requirePermission('manage_draws'), async (req, res) => {
  if (!isUuid(req.params.crId)) return res.status(404).json({ error: 'not found' });
  const status = ['approved', 'rejected', 'pending'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status must be approved, rejected, or pending' });
  const d = (await db.query(`SELECT d.*, cr.application_id FROM sow_change_request_details d JOIN change_requests cr ON cr.id=d.change_request_id WHERE d.change_request_id=$1`, [req.params.crId])).rows[0];
  if (!d || !(await canSeeFile(req, d.application_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`UPDATE sow_change_request_details SET capital_partner_status=$2, updated_at=now() WHERE change_request_id=$1`, [req.params.crId, status]);
  res.json({ ok: true, capital_partner_status: status });
});

// ---- POST /change-requests/:crId/apply — apply an approved reallocation ----
router.post('/change-requests/:crId/apply', requirePermission('manage_draws'), async (req, res) => {
  const crId = req.params.crId;
  if (!isUuid(crId)) return res.status(404).json({ error: 'not found' });
  const cr = (await db.query(`SELECT cr.*, d.proposed_payload, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id WHERE cr.id=$1 AND cr.field='sow_reallocation'`, [crId])).rows[0];
  if (!cr || !(await canSeeFile(req, cr.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (cr.status === 'approved') return res.status(409).json({ error: 'already applied' });
  const appId = cr.application_id;
  const a = (await db.query(`SELECT status FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!a) return res.status(404).json({ error: 'file not found' });
  const phase = phaseFor(a.status);
  const proposedPayload = cr.proposed_payload;
  try {
    // re-validate against the CURRENT rollup (drawn amounts may have moved since creation)
    const rollup = await rollupMod.loadRollup(db, appId);
    const ex = reconciledExplode(rollup, proposedPayload.state);
    const cells = buildReallocationCells(rollup, ex.items);
    const plan = planReallocation(cells, { phase, variancePct: await variancePct() });
    if (!plan.ok) return res.status(422).json({ error: 'reallocation is no longer valid', plan });
    if (plan.needs_capital_partner && cr.capital_partner_status !== 'approved') return res.status(409).json({ error: 'capital-partner approval is required before applying' });

    // AFTER clear-to-close + net-zero: money moves between lines, total unchanged. Write the
    // new Scope of Work (gated by the exact-match budget check) and re-push the budget to
    // Sitewire (the crosswalk diff moves money between job items). rehab_budget never changes.
    if (phase === 'after_ctc' && plan.totals.net_zero) {
      const gate = await rehab.checkSowBudget(appId, proposedPayload);
      if (!gate.ok) return res.status(422).json({ error: `new Scope of Work must still total the frozen budget to the cent — ${gate.message || 'mismatch'}` });
      // Write the new Version-2 Scope of Work AND reopen its condition (→ 'issue', sign-off
      // cleared) so the borrower re-signs the revised budget — mirrors the budget-change reopen
      // pattern. A net-zero move keeps total == frozen budget, so it can be re-signed.
      await db.query(`UPDATE checklist_items SET tool_payload=$2, status='issue', signed_off_at=NULL, signed_off_by=NULL,
        notes=COALESCE(notes,'') || CASE WHEN COALESCE(notes,'')='' THEN '' ELSE E'\n' END || '[auto] Scope of Work reallocated — please re-sign the revised budget.', updated_at=now()
        WHERE application_id=$1 AND tool_key='rehab_budget'`, [appId, JSON.stringify(proposedPayload)]);
      await db.query(`UPDATE sitewire_property_links SET budget_version=budget_version+1, updated_at=now() WHERE application_id=$1`, [appId]);
      enqueueSitewirePush(appId, 'push_file').catch(() => {});
      await db.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, [crId, req.actor.id]);
      await db.query(`UPDATE sow_change_request_details SET updated_at=now() WHERE change_request_id=$1`, [crId]);
      // Only claim a Sitewire push when the integration is actually on — otherwise the enqueue
      // no-ops and the DB SOW would silently diverge from Sitewire (audit E-REALLOC-FALSEPUSH).
      const willPush = !!cfg.sitewireEnabled;
      // In-app only (owner-directed 2026-07-20): a confirmation that a reallocation
      // was APPLIED is a desk marker, not a whole-team email. (The "needs
      // re-registration" variant below is Action-needed and still emails.)
      await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Budget reallocation applied', badge: { text: 'Applied', tone: 'positive' }, inAppOnly: true,
        body: willPush ? 'A net-zero Scope-of-Work reallocation was applied and is being pushed to Sitewire.' : 'A net-zero Scope-of-Work reallocation was applied to the Scope of Work (Sitewire is currently off — it will sync when turned on).',
        applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
      return res.json({ ok: true, applied: true, pushed_to_sitewire: willPush });
    }

    // BEFORE clear-to-close OR a total change: the construction total is changing, which
    // re-sizes the loan. We never silently change the frozen budget — mark the request
    // approved and flag it for product re-registration (Products & Pricing re-opens).
    await db.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=COALESCE($3,decision_note), updated_at=now() WHERE id=$1`, [crId, req.actor.id, 'Total changed — requires product re-registration on the new budget']);
    await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Scope-of-Work change needs re-registration', badge: { text: 'Action needed', tone: 'action' },
      body: 'A Scope-of-Work change alters the construction total. Re-register the product on the new budget in Products & Pricing before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    res.json({ ok: true, applied: false, requires_reregister: true, plan });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /change-requests/:crId/export — Version 1 vs Version 2 as an Excel workbook ----
router.get('/change-requests/:crId/export', requirePermission('manage_draws'), async (req, res) => {
  if (!isUuid(req.params.crId)) return res.status(404).json({ error: 'not found' });
  const cr = (await db.query(`SELECT cr.*, d.deltas FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id WHERE cr.id=$1 AND cr.field='sow_reallocation'`, [req.params.crId])).rows[0];
  if (!cr || !(await canSeeFile(req, cr.application_id))) return res.status(403).json({ error: 'forbidden' });
  const deltas = Array.isArray(cr.deltas) ? cr.deltas : [];
  const usd = (c) => Math.round(Number(c || 0)) / 100; // numeric cells (dollars) for real Excel math
  const rows = [['Line item', 'Version 1 (current)', 'Already drawn', 'Version 2 (proposed)', 'Change', 'Movable (undrawn)', 'Over threshold']];
  let b = 0, aTot = 0, dr = 0;
  for (const c of deltas) {
    b += Number(c.budget_cents || 0); aTot += Number(c.new_cents || 0); dr += Number(c.drawn_cents || 0);
    rows.push([c.label, usd(c.budget_cents), usd(c.drawn_cents), usd(c.new_cents), usd(c.delta_cents), usd(c.movable_cents), c.material ? 'YES' : '']);
  }
  rows.push(['TOTAL', usd(b), usd(dr), usd(aTot), usd(aTot - b), '', '']);
  const buf = buildXlsx(rows, 'SOW Reallocation');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="sow-reallocation-${req.params.crId}.xlsx"`);
  res.send(buf);
});

module.exports = router;
