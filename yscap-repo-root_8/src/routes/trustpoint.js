'use strict';
/**
 * TrustPoint routes (phase 2 — blueprint §4).
 *   STAFF-ONLY router (requireAuth + requireStaff wall + per-route capability gates):
 *   status, the linking desk (platform_setup), per-file mirror reads (manage_draws +
 *   file scope), per-line entry/write-back/report (phase 3), webhook registration
 *   (platform_setup — the one outbound write, journaled + dry-run honored).
 *   The PUBLIC webhook receiver lives in routes/trustpoint-webhook.js (own parser +
 *   rate limit, mounted before the global JSON parser).
 * STAFF-ONLY SURFACES: TrustPoint/note-buyer names never reach a borrower here.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, visibleOfficersSql } = require('../lib/permissions');
const client = require('../trustpoint/client');
const mirror = require('../trustpoint/mirror');
const discovery = require('../trustpoint/discovery');
const parked = require('../trustpoint/parked');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
/* THE FILE SCOPE IS THE SHARED FIVE-WAY RULE, NOT THE ASSIGNEE BRANCH ALONE
   (owner-reported 2026-08-25: an appraisal XML import answering "not found", and a
   processor sent to the Encompass tab from the term sheet hitting a refusal).
   `assigneeExistsSql` is branch 4 of `visibleOfficersSql`'s five, so this tab used to
   refuse a staffer who reaches the file by DELEGATION (staff_users.visible_officer_ids)
   or by an OPEN workflow hand-off — while staff.js's own /applications/:id middleware,
   which uses the full rule, let them open the whole file screen. Same person, same file,
   one tab saying "not found". Never re-inline a file scope; ask permissions.js. */
