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
const { can, assigneeExistsSql } = require('../lib/permissions');
const client = require('../trustpoint/client');
const mirror = require('../trustpoint/mirror');
const discovery = require('../trustpoint/discovery');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
async function canSeeFile(req, appId) {
  if (!isUuid(appId)) return false;
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`, [appId, req.actor.id]);
  return r.rowCount > 0;
}

// The whole router is STAFF-ONLY (the public webhook lives in routes/trustpoint-webhook.js,
// mounted separately before the JSON parser). requirePermission alone never authenticates —
// it needs req.actor from requireAuth (phase-2 audit BLOCKER #1).
router.use(requireAuth, requireStaff);

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
              sitewire_draw_id, report_document_id, updated_at
         FROM trustpoint_draws WHERE application_id=$1 ORDER BY COALESCE(number, 0), tp_created_at`, [appId])).rows : [];
    const serviceOrders = link ? (await db.query(
      `SELECT tp_service_order_id, tp_draw_id, service_type, status, service_number, ordered_at, scheduled_at, completed_at, cancelled_at, inspector_allowance_rate
         FROM trustpoint_service_orders WHERE application_id=$1 ORDER BY COALESCE(ordered_at, completed_at) DESC NULLS LAST`, [appId])).rows : [];
    const milestones = link ? (await db.query(
      `SELECT tp_milestone_id, name, amount_cents, sow_line_key, matched_by FROM trustpoint_milestone_links WHERE application_id=$1 ORDER BY id`, [appId])).rows : [];
    res.json({ linked: !!link, link, draws, service_orders: serviceOrders, milestones });
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
    res.setHeader('Content-Disposition', `inline; filename="${r.filename}"`);
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
