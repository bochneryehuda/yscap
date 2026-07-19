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
    res.json({
      started: !!(link && link.sitewire_property_id),
      state: link ? link.state : null,
      started_at: link ? link.draw_setup_started_at : null,
      program,
      capital_partner: { id: cp.id != null ? Number(cp.id) : null, name: (cpName && cpName.name) || null, candidate: cp.candidate != null ? Number(cp.candidate) : null, candidate_name: cp.candidateName || null, ambiguous: !!cp.ambiguous },
      inspection: {
        method: insp.method, fee_kind: insp.feeKind, fee_cents: Number(insp.feeCents),
        allow_virtual: insp.allowVirtual, allow_physical: insp.allowPhysical,
        can_switch: insp.allowVirtual && insp.allowPhysical,
        default_method: (rule && rule.inspection_method) || 'mobile',
        chosen_override: link ? link.inspection_method : null,
        fee_virtual_cents: rule ? Number(rule.fee_cents_virtual) : null,
        fee_physical_cents: rule && rule.fee_cents_physical != null ? Number(rule.fee_cents_physical) : null,
      },
      requires: { sitewire_inspector: !!(rule && rule.require_sitewire_inspector), capital_partner_approval: !!(rule && rule.require_capital_partner_approval) },
      // handled externally = this capital partner runs draws in its own system; PILOT never pushes it.
      handled_externally: !!(rule && rule.handled_externally),
      prereqs,
      open_reviews: openReviews,
      can_start: !(rule && rule.handled_externally) && Object.values(prereqs).every(Boolean),
      switches: { enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    // ensure a link row exists to carry the coordinator's choice + who/when started
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, inspection_method, draw_setup_started_at, draw_setup_started_by)
       VALUES ($1,'created','pending',$2,now(),$3)
       ON CONFLICT (application_id) DO UPDATE SET inspection_method=COALESCE($2, sitewire_property_links.inspection_method),
         draw_setup_started_at=COALESCE(sitewire_property_links.draw_setup_started_at, now()), draw_setup_started_by=COALESCE(sitewire_property_links.draw_setup_started_by, $3), updated_at=now()`,
      [appId, chosen, req.actor.id]);
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
  } catch (e) { res.status(e.status === 422 ? 422 : 500).json({ error: e.message }); }
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
  // validate the draw id: if supplied it must be numeric AND belong to THIS file (never store a
  // draw id from another file — the lien gate reads that draw's waivers). Audit #3.
  let drawId = null;
  if (sitewire_draw_id != null && sitewire_draw_id !== '') {
    if (!/^\d+$/.test(String(sitewire_draw_id))) return res.status(400).json({ error: 'invalid draw id' });
    const own = (await db.query(`SELECT total_approved_cents FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [sitewire_draw_id, application_id])).rows[0];
    if (!own) return res.status(400).json({ error: 'that draw is not on this file' });
    drawId = sitewire_draw_id;
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
  }
  try {
    // retainage: hold a % of the approved amount; net = approved − fee − retainage held
    const pct = await retainagePctFor(application_id);
    const split = computeRelease({ approvedCents: approved, feeCents: fee, retainagePct: pct });
    if (!split.ok) return res.status(422).json({ error: split.violation });
    // lien-waiver gate: a RELEASE must name its draw so we can check its waivers — otherwise the
    // gate could be skipped by leaving the draw blank (audit #1). Block if any required waiver is
    // still outstanding (never guessed).
    if (fundedStatus === 'released' && await lienGateEnabled(application_id)) {
      if (!drawId) return res.status(400).json({ error: 'Select which draw this release is for — lien waivers are required on this project and are checked per draw.' });
      const waivers = (await db.query(`SELECT status, tier, party_name, kind FROM draw_lien_waivers WHERE sitewire_draw_id=$1`, [drawId])).rows;
      const gate = waiverGate(waivers, { enabled: true });
      if (!gate.ok) return res.status(409).json({ error: `Lien waivers still outstanding: ${gate.missing.join('; ')}. Mark them received or waived before releasing.`, missing: gate.missing });
    }
    const row = (await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, fee_kind, retainage_held_cents, net_release_cents, release_date, funded_status, kind, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draw',$10,$11) RETURNING *`,
      [application_id, drawId, approved, fee, feeKind, split.retainage_held_cents, split.net_release_cents, releaseDate, fundedStatus, req.body.note || null, req.actor.id])).rows[0];
    res.json({ ok: true, disbursement: row });
  } catch (e) {
    // db/148 unique index — a second draw release raced past the pre-check
    if (e.code === '23505') return res.status(409).json({ error: 'A release is already recorded for this draw.' });
    res.status(500).json({ error: e.message });
  }
});

