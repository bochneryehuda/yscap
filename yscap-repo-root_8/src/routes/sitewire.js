'use strict';
/**
 * Sitewire draw desk (staff) + admin setup. Mounted at /api/sitewire.
 * Draw-desk actions require the `manage_draws` capability (Draw Coordinator / processor /
 * LO / admin); setup actions (rules, directory sync, manual push, settings) require
 * `platform_setup`. Every Sitewire write goes through the guarded orchestrator/client —
 * never a raw call from a route. Non-see-all staff are scoped to their assigned files.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const cfg = require('../config');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const client = require('../sitewire/client');
const orchestrator = require('../sitewire/orchestrator');
const reconcile = require('../sitewire/reconcile');
const T = require('../sitewire/transforms');

router.use(requireAuth, requireStaff);

// scope helper: see_all_files -> everything; else only assigned files
function fileScope(req, alias, startIdx) {
  if (can(req.actor, 'see_all_files')) return { where: '', params: [] };
  return { where: ` AND ${assigneeExistsSql(alias, '$' + startIdx)}`, params: [req.actor.id] };
}
async function canSeeFile(req, appId) {
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
              (SELECT count(*) FROM draw_disbursements dd WHERE dd.sitewire_draw_id=d.sitewire_draw_id AND dd.funded_status='released') AS released_count
         FROM sitewire_draws d JOIN applications a ON a.id=d.application_id
        WHERE a.deleted_at IS NULL${sc.where}
        ORDER BY d.updated_at DESC NULLS LAST LIMIT 300`, sc.params)).rows;
    res.json({ draws: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /api/sitewire/files/:id/findings/:drawId — pull full findings (photos + notes) ----
router.get('/files/:id/findings/:drawId', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  try {
    const findings = await reconcile.fetchDrawFindings(req.params.drawId);
    res.json(findings);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- POST /api/sitewire/files/:id/reconcile — pull now ----
router.post('/files/:id/reconcile', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  try { res.json(await reconcile.reconcileOne(req.params.id)); } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- POST /api/sitewire/files/:id/push — manual birth push (admin/setup, guarded) ----
router.post('/files/:id/push', requirePermission('platform_setup'), async (req, res) => {
  try { res.json(await orchestrator.pushFile(req.params.id, { force: !!req.body.force })); }
  catch (e) { res.status(e.status === 422 ? 422 : 502).json({ error: e.message }); }
});

// ---- POST /api/sitewire/requests/:reqId/approve — set approved_cents on a draw line ----
router.post('/requests/:reqId/approve', requirePermission('manage_draws'), async (req, res) => {
  if (!cfg.sitewireEnabled || !cfg.sitewireOutboundEnabled) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const reqId = req.params.reqId;
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
    if (e.status === 422) return res.status(422).json({ error: `Sitewire rejected: ${JSON.stringify(e.body || {}).slice(0, 200)}` });
    res.status(502).json({ error: e.message });
  }
});

// ---- POST /api/sitewire/draws/:drawId/:action — approve / amend / reopen ----
router.post('/draws/:drawId/:action', requirePermission('manage_draws'), async (req, res) => {
  if (!cfg.sitewireEnabled || !cfg.sitewireOutboundEnabled) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const { drawId, action } = req.params;
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
    res.status(502).json({ error: e.message });
  }
});

// ---- POST /api/sitewire/disbursements — record a release in OUR ledger (net = approved - fee) ----
router.post('/disbursements', requirePermission('manage_draws'), async (req, res) => {
  const { application_id, sitewire_draw_id } = req.body;
  const approved = Math.round(Number(req.body.approved_cents) || 0);
  const fee = Math.round(Number(req.body.fee_cents) || 0);
  const feeKind = ['virtual', 'physical'].includes(req.body.fee_kind) ? req.body.fee_kind : null;
  const releaseDate = req.body.release_date || null;
  const fundedStatus = ['pending', 'released', 'held'].includes(req.body.funded_status) ? req.body.funded_status : 'pending';
  if (!application_id || !(await canSeeFile(req, application_id))) return res.status(403).json({ error: 'forbidden' });
  const net = approved - fee; // the money invariant: net = approved - fee
  if (net < 0) return res.status(422).json({ error: 'fee exceeds approved amount — net release would be negative' });
  try {
    const row = (await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, fee_kind, net_release_cents, release_date, funded_status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [application_id, sitewire_draw_id || null, approved, fee, feeKind, net, releaseDate, fundedStatus, req.body.note || null, req.actor.id])).rows[0];
    res.json({ ok: true, disbursement: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- inspection + fee rules (admin/setup) ----
router.get('/rules', requirePermission('platform_setup'), async (req, res) => {
  const rules = (await db.query(`SELECT r.*, cp.name AS capital_partner_name FROM sitewire_inspection_rules r LEFT JOIN sitewire_capital_partners cp ON cp.sitewire_id=r.capital_partner_id ORDER BY r.capital_partner_id NULLS FIRST`)).rows;
  const partners = (await db.query(`SELECT sitewire_id, name, on_our_lender FROM sitewire_capital_partners ORDER BY name`)).rows;
  res.json({ rules, partners });
});
router.post('/rules', requirePermission('platform_setup'), async (req, res) => {
  const b = req.body || {};
  const method = b.inspection_method === 'traditional' ? 'traditional' : 'mobile';
  try {
    const row = (await db.query(
      `INSERT INTO sitewire_inspection_rules (capital_partner_id, program, inspection_method, require_sitewire_inspector, require_capital_partner_approval, allow_reallocation, fee_cents_virtual, fee_cents_physical)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (COALESCE(capital_partner_id,-1), COALESCE(program,'')) DO UPDATE SET inspection_method=EXCLUDED.inspection_method, require_sitewire_inspector=EXCLUDED.require_sitewire_inspector, require_capital_partner_approval=EXCLUDED.require_capital_partner_approval, allow_reallocation=EXCLUDED.allow_reallocation, fee_cents_virtual=EXCLUDED.fee_cents_virtual, fee_cents_physical=EXCLUDED.fee_cents_physical, updated_at=now()
       RETURNING *`,
      [b.capital_partner_id || null, b.program || null, method, b.require_sitewire_inspector !== false, !!b.require_capital_partner_approval, !!b.allow_reallocation, Math.round(Number(b.fee_cents_virtual) || 29900), b.fee_cents_physical != null ? Math.round(Number(b.fee_cents_physical)) : null])).rows[0];
    res.json({ ok: true, rule: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- refresh the capital-partner directory + staff<->Sitewire-user map ----
router.post('/sync-directory', requirePermission('platform_setup'), async (req, res) => {
  if (!cfg.sitewireEnabled) return res.status(503).json({ error: 'Sitewire is turned off' });
  try {
    const cp = await reconcile.syncCapitalPartners();
    const staff = await reconcile.syncStaffUsers();
    res.json({ ok: true, capital_partners: cp.count, staff_matched: staff.matched });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- settings (wire turnaround hours, variance) ----
router.get('/settings', requirePermission('manage_draws'), async (req, res) => {
  const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});
router.patch('/settings', requirePermission('platform_setup'), async (req, res) => {
  const allowed = new Set(['wire_turnaround_hours', 'variance_pct']);
  const updates = [];
  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;
    await db.query(`INSERT INTO sitewire_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(req.body[k])]);
    updates.push(k);
  }
  res.json({ ok: true, updated: updates });
});

// ---- health/status (setup screen) ----
router.get('/status', requirePermission('manage_draws'), async (req, res) => {
  try {
    const linked = (await db.query(`SELECT count(*)::int c FROM sitewire_property_links WHERE sitewire_property_id IS NOT NULL`)).rows[0].c;
    const draws = (await db.query(`SELECT count(*)::int c FROM sitewire_draws`)).rows[0].c;
    const openReviews = (await db.query(`SELECT count(*)::int c FROM sync_review_queue WHERE field_key='sitewire' AND status='open'`)).rows[0].c;
    res.json({ enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun, linked_files: linked, mirrored_draws: draws, open_reviews: openReviews });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
