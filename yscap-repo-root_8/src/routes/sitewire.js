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
const rollupMod = require('../sitewire/rollup');
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const T = require('../sitewire/transforms');
const rehab = require('../lib/rehab-budget');
const notify = require('../lib/notify');
const { enqueueSitewirePush } = require('../sitewire/enqueue');

router.use(requireAuth, requireStaff);

// a funded file is past clear-to-close; a SOW change after CTC must net to zero
const phaseFor = (status) => (String(status) === 'funded' ? 'after_ctc' : 'before_ctc');

async function variancePct() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='variance_pct'`); return Number(r.rows[0] && r.rows[0].value) || 10; } catch (_) { return 10; }
}

// Build the per-SOW-line reallocation cells from the current rollup + a proposed explosion.
// current budget/drawn come from the live rollup (per sow_line_key); proposed from the new
// SOW explosion aggregated by line. Contingency/GC are real movable lines; media excluded.
function buildReallocationCells(rollup, proposedItems) {
  const cur = new Map();
  for (const l of rollup.lines) { if (l.kind === 'media') continue; cur.set(l.sow_line_key, { label: l.label, budget: l.budgeted, drawn: l.drawn }); }
  const prop = new Map();
  for (const it of proposedItems) {
    if (it.is_media_item || String(it.sow_line_key).indexOf('__media__') === 0) continue;
    prop.set(it.sow_line_key, (prop.get(it.sow_line_key) || 0) + Number(it.budgeted_cents || 0));
  }
  const keys = new Set([...cur.keys(), ...prop.keys()]);
  const cells = [];
  for (const k of keys) {
    const c = cur.get(k) || { label: rollupMod.baseLabelFromName(k), budget: 0, drawn: 0 };
    cells.push({ key: k, label: c.label, budget_cents: c.budget, drawn_cents: c.drawn, new_cents: prop.has(k) ? prop.get(k) : 0 });
  }
  return cells;
}

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
    if (e.status === 422) return res.status(422).json({ error: `Sitewire rejected: ${JSON.stringify(e.body || {}).slice(0, 200)}` });
    res.status(502).json({ error: e.message });
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
    const link = (await db.query(`SELECT l.*, cs.full_name AS coordinator_name FROM sitewire_property_links l LEFT JOIN staff_users cs ON cs.id=l.coordinator_staff_id WHERE l.application_id=$1`, [appId])).rows[0] || null;
    const draws = (await db.query(`SELECT sitewire_draw_id, number, name, status, risk_level, risk_flags, submitted_at, approved_at, pdf_src FROM sitewire_draws WHERE application_id=$1 ORDER BY number DESC NULLS LAST`, [appId])).rows;
    const ledger = (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    const findings = (await db.query(`SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [appId])).rows;
    const changeRequests = (await db.query(
      `SELECT cr.id, cr.status, cr.reason, cr.created_at, cr.decided_at, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status, d.deltas
         FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id
        WHERE cr.application_id=$1 AND cr.field='sow_reallocation' ORDER BY cr.created_at DESC`, [appId])).rows;
    // merge risk flags onto the rollup draw summaries
    const riskByDraw = new Map(draws.map((d) => [Number(d.sitewire_draw_id), { level: d.risk_level, flags: d.risk_flags, pdf_src: d.pdf_src }]));
    for (const d of rollup.draws) { const r = riskByDraw.get(d.sitewire_draw_id); if (r) { d.risk_level = r.level; d.risk_flags = r.flags; d.pdf_src = r.pdf_src; } }
    res.json({ rollup, link, draws, ledger, findings, change_requests: changeRequests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /portfolio — exposure / pacing dashboard across the actor's files ----
router.get('/portfolio', requirePermission('manage_draws'), async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    // per-file budget (frozen) + drawn (approved on approved draws) + pending-approval counts
    const rows = (await db.query(
      `SELECT a.id AS application_id, a.ys_loan_number, a.property_address->>'oneLine' AS address, a.status,
              l.sitewire_property_id,
              COALESCE((SELECT sum(ji.budgeted_cents) FROM sitewire_job_item_links ji WHERE ji.application_id=a.id AND ji.state<>'deleted' AND ji.is_media_item=false),0) AS budget_cents,
              COALESCE((SELECT sum(r.approved_cents) FROM sitewire_draw_requests r JOIN sitewire_draws d2 ON d2.sitewire_draw_id=r.sitewire_draw_id WHERE d2.application_id=a.id AND d2.status='approved'),0) AS drawn_cents,
              COALESCE((SELECT sum(d3.total_requested_cents) FROM sitewire_draws d3 WHERE d3.application_id=a.id AND d3.status NOT IN ('approved','drafting')),0) AS pending_requested_cents,
              (SELECT count(*) FROM sitewire_draws d4 WHERE d4.application_id=a.id AND d4.status='pending') AS pending_count,
              (SELECT count(*) FROM sitewire_draws d5 WHERE d5.application_id=a.id AND d5.risk_level='high') AS high_risk_count
         FROM sitewire_property_links l JOIN applications a ON a.id=l.application_id
        WHERE a.deleted_at IS NULL AND l.sitewire_property_id IS NOT NULL${sc.where}`, sc.params)).rows;
    let budget = 0, drawn = 0, pendingReq = 0, pendingCount = 0, highRisk = 0;
    const files = rows.map((r) => {
      const b = Number(r.budget_cents) || 0, dr = Number(r.drawn_cents) || 0;
      budget += b; drawn += dr; pendingReq += Number(r.pending_requested_cents) || 0;
      pendingCount += Number(r.pending_count) || 0; highRisk += Number(r.high_risk_count) || 0;
      return { application_id: r.application_id, ys_loan_number: r.ys_loan_number, address: r.address, status: r.status,
        budget_cents: b, drawn_cents: dr, remaining_cents: b - dr, pct_complete: b > 0 ? Math.round((dr / b) * 1000) / 10 : 0,
        pending_requested_cents: Number(r.pending_requested_cents) || 0, pending_count: Number(r.pending_count) || 0, high_risk_count: Number(r.high_risk_count) || 0 };
    });
    res.json({ totals: { files: files.length, budget_cents: budget, drawn_cents: drawn, remaining_cents: budget - drawn,
      pct_complete: budget > 0 ? Math.round((drawn / budget) * 1000) / 10 : 0, pending_requested_cents: pendingReq, pending_count: pendingCount, high_risk_count: highRisk },
      files: files.sort((a, b) => b.pending_count - a.pending_count || b.remaining_cents - a.remaining_cents) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- POST /files/:id/coordinator — set the per-file draw-coordinator (admin override) ----
router.post('/files/:id/coordinator', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const staffId = req.body.coordinator_staff_id || null;
  if (staffId) { const ok = (await db.query(`SELECT 1 FROM staff_users WHERE id=$1 AND is_active`, [staffId])).rowCount; if (!ok) return res.status(400).json({ error: 'unknown staff user' }); }
  await db.query(`UPDATE sitewire_property_links SET coordinator_staff_id=$2, updated_at=now() WHERE application_id=$1`, [appId, staffId]);
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
  try {
    const f = (await db.query(`SELECT a.property_address->>'oneLine' AS address, b.id AS borrower_id, b.email AS borrower_email FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0] || {};
    const deliveredTo = { borrower: f.borrower_email || null };
    const result = await reconcile.persistDrawFindings(appId, drawId, deliveredTo);
    // notify borrower (portal + email) + the loan team + coordinator
    const addr = f.address || 'your property';
    const link = `/app/${appId}`;
    if (f.borrower_id) await notify.notifyBorrower(f.borrower_id, {
      type: 'draw_findings', title: 'Your draw inspection results are ready',
      body: `The inspection results for a draw on ${addr} are ready to review. Please review each item and accept or dispute.`,
      applicationId: appId, link, ctaLabel: 'Review draw results' }).catch(() => {});
    await notify.notifyAppStaff(appId, { type: 'draw_findings', title: 'Draw findings delivered to borrower',
      body: `Inspection findings for ${addr} were delivered to the borrower to accept or dispute.`, applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    res.json({ ok: true, ...result });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- GET /findings/:findingId — full finding detail (staff) ----
router.get('/findings/:findingId', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await canSeeFile(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  const lines = (await db.query(`SELECT * FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows;
  res.json({ finding: f, lines });
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
  // if no more open disputes, mark the finding resolved
  const openLeft = (await db.query(`SELECT count(*)::int c FROM draw_finding_lines WHERE finding_id=$1 AND dispute_status='open'`, [findingId])).rows[0].c;
  if (openLeft === 0) await db.query(`UPDATE draw_findings SET status='resolved', resolved_at=now(), updated_at=now() WHERE id=$1`, [findingId]);
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
    const ex = M.explodeSow(proposedPayload.state, {});
    const cells = buildReallocationCells(rollup, ex.items);
    const phase = phaseFor(a.status);
    const plan = planReallocation(cells, { phase, variancePct: await variancePct() });
    // persist the change request (both versions live on record)
    const oldCells = cells.map((c) => ({ key: c.key, label: c.label, cents: c.budget_cents }));
    const newCells = cells.map((c) => ({ key: c.key, label: c.label, cents: c.new_cents }));
    const cr = (await db.query(
      `INSERT INTO change_requests (application_id, field, field_label, old_value, new_value, reason, status, requested_by_kind, requested_by_id)
       VALUES ($1,'sow_reallocation','Scope of Work reallocation',$2,$3,$4,'pending','staff',NULL) RETURNING id`,
      [appId, JSON.stringify(oldCells), JSON.stringify(newCells), req.body.reason || null])).rows[0];
    await db.query(
      `INSERT INTO sow_change_request_details (change_request_id, application_id, proposed_payload, deltas, net_zero, after_ctc, needs_capital_partner, capital_partner_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cr.id, appId, JSON.stringify(proposedPayload), JSON.stringify(plan.cells), plan.totals.net_zero, phase === 'after_ctc', plan.needs_capital_partner, plan.needs_capital_partner ? 'pending' : null]);
    res.json({ ok: true, change_request_id: cr.id, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- POST /change-requests/:crId/capital-partner — record capital-partner decision ----
router.post('/change-requests/:crId/capital-partner', requirePermission('manage_draws'), async (req, res) => {
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
    const ex = M.explodeSow(proposedPayload.state, {});
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
      await db.query(`UPDATE checklist_items SET tool_payload=$2, updated_at=now() WHERE application_id=$1 AND tool_key='rehab_budget'`, [appId, JSON.stringify(proposedPayload)]);
      await db.query(`UPDATE sitewire_property_links SET budget_version=budget_version+1, updated_at=now() WHERE application_id=$1`, [appId]);
      enqueueSitewirePush(appId, 'push_file').catch(() => {});
      await db.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, [crId, req.actor.id]);
      await db.query(`UPDATE sow_change_request_details SET updated_at=now() WHERE change_request_id=$1`, [crId]);
      await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Budget reallocation applied', body: 'A net-zero Scope-of-Work reallocation was applied and is being pushed to Sitewire.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
      return res.json({ ok: true, applied: true, pushed_to_sitewire: true });
    }

    // BEFORE clear-to-close OR a total change: the construction total is changing, which
    // re-sizes the loan. We never silently change the frozen budget — mark the request
    // approved and flag it for product re-registration (Products & Pricing re-opens).
    await db.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=COALESCE($3,decision_note), updated_at=now() WHERE id=$1`, [crId, req.actor.id, 'Total changed — requires product re-registration on the new budget']);
    await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Scope-of-Work change needs re-registration',
      body: 'A Scope-of-Work change alters the construction total. Re-register the product on the new budget in Products & Pricing before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    res.json({ ok: true, applied: false, requires_reregister: true, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /change-requests/:crId/export — Version 1 vs Version 2 as an Excel-openable CSV ----
router.get('/change-requests/:crId/export', requirePermission('manage_draws'), async (req, res) => {
  const cr = (await db.query(`SELECT cr.*, d.deltas FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id WHERE cr.id=$1 AND cr.field='sow_reallocation'`, [req.params.crId])).rows[0];
  if (!cr || !(await canSeeFile(req, cr.application_id))) return res.status(403).json({ error: 'forbidden' });
  const deltas = Array.isArray(cr.deltas) ? cr.deltas : [];
  const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const usd = (c) => (Number(c || 0) / 100).toFixed(2);
  const lines = [['Line item', 'Version 1 (current)', 'Already drawn', 'Version 2 (proposed)', 'Change', 'Movable (undrawn)', 'Over threshold'].map(esc).join(',')];
  let b = 0, aTot = 0, dr = 0;
  for (const c of deltas) {
    b += Number(c.budget_cents || 0); aTot += Number(c.new_cents || 0); dr += Number(c.drawn_cents || 0);
    lines.push([c.label, usd(c.budget_cents), usd(c.drawn_cents), usd(c.new_cents), usd(c.delta_cents), usd(c.movable_cents), c.material ? 'YES' : ''].map(esc).join(','));
  }
  lines.push(['TOTAL', usd(b), usd(dr), usd(aTot), usd(aTot - b), '', ''].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sow-reallocation-${req.params.crId}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