async function canSeeFile(req, appId) {
  if (!isUuid(appId)) return false;
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${visibleOfficersSql('a', '$2')}`, [appId, req.actor.id]);
  return r.rowCount > 0;
}

// The whole router is STAFF-ONLY (the public webhook lives in routes/trustpoint-webhook.js,
// mounted separately before the JSON parser). requirePermission alone never authenticates —
// it needs req.actor from requireAuth (phase-2 audit BLOCKER #1).
router.use(requireAuth, requireStaff);

// ---- PARKED: the whole surface is closed (owner-directed 2026-08-24) --------------------
// Every route under /api/trustpoint is about the TrustPoint mirror — status, the linking desk,
// per-file reads, per-line entry, write-back, the report, webhook registration — so while the
// integration is parked they are refused as ONE gate rather than shape-by-shape. That also
// removes the TrustPoint SCREEN from the draw centre for free: `TrustpointPanel` loads
// `/files/:id/overview`, does `.catch(() => setOv(null))`, and renders nothing on null — so a
// refusal here hides the panel at BOTH of its mount points with no front-end change, and it
// comes back the moment the integration is un-parked. See ../trustpoint/parked.js.
//
// This does NOT touch the Blue Lake workflow the owner kept: the coordinator's "enter it in
// TrustPoint" task and email come from sitewire/trustpoint-intake.js off the SITEWIRE reconcile
// and never load this router, and the manual approve + release controls are /api/sitewire.
router.use((req, res, next) => {
  if (!parked.isParked()) return next();
  return res.status(410).json({ error: 'trustpoint_parked', parked: true, linked: false, message: parked.PARKED_REASON });
});

// ---- staff: status ----
router.get('/status', requirePermission('manage_draws'), async (req, res) => {
  try {
    const counts = (await db.query(`SELECT
        (SELECT count(*)::int FROM trustpoint_project_links WHERE application_id IS NOT NULL) AS linked,
        (SELECT count(*)::int FROM trustpoint_project_links WHERE application_id IS NULL) AS unlinked,
        (SELECT count(*)::int FROM trustpoint_draws) AS draws,
        (SELECT count(*)::int FROM trustpoint_webhook_events WHERE processed_at IS NULL) AS inbox_pending`)).rows[0];
    res.json({ enabled: client.enabled(), configured: client.available(), dryrun: cfg.trustpointDryrun,
      webhook_receiver: !!cfg.trustpointWebhookToken, ...counts });
  } catch (e) { console.warn('[trustpoint] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- staff: the linking desk ----
router.get('/projects', requirePermission('platform_setup'), async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT l.tp_project_id, l.application_id, l.matched_by, l.match_detail, l.candidate_reason,
              l.loan_external_id, l.project_name, l.address_text, l.tp_status, l.discarded, l.updated_at,
              a.ys_loan_number, a.property_address->>'oneLine' AS file_addr
         FROM trustpoint_project_links l
         LEFT JOIN applications a ON a.id = l.application_id
        ORDER BY (l.application_id IS NULL) DESC, l.updated_at DESC
        LIMIT 500`)).rows;
    res.json({ projects: rows });
  } catch (e) { console.warn('[trustpoint] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});
router.post('/projects/:tpId/link', requirePermission('platform_setup'), async (req, res) => {
  try {
    const appId = req.body && req.body.application_id;
    if (!isUuid(appId)) return res.status(400).json({ error: 'application_id required' });
    const app = (await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app) return res.status(404).json({ error: 'file not found' });
    const r = await discovery.linkProject(String(req.params.tpId), appId, { matchedBy: 'manual', staffId: req.actor.id });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e.code === 'already_linked' || e.code === 'file_taken') return res.status(409).json({ error: e.message });
    console.warn('[trustpoint] link error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});
router.post('/projects/:tpId/unlink', requirePermission('platform_setup'), async (req, res) => {
  try { res.json({ ok: true, ...(await discovery.unlinkProject(String(req.params.tpId), req.actor.id)) }); }
  catch (e) { console.warn('[trustpoint] unlink error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});
router.post('/sweep', requirePermission('platform_setup'), async (req, res) => {
  try { res.json({ ok: true, ...(await discovery.sweep()) }); }
  catch (e) { console.warn('[trustpoint] sweep error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- staff: per-file mirror (the read-only desk panel) ----
router.get('/files/:id/overview', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const link = (await db.query(`SELECT * FROM trustpoint_project_links WHERE application_id=$1`, [appId])).rows[0] || null;
    const draws = link ? (await db.query(
      `SELECT tp_draw_id, number, name, status, draw_type, requested_cents, approved_cents, disbursed_cents,
              to_disburse_cents, fees, retainage, contingency, inspector_allowance_rate, inspector_recommendation_rate,
              coordinator_name, submitted_at, approved_at, completed_at, disbursed_at, estimated_reimbursement_date,
              sitewire_draw_id, portal_draw_request_id, report_document_id, writeback_at, writeback_note, updated_at
         FROM trustpoint_draws WHERE application_id=$1 ORDER BY COALESCE(number, 0), tp_created_at`, [appId])).rows : [];
    const serviceOrders = link ? (await db.query(
      `SELECT tp_service_order_id, tp_draw_id, service_type, status, service_number, ordered_at, scheduled_at, completed_at, cancelled_at, inspector_allowance_rate
         FROM trustpoint_service_orders WHERE application_id=$1 ORDER BY COALESCE(ordered_at, completed_at) DESC NULLS LAST`, [appId])).rows : [];
    const milestones = link ? (await db.query(
      `SELECT tp_milestone_id, name, amount_cents, sow_line_key, matched_by FROM trustpoint_milestone_links WHERE application_id=$1 ORDER BY id`, [appId])).rows : [];
    // Resolve every raw status into its plain-language shape HERE (owner-directed 2026-07-27), so
    // the desk renders a label + tone + meaning rather than a lower-cased database value, and a
    // status TrustPoint adds tomorrow degrades to something readable instead of a blank chip.
    const ds = require('../lib/draw-status');
    // The per-draw CONVERSATION, attached to the draw it belongs to (owner-directed 2026-07-27:
    // "we should also be able to see the real messages in our system related to each and every
    // draw"). Mirrored read-only; a reply belongs in TrustPoint where the administrator sees it.
    // Best-effort — the desk must still render if the thread read fails.
    let threads = new Map();
    if (link && draws.length) {
      try {
        const comments = require('../trustpoint/comments');
        for (const d of draws) threads.set(d.tp_draw_id, await comments.threadFor(appId, d.tp_draw_id));
      } catch (e) { console.warn('[trustpoint] thread read failed:', e && e.message); threads = new Map(); }
    }
    // WAS THIS DRAW ACTUALLY WIRED? Answered on the SERVER, by the same predicate the
    // money mirror gates its ledger row on (`mirror.releaseConfirmed`), so the desk can
    // never call a draw released on evidence the ledger refuses. The screen used to test
    // `disbursed_cents > 0` itself — TrustPoint's projected net, pre-populated at
    // submission — and printed "✓ Released $6,200.00" against a $6,450 DRAFT on
    // YSCAP258134629 (owner-reported 2026-08-24). Never re-derive this in a component.
    const tpMirror = require('../trustpoint/mirror');
    const draws2 = draws.map((d) => ({
      ...d, status_info: ds.drawStatus(d), messages: threads.get(d.tp_draw_id) || [],
      release_confirmed: tpMirror.releaseConfirmed(d),
    }));
    const sos2 = serviceOrders.map((s) => ({ ...s, status_info: ds.serviceStatus(s) }));
    // The newest draw is the one the file is "on" — its headline answers "what's happening now?"
    const newest = draws2[draws2.length - 1] || null;
    const now = newest ? ds.headline(newest, sos2.filter((s) => !s.tp_draw_id || s.tp_draw_id === newest.tp_draw_id)) : null;
    res.json({ linked: !!link, link, draws: draws2, service_orders: sos2, milestones, headline: now });
  } catch (e) { console.warn('[trustpoint] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- staff: per-line amounts + Sitewire write-back + branded report (phase 3) ----
async function ownDraw(req, res) {
  const appId = req.params.id, tpDrawId = String(req.params.tpDrawId || '');
  if (!(await canSeeFile(req, appId))) { res.status(403).json({ error: 'forbidden' }); return null; }
  const d = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1 AND application_id=$2`, [tpDrawId, appId])).rows[0];
  if (!d) { res.status(404).json({ error: 'draw not found on this file' }); return null; }
  return { appId, tpDrawId, draw: d };
}

router.get('/files/:id/draws/:tpDrawId/lines', requirePermission('manage_draws'), async (req, res) => {
  try {
    const own = await ownDraw(req, res); if (!own) return;
    const lines = require('../trustpoint/lines');
    const current = await lines.linesFor(own.tpDrawId);
    // The pickable budget lines (the file's operative per-line ledger) for the entry form.
    const budget = (await db.query(
      `SELECT sitewire_job_item_id, name, budgeted_cents FROM sitewire_job_item_links
        WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL AND is_media_item=false AND (state IS NULL OR state<>'deleted')
        ORDER BY name`, [own.appId])).rows;
    res.json({ draw: { tp_draw_id: own.tpDrawId, number: own.draw.number, status: own.draw.status,
      requested_cents: own.draw.requested_cents, approved_cents: own.draw.approved_cents,
      writeback_at: own.draw.writeback_at, writeback_note: own.draw.writeback_note, sitewire_draw_id: own.draw.sitewire_draw_id },
      lines: current, budget_lines: budget });
  } catch (e) { console.warn('[trustpoint] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.post('/files/:id/draws/:tpDrawId/lines', requirePermission('manage_draws'), async (req, res) => {
  try {
    const own = await ownDraw(req, res); if (!own) return;
    const lines = require('../trustpoint/lines');
    const r = await lines.saveManualLines(own.appId, own.tpDrawId, (req.body && req.body.entries) || [], req.actor.id);
    // A completed line set immediately attempts the Sitewire write-back (guarded; the
    // result explains a wait — e.g. writes off / not approved yet — without failing).
    const wb = await require('../trustpoint/writeback').pushApprovalToSitewire(own.appId, own.tpDrawId, { actorId: req.actor.id });
    res.json({ ok: true, ...r, writeback: wb });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[trustpoint] lines error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

router.post('/files/:id/draws/:tpDrawId/push-sitewire', requirePermission('manage_draws'), async (req, res) => {
  try {
    const own = await ownDraw(req, res); if (!own) return;
    const wb = await require('../trustpoint/writeback').pushApprovalToSitewire(own.appId, own.tpDrawId, { actorId: req.actor.id });
    // ok ONLY when something was actually pushed — a skip/park explains itself in the body
    res.json({ ok: !!wb.ok, ...wb });
  } catch (e) { console.warn('[trustpoint] push error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.get('/files/:id/draws/:tpDrawId/report', requirePermission('manage_draws'), async (req, res) => {
  try {
    const own = await ownDraw(req, res); if (!own) return;
    const report = require('../trustpoint/report');
    const mode = req.query.mode === 'borrower' ? 'borrower' : 'staff';
    const r = await report.buildOrGetReport(own.appId, own.tpDrawId, mode);
    let bytes = r.bytes;
    if (!bytes) {
      const storage = require('../lib/storage');
      const doc = (await db.query(`SELECT storage_ref FROM documents WHERE id=$1`, [r.documentId])).rows[0];
      bytes = await storage.read(doc.storage_ref);
    }
    require('../lib/content-disposition').setContentDisposition(res, r.filename, { inline: true });
    res.type('application/pdf').send(Buffer.from(bytes));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[trustpoint] report error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

// ---- staff: webhook registration (the ONE outbound write — journaled, dry-run honored) ----
router.post('/register-webhook', requirePermission('platform_setup'), async (req, res) => {
  try {
    if (!client.available()) return res.status(422).json({ error: 'TrustPoint API key is not configured yet.' });
    if (!cfg.trustpointWebhookToken) return res.status(422).json({ error: 'Set TRUSTPOINT_WEBHOOK_TOKEN first — it is the password PILOT gives TrustPoint to authenticate deliveries.' });
    const companyPk = req.body && req.body.company_pk;
    if (!companyPk) return res.status(400).json({ error: 'company_pk required (from GET /companies on TrustPoint)' });
    const endpoint = `${String(cfg.appUrl || '').replace(/\/+$/, '')}/api/trustpoint/webhook`;
    const body = { endpoint, company_id: String(companyPk), auth_type: 'BEARER_TOKEN', credentials: { token: cfg.trustpointWebhookToken } };
    let resp = null, ok = false, err = null;
    try { resp = await client.createWebhook(String(companyPk), body); ok = true; }
    catch (e) { err = e; resp = { status: e.status, body: e.body }; }
    await db.query(
      `INSERT INTO trustpoint_write_log (endpoint, method, body, response, ok)
       VALUES ($1,'POST',$2::jsonb,$3::jsonb,$4)`,
      [`/companies/${companyPk}/webhooks/`, JSON.stringify({ ...body, credentials: { token: '***' } }), ((x) => x.length > 20000 ? JSON.stringify({ truncated: true }) : x)(JSON.stringify(resp)), ok]);
    if (!ok) return res.status(err && err.status === 403 ? 403 : 502).json({ error: `TrustPoint refused the registration (${err && err.status || 'network'}) — check the key's permissions.` });
    res.json({ ok: true, dryrun: !!(resp && resp.__dryrun), endpoint });
  } catch (e) { console.warn('[trustpoint] register-webhook error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
