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
const { buildXlsx } = require('../lib/xlsx');

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
  const releaseDate = req.body.release_date || null;
  const fundedStatus = ['pending', 'released', 'held'].includes(req.body.funded_status) ? req.body.funded_status : 'pending';
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
  const allowed = new Set(['wire_turnaround_hours', 'variance_pct', 'stale_days', 'no_draw_days', 'pacing_gap_pct', 'front_load_pct', 'first_draw_max_pct']);
  const updates = [];
  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;
    await db.query(`INSERT INTO sitewire_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(req.body[k])]);
    updates.push(k);
  }
  res.json({ ok: true, updated: updates });
});

// ---- POST /reviews/:id/:action — resolve a parked Sitewire review (retry | dismiss) ----
// Sitewire parks are "fix the file, then re-push" rows. `retry` re-queues any dead push jobs
// for the file (or enqueues a fresh push after the human fixed the upstream cause) and marks the
// row resolved; `dismiss` closes it without action. Guarded + scoped like every draw-desk write.
router.post('/reviews/:id/:action', requirePermission('manage_draws'), async (req, res) => {
  const { id, action } = req.params;
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'not found' });
  if (!['retry', 'dismiss'].includes(action)) return res.status(400).json({ error: 'action must be retry or dismiss' });
  const row = (await db.query(`SELECT id, application_id, reason FROM sync_review_queue WHERE id=$1 AND field_key='sitewire' AND status='open'`, [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'review not found (or already resolved)' });
  if (!row.application_id || !(await canSeeFile(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
  try {
    if (action === 'retry') {
      // re-arm every dead sitewire push job for this file (they re-run through all the guards)
      const dead = await db.query(
        `UPDATE sync_queue SET status='queued', attempts=0, run_after=now(), updated_at=now()
          WHERE entity_type='application' AND entity_id=$1 AND target='sitewire' AND direction='push' AND status='dead' RETURNING id`, [row.application_id]);
      // if nothing was dead-lettered, enqueue a fresh push so a fixed upstream cause re-attempts
      if (!dead.rows.length) await enqueueSitewirePush(row.application_id, 'push_file').catch(() => {});
      await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3, updated_at=now() WHERE id=$1`,
        [id, req.actor.id, dead.rows.length ? `retried ${dead.rows.length} push job(s)` : 're-queued a fresh push']);
      return res.json({ ok: true, retried: dead.rows.length, requeued: !dead.rows.length });
    }
    await db.query(`UPDATE sync_review_queue SET status='rejected', resolved_by=$2, resolved_at=now(), resolution_note='dismissed', updated_at=now() WHERE id=$1`, [id, req.actor.id]);
    res.json({ ok: true, dismissed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const link = (await db.query(`SELECT l.*, cs.full_name AS coordinator_name FROM sitewire_property_links l LEFT JOIN staff_users cs ON cs.id=l.coordinator_staff_id WHERE l.application_id=$1 AND l.matched_by='created'`, [appId])).rows[0] || null;
    const draws = (await db.query(`SELECT sitewire_draw_id, number, name, status, risk_level, risk_flags, submitted_at, approved_at, pdf_src FROM sitewire_draws WHERE application_id=$1 ORDER BY number DESC NULLS LAST`, [appId])).rows;
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
    const riskByDraw = new Map(draws.map((d) => [Number(d.sitewire_draw_id), { level: d.risk_level, flags: d.risk_flags, pdf_src: d.pdf_src }]));
    for (const d of rollup.draws) { const r = riskByDraw.get(d.sitewire_draw_id); if (r) { d.risk_level = r.level; d.risk_flags = r.flags; d.pdf_src = r.pdf_src; } }
    res.json({ rollup, link, draws, requests, ledger, findings, change_requests: changeRequests });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /portfolio — exposure / pacing dashboard across the actor's files ----
router.get('/portfolio', requirePermission('manage_draws'), async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    // per-file budget (frozen) + drawn (approved on approved draws) + pending-approval counts
    const rows = (await db.query(
      `SELECT a.id AS application_id, a.ys_loan_number, a.property_address->>'oneLine' AS address, a.status,
              a.actual_closing, a.term,
              l.sitewire_property_id,
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
        budget_cents: b, drawn_cents: dr, remaining_cents: b - dr, pct_complete: b > 0 ? Math.round((dr / b) * 1000) / 10 : 0,
        pending_requested_cents: Number(r.pending_requested_cents) || 0, pending_count: Number(r.pending_count) || 0, high_risk_count: Number(r.high_risk_count) || 0,
        funded_on: r.actual_closing || null, term: r.term || null, draw_count: Number(r.draw_count) || 0,
        last_activity_at: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null,
        wire_overdue: Number(r.overdue_wire_count) > 0 };
    });
    // early-warning monitoring (advisory, computed from real data only)
    let alerts = { files: [], summary: { by_code: {}, flagged: 0, total: files.length } };
    try {
      const s = await reconcile.settingsMap();
      const monitor = require('../sitewire/monitor');
      alerts = monitor.assessPortfolioAlerts(files, {
        nowMs: Date.now(),
        staleDays: Number(s.stale_days) || 30, noDrawDays: Number(s.no_draw_days) || 45, pacingGapPct: Number(s.pacing_gap_pct) || 25,
      });
    } catch (_) {}
    const alertByFile = {};
    for (const af of alerts.files) alertByFile[af.application_id] = af.alerts;
    for (const f of files) f.alerts = alertByFile[f.application_id] || [];
    res.json({ totals: { files: files.length, budget_cents: budget, drawn_cents: drawn, remaining_cents: budget - drawn,
      pct_complete: budget > 0 ? Math.round((drawn / budget) * 1000) / 10 : 0, pending_requested_cents: pendingReq, pending_count: pendingCount, high_risk_count: highRisk,
      flagged: alerts.summary.flagged, alert_codes: alerts.summary.by_code },
      files: files.sort((a, b) => (b.alerts.length - a.alerts.length) || b.pending_count - a.pending_count || b.remaining_cents - a.remaining_cents) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assemble a file's complete draw audit trail (examiner-ready) from every source we record:
// our write journal, the Sitewire draw lifecycle events, the money ledger, findings accept/
// dispute, and Scope-of-Work reallocations. Time-ordered, newest first. Read-only.
async function buildDrawActivity(appId) {
  const ev = [];
  const push = (at, kind, summary, actor) => { if (at) ev.push({ at: new Date(at).toISOString(), kind, summary, actor: actor || null }); };
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
    push(l.release_date || l.created_at, 'money', `Release recorded: net ${T.usd(l.net_release_cents)} (${l.funded_status})${l.sitewire_draw_id ? ' · draw #' + l.sitewire_draw_id : ''}`);
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
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return ev;
}

// ---- GET /files/:id/activity — the draw audit trail (examiner-ready) ----
router.get('/files/:id/activity', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json({ activity: await buildDrawActivity(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /files/:id/activity/export — audit trail as an Excel-openable CSV ----
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- POST /files/:id/coordinator — set the per-file draw-coordinator (admin override) ----
router.post('/files/:id/coordinator', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const staffId = req.body.coordinator_staff_id || null;
  if (staffId && !isUuid(staffId)) return res.status(400).json({ error: 'unknown staff user' });
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
    if (f.borrower_id) await notify.notifyBorrower(f.borrower_id, {
      type: 'draw_findings', title: 'Your draw inspection results are ready',
      body: `The inspection results for a draw on ${addr} are ready to review. Please review each item and accept or dispute.`,
      applicationId: appId, link: acceptLink, ctaLabel: 'Review draw results' }).catch(() => {});
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
      await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Budget reallocation applied',
        body: willPush ? 'A net-zero Scope-of-Work reallocation was applied and is being pushed to Sitewire.' : 'A net-zero Scope-of-Work reallocation was applied to the Scope of Work (Sitewire is currently off — it will sync when turned on).',
        applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
      return res.json({ ok: true, applied: true, pushed_to_sitewire: willPush });
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