// ---- POST /files/:id/retainage-release — release the accumulated retainage at completion ----
router.post('/files/:id/retainage-release', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
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
      [appId, toRelease, req.body.release_date || null, req.body.note || 'Retainage released at completion', req.actor.id])).rows[0];
    await client.query('COMMIT');
    res.json({ ok: true, disbursement: row, released_cents: toRelease });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); }
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
  const amt = Math.max(0, Math.round(Number(b.amount_cents) || 0));
  try {
    const row = (await db.query(
      `INSERT INTO draw_lien_waivers (application_id, sitewire_draw_id, kind, scope, tier, party_name, amount_cents, status, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'required',$8,$9) RETURNING *`,
      [appId, /^\d+$/.test(String(b.sitewire_draw_id)) ? b.sitewire_draw_id : null, kind, scope, tier, b.party_name || null, amt, b.note || null, req.actor.id])).rows[0];
    res.json({ ok: true, waiver: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/waivers/:wid', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.wid)) return res.status(404).json({ error: 'not found' });
  const status = ['required', 'received', 'waived', 'na'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status must be required, received, waived, or na' });
  const w = (await db.query(`SELECT application_id FROM draw_lien_waivers WHERE id=$1`, [req.params.wid])).rows[0];
  if (!w || !(await canSeeFile(req, w.application_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`UPDATE draw_lien_waivers SET status=$2, received_at=CASE WHEN $2 IN ('received','waived') THEN now() ELSE NULL END, note=COALESCE($3,note), updated_at=now() WHERE id=$1`, [req.params.wid, status, req.body.note || null]);
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- inspection + fee rules (admin/setup) ----
router.get('/rules', requirePermission('platform_setup'), async (req, res) => {
  const rules = (await db.query(`SELECT r.*, cp.name AS capital_partner_name FROM sitewire_inspection_rules r LEFT JOIN sitewire_capital_partners cp ON cp.sitewire_id=r.capital_partner_id ORDER BY r.partner_label NULLS FIRST, r.capital_partner_id NULLS FIRST`)).rows;
  // The partner dropdown is EVERY note buyer we have — the Sitewire directory PLUS every distinct
  // note-buyer label actually used on our files (applications.lender). External partners aren't in
  // the Sitewire directory, so the note-buyer field is the real source of truth (owner-directed).
  const dir = (await db.query(`SELECT sitewire_id, name, on_our_lender FROM sitewire_capital_partners`)).rows;
  const used = (await db.query(`SELECT DISTINCT btrim(lender) AS lender FROM applications WHERE lender IS NOT NULL AND btrim(lender) <> '' AND deleted_at IS NULL`)).rows.map((r) => r.lender);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const byNorm = new Map();
  for (const d of dir) byNorm.set(norm(d.name), { label: d.name, sitewire_id: Number(d.sitewire_id), on_our_lender: !!d.on_our_lender, in_directory: true, in_use: false });
  for (const l of used) {
    const k = norm(l); if (!k) continue;
    const ex = byNorm.get(k);
    if (ex) ex.in_use = true; else byNorm.set(k, { label: l, sitewire_id: null, on_our_lender: false, in_directory: false, in_use: true });
  }
  const partners = [...byNorm.values()].sort((a, b) => a.label.localeCompare(b.label));
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
  const feeVirtual = Number.isFinite(vFee) && vFee > 0 ? Math.round(vFee) : 29900;
  const pRaw = b.fee_cents_physical;
  const pFee = Number(pRaw);
  const feePhysical = pRaw == null || pRaw === '' || !Number.isFinite(pFee) ? null : Math.round(pFee);
  try {
    const row = (await db.query(
      `INSERT INTO sitewire_inspection_rules (capital_partner_id, partner_label, program, inspection_method, require_sitewire_inspector, require_capital_partner_approval, allow_reallocation, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, handled_externally)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO UPDATE SET capital_partner_id=EXCLUDED.capital_partner_id, partner_label=COALESCE(EXCLUDED.partner_label, sitewire_inspection_rules.partner_label), inspection_method=EXCLUDED.inspection_method, require_sitewire_inspector=EXCLUDED.require_sitewire_inspector, require_capital_partner_approval=EXCLUDED.require_capital_partner_approval, allow_reallocation=EXCLUDED.allow_reallocation, fee_cents_virtual=EXCLUDED.fee_cents_virtual, fee_cents_physical=EXCLUDED.fee_cents_physical, allow_virtual=EXCLUDED.allow_virtual, allow_physical=EXCLUDED.allow_physical, handled_externally=EXCLUDED.handled_externally, updated_at=now()
       RETURNING *`,
      [cpId, partnerLabel, b.program || null, method, b.require_sitewire_inspector !== false, !!b.require_capital_partner_approval, !!b.allow_reallocation, feeVirtual, feePhysical, allowVirtual, allowPhysical, handledExternally])).rows[0];
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
  const allowed = new Set(['wire_turnaround_hours', 'variance_pct', 'stale_days', 'no_draw_days', 'pacing_gap_pct', 'front_load_pct', 'first_draw_max_pct', 'retainage_pct', 'require_lien_waivers']);
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
      // so the desk can show a proactive read-only banner + disable write buttons when writes are off
      // (an approve/release/finding write 503s unless BOTH the master switch and the write gate are on).
      switches: { enabled: cfg.sitewireEnabled, outbound: cfg.sitewireOutboundEnabled, dryrun: cfg.sitewireDryrun } });
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- GET /files/:id/activity — the draw audit trail (examiner-ready) ----
router.get('/files/:id/activity', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json({ activity: await buildDrawActivity(req.params.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  await db.query(`UPDATE sitewire_property_links SET require_lien_waivers=$2, updated_at=now() WHERE application_id=$1`, [appId, v]);
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
