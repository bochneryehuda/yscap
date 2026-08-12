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
const switches = require('../lib/integrations/switches'); // runtime on/off (env default unless flipped on the API Health page)
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const client = require('../sitewire/client');
const orchestrator = require('../sitewire/orchestrator');
const sowLineEdit = require('../sitewire/sow-line-edit');
const reconcile = require('../sitewire/reconcile');
const rollupMod = require('../sitewire/rollup');
const drawTimeline = require('../sitewire/draw-timeline');
const { drawEmailBlocks } = require('../sitewire/draw-email-blocks');
const drawEmail = require('../lib/email/draw-email'); // the ONE money formatter for a draw email
const drawLabel = require('../lib/draw-label');        // "Draw 2" — the ONE way a draw is named in a subject
// Investor delivery + the release party. Required at the TOP rather than beside their route
// section further down: the rules route and the rollup route (both far above that section) now
// read them, and a route handler that reaches for a `const` declared later in the file works only
// because handlers run after the module finishes loading — too subtle to rely on.
const investorDelivery = require('../sitewire/investor-delivery');
const investorSend = require('../sitewire/investor-delivery-send');
const releaseParty = require('../sitewire/release-party'); // who releases the money, which level said so, and is it sold yet
const autoRelease = require('../sitewire/auto-release');   // final approve writes the ledger when the INVESTOR releases
const stageEvents = require('../sitewire/stage-events');   // when each draw reached each step, forward-only
const drawAttachments = require('../sitewire/draw-attachments'); // invoices/receipts/photos ON a draw
const drawSettings = require('../sitewire/draw-settings');       // every knob, its three levels, and which one won
const drawChecklist = require('../sitewire/draw-checklist');     // what's left on a draw, stated forward

/**
 * EVERY OVERRIDE CAN CARRY ITS PROOF (owner-directed 2026-08-09: "when we override something, we
 * should be able to add invoices, receipts, or additional photos").
 *
 * A shared tail for the four override paths — approving more than the borrower requested,
 * releasing more than was approved, amending, reopening. The super-admin gate and the typed note
 * on those paths are UNCHANGED: attachments are additional evidence, never a substitute for either.
 *
 * Best-effort by design: the override itself has already been journaled and written, so a storage
 * hiccup while filing an invoice must never unwind a money decision. What did NOT land comes back
 * in `skipped` with a reason, so the person who attached it is told rather than left guessing.
 */
async function attachOverrideEvidence(appId, drawId, body, actorId, supports) {
  try {
    const items = Array.isArray(body && body.attachments) ? body.attachments : [];
    if (!items.length || drawId == null) return null;
    const out = await drawAttachments.attach(appId, { sitewireDrawId: drawId }, items, {
      by: { kind: 'staff', id: actorId || null }, supports,
    });
    return { attached: out.added.length, attachments_skipped: out.skipped };
  } catch (_) { return null; }
}
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const T = require('../sitewire/transforms');
const routing = require('../sitewire/routing');
const rehab = require('../lib/rehab-budget');
const { sanitizeDateOnly, jsonbText } = require('../lib/fields'); // strict YYYY-MM-DD validation for date inputs; jsonbText = NUL-safe jsonb text
const { normalizeDisputeMedia } = require('../sitewire/dispute-media'); // sniff/strip/cap dispute evidence — shared with the borrower + TPO surfaces
const notify = require('../lib/notify');
const { drawSetupNotifyOpts } = require('../lib/email/draw-setup-email');
const { enqueueSitewirePush } = require('../sitewire/enqueue');
const { buildXlsx } = require('../lib/xlsx');
const mediaArchive = require('../sitewire/media-archive');
const drawReport = require('../sitewire/draw-report');
const storage = require('../lib/storage');
const { setMediaHeaders } = require('../lib/media-headers');
const { serveDocument } = require('../lib/serve-document');
const { computeRelease, waiverGate } = require('../sitewire/money');
const { keyedRateLimit } = require('../lib/rate-limit');
// Coordinator-message spam throttle (audit finding B-7, 2026-07-21). Per-(file, actor) so a whole team
// isn't rate-limited by one coordinator on a different file. 5/min is generous for a real conversation
// (a coordinator typing one reply, then a follow-up) but tight enough that a malicious/compromised
// admin token can't script a per-second borrower email flood.
const drawMessageReplyThrottle = keyedRateLimit({ bucket: 'sw-draw-msg-reply', windowMs: 60000, max: 5,
  keyOf: (req) => `${req.params.id}:${(req.actor && req.actor.id) || 'anon'}` });
// The Draw Request & Wire Instructions form goes out through the existing DocuSign
// e-sign integration (owner-directed 2026-07-20). orchestrate.sendPackage drives the
// send; draw-wire owns the wire condition + capture.
const esignOrchestrate = require('../lib/esign/orchestrate');
const drawWire = require('../lib/esign/draw-wire');

// Resolve the retainage % for a file: per-file override on the link, else the global default.
// The retainage % and the lien-waiver switch now live in ONE place, `src/sitewire/draw-settings.js`
// (moved verbatim, same fail-closed behaviour), because the AUTOMATIC ledger writer on final
// approve reads them too — and two copies of a money resolver is exactly how one draw ends up with
// two different answers about its own money on two screens.
const { retainagePctFor, lienGateEnabled } = drawSettings;

router.use(requireAuth, requireStaff);

// VIEW-ONLY draw access (owner-directed 2026-08-12). A loan officer holds `view_draws`
// (never `manage_draws`), so the READ routes and the two borrower-behalf actions
// (approve / dispute a finding) accept EITHER capability; every draw-desk WRITE stays
// on `requirePermission('manage_draws')` and refuses a loan officer with a 403. File
// scope is still enforced per-route by canSeeFile / fileScope, so the LO only ever
// sees their own files. Grep for `requireDrawView` to see exactly which routes a
// loan officer can reach — a route on plain `manage_draws` is management-only.
const requireDrawView = requirePermission(['manage_draws', 'view_draws']);

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
// A robust one-line property address from the property_address jsonb. Files store the
// address several ways — a ready `oneLine`, a geocoded `formatted_address`, structured
// line1/street/city/state/zip, or a bare JSON string — so reading ONLY `oneLine` (the
// old query) left many files showing no address on the draw desk. Mirrors the same
// fallback ladder loadDocGenData uses for the generated documents.
function addrExpr(alias) {
  const p = `${alias}.property_address`;
  return `COALESCE(
    NULLIF(btrim(${p}->>'oneLine'), ''),
    NULLIF(btrim(${p}->>'formatted_address'), ''),
    NULLIF(btrim(concat_ws(', ',
      NULLIF(btrim(concat_ws(' ', ${p}->>'line1', ${p}->>'street', ${p}->>'unit')), ''),
      NULLIF(btrim(${p}->>'city'), ''),
      NULLIF(btrim(concat_ws(' ', ${p}->>'state', ${p}->>'zip')), '')
    )), ''),
    CASE WHEN jsonb_typeof(${p}) = 'string' THEN ${p} #>> '{}' END
  )`;
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
router.get('/draws', requireDrawView, async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    const rows = (await db.query(
      `SELECT d.sitewire_draw_id, d.application_id, d.number, d.status, d.total_requested_cents, d.total_approved_cents,
              -- What the INSPECTOR approved. total_approved_cents is Sitewire's FINAL-approval
              -- field and stays 0 from the inspection until we press Final approve, so the desk list
              -- showed $0 on fully-inspected draws (owner-reported 2026-08-03). SAME precedence as
              -- approval.inspectorApproved so this column equals the report/email headline: the live
              -- request mirror first, then the delivered-findings snapshot (the inspector's per-line
              -- figure lands there BEFORE the mirror catches up — owner-reported 2026-08-10, 109
              -- Chapel St, where this column read $0 while the report read $7,700), then the draw total.
              COALESCE((SELECT sum(r.approved_cents) FROM sitewire_draw_requests r WHERE r.sitewire_draw_id = d.sitewire_draw_id),
                       (SELECT sum(fl.approved_cents) FROM draw_finding_lines fl JOIN draw_findings df ON df.id = fl.finding_id WHERE df.sitewire_draw_id = d.sitewire_draw_id AND fl.retired_at IS NULL),
                       d.total_approved_cents) AS inspector_approved_cents,
              d.submitted_at, d.approved_at, d.updated_at, d.pdf_src,
              a.ys_loan_number, ${addrExpr('a')} AS address,
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
router.get('/files/:id', requireDrawView, async (req, res) => {
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
router.get('/files/:id/findings/:drawId', requireDrawView, async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!switches.on('SITEWIRE_ENABLED')) return res.status(503).json({ error: 'Sitewire is turned off' });
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
router.get('/files/:id/draws/:drawId/archived-media', requireDrawView, async (req, res) => {
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
router.get('/files/:id/draws/:drawId/media/:mediaId', requireDrawView, async (req, res) => {
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
// can file and the borrower can see. mode=staff (everything) | mode=borrower (borrower-safe: no
// capital-partner name, no photo GPS, and no project-wide fee income — but the per-draw processing fee
// IS shown, owner-directed 2026-08-03, because it comes out of the borrower's own approved amount). Idempotent + cached by a version hash: an unchanged draw reuses the
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
router.get('/files/:id/draws/:drawId/report', requireDrawView, async (req, res) => {
  if (!/^\d+$/.test(req.params.drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [req.params.drawId, req.params.id]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  return generateAndServeReport(req, res, { sitewireDrawId: req.params.drawId, scope: 'draw' });
});
// whole-project report (cumulative across all draws)
router.get('/files/:id/report', requireDrawView, async (req, res) => {
  return generateAndServeReport(req, res, { sitewireDrawId: null, scope: 'project' });
});

// ---- POST /api/sitewire/files/:id/reconcile — pull now ----
router.post('/files/:id/reconcile', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  if (!switches.on('SITEWIRE_ENABLED')) return res.status(503).json({ error: 'Sitewire is turned off' });
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
// KEPT. Owner-directed 2026-07-21 (audit finding B-3): this is a NUKE button — it deactivates the Sitewire
// property, tombstones the link, and clears mirrored draws. Restrict to super_admin AND require a typed
// confirmation of the file's loan number so a coordinator on the wrong file can't hit it by accident. Every
// invocation is journaled (via resetDrawSetup's own audit trail).
router.post('/files/:id/reset-draw', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Only a super admin can reset the Sitewire draw setup — ask an admin.' });
  const confirm = req.body && req.body.confirm_loan_number ? String(req.body.confirm_loan_number).trim() : '';
  if (!confirm) return res.status(400).json({ error: 'To reset, type the file\'s loan number in `confirm_loan_number`.' });
  const a = (await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  const expected = String(a.ys_loan_number || '').trim();
  if (!expected) return res.status(409).json({ error: 'This file has no loan number to confirm against — reset refused.' });
  if (confirm !== expected) return res.status(400).json({ error: `The loan number you typed doesn't match this file. Reset refused.` });
  try {
    const r = await orchestrator.resetDrawSetup(appId, req.actor && req.actor.id);
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire — there’s nothing to reset.' });
    res.json(r);
  } catch (e) { console.warn('[sitewire] reset-draw error:', e && e.message); res.status(500).json({ error: 'Couldn’t reset the draw setup right now — please try again shortly.' }); }
});

// ---- GET /files/:id/sitewire-property — the LIVE Sitewire property settings for the draw desk ----
// Owner-directed 2026-07-21: bring Sitewire's property controls into PILOT. This reads the real property
// from Sitewire (managed-only) so the desk shows its true current state (active/inactive, inspection method)
// and offers the toggles. It also returns the raw property object — the honest way to reveal the exact field
// names Sitewire uses for the two toggles we haven't confirmed yet (Block Draws / review type). manage_draws
// + canSeeFile. Degrades gracefully: available:false when the file isn't PILOT-managed or the connection is off.
router.get('/files/:id/sitewire-property', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const live = await orchestrator.getPropertyLive(appId);
    // resolve the file's inspection rule so the UI knows which methods are switchable + the current choice
    let inspection = null;
    try {
      const a = await orchestrator.loadFile(appId);
      const link = await orchestrator.getLink(appId);
      if (a && link) {
        const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
        const cp = await orchestrator.resolveCapitalPartnerId(a.lender);
        const rule = await orchestrator.resolveRule(a.lender, cp.id, program);
        const insp = orchestrator.resolveInspection(link, rule);
        inspection = {
          method: insp.method, allow_virtual: insp.allowVirtual, allow_physical: insp.allowPhysical,
          can_switch: insp.allowVirtual && insp.allowPhysical, default_method: (rule && rule.inspection_method) || 'mobile',
          // Current draw processing fee (cents) + whether it's a per-file override or the rule default,
          // so the desk can show it and offer "Change fee". The LIVE property's processing_fee_cents is the
          // source of truth for what Sitewire is charging; insp.feeCents is what PILOT would push.
          fee_cents: (live && live.property && Number.isFinite(Number(live.property.processing_fee_cents))) ? Number(live.property.processing_fee_cents) : Number(insp.feeCents),
          rule_fee_cents: Number(insp.ruleFeeCents), fee_overridden: !!insp.overridden,
        };
      }
    } catch (_) { /* inspection is advisory context — never fail the read on it */ }
    res.json({
      ...live,
      inspection,
      switches: { enabled: switches.on('SITEWIRE_ENABLED'), outbound: switches.on('SITEWIRE_OUTBOUND_ENABLED'), dryrun: cfg.sitewireDryrun },
    });
  } catch (e) { console.warn('[sitewire] sitewire-property error:', e && e.message); res.status(500).json({ error: 'Couldn’t read the Sitewire property right now — please try again shortly.' }); }
});

// ---- POST /files/:id/property-settings — flip a Sitewire property control from the desk ----
// Owner-directed 2026-07-21: control the process from PILOT. All controls use the OFFICIAL Sitewire API v2
// field names (verified against the saved swagger) — inactive (Active↔Inactive), require_sitewire_inspector
// (Sitewire GC↔in-house review), inspection_method (Virtual↔On-site), processing_fee_cents (fee), and
// draw_eligible (Block Draws — this lives on the BUDGET). The guarded orchestrator write reads back what it
// wrote (never a silent 200-that-did-nothing). manage_draws + canSeeFile.
router.post('/files/:id/property-settings', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const changes = {};
  // Boolean controls: property `inactive` + `require_sitewire_inspector`, and the BUDGET `draw_eligible`.
  for (const f of ['inactive', 'require_sitewire_inspector', 'draw_eligible']) {
    if (Object.prototype.hasOwnProperty.call(b, f)) changes[f] = !!b[f];
  }
  if (b.inspection_method != null && b.inspection_method !== '') changes.inspection_method = String(b.inspection_method);
  if (b.fee_cents != null && b.fee_cents !== '') changes.processing_fee_cents = b.fee_cents; // integer cents; orchestrator validates $0..$100k
  if (Object.keys(changes).length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  try {
    const r = await orchestrator.updatePropertyControls(appId, changes, req.actor && req.actor.id);
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire yet — start the draw process first.' });
    if (r.error === 'invalid_method') return res.status(400).json({ error: 'Pick Virtual or On-site.' });
    if (r.error === 'invalid_fee') return res.status(400).json({ error: 'The draw fee must be a dollar amount between $0 and $100,000.' });
    if (r.error === 'method_forbidden') return res.status(422).json({ error: 'The capital partner doesn’t allow that inspection type for this file.' });
    if (r.error === 'no_budget') return res.status(409).json({ error: 'This file’s construction budget isn’t in Sitewire yet, so draws can’t be blocked/allowed — start or re-push the draw first.' });
    if (r.error === 'writes_off') return res.status(409).json({ error: 'The Sitewire connection is currently turned off, so this change can’t be sent yet.' });
    if (r.error === 'nothing_to_change') return res.status(400).json({ error: 'Nothing to change.' });
    if (r.parked) return res.status(502).json({ error: 'Couldn’t save the change to Sitewire — a review was opened so nothing is lost.', parked: r.parked });
    res.json(r);
  } catch (e) { console.warn('[sitewire] property-settings error:', e && e.message); res.status(502).json({ error: 'Couldn’t reach Sitewire right now — please try again shortly.' }); }
});

// ==== Push property DOCUMENTS to Sitewire (the website workaround — no API upload endpoint) ====
// Owner-directed 2026-07-21: push the appraisal PDF + Scope of Work Excel + Scope of Work PDF into the
// Sitewire property's Documents tab so nobody has to log into Sitewire. Sitewire's API has no document
// upload, so this uses the website "browser robot" (doc-push → web-client). It also runs automatically on
// every property push; these routes are the manual "Push documents" + "Re-push" buttons for the desk.
const docPush = require('../sitewire/doc-push');

// GET the current push status of the 3 documents (available? pushed? verified in Sitewire?).
router.get('/files/:id/documents-push', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await docPush.status(appId)); }
  catch (e) { console.warn('[sitewire] documents-push status error:', e && e.message); res.status(502).json({ error: 'Couldn’t read the document status right now.' }); }
});

// POST push the documents. Body: { which? ('appraisal_pdf'|'sow_xlsx'|'sow_pdf'), force? } — omit `which`
// to push all three; `force:true` re-uploads even if the same file was already pushed (the "Re-push" button).
router.post('/files/:id/documents-push', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const which = b.which && docPush.SLOTS.includes(b.which) ? b.which : undefined;
  try {
    const r = await docPush.pushDocuments(appId, { which, force: !!b.force, staffId: req.actor && req.actor.id, source: 'desk' });
    if (r.error === 'docs_disabled') return res.status(409).json({ error: 'Sending documents to Sitewire is turned off right now. It can be switched on once the Sitewire login is set up.' });
    if (r.error === 'sitewire_disabled' || r.error === 'outbound_disabled') return res.status(409).json({ error: 'The Sitewire connection is currently turned off, so documents can’t be sent yet.' });
    if (r.error === 'not_managed') return res.status(409).json({ error: 'This file isn’t managed by PILOT in Sitewire yet — start the draw process first.' });
    if (r.error === 'web_creds_missing') return res.status(409).json({ error: 'Sitewire’s document login isn’t set up yet. Add the Sitewire website login in the app settings, then try again.', detail: r.message });
    if (r.error) return res.status(502).json({ error: r.message || 'Couldn’t send the documents to Sitewire right now — a review was opened so nothing is lost.', code: r.error });
    res.json(r);
  } catch (e) { console.warn('[sitewire] documents-push error:', e && e.message); res.status(502).json({ error: 'Couldn’t reach Sitewire right now — please try again shortly.' }); }
});

// ==== Super-admin Scope-of-Work line-item editing (owner-directed 2026-07-21) ====
// Editing a line's WORDING (label) + DESCRIPTION is NOT allowed by default. A SUPER-ADMIN must UNLOCK the
// file's SOW editing first (mirrors the structural unlock). Each edit updates the REAL Scope of Work +
// regenerates its Excel + pushes the new wording AND description to Sitewire (owner-directed 2026-07-21 — a
// capture confirmed the job item's `description` field is writable, so it's no longer read-only-for-us).
const isSuperAdmin = (req) => !!(req.actor && req.actor.role === 'super_admin');

// GET the SOW lines for the editor: each line's wording/description/amount + whether it's drawn-locked in
// Sitewire, plus the unlock state + whether the viewer is a super-admin. manage_draws + canSeeFile.
router.get('/files/:id/sow-lines', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const data = await sowLineEdit.listLines(appId);
    const u = (await db.query(`SELECT sow_edit_unlocked_at FROM applications WHERE id=$1`, [appId])).rows[0];
    res.json({ ...data, unlocked: !!(u && u.sow_edit_unlocked_at), is_super_admin: isSuperAdmin(req) });
  } catch (e) { console.warn('[sitewire] sow-lines error:', e && e.message); res.status(500).json({ error: 'Couldn’t read the Scope of Work right now.' }); }
});

// UNLOCK / re-lock SOW line editing — super-admin ONLY (the "click to unfreeze" gate). Audited.
router.post('/files/:id/sow-edit-lock', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Only a super-admin can unlock Scope-of-Work line editing.' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const unlock = !!(req.body && req.body.unlocked);
  try {
    if (unlock) await db.query(`UPDATE applications SET sow_edit_unlocked_at=now(), sow_edit_unlocked_by=$2, updated_at=now() WHERE id=$1`, [appId, req.actor.id]);
    else await db.query(`UPDATE applications SET sow_edit_unlocked_at=NULL, sow_edit_unlocked_by=NULL, updated_at=now() WHERE id=$1`, [appId]);
    res.json({ ok: true, unlocked: unlock });
  } catch (e) { console.warn('[sitewire] sow-edit-lock error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// EDIT a line's wording/description — super-admin ONLY + must be UNLOCKED. Updates the real SOW + Excel +
// pushes the wording to Sitewire (a drawn line's name is locked there and is left as-is).
router.post('/files/:id/sow-line-edit', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Only a super-admin can edit Scope-of-Work line items.' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  // require an ACTIVE unlock — editing is never automatically allowed
  const u = (await db.query(`SELECT sow_edit_unlocked_at FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!(u && u.sow_edit_unlocked_at)) return res.status(409).json({ error: 'Unlock Scope-of-Work editing first (the file is frozen).' });
  const b = req.body || {};
  try {
    const r = await sowLineEdit.editLine(appId, { sow_line_key: b.sow_line_key, label: b.label, desc: b.desc }, req.actor.id);
    if (r.error === 'missing_key') return res.status(400).json({ error: 'Which line item? (missing line key)' });
    if (r.error === 'nothing_to_change') return res.status(400).json({ error: 'Enter a wording or description to save.' });
    if (r.error === 'no_sow') return res.status(409).json({ error: 'This file has no saved Scope of Work to edit.' });
    if (r.error === 'line_not_found') return res.status(404).json({ error: 'That line item isn’t in the Scope of Work.' });
    if (r.error === 'line_drawn_locked') return res.status(422).json({ error: r.message || 'This line has already been drawn against in Sitewire — its name is locked there. Edit the description instead, or reset the draw process first.' });
    res.json(r);
  } catch (e) { console.warn('[sitewire] sow-line-edit error:', e && e.message); res.status(500).json({ error: 'Couldn’t save the line-item change right now.' }); }
});

// ---- GET /files/:id/notifications — the DRAW file's email/notification center (staff) ----
// The draw coordinator's per-file email section: every DRAW-RELATED notification PILOT sent about this file
// (who it went to, when, delivery status, full content) plus the borrower's email REPLIES we've received.
// Scoped to draw items ONLY (type draw%/sow_%) so it stays the coordinator's draw inbox, not the whole file's
// notification history. Sitewire does not expose the emails IT sends, so this is PILOT's own trail.
// manage_draws + canSeeFile.
router.get('/files/:id/notifications', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const sent = (await db.query(
      `SELECT n.id, n.recipient_kind, n.type, n.title, n.body, n.link, n.read_at, n.email_status, n.emailed_at, n.created_at,
              COALESCE(s.full_name, NULLIF(b.full_name,'')) AS recipient_name,
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
router.get('/files/:id/messages/:notificationId', requireDrawView, async (req, res) => {
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
router.get('/files/:id/messages/:notificationId/attachments/:idx', requireDrawView, async (req, res) => {
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
router.post('/files/:id/messages/reply', requirePermission('manage_draws'), drawMessageReplyThrottle, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Type a message to send.' });
  if (body.length > 8000) return res.status(400).json({ error: 'That message is too long.' });
  const subject = req.body && req.body.subject ? String(req.body.subject).slice(0, 200) : 'A message about your draw';
  // A coordinator writing about ONE draw may say which (the desk sends the draw it is open on).
  // Optional by design: a general message about the project carries no draw tag rather than a
  // wrong one, and the id is validated here because it reaches a bigint column.
  const msgDrawId = req.body && /^\d+$/.test(String(req.body.sitewire_draw_id || '')) ? String(req.body.sitewire_draw_id) : null;
  try {
    const ids = await notify.notifyAppBorrowers(appId, {
      type: 'draw_message', major: true,
      title: subject, body,
      drawTag: msgDrawId ? await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: msgDrawId }) : null,
      badge: { text: 'From your loan team', tone: 'teal' },
      applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws',
    });
    const sent = (ids || []).filter(Boolean).length;
    if (!sent) return res.status(409).json({ error: 'This file has no borrower to message.' });
    res.json({ ok: true, sent });
  } catch (e) { console.warn('[sitewire] reply route error:', e && e.message); res.status(500).json({ error: 'Could not send your message — please try again.' }); }
});

// ---- GET /files/:id/borrower-status — Sitewire's borrower-invite state (live read) ----
router.get('/files/:id/borrower-status', requireDrawView, async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await orchestrator.getBorrowerInviteStatus(req.params.id)); }
  catch (e) { res.status(500).json({ error: 'Could not read the borrower status from Sitewire right now.' }); }
});

// ---- GET /files/:id/quick-notify-statuses — Sitewire's pipeline status labels ----
router.get('/files/:id/quick-notify-statuses', requireDrawView, async (req, res) => {
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
router.get('/files/:id/sitewire-documents', requireDrawView, async (req, res) => {
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

// ---- POST /files/:id/invite-email — set/change WHICH email the Sitewire borrower invite goes to ----
// Sitewire keeps ONE email per property, so this REPLACES the pending invite and re-invites (send it to
// the borrower's GC/partner instead). Stored on the file so a later push/resend honors it; assigned to
// Sitewire immediately when the property is already live. Prefilled with the borrower's email on the UI.
router.post('/files/:id/invite-email', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await orchestrator.setBorrowerInviteEmail(req.params.id, (req.body || {}).email, req.actor.id);
    if (r.error === 'invalid_email') return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (r.error) return res.status(502).json({ error: 'Couldn’t update the invite email through Sitewire — please try again shortly.' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'Couldn’t update the invite email right now — please try again shortly.' }); }
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
    // A READINESS LIST, in the same shape as a draw's own checklist (owner-directed 2026-08-09:
    // the coordinator should see what is missing BEFORE pressing Start, not be refused after).
    // It is a DESCRIPTION — Start still enforces its own gates; this only says what they will find.
    // `prereqs` above is unchanged for every existing reader.
    let reconcile = null;
    try {
      if (prereqs.scope_of_work && prereqs.budget) {
        const budgetCents = Math.round(Number(budgetDollars) * 100);
        const ex = M.reconcileToBudget(M.explodeSow(a.sow_payload.state, {}), budgetCents);
        const total = (ex && Array.isArray(ex.items)) ? ex.items.reduce((t, i) => t + (Number(i.budgeted_cents) || 0), 0) : null;
        reconcile = total == null ? null : { ok: total === budgetCents, exploded_cents: total, budget_cents: budgetCents };
      }
    } catch (_) { reconcile = null; }   // unreadable → the step reports unknown, never a false "ready"
    // The DURABLE record that the borrower was invited is the stamp on the link, not the live
    // invite-status read — that answers "can we send one right now?" (and reports `available:false`
    // whenever the integration switch is off), which is a different question and would show a file
    // whose borrower was invited weeks ago as still waiting.
    const borrowerInvited = link ? !!link.setup_email_sent_at : null;
    let wireForm = null;
    try { wireForm = await investorSend.wireFormStatus(appId); } catch (_) {}
    const step = (key, label, state, detail, action) => ({ key, label, state, detail: detail || null, action: state === 'done' ? null : action });
    const readiness = [
      step('funded', 'The loan is funded', prereqs.funded ? 'done' : 'waiting', null, 'Draws start after funding'),
      step('loan_number', 'The file has a loan number', prereqs.loan_number ? 'done' : 'waiting', null, 'Add the YS loan number'),
      step('scope_of_work', 'Scope of Work saved', prereqs.scope_of_work ? 'done' : 'waiting', null, 'Complete the Scope of Work'),
      step('budget_reconciles', 'Scope of Work reconciles to the budget',
        reconcile == null ? 'unknown' : (reconcile.ok ? 'done' : 'waiting'),
        reconcile && !reconcile.ok ? `The line items add up to ${T.usd(reconcile.exploded_cents)} against a ${T.usd(reconcile.budget_cents)} budget — they must match to the cent.` : null,
        'Fix the Scope of Work so the line items total the frozen budget'),
      step('address', 'The property address is complete', prereqs.address ? 'done' : 'waiting', null, 'Fill in the street, city, state and ZIP'),
      step('capital_partner', 'Capital partner matched', prereqs.capital_partner ? 'done' : 'waiting',
        cp.candidate != null ? `Closest match: ${cp.candidateName || cp.candidate} — confirm it on the draw rules screen.` : null,
        'Match this note buyer to a capital partner'),
      step('inspection', 'Inspection method and fee set', insp && insp.method ? 'done' : 'unknown',
        insp && insp.method ? `${insp.method === 'traditional' ? 'On-site' : 'Virtual'} — ${T.usd(Number(insp.feeCents))} per draw` : null,
        'Set the inspection rule for this capital partner'),
      step('borrower_invited', 'Borrower invited to the draw portal',
        borrowerInvited == null ? 'unknown' : (borrowerInvited ? 'done' : 'waiting'), null, 'Send the borrower their invitation'),
      step('wire_form', 'Wire instructions signed',
        wireForm == null ? 'unknown' : (wireForm.present ? (wireForm.accepted ? 'done' : 'waiting') : 'waiting'),
        wireForm && wireForm.present && !wireForm.accepted ? 'Signed, but not accepted yet — review it.' : null,
        'Send the wire form for signature'),
    ];
    const cpName = cp.id ? (await db.query(`SELECT name FROM sitewire_capital_partners WHERE sitewire_id=$1`, [cp.id])).rows[0] : null;
    // Unit count preview (owner-directed 2026-07-20 — "use physical building units"). The count PUSHED to
    // Sitewire = the physical building count = the LARGER of the file's unit count and the Scope of Work's.
    // A disagreement is surfaced (not an error): units with no work simply carry no budget lines.
    const hasSow = !!(a.sow_payload && a.sow_payload.state);
    const sowUnits = M.unitCount(a.sow_payload && a.sow_payload.state);
    const fileUnits = (a.units != null && Number(a.units) > 0) ? Number(a.units) : 0;
    const physicalUnits = Math.max(1, fileUnits, sowUnits);
    // Out-of-pocket-first (owner-directed 2026-07-31): the OOP-rehab floor the draw ledger will
    // enforce — the borrower funds this first and it is never reimbursed. Use the snapshot once the
    // draw process is started, else the live registration amount (what Start will snapshot). 0 = no
    // exception; the full construction budget still pushes to Sitewire (G-RECON) either way.
    const oopFloorCents = (link && Number(link.oop_floor_cents) > 0) ? Number(link.oop_floor_cents) : await orchestrator.registrationOopCents(appId);
    const fullRehabCents = budgetDollars != null ? Math.round(Number(budgetDollars) * 100) : null;
    res.json({
      readiness,
      readiness_done: readiness.filter((r) => r.state === 'done').length,
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
      // Out-of-pocket-first floor: full construction budget still pushes to Sitewire; the floor is what
      // PILOT's draw ledger holds back from reimbursement (0 when there is no OOP-rehab exception).
      out_of_pocket: {
        floor_cents: oopFloorCents,
        full_rehab_cents: fullRehabCents,
        financed_rehab_cents: fullRehabCents != null ? Math.max(0, fullRehabCents - oopFloorCents) : null,
      },
      // Routing (phase 1, 2026-07-24): which platform administers this file's draws.
      // 'external' = the legacy handled-externally semantics (PILOT does nothing);
      // 'trustpoint' = full Sitewire setup as intake+mirror, approvals run in TrustPoint.
      draw_platform: routing.platformOf(rule),
      // handled externally = this capital partner runs draws in its own system; PILOT never pushes it.
      handled_externally: routing.isExternal(rule),
      prereqs,
      open_reviews: openReviews,
      can_start: !routing.isExternal(rule) && Object.values(prereqs).every(Boolean),
      switches: { enabled: switches.on('SITEWIRE_ENABLED'), outbound: switches.on('SITEWIRE_OUTBOUND_ENABLED'), dryrun: cfg.sitewireDryrun },
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
    // Routing (phase 1, 2026-07-24): only the legacy 'external' platform blocks the start —
    // a 'trustpoint' file gets the FULL Sitewire setup (Sitewire is its borrower intake +
    // mirror; approvals run in TrustPoint via the coordinator import-task flow).
    if (routing.isExternal(rule)) {
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
    // Snapshot the out-of-pocket-first floor (owner-directed 2026-07-31) onto the property link as the
    // draw process begins — the borrower funds the first `oopFloorCents` of rehab themselves and it is
    // never reimbursed (the OOP-rehab exception). The structure is frozen post-funding, so this equals
    // the current registration's priced OOP amount. 0 (no exception) leaves every release byte-identical.
    // FREEZE it once draws exist: if the file were re-registered under a super-admin unlock with a
    // different OOP amount and Start pressed again, moving the floor mid-stream would break the running
    // telescoping total (earlier draws were computed against the old floor). So only (re-)snapshot while
    // no draw has been recorded yet (audit A #3).
    const drawsRecorded = Number((await db.query(`SELECT count(*)::int c FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].c) || 0;
    if (drawsRecorded === 0) {
      const oopFloorCents = await orchestrator.registrationOopCents(appId);
      await db.query(`UPDATE sitewire_property_links SET oop_floor_cents=$2, updated_at=now() WHERE application_id=$1`, [appId, oopFloorCents]);
      if (oopFloorCents > 0) await orchestrator.journal({ appId, entity: 'settings', field: 'oop_floor_cents', newValue: String(oopFloorCents), source: 'coordinator_start', changed: true }).catch(() => {});
    }
    // Record the draw-start as a visible team notification so it shows in the file's Draw messages box
    // ("when the draw is being pushed / registered"). Fires once per Start; best-effort.
    notify.notifyAppStaff(appId, {
      type: 'draw_started', title: 'Draw process started',
      body: `The draw process was started for this file — property, construction budget, Scope of Work and fees ${switches.on('SITEWIRE_ENABLED') ? 'were pushed to Sitewire.' : 'will push to Sitewire once it is turned on.'}`,
      badge: { text: 'Draw started', tone: 'teal' }, applicationId: appId, link: `/internal/app/${appId}/draws`,
      // Owner-directed 2026-07-20: a confirmation of an action the coordinator
      // just took is IN-APP ONLY — no whole-team email. It shows on the draw desk.
      inAppOnly: true,
    }).catch(() => {});
    // push everything now (guarded). When Sitewire is off, the link row above (draw_setup_started_at)
    // is the durable birth record — the worker's stranded-birth backfill enqueues the push the moment
    // the switch is turned on, so nothing is lost while staged off.
    if (!switches.on('SITEWIRE_ENABLED')) {
      return res.json({ ok: true, started: true, pushed: false, note: 'Draw setup recorded. Sitewire is currently off — it will push automatically when turned on.' });
    }
    // Push now for immediate read-after-write feedback. A guard failure comes back as
    // { parked } (handled by the coordinator's review list). A TRANSIENT throw (network /
    // circuit) must not be lost — enqueue a durable retry (the worker drains it) so the
    // coordinator's Start is as reliable as the borrower's request-a-draw path (audit L1).
    try {
      const result = await orchestrator.pushFile(appId, {});
      // Property is live in Sitewire now — welcome the borrower (once), best-effort, never blocks.
      require('../sitewire/draw-setup-notify').sendDrawSetupWelcome(appId).catch(() => {});
      return res.json({ ok: true, started: true, result });
    } catch (e) {
      await enqueueSitewirePush(appId, 'push_file').catch(() => {});
      return res.status(202).json({ ok: true, started: true, queued: true, note: 'Draw setup saved. Sitewire is briefly unavailable — the push will retry automatically.' });
    }
  } catch (e) { if (e.status === 422) return res.status(422).json({ error: e.message }); console.warn('[sitewire] start-draw error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- Portal draw requests (phase 4 — blueprint §2 Path B/C, §5B): the staff composer + desk ----
// A PORTAL request is a draw cycle born on OUR website (staff here; the borrower on their
// draws screen) on a physical-inspection file. GET = composer state + pickable lines +
// history + Trinity orders; POST = create (staff may deliberately pass allow_over /
// allow_parallel); then cancel / close-out retry / Trinity actions are the desk's levers.
const intId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
router.get('/files/:id/portal-draws', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const portalDraws = require('../lib/portal-draws');
    const state = await portalDraws.composerState(appId);
    const lines = state.set_up ? await portalDraws.composerLines(appId) : [];
    const history = (await db.query(
      `SELECT id, source, status, platform, lines, total_requested_cents, approved_cents, note,
              tp_draw_id, sitewire_draw_id, cancelled_reason, created_at, updated_at
         FROM portal_draw_requests WHERE application_id=$1 ORDER BY created_at DESC LIMIT 50`, [appId])).rows;
    const trinity = (await db.query(
      `SELECT id, portal_draw_request_id, sitewire_draw_id, status, ordered_at, note, created_at
         FROM trinity_inspection_orders WHERE application_id=$1 ORDER BY created_at DESC LIMIT 50`, [appId])).rows;
    res.json({ state, lines, history, trinity_orders: trinity });
  } catch (e) { console.warn('[sitewire] portal-draws error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.post('/files/:id/portal-draws', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const portalDraws = require('../lib/portal-draws');
    const b = req.body || {};
    const row = await portalDraws.createRequest(appId, Array.isArray(b.entries) ? b.entries : [], {
      source: 'staff', staffId: req.actor.id,
      allowOver: b.allow_over === true, allowParallel: b.allow_parallel === true,
      note: b.note ? String(b.note) : null,
    });
    res.json({ ok: true, request: row });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[sitewire] portal-draw create error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

router.post('/files/:id/portal-draws/:prId/cancel', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, prId = intId(req.params.prId);
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!prId) return res.status(400).json({ error: 'bad request id' });
  try {
    const row = await require('../lib/portal-draws').cancelRequest(appId, prId, {
      staffId: req.actor.id, reason: req.body && req.body.reason ? String(req.body.reason) : null,
    });
    res.json({ ok: true, request: row });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[sitewire] portal-draw cancel error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

// Retry the historical close-out (it also runs by itself on the TrustPoint approval).
router.post('/files/:id/portal-draws/:prId/close-out', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, prId = intId(req.params.prId);
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!prId) return res.status(400).json({ error: 'bad request id' });
  try {
    const r = await require('../lib/portal-draws').historicalCloseOut(appId, prId);
    res.json({ ok: !!r.ok, ...r });
  } catch (e) { console.warn('[sitewire] portal-draw close-out error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// The Trinity decision: per-line approved amounts → approved + close-out attempt.
router.post('/files/:id/portal-draws/:prId/approve-trinity', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, prId = intId(req.params.prId);
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!prId) return res.status(400).json({ error: 'bad request id' });
  try {
    const b = req.body || {};
    const r = await require('../lib/portal-draws').approveTrinityRequest(appId, prId, Array.isArray(b.entries) ? b.entries : [], { staffId: req.actor.id });
    res.json({ ok: true, ...r });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[sitewire] trinity approve error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

router.post('/files/:id/trinity-orders/:orderId/advance', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, orderId = intId(req.params.orderId);
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!orderId) return res.status(400).json({ error: 'bad order id' });
  try {
    const b = req.body || {};
    const row = await require('../lib/portal-draws').advanceTrinityOrder(appId, orderId, String(b.action || ''), {
      staffId: req.actor.id, note: b.note ? String(b.note) : null,
    });
    res.json({ ok: true, order: row });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[sitewire] trinity advance error:', e && e.message); res.status(500).json({ error: 'server error' });
  }
});

// ---- GET /files/:id/draw-request — draw-request form status + captured wire instructions ----
// Everything the coordinator sees for the DocuSign Draw Request & Wire Instructions form:
// whether it can be sent, the latest envelope's status, the borrower-typed wire details
// (account number MASKED — only its last-4), the fatal operating-agreement condition when
// the wire goes to a new entity, and the signed PDF link once it's filed back. Read-only.
router.get('/files/:id/draw-request', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const a = (await db.query(
      `SELECT id, status, ys_loan_number, property_address FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!a) return res.status(404).json({ error: 'file not found' });
    const addr = T.addressForSitewire(a.property_address);
    const prereqs = {
      funded: a.status === 'funded',
      loan_number: !!a.ys_loan_number,
      address: !!(addr && (addr.street || addr.city || addr.state || addr.zip)),
    };
    // Latest draw_request envelope + the borrower signer's progress.
    const env = (await db.query(
      `SELECT id, status, envelope_id, sent_at, completed_at, created_at
         FROM esign_envelopes WHERE application_id=$1 AND purpose='draw_request'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;
    let recipients = [];
    if (env) {
      recipients = (await db.query(
        `SELECT id, role, name, email, borrower_id, status, signed_at, delivered_at, declined_at
           FROM esign_recipients WHERE envelope_row_id=$1 ORDER BY routing_order, role`, [env.id])).rows;
    }
    // The envelope is re-addressable while it is out for signature (sent, not terminal).
    const envLive = !!(env && env.envelope_id && !['completed', 'declined', 'voided'].includes(String(env.status || '')));
    // SELF-HEAL the stored classification BEFORE reading it (owner-reported 2026-08-10: "the
    // entity name is the same but it still shows New Entity"). `name_kind` is written once at
    // capture, so the db/478 known-entity rule fix — and any later profile change (an entity
    // added, verified, or its operating agreement accepted) — never reached already-captured
    // rows: the card kept showing a fatal verdict the live rule no longer holds. Re-running the
    // ONE classifier here (two reads + a pure match) makes the card state the LIVE answer every
    // time it is opened. Best-effort — an error still renders the stored row.
    try { await require('../lib/esign/draw-wire').reclassifyWire(db, appId); } catch (_) { /* best-effort */ }
    // Captured wire — NEVER the raw account number (masked to last-4).
    const w = (await db.query(
      `SELECT account_name, bank_name, account_last4, routing_number, bank_address, account_address,
              name_kind, name_matches, operating_agreement_item_id, captured_at
         FROM draw_wire_instructions WHERE application_id=$1`, [appId])).rows[0] || null;
    const wire = w ? {
      account_name: w.account_name, bank_name: w.bank_name,
      account_number_masked: w.account_last4 ? `****${w.account_last4}` : null,
      routing_number: w.routing_number, bank_address: w.bank_address, account_address: w.account_address,
      name_kind: w.name_kind, name_matches: w.name_matches, captured_at: w.captured_at,
    } : null;
    // The fatal operating-agreement condition, when a new entity — with its document progress so the
    // card can say whether an agreement has been pulled/uploaded and whether it has been accepted.
    let oaCondition = null;
    if (w && w.operating_agreement_item_id) {
      const oa = (await db.query(`SELECT id, status, label FROM checklist_items WHERE id=$1`, [w.operating_agreement_item_id])).rows[0];
      if (oa) {
        const docs = (await db.query(
          `SELECT count(*) FILTER (WHERE review_status='accepted') AS accepted, count(*) AS total
             FROM documents WHERE checklist_item_id=$1 AND is_current`, [oa.id])).rows[0] || {};
        oaCondition = {
          id: oa.id, status: oa.status, label: oa.label, satisfied: oa.status === 'satisfied',
          doc_total: Number(docs.total || 0), doc_accepted: Number(docs.accepted || 0),
        };
      }
    }
    // The signed PDF, once filed back to the condition — with its review state so the desk can
    // show + do the "accept the wire instructions" step right here (owner-directed 2026-08-12).
    const signed = (await db.query(
      `SELECT id, filename, created_at, COALESCE(review_status,'pending') AS review_status, rejection_reason FROM documents
        WHERE application_id=$1 AND doc_kind='draw_request_signed' AND is_current=true
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;
    // The wire-form GATE, the SAME one the delivery step reads, so the card and the money gate can
    // never disagree about whether the wire instructions are accepted.
    const wireForm = await require('../sitewire/investor-delivery-send').wireFormStatus(appId)
      .catch(() => ({ present: false, accepted: true, rejectedOnly: false }));
    res.json({
      docusign_enabled: switches.on('DOCUSIGN_SEND_ENABLED'),
      docusign_test_mode: !!cfg.docusign.testMode,
      prereqs,
      can_send: switches.on('DOCUSIGN_SEND_ENABLED') && Object.values(prereqs).every(Boolean),
      envelope: env ? {
        row_id: env.id, status: env.status, sent_at: env.sent_at, completed_at: env.completed_at, created_at: env.created_at,
        terminal: ['completed', 'declined', 'voided'].includes(String(env.status || '')),
        // Live = out for signature, so its recipient's email can still be corrected + re-sent.
        live: envLive,
      } : null,
      // `id` + `can_change_email` let the panel offer "change email & re-send" per signer
      // (a signed/declined signer can't be re-addressed). `has_file_email_mismatch` drives
      // the "also update the email on the file" warning without exposing the raw file email.
      recipients: recipients.map((r) => ({
        id: r.id, role: r.role, name: r.name, email: r.email, status: r.status,
        signed_at: r.signed_at, viewed_at: r.delivered_at,
        can_change_email: envLive && !r.signed_at && !r.declined_at && r.status !== 'signed' && r.status !== 'completed' && r.status !== 'declined',
      })),
      // Who the wire form CAN be sent to (borrower / co-borrower) so the UI can offer the choice.
      recipient_options: await require('../lib/draw-recipients').drawRecipients(appId).catch(() => ({ borrower: null, coBorrower: null })),
      wire,
      operating_agreement: oaCondition,
      signed_document: signed ? { id: signed.id, filename: signed.filename, created_at: signed.created_at, review_status: signed.review_status, rejection_reason: signed.rejection_reason || null } : null,
      wire_form: wireForm,
    });
  } catch (e) { console.warn('[sitewire] draw-request status error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /files/:id/wire-form/review — accept / reject the signed wire instructions ----
// The borrower's signed DocuSign wire form files onto the draw-request condition; the money can
// only move once ONE correct version is ACCEPTED. This lets the DRAW COORDINATOR do that step
// right on the draw desk (owner-directed 2026-08-12: "accept the wire instructions, part of the
// process of approving a draw … I don't see any option"). It writes the ONE shared 'accepted'
// definition (document-acceptance / review_status='accepted'), so this desk, the delivery gate
// and the sign-off gate can never disagree about what "accepted" means.
router.post('/files/:id/wire-form/review', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const action = String((req.body || {}).action || '');
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be accept or reject' });
  const reason = String((req.body || {}).reason || '').trim();
  if (action === 'reject' && !reason) return res.status(400).json({ error: 'a rejection reason is required' });
  try {
    const doc = (await db.query(
      `SELECT id FROM documents
        WHERE application_id=$1 AND is_current=true AND doc_kind='draw_request_signed'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    if (!doc) return res.status(404).json({ error: 'No signed wire form is on file to review.' });
    const status = action === 'accept' ? 'accepted' : 'rejected';
    await db.query(
      `UPDATE documents SET review_status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
      [doc.id, status, action === 'reject' ? reason.slice(0, 1000) : null, req.actor.id]);
    res.json({ ok: true, status });
  } catch (e) { console.warn('[sitewire] wire-form review error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /files/:id/draw-request/send — send the Draw Request & Wire Instructions form via DocuSign ----
// Creates (idempotently) the "Signed draw request form" draw condition, then sends the
// PILOT-branded, auto-filled form through the existing DocuSign integration. The borrower
// fills the wire boxes + signs on DocuSign; on completion the signed PDF files back to the
// condition and the typed wire values are captured (webhook → draw-wire).
router.post('/files/:id/draw-request/send', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const a = (await db.query(
      `SELECT id, status, ys_loan_number, property_address FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!a) return res.status(404).json({ error: 'file not found' });
    if (a.status !== 'funded') return res.status(409).json({ error: 'The draw request form is sent once the loan is funded.' });
    const addr = T.addressForSitewire(a.property_address);
    if (!a.ys_loan_number || !(addr && (addr.street || addr.city || addr.state || addr.zip))) {
      return res.status(422).json({ error: 'The file needs a loan number and a property address before the draw request can go out.' });
    }
    if (!switches.on('DOCUSIGN_SEND_ENABLED')) {
      return res.status(422).json({ error: 'DocuSign sending is turned off (DOCUSIGN_SEND_ENABLED). Turn it on to send the draw request form.' });
    }
    // Recipient choice (owner-directed 2026-07-21): send the wire form to the borrower (default) or the
    // co-borrower. Validated: 'co_borrower' is only allowed when the file actually has a co-borrower WITH an email.
    let recipient = (req.body && String(req.body.recipient || '').trim()) || 'borrower';
    if (recipient !== 'co_borrower') recipient = 'borrower';
    if (recipient === 'co_borrower') {
      const cob = (await db.query(
        `SELECT cb.id, cb.email FROM applications a JOIN borrowers cb ON cb.id=a.co_borrower_id WHERE a.id=$1`, [appId])).rows[0];
      if (!cob) return res.status(400).json({ error: 'This file has no co-borrower to send the wire form to.' });
      if (!cob.email) return res.status(400).json({ error: 'The co-borrower has no email on file — add one before sending the wire form to them.' });
    }
    // Ensure the draw condition exists FIRST so the signed PDF has somewhere to file back to.
    await drawWire.ensureDrawRequestCondition(db, appId, req.actor && req.actor.id);
    const reissue = !!(req.body && req.body.reissue);
    const out = await esignOrchestrate.sendPackage(appId, 'draw_request', req.actor, { reissue, recipient });
    if (out && out.terminal) {
      return res.status(409).json({ error: 'A draw request was already sent for this file. Use "Re-send" to issue a fresh one.', terminal: true, latestStatus: out.latestStatus });
    }
    if (!out || !out.ok) {
      return res.status(202).json({ ok: false, queued: true, note: 'The draw request is queued to send — it will go out shortly.' });
    }
    notify.notifyAppStaff(appId, {
      type: 'draw_started', title: 'Draw request form sent for signature',
      body: 'The Draw Request & Wire Instructions form was sent to the borrower via DocuSign. Their wire details will be captured here once they sign.',
      badge: { text: 'Sent for signature', tone: 'teal' }, applicationId: appId, link: `/internal/app/${appId}/draws`,
    }).catch(() => {});
    res.json({ ok: true, envelopeRowId: out.envelopeRowId });
  } catch (e) {
    if (e && e.code === 'DOCUSIGN_SEND_DISABLED') return res.status(422).json({ error: 'DocuSign sending is turned off. Turn it on to send the draw request form.' });
    if (e && e.code === 'DOCUSIGN_GATE_NOT_READY') return res.status(422).json({ error: e.message });
    if (e && e.retryable === false && e.message) return res.status(422).json({ error: e.message });
    console.warn('[sitewire] draw-request send error:', e && e.message);
    res.status(502).json({ error: 'The signing service is temporarily unavailable — nothing was sent; try again shortly.' });
  }
});

// ---- POST /files/:id/draw-request/recipient-email — change the wire form's email + re-send ----
// The wire form went out to a wrong email? Correct the signer's email on the in-flight
// DocuSign envelope and re-send the invitation to the new address (owner-directed), without
// voiding + re-issuing. The wire form is a solo-signer package, so with no recipientRowId in
// the body we correct that single signer. Reuses the shared esign recipient-email helper.
router.post('/files/:id/draw-request/recipient-email', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const env = (await db.query(
      `SELECT id FROM esign_envelopes WHERE application_id=$1 AND purpose='draw_request'
        ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0] || null;
    if (!env) return res.status(404).json({ error: 'No draw request form has been sent for this file yet.' });
    let recipientRowId = String((req.body && req.body.recipientRowId) || '').trim();
    if (!recipientRowId) {
      // Solo package — the single borrower signer, if any is still awaiting.
      const r = (await db.query(
        `SELECT id FROM esign_recipients WHERE envelope_row_id=$1 AND role='borrower'
          ORDER BY routing_order LIMIT 1`, [env.id])).rows[0];
      if (!r) return res.status(404).json({ error: 'That signer isn’t on this form — refresh and try again.' });
      recipientRowId = r.id;
    }
    const out = await require('../lib/esign/recipient-email').changeRecipientEmail({
      envelopeRowId: env.id, recipientRowId,
      email: (req.body && req.body.email) || '', name: (req.body && req.body.name) || '',
      actorId: req.actor && req.actor.id, db,
    });
    // Best-effort audit — an irreversible re-address must be recorded, but the logging
    // write can never fail the action.
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
         VALUES ('staff',$1,'esign_recipient_email_changed','application',$2,$3,$4,$5)`,
        [req.actor && req.actor.id, appId, req.ip, req.get('user-agent') || null,
         { purpose: 'draw_request', role: out.role, from: out.prevEmail, to: out.email, differsFromFile: out.differsFromFile }]);
    } catch (_) { /* logging is best-effort */ }
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.status && e.expose) return res.status(e.status).json({ error: e.message });
    if (e && e.retryable === false && e.message) return res.status(400).json({ error: e.message });
    console.warn('[sitewire] draw-request recipient-email error:', e && e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ---- POST /api/sitewire/requests/:reqId/approve — set approved_cents on a draw line ----
router.post('/requests/:reqId/approve', requirePermission('manage_draws'), async (req, res) => {
  if (!switches.on('SITEWIRE_ENABLED') || !switches.on('SITEWIRE_OUTBOUND_ENABLED')) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const reqId = req.params.reqId;
  if (!/^\d+$/.test(reqId)) return res.status(404).json({ error: 'request not found' });
  const approvedCents = Math.round(Number(req.body.approved_cents));
  const lenderComments = req.body.lender_comments || undefined;
  if (!Number.isFinite(approvedCents) || approvedCents < 0) return res.status(400).json({ error: 'approved_cents must be a non-negative whole number of cents' });
  // scope: the request must belong to a file the actor can see. Also LEFT JOIN the crosswalk so we
  // know whether the job item is a media/inspection-gate row (is_media_item=true) — those carry no
  // money and must never accept a non-zero approved amount even from a raw API call bypassing the UI.
  const own = (await db.query(
    `SELECT r.sitewire_request_id, r.requested_cents, d.application_id, d.sitewire_draw_id,
            COALESCE(jil.is_media_item, false) AS is_media_item, jil.name AS crosswalk_name
       FROM sitewire_draw_requests r
       JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id
       LEFT JOIN sitewire_job_item_links jil ON jil.application_id=d.application_id AND jil.sitewire_job_item_id=r.sitewire_job_item_id
      WHERE r.sitewire_request_id=$1`, [reqId])).rows[0];
  if (!own || !(await canSeeFile(req, own.application_id))) return res.status(403).json({ error: 'forbidden' });
  // Owner-directed 2026-07-22: refuse a non-zero approved amount on a media/inspection-gate line.
  // Sitewire lists these as "Photo Required" / "Video Required" and never as money lines; the
  // draw desk UI hides the money input, but a raw API call must be blocked too. approved=0 IS
  // allowed (a coordinator could still hit Save with 0 to record an explicit zero).
  if (own.is_media_item && approvedCents > 0) {
    return res.status(422).json({ error: `"${own.crosswalk_name || 'This line'}" is a photo/video inspection gate — no money can be approved against it. Enter the amount on the real budget lines instead.` });
  }
  // G-APPRV: never exceed requested without an explicit override. Owner-directed 2026-07-21:
  // `override:true` is a MONEY escalation (approved > requested is the coordinator overriding the
  // inspector's number), so restrict it to super_admin AND require a note documenting why. Journal
  // every override so the audit trail explains any approved-over-requested figure on this line.
  let overrideEvidence = null;
  if (approvedCents > own.requested_cents) {
    if (!req.body.override) {
      return res.status(422).json({ error: `approved ${T.usd(approvedCents)} exceeds requested ${T.usd(own.requested_cents)} — pass override:true (super_admin only, with a note) to allow` });
    }
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ error: 'Only a super admin can approve more than the borrower requested. Ask an admin to override this line.' });
    }
    const overrideNote = req.body.override_note ? String(req.body.override_note).trim() : '';
    if (!overrideNote || overrideNote.length < 8) {
      return res.status(400).json({ error: 'An override note (at least 8 characters) is required to approve more than requested.' });
    }
    // Best-effort journal BEFORE the write so the intent is captured even if the Sitewire push then fails.
    try { await orchestrator.journal({ appId: own.application_id, entity: 'request', entityId: Number(reqId), field: 'override_approve', oldValue: { requested_cents: own.requested_cents }, newValue: { approved_cents: approvedCents, note: overrideNote.slice(0, 500), actor: req.actor && req.actor.id }, source: 'money_override' }); } catch (_) {}
    // …and the PROOF behind it — the invoice or receipt that justifies approving more than was
    // asked for. Filed on the draw, so it travels to the investor with everything else.
    overrideEvidence = await attachOverrideEvidence(own.application_id, own.sitewire_draw_id, req.body, req.actor && req.actor.id,
      `Approved ${T.usd(approvedCents)} on a line the borrower requested ${T.usd(own.requested_cents)} for`);
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
      return res.json({ ok: true, approved_cents: saved, ...(overrideEvidence || {}) });
    }
    res.json({ dryrun: true, approved_cents: approvedCents, ...(overrideEvidence || {}) });
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

/**
 * FINAL APPROVE FINISHES THE DRAW (owner-directed 2026-08-09: "the last step that we have access
 * to do on the draws is final approved, and since, by default, we don't release the wire, final
 * approved means, technically, the wire is released for now").
 *
 * Final approve used to do nothing but flip a status: no money recorded, nobody told, no history.
 * Now it (1) stamps the stage, (2) writes the money ledger ITSELF when the INVESTOR releases —
 * because on those files the final approval IS the release — and (3) tells the borrower and the
 * team, in ONE threaded email carrying the draw number and the figures.
 *
 * Every step is independently caught. This runs after a transition Sitewire has already accepted,
 * so nothing here may reverse it, and a failure leaves the coordinator exactly where they were
 * before: able to record the release by hand on the disbursements route, unchanged.
 */
async function finishFinalApprove(appId, drawId, staffId, note) {
  const out = {};

  // 1. The stage, stamped forward-only. Written first so the history records the approval even if
  //    the money or the email later fails.
  try {
    await stageEvents.record(appId, { sitewireDrawId: drawId }, 'final_approved', {
      detail: 'Final approval recorded', actorStaffId: staffId || null, source: 'pilot' });
  } catch (_) {}

  // 2. The money ledger — ONLY when the investor releases. On a we-release file this writes
  //    nothing and the manual disbursements route stays the record of the wire we actually send.
  let ledger = null;
  try {
    ledger = await autoRelease.recordInvestorRelease(appId, drawId, { staffId: staffId || null, note: note || null });
    if (ledger && ledger.recorded) {
      out.ledger = { recorded: true, funded_status: ledger.row.funded_status, net_release_cents: ledger.row.net_release_cents, fee_status: ledger.row.fee_status };
      await stageEvents.record(appId, { sitewireDrawId: drawId }, 'released', {
        detail: ledger.waiversMissing && ledger.waiversMissing.length
          ? 'Investor released — held pending lien waivers'
          : 'Investor released the money directly', actorStaffId: staffId || null, source: 'pilot' }).catch(() => {});
    } else if (ledger) {
      out.ledger = { recorded: false, reason: ledger.skipped };
    }
  } catch (_) {}

  // 3. A LIEN-WAIVER FAILURE IS NEVER SILENT. The row was recorded as `held` rather than released
  //    (the money already moved — refusing to record it would only lose the record), so the desk is
  //    told immediately, naming exactly which waivers are outstanding.
  if (ledger && ledger.recorded && ledger.waiversMissing && ledger.waiversMissing.length) {
    out.waivers_missing = ledger.waiversMissing;
    try {
      await notify.notifyAppStaff(appId, {
        type: 'draw', title: 'Draw released by the investor — lien waivers still outstanding',
        drawTag: await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: drawId }),
        badge: { text: 'Action needed', tone: 'action' },
        body: `This draw was finally approved and the investor releases this file's draws directly, so the money has moved. `
          + `It is recorded as HELD rather than released because these lien waivers are still outstanding: ${ledger.waiversMissing.join('; ')}. `
          + `Collect or waive them, then mark the release complete.`,
        applicationId: appId, link: `/internal/app/${appId}/draws`, ctaLabel: 'Open the draw desk',
      });
    } catch (_) {}
  }

  // 4. FINAL APPROVE STOPS BEING SILENT. One email, borrower in To and the draw team on a visible
  //    Cc (the loop-in is applied at the notify chokepoint for every 'draws' notification). The
  //    money comes from `drawEmailBlocks` → the rollup → `approval.drawMoney` — read AFTER the
  //    ledger row above, so the figures and the ledger can never disagree. Nothing is recomputed.
  try {
    const releasedNow = !!(ledger && ledger.recorded && ledger.row.funded_status === 'released');
    const blocks = await drawEmailBlocks(db, appId, { sitewireDrawId: drawId, borrower: true });
    await notify.notifyAppThread(appId, {
      type: 'draw',
      drawTag: await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: drawId }),
      title: releasedNow ? 'Your draw is approved — the money is on its way' : 'Your draw has been approved',
      staffTitle: releasedNow ? 'Draw finally approved — investor released, ledger recorded' : 'Draw finally approved',
      staffBody: releasedNow
        ? 'Final approval recorded. This file\'s draws are released by the investor, so the release was written to the money ledger automatically and our fee is now owed to us.'
        : 'Final approval recorded. We release this file\'s draws, so record the wire on the draw desk when it goes out.',
      figures: (blocks && blocks.figures) || null,
      facts: (blocks && blocks.facts) || null,
      badge: { text: releasedNow ? 'Released' : 'Approved', tone: 'positive' },
      body: releasedNow
        ? 'Your draw has been fully approved and the funds have been released. Depending on your bank, they typically take 1–2 business days to arrive.'
        : 'Your draw has been fully approved. Your loan team is arranging the wire — we will let you know the moment it goes out.',
      lines: ['Questions about this draw? Just reply to this email — your loan team is on it.'],
      applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws',
    });
    out.notified = true;
  } catch (_) { /* the email is best-effort; the approval stands either way */ }

  return out;
}

// ---- POST /api/sitewire/draws/:drawId/:action — approve / amend / reopen ----
router.post('/draws/:drawId/:action', requirePermission('manage_draws'), async (req, res) => {
  if (!switches.on('SITEWIRE_ENABLED') || !switches.on('SITEWIRE_OUTBOUND_ENABLED')) return res.status(503).json({ error: 'Sitewire writes are turned off' });
  const { drawId, action } = req.params;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!client.DRAW_TRANSITIONS.has(action)) return res.status(400).json({ error: 'action must be approve, amend, or reopen' });
  const own = (await db.query(`SELECT application_id FROM sitewire_draws WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
  if (!own || !(await canSeeFile(req, own.application_id))) return res.status(403).json({ error: 'forbidden' });
  // Audit finding B-10 (2026-07-21): amend + reopen are destructive draw-state changes (they take a
  // draw the lender already decided on and re-open it for another round of work) — the audit trail
  // must record WHY. Require + persist a note ≥ 8 chars for those two actions; approve stays note-
  // optional (the approval itself is self-explanatory). Journaled with the note below.
  let note = null;
  if (action === 'amend' || action === 'reopen') {
    note = req.body && req.body.note ? String(req.body.note).trim() : '';
    if (!note || note.length < 8) return res.status(400).json({ error: `Add a note (at least 8 characters) explaining why you are ${action === 'amend' ? 'amending' : 'reopening'} this draw.` });
    note = note.slice(0, 500);
  }
  try {
    await orchestrator.circuitCheck(1);
    const r = await client.drawTransition(drawId, action);
    if (!(r && r.__dryrun)) {
      await orchestrator.journal({ appId: own.application_id, entity: 'draw', entityId: Number(drawId), field: action, newValue: { status: r && r.status, note, actor: req.actor && req.actor.id }, source: 'push' });
      await reconcile.reconcileOne(own.application_id).catch(() => {});
    }
    // FINAL APPROVE FINISHES THE DRAW. Everything below runs AFTER the Sitewire transition and the
    // reconcile — nothing about that call changes — and every piece is best-effort: an approval that
    // already happened in Sitewire must never be reversed or 500'd by our own bookkeeping.
    // An AMEND or a REOPEN takes a draw the lender already decided on and sends it back for another
    // round — the note says why, and an attached invoice/receipt/photo says what changed.
    let evidence = null;
    if ((action === 'amend' || action === 'reopen') && !(r && r.__dryrun)) {
      evidence = await attachOverrideEvidence(own.application_id, drawId, req.body, req.actor && req.actor.id,
        `${action === 'amend' ? 'Amended' : 'Reopened'} this draw — ${String(note || '').slice(0, 200)}`);
    }
    let finished = null;
    if (action === 'approve' && !(r && r.__dryrun)) {
      finished = await finishFinalApprove(own.application_id, drawId, req.actor && req.actor.id, note)
        .catch((e) => { console.warn('[sitewire] final-approve follow-through:', e && e.message); return null; });
    }
    res.json({ ok: true, status: r && r.status, ...(finished || {}), ...(evidence || {}) });
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
  const own = (await db.query(`SELECT total_approved_cents, number FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [sitewire_draw_id, application_id])).rows[0];
  if (!own) return res.status(400).json({ error: 'that draw is not on this file' });
  const drawId = sitewire_draw_id;
  // M1: don't record a release larger than what the lender actually approved on this draw. Owner-directed
  // 2026-07-21: `override:true` on a disbursement is REAL MONEY going out — a bigger wire than the approval
  // — so restrict to super_admin AND require a note. Every override is journaled so a future audit can
  // reconstruct why any release exceeded the approval.
  const drawApproved = Number(own.total_approved_cents) || 0;
  let releaseEvidence = null;
  if (drawApproved > 0 && approved > drawApproved) {
    if (!req.body.override) {
      return res.status(422).json({ error: `${T.usd(approved)} is more than the ${T.usd(drawApproved)} approved on this draw — pass override:true (super_admin only, with a note) to record it anyway.` });
    }
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ error: 'Only a super admin can record a release larger than the approved amount. Ask an admin to override.' });
    }
    const overrideNote = req.body.override_note ? String(req.body.override_note).trim() : '';
    if (!overrideNote || overrideNote.length < 8) {
      return res.status(400).json({ error: 'An override note (at least 8 characters) is required to release more than the approved amount.' });
    }
    try { await orchestrator.journal({ appId: application_id, entity: 'draw', entityId: Number(drawId), field: 'override_disbursement', oldValue: { approved_on_draw_cents: drawApproved }, newValue: { released_cents: approved, note: overrideNote.slice(0, 500), actor: req.actor && req.actor.id }, source: 'money_override' }); } catch (_) {}
    // …and the PROOF behind releasing more than was approved. Filed on the draw before the money
    // transaction opens, so nothing is held while bytes are written to storage.
    releaseEvidence = await attachOverrideEvidence(application_id, drawId, req.body, req.actor && req.actor.id,
      `Released ${T.usd(approved)} against ${T.usd(drawApproved)} approved on this draw`);
  }
  // H1: a draw is released once — block a duplicate ledger row up front (the db/148 unique index is the
  // belt-and-suspenders). A duplicate would double-count into the retainage pool.
  const dup = await db.query(`SELECT 1 FROM draw_disbursements WHERE sitewire_draw_id=$1 AND kind='draw'`, [drawId]);
  if (dup.rowCount) return res.status(409).json({ error: 'A release is already recorded for this draw — correct the existing entry instead of adding another.' });
  // Phase 5 (audit-5 #1b): the administrator's observed release may have mirrored BEFORE
  // the draw tie landed — that row carries the TrustPoint draw id but no sitewire_draw_id
  // yet. A hand-recorded second row for the same wire would double-count the ledger.
  const dupTp = await db.query(
    `SELECT 1 FROM draw_disbursements dd JOIN trustpoint_draws t ON t.tp_draw_id = dd.trustpoint_draw_id
      WHERE dd.kind='draw' AND (t.sitewire_draw_id=$1
         OR t.portal_draw_request_id IN (SELECT id FROM portal_draw_requests WHERE sitewire_draw_id=$1))`, [drawId]);
  if (dupTp.rowCount) return res.status(409).json({ error: 'This draw\'s release was already recorded automatically from the draw administrator — there is nothing to enter by hand.' });
  // retainage pct is a stable config read (its own connection is fine outside the money txn).
  const pct = await retainagePctFor(application_id);
  // Serialize the release per file (audit A #1 — real money). Out-of-pocket-first makes the reimbursable
  // amount depend on the RUNNING approved total across draws, so the prior-sum read and the insert must be
  // atomic: two DIFFERENT draws recorded at once would otherwise both read the same prior total and each
  // under-reimburse against the floor. A per-file advisory xact lock (same pattern as retainage-release)
  // makes the second draw see the first's committed row. floor=0 files don't depend on the prior sum, so
  // this only tightens the OOP-exception case; a normal single release is unaffected.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sw-disb:${application_id}`]);
    // Out-of-pocket-first (owner-directed 2026-07-31 — the OOP-rehab exception): the borrower funds the
    // first `floorCents` of rehab themselves, so it is never reimbursed. The floor was snapshotted onto the
    // property link when the draw process started (0 when there is no exception → every number below is
    // byte-identical). `priorApproved` is the approved rehab already recorded on this file's earlier draws
    // (read UNDER the lock so a concurrent draw can't hand us a stale running total); computeRelease
    // reimburses only the part of THIS draw that clears the running floor.
    const floorCents = Number(((await client.query(`SELECT oop_floor_cents FROM sitewire_property_links WHERE application_id=$1`, [application_id])).rows[0] || {}).oop_floor_cents) || 0;
    const priorApproved = Number((await client.query(`SELECT COALESCE(sum(approved_cents),0) s FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [application_id])).rows[0].s) || 0;
    const split = computeRelease({ approvedCents: approved, feeCents: fee, retainagePct: pct, oopFloorCents: floorCents, priorApprovedCents: priorApproved });
    if (!split.ok) { await client.query('ROLLBACK'); return res.status(422).json({ error: split.violation }); }
    // lien-waiver gate: the release already named its draw (required above), so we check exactly that draw's
    // waivers. Block the release if any required waiver is still outstanding (never guessed).
    if (fundedStatus === 'released' && await lienGateEnabled(application_id)) {
      const waivers = (await client.query(`SELECT status, tier, party_name, kind FROM draw_lien_waivers WHERE sitewire_draw_id=$1`, [drawId])).rows;
      const gate = waiverGate(waivers, { enabled: true });
      if (!gate.ok) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Lien waivers still outstanding: ${gate.missing.join('; ')}. Mark them received or waived before releasing.`, missing: gate.missing }); }
    }
    // WHO released, per the file's "Who releases the money" setting (owner-directed 2026-08-12: the
    // money ledger should record who released "according to the settings"). reimbursement → us,
    // investor_direct → investor, manual/unset → us (the column's own default). Resolved under the
    // txn's client; never fatal — a lookup miss keeps the safe default.
    let releaseParty = 'us';
    try { releaseParty = (await require('../sitewire/release-party').releaseStateFor(client, application_id, { sitewireDrawId: drawId })).party || 'us'; } catch (_) {}
    const row = (await client.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, fee_kind, retainage_held_cents, net_release_cents, release_date, funded_status, kind, note, created_by, release_party)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draw',$10,$11,$12) RETURNING *`,
      [application_id, drawId, approved, fee, feeKind, split.retainage_held_cents, split.net_release_cents, releaseDate, fundedStatus, req.body.note ? String(req.body.note).slice(0, 2000) : null, req.actor.id, releaseParty])).rows[0];
    await client.query('COMMIT');
    // Milestone → borrower (owner-directed 2026-07-20): a construction draw was released. Tell them the NET
    // amount actually on its way (reimbursable − fee − retainage), only on an actual release. type 'draw'
    // emails the borrower. Best-effort + OUTSIDE the money txn/lock (never hold the lock during email).
    if (fundedStatus === 'released' && split.net_release_cents > 0) {
      try {
        const amt = '$' + (split.net_release_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        // The release is now the HEADLINE figure, with the approval, the request and the draw fee
        // beneath it (draw rule 15). The release row was committed a moment ago, so the rollup —
        // the same one the branded PDF and the desk read — already reports this draw as released
        // and its figures agree with `amt` by construction.
        const blocks = await drawEmailBlocks(db, application_id, { sitewireDrawId: drawId, borrower: true });
        // ONE email, the whole team visibly on it (draw rule 15). The loop-in Cc is applied at the
        // notify chokepoint for every 'draws' notification, so the old bccExtra — which put the
        // desk on an invisible Bcc nobody could reply-all to — is no longer needed here.
        await notify.notifyAppThread(application_id, {
          type: 'draw',
          // The draw number leads the SUBJECT (drawTag) rather than sitting inside the
          // sentence: three draws on one property otherwise produce three identical
          // subjects. The inline `#N` is gone from both titles so it is never printed twice.
          drawTag: drawLabel.drawLabel(own.number),
          title: 'Your construction draw has been released',
          staffTitle: 'Draw funds released',
          staffBody: `A construction draw of ${amt} was released to the borrower on this file.`,
          figures: (blocks && blocks.figures) || null,
          facts: (blocks && blocks.facts) || null,
          // The hero survives only as the fallback, so the email never loses its headline number.
          hero: (blocks && blocks.figures) ? null
            : { label: 'Released to you', value: amt, sub: 'typically arrives in 1–2 business days', tone: 'positive' },
          badge: { text: 'Draw released', tone: 'positive' },
          body: `Your loan team has released a construction draw on your file. Depending on your bank, funds typically take 1–2 business days to arrive.`,
          lines: ['Questions about this draw? Just reply to this email — your loan team is on it.'],
          applicationId: application_id, link: `/app/${application_id}`, ctaLabel: 'View your draws' });
      } catch (_) { /* milestone email is best-effort */ }
    }
    res.json({ ok: true, disbursement: row, ...(releaseEvidence || {}) });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already unwound */ }
    // db/148 unique index — a second draw release raced past the pre-check
    if (e.code === '23505') return res.status(409).json({ error: 'A release is already recorded for this draw.' });
    res.status(500).json({ error: 'Could not record this release — please try again.' });
  } finally {
    client.release();
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
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sw-retrel:${appId}`]);
    const held = Number((await client.query(`SELECT COALESCE(sum(retainage_held_cents),0) h FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].h) || 0;
    const already = Number((await client.query(`SELECT COALESCE(sum(net_release_cents),0) r FROM draw_disbursements WHERE application_id=$1 AND kind='retainage_release'`, [appId])).rows[0].r) || 0;
    const toRelease = held - already;
    if (toRelease <= 0) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'no retainage is being held to release' }); }
    // Snapshot the total-held at this moment onto the release row (db/241) so a later retro-edit
    // of an old draw's retainage_held_cents can't silently shift the pool — the audit trail shows
    // exactly what was held when we wired this release (audit finding 2026-07-21).
    const row = (await client.query(
      `INSERT INTO draw_disbursements (application_id, approved_cents, fee_cents, retainage_held_cents, net_release_cents, held_at_release_cents, release_date, funded_status, kind, note, created_by)
       VALUES ($1,$2,0,0,$2,$3,$4,'released','retainage_release',$5,$6) RETURNING *`,
      [appId, toRelease, held, relDate, relNote, req.actor.id])).rows[0];
    await client.query('COMMIT');
    // Milestone → borrower: the completion retainage has been released.
    try {
      const amt = '$' + (toRelease / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // A retainage release is not a DRAW, so there is no per-draw money object and no `drawFigures`
      // stage to read — the one number that matters is the amount being wired. It is formatted by
      // the composer's own `usd` (whole dollars, like every other draw headline) so this band can
      // never disagree in shape with the ones beside it; nothing is computed here. The facts box is
      // the FILE-level budget picture, which is exactly the right closing statement.
      const blocks = await drawEmailBlocks(db, appId, { borrower: true });
      await notify.notifyAppThread(appId, {
        type: 'draw',
        title: `Your held-back retainage has been released`,
        staffTitle: 'Retainage released at completion',
        staffBody: `The retainage held back across this file's draws — ${amt} — was released to the borrower.`,
        figures: { primary: { label: 'Retainage released', value: drawEmail.usd(toRelease), sub: 'held back across your draws — now yours', tone: 'positive' }, secondary: [] },
        facts: (blocks && blocks.facts) || null,
        badge: { text: 'Complete', tone: 'positive' },
        body: `With your construction complete, the retainage we held back across your draws has now been released. Depending on your bank, funds typically take 1–2 business days to arrive.`,
        applicationId: appId, link: `/app/${appId}`, ctaLabel: 'View your draws' });
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, disbursement: row, released_cents: toRelease });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: 'Could not release the retainage — please try again.' }); }
  finally { client.release(); }
});

// ---- lien waivers (per draw) ----
router.get('/files/:id/waivers', requireDrawView, async (req, res) => {
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
  const w = (await db.query(`SELECT application_id, sitewire_draw_id, tier, party_name, kind FROM draw_lien_waivers WHERE id=$1`, [req.params.wid])).rows[0];
  if (!w || !(await canSeeFile(req, w.application_id))) return res.status(403).json({ error: 'forbidden' });
  // THE WAIVER ITSELF. `draw_lien_waivers.document_id` has existed since the money model shipped and
  // nothing ever filled it, so "received" was a word with no paper behind it — on the one gate that
  // stands between a contractor's claim and a release. The signed waiver is filed on the draw like
  // any other supporting document (so it reaches the investor and SharePoint) and the row is pointed
  // at it. A waiver with no draw has nowhere to file, so it records the status alone, as before.
  let filed = null;
  const upload = (req.body && (req.body.document || (req.body.dataBase64 ? req.body : null))) || null;
  if (upload && w.sitewire_draw_id != null) {
    const out = await drawAttachments.attach(w.application_id, { sitewireDrawId: w.sitewire_draw_id }, [{ ...upload, category: 'other' }], {
      by: { kind: 'staff', id: req.actor.id },
      supports: `Lien waiver — ${w.tier || 'party'}${w.party_name ? ' ' + w.party_name : ''} (${w.kind || 'conditional'})`,
    });
    filed = { attached: out.added.length, attachments_skipped: out.skipped };
    if (out.added[0]) {
      await db.query(`UPDATE draw_lien_waivers SET document_id=$2 WHERE id=$1`, [req.params.wid, out.added[0].document_id]).catch(() => {});
    }
  }
  await db.query(`UPDATE draw_lien_waivers SET status=$2, received_at=CASE WHEN $2 IN ('received','waived') THEN now() ELSE NULL END, note=COALESCE($3,note), updated_at=now() WHERE id=$1`, [req.params.wid, status, req.body.note ? String(req.body.note).slice(0, 2000) : null]);
  res.json({ ok: true, status, ...(filed || {}) });
});

// ---- GET /files/:id/gl-export — the release ledger as a GL/accounting Excel workbook ----
router.get('/files/:id/gl-export', requirePermission('manage_draws'), async (req, res) => {
  if (!(await canSeeFile(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const rows = (await db.query(
      `SELECT d.created_at, d.release_date, d.sitewire_draw_id, d.kind, d.approved_cents, d.fee_cents, d.retainage_held_cents, d.net_release_cents, d.funded_status,
              d.release_party, d.fee_receivable_cents, d.fee_status, d.fee_received_date, d.note_buyer_label,
              a.ys_loan_number, a.property_address->>'oneLine' AS address
         FROM draw_disbursements d JOIN applications a ON a.id=d.application_id
        WHERE d.application_id=$1 ORDER BY d.created_at`, [req.params.id])).rows;
    const c = (x) => Math.round(Number(x || 0)) / 100;
    // Out-of-pocket-first (owner-directed 2026-07-31): on an OOP-rehab draw the reimbursable amount is
    // less than the approved amount, so approved − fee − retainage ≠ net. The gap is the borrower's
    // out-of-pocket portion; expose it as its own column so every row reconciles exactly
    // (Approved = Fee + Retainage held + Net release + Out-of-pocket held). It is 0 on a normal draw and
    // on a retainage-release row, so a file with no exception is byte-identical apart from the new column.
    const n = (x) => Number(x || 0);
    const oopHeldCents = (r) => (r.kind === 'draw' ? Math.max(0, n(r.approved_cents) - n(r.fee_cents) - n(r.retainage_held_cents) - n(r.net_release_cents)) : 0);
    // WHO RELEASED, and what the investor still owes us (owner-directed 2026-08-09). Accounting has
    // to be able to tell a wire WE sent from one the investor sent — the cash left our account in
    // one case and not the other — and to see the fee receivable beside the release that created
    // it. Every existing column keeps its position and meaning; these are appended.
    const RELEASED_BY = { us: 'Us', investor: 'Investor' };
    const FEE_STATUS = { n_a: '', owed: 'Owed by investor', received: 'Received' };
    const out = [['Loan', 'Property', 'Recorded', 'Release date', 'Draw', 'Type', 'Approved', 'Fee', 'Retainage held', 'Net release', 'Out-of-pocket held', 'Status', 'Released by', 'Investor', 'Fee owed to us', 'Fee status', 'Fee received']];
    for (const r of rows) out.push([r.ys_loan_number || '', r.address || '', new Date(r.created_at).toISOString().slice(0, 10), r.release_date || '', r.sitewire_draw_id ? '#' + r.sitewire_draw_id : '', r.kind, c(r.approved_cents), c(r.fee_cents), c(r.retainage_held_cents), c(r.net_release_cents), c(oopHeldCents(r)), r.funded_status,
      RELEASED_BY[r.release_party] || r.release_party || '', r.note_buyer_label || '',
      // Only a fee actually OWED is a receivable — a received one is history and a we-release draw
      // never had one, so printing 0.00 in those rows would read as a debt of nothing.
      r.fee_status === 'owed' ? c(r.fee_receivable_cents) : '', FEE_STATUS[r.fee_status] || '', r.fee_received_date || '']);
    const buf = buildXlsx(out, 'GL Export');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="draw-gl-${req.params.id}.xlsx"`);
    res.send(buf);
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ===================================================================================
//  SUPPORTING DOCUMENTS ON A DRAW — invoices, receipts, extra photos
//  (owner-directed 2026-08-09). They live on the draw, they travel to the investor,
//  and they are what turns a typed override note into actual proof.
//  (`drawAttachments` is required at the top of the file — the override routes above
//  read it too.)
// ===================================================================================

// A draw the caller is allowed to touch, in ONE place: the file must be visible AND the draw must
// belong to that file. Reading the draw id straight from the URL without this is the IDOR that
// would let one file's attachment be filed onto another's draw.
async function ownedDraw(req, appId, drawId) {
  if (!/^\d+$/.test(String(drawId))) return null;
  if (!(await canSeeFile(req, appId))) return 'forbidden';
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  return own.rowCount ? { sitewireDrawId: String(drawId) } : null;
}

router.get('/files/:id/draws/:drawId/attachments', requireDrawView, async (req, res) => {
  const ref = await ownedDraw(req, req.params.id, req.params.drawId);
  if (ref === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (!ref) return res.status(404).json({ error: 'draw not found on this file' });
  res.json({
    attachments: await drawAttachments.listFor(req.params.id, ref),
    categories: drawAttachments.CATEGORIES.map((c) => ({ value: c, label: drawAttachments.CATEGORY_LABEL[c] })),
    max_bytes: drawAttachments.MAX_BYTES, max_per_upload: drawAttachments.MAX_PER_CALL,
  });
});

router.post('/files/:id/draws/:drawId/attachments', requirePermission('manage_draws'), async (req, res) => {
  const ref = await ownedDraw(req, req.params.id, req.params.drawId);
  if (ref === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (!ref) return res.status(404).json({ error: 'draw not found on this file' });
  const b = req.body || {};
  const items = Array.isArray(b.files) ? b.files : (b.dataBase64 ? [b] : []);
  if (!items.length) return res.status(400).json({ error: 'Attach at least one file.' });
  const out = await drawAttachments.attach(req.params.id, ref, items, {
    by: { kind: 'staff', id: req.actor.id }, supports: b.supports || null,
  });
  // Not a 4xx when SOME files landed: the caller needs the per-file reasons either way, and the
  // ones that did land really are on the draw. A call where NOTHING landed is a real failure.
  if (!out.added.length) return res.status(400).json({ error: out.skipped[0] ? `${out.skipped[0].what}: ${out.skipped[0].reason}` : 'Nothing could be attached.', ...out });
  res.json({ ok: true, ...out, attachments: await drawAttachments.listFor(req.params.id, ref) });
});

router.delete('/files/:id/draws/:drawId/attachments/:attId', requirePermission('manage_draws'), async (req, res) => {
  const ref = await ownedDraw(req, req.params.id, req.params.drawId);
  if (ref === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (!ref) return res.status(404).json({ error: 'draw not found on this file' });
  if (!/^\d+$/.test(String(req.params.attId))) return res.status(404).json({ error: 'not found' });
  // A PULLED document's identity is remembered as removed BEFORE the row (and its source_key)
  // is gone, or the next Sitewire poll re-pulls it — the resurrection loop the pre-merge audit
  // reproduced on every removed phone photo.
  let srcKey = null;
  try { srcKey = ((await db.query(`SELECT source_key FROM draw_attachments WHERE id=$1 AND application_id=$2`, [req.params.attId, req.params.id])).rows[0] || {}).source_key || null; } catch (_) {}
  const r = await drawAttachments.detach(req.params.id, req.params.attId);
  if (!r.removed) return res.status(404).json({ error: 'not found' });
  if (srcKey) { try { await require('../sitewire/property-doc-ingest').rememberRemoved(req.params.id, srcKey); } catch (_) {} }
  // The BYTES are not deleted — the document stays on the file (and in SharePoint, which never
  // deletes). Only the binding to this draw is removed, so it stops travelling to the investor.
  res.json({ ok: true, attachments: await drawAttachments.listFor(req.params.id, ref) });
});

// Review a supporting document IN PLACE on the draw card (owner-directed 2026-08-10). A pulled
// Sitewire document and a borrower upload are born 'pending', and only an ACCEPTED document
// travels to the investor (db/424) — so the person looking at the draw must be able to accept or
// reject it right there, not hunt for it elsewhere. Writes the ordinary documents review fields
// (db/013), so every other surface that reads review_status agrees.
// DELIBERATE SCOPE: gated on manage_draws — the draw COORDINATOR is exactly who reviews draw
// proof, and the main /documents review door's sign_off_conditions gate would lock them out of
// their own desk. Audited like the main door (accept_document / reject_document), and only a
// CURRENT document can be decided (a superseded copy is not on any screen).
router.post('/files/:id/draws/:drawId/attachments/:attId/review', requirePermission('manage_draws'), async (req, res) => {
  const ref = await ownedDraw(req, req.params.id, req.params.drawId);
  if (ref === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (!ref) return res.status(404).json({ error: 'draw not found on this file' });
  if (!/^\d+$/.test(String(req.params.attId))) return res.status(404).json({ error: 'not found' });
  const action = String((req.body && req.body.action) || '');
  if (action !== 'accept' && action !== 'reject') return res.status(400).json({ error: 'action must be accept or reject' });
  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
  try {
    const r = await db.query(
      `UPDATE documents d
          SET review_status=$4, reviewed_by=$5, reviewed_at=now(),
              rejection_reason=CASE WHEN $4='rejected' THEN $6 ELSE NULL END
         FROM draw_attachments da
        WHERE da.id=$1 AND da.application_id=$2 AND da.sitewire_draw_id=$3 AND d.id=da.document_id AND d.is_current
        RETURNING d.id`,
      [req.params.attId, req.params.id, req.params.drawId, action === 'accept' ? 'accepted' : 'rejected', req.actor.id, reason]);
    if (!r.rowCount) return res.status(404).json({ error: 'not found' });
    // Same audit vocabulary as the main /documents review door, so "who accepted this?" has one
    // answer wherever the click happened. Best-effort — a logging write never fails the action.
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
         VALUES ('staff',$1,$2,'document',$3,$4,$5,$6)`,
        [req.actor.id, action === 'accept' ? 'accept_document' : 'reject_document', r.rows[0].id,
          req.ip, req.get('user-agent') || null, JSON.stringify({ via: 'draw_attachment_review', drawId: req.params.drawId, applicationId: req.params.id, reason: reason || undefined })]);
    } catch (_) {}
    res.json({ ok: true, attachments: await drawAttachments.listFor(req.params.id, ref) });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// Stream one attachment back. Scoped through the same draw ownership check, so an attachment id
// from another file can never be fetched by guessing.
router.get('/files/:id/draws/:drawId/attachments/:attId/file', requireDrawView, async (req, res) => {
  const ref = await ownedDraw(req, req.params.id, req.params.drawId);
  if (ref === 'forbidden') return res.status(403).json({ error: 'forbidden' });
  if (!ref) return res.status(404).json({ error: 'draw not found on this file' });
  const row = (await db.query(
    `SELECT d.* FROM draw_attachments da JOIN documents d ON d.id=da.document_id
      WHERE da.id=$1 AND da.application_id=$2 AND da.sitewire_draw_id=$3`,
    [req.params.attId, req.params.id, req.params.drawId])).rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  return serveDocument(res, row, { inline: true });
});

// ===================================================================================
//  FEES OWED BY INVESTORS — a REPORT, never a gate (owner-directed 2026-08-09:
//  "the money ledger should just save our fee and this date related to this property,
//  how much money we're supposed to make from the investor directly").
//
//  On an investor-released draw the investor wires the borrower the net and wires US
//  our draw fee separately, so the fee is money we are OWED. Nothing anywhere waits on
//  it — this is what accounting chases, and what the fee-owed reminder counts.
// ===================================================================================
router.get('/fees-owed', requirePermission('manage_draws'), async (req, res) => {
  try {
    // Scoped exactly like the portfolio: an officer sees the files they may see. The scope is
    // resolved HERE (where visibility is decided) and handed to the query as a fragment.
    const sc = fileScope(req, 'a', 1);
    const olderThan = Number(req.query && req.query.olderThanDays);
    const out = await autoRelease.feesOwed({
      scopeWhere: sc.where, scopeParams: sc.params,
      olderThanDays: Number.isFinite(olderThan) && olderThan > 0 ? olderThan : null,
    });
    // The threshold the chase reminder uses, resolved from the SAME setting it reads, so the screen
    // and the email can never disagree about which fee is overdue. It is a configurable knob, not the
    // fallback 14 — hard-coding it on the screen would drift the moment somebody changed it.
    out.chase_days = await drawSettings.daysSettingFor('fee_owed_chase_days');
    res.json(out);
  } catch (e) { console.warn('[sitewire] fees owed:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// Mark one investor fee received. Only ever moves 'owed' → 'received', so a second click changes
// nothing rather than re-dating a fee that was already settled.
router.post('/fees-owed/:id/received', requirePermission('manage_draws'), async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'not found' });
  const row = (await db.query(`SELECT application_id FROM draw_disbursements WHERE id=$1`, [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeFile(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
  const day = req.body && req.body.received_date ? sanitizeDateOnly(req.body.received_date) : null;
  if (req.body && req.body.received_date && !day) return res.status(400).json({ error: 'The date received must be a valid calendar date (YYYY-MM-DD).' });
  const r = await autoRelease.markFeeReceived(id, { receivedDate: day, staffId: req.actor.id });
  if (!r.changed) return res.status(409).json({ error: 'That fee is not outstanding — it was already marked received, or this draw never carried a fee owed by the investor.' });
  res.json({ ok: true, disbursement: r.row });
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
  // Routing (phase 1, 2026-07-24): the rule now names WHICH PLATFORM administers the
  // partner's draws — 'sitewire' (default), 'trustpoint' (Blue Lake physical: full
  // Sitewire setup as intake+mirror, approvals in TrustPoint), or 'external' (the legacy
  // handled_externally semantics). Back-compat: an absent draw_platform falls back to the
  // old handled_externally checkbox; handled_externally is derived and kept in lock-step.
  const rawPlatform = b.draw_platform != null ? String(b.draw_platform).trim() : null;
  if (rawPlatform && !['sitewire', 'trustpoint', 'external'].includes(rawPlatform)) {
    return res.status(400).json({ error: 'draw_platform must be sitewire, trustpoint, or external' });
  }
  const drawPlatform = rawPlatform || (b.handled_externally ? 'external' : 'sitewire');
  const handledExternally = drawPlatform === 'external';
  // A NON-Sitewire platform must NAME a partner. A global-default rule (no partner_label)
  // marked external/trustpoint would make resolveRule's last-resort fallback apply it to
  // EVERY unmatched file — silently rerouting/stopping all Sitewire pushes portfolio-wide
  // with no park/alert. Never allow that (owner's never-guess / never-silently-drop rule).
  if (drawPlatform !== 'sitewire' && !partnerLabel) {
    return res.status(400).json({ error: 'Pick a specific capital partner before routing a rule to TrustPoint or marking it “handled externally” — the global default must stay on Sitewire.' });
  }
  // Audit finding B-9 (2026-07-21): a rule for a partner_label that DOESN'T map to a Sitewire
  // capital_partner_id (either directory-exact or an owner-confirmed link) AND isn't external
  // used to save cp_id=NULL. Every push for that label then paused at bind-time with
  // `sitewire_capital_partner_unmatched` — a silent trap. Reject at POST time so the coordinator
  // fixes it here. This applies to 'trustpoint' rules too — those files STILL push to Sitewire,
  // so the partner must resolve. Only 'external' rules (no push at all) skip the requirement.
  if (partnerLabel && !cpId && !handledExternally) {
    return res.status(400).json({ error: `We couldn't find "${partnerLabel}" in the Sitewire capital-partner directory. Either link it to a Sitewire partner on the Partners page, or set the "Draws administered on" choice to External if this partner isn't in Sitewire.` });
  }
  // Dormant markup knob (owner D9 2026-07-24): stored only; no code charges it yet. Integer
  // cents 0..$100k; blank/garbage → null (no markup), matching the physical-fee handling.
  const mkRaw = b.markup_cents;
  const mkNum = Number(mkRaw);
  const markupCents = mkRaw == null || mkRaw === '' || !Number.isFinite(mkNum) || mkNum < 0 || mkNum > 10000000 ? null : Math.round(mkNum);
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
  // WHO RELEASES THE MONEY for this capital provider (owner-directed 2026-08-09: "we should also
  // have settings where we should be able to set that by capital provider"). NULL = no answer at
  // this level, which falls through to the company default — a rule that was never given an answer
  // must not silently start deciding where money goes. A typo is REFUSED here rather than left to
  // the column's CHECK, which would surface as an unexplained 500. Like every other field on this
  // route it is written from EXCLUDED, so a save can also CLEAR it (handing the decision back to
  // the company default) — which means any screen that saves a rule must send this field.
  const rawFund = b.investor_funding_mode;
  const investorFundingMode = (rawFund == null || String(rawFund).trim() === '') ? null : String(rawFund).trim();
  if (investorFundingMode && !investorDelivery.MODES.includes(investorFundingMode)) {
    return res.status(400).json({ error: 'Pick who releases the money for this capital provider, or leave it on the company default.' });
  }
  try {
    const row = (await db.query(
      `INSERT INTO sitewire_inspection_rules (capital_partner_id, partner_label, program, inspection_method, require_sitewire_inspector, require_capital_partner_approval, allow_reallocation, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, handled_externally, draw_platform, markup_cents, investor_funding_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO UPDATE SET capital_partner_id=EXCLUDED.capital_partner_id, partner_label=COALESCE(EXCLUDED.partner_label, sitewire_inspection_rules.partner_label), inspection_method=EXCLUDED.inspection_method, require_sitewire_inspector=EXCLUDED.require_sitewire_inspector, require_capital_partner_approval=EXCLUDED.require_capital_partner_approval, allow_reallocation=EXCLUDED.allow_reallocation, fee_cents_virtual=EXCLUDED.fee_cents_virtual, fee_cents_physical=EXCLUDED.fee_cents_physical, allow_virtual=EXCLUDED.allow_virtual, allow_physical=EXCLUDED.allow_physical, handled_externally=EXCLUDED.handled_externally, draw_platform=EXCLUDED.draw_platform, markup_cents=EXCLUDED.markup_cents, investor_funding_mode=EXCLUDED.investor_funding_mode, updated_at=now()
       RETURNING *`,
      [cpId, partnerLabel, b.program || null, method, b.require_sitewire_inspector !== false, !!b.require_capital_partner_approval, !!b.allow_reallocation, feeVirtual, feePhysical, allowVirtual, allowPhysical, handledExternally, drawPlatform, markupCents, investorFundingMode])).rows[0];
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
  if (!switches.on('SITEWIRE_ENABLED')) return res.status(503).json({ error: 'Sitewire is turned off' });
  try {
    const cp = await reconcile.syncCapitalPartners();
    const staff = await reconcile.syncStaffUsers();
    res.json({ ok: true, capital_partners: cp.count, staff_matched: staff.matched });
  } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- settings (wire turnaround hours, variance) ----
router.get('/settings', requirePermission(['manage_draws', 'platform_setup']), async (req, res) => {
  const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
  // `settings` is the raw key→value map every existing caller already reads — unchanged. `catalog`
  // is what the admin Draw Settings screen renders from: every knob, in plain words, with WHERE it
  // can be answered, so no screen has to keep its own list (owner-directed 2026-08-09).
  res.json({
    settings: Object.fromEntries(rows.map((r) => [r.key, r.value])),
    catalog: drawSettings.CATALOG,
    company: drawSettings.resolveAll({ company: drawSettings.companyMapFrom(rows) })
      .filter((e) => e.settable.company),
    levels: drawSettings.LEVELS, level_labels: drawSettings.LEVEL_LABEL,
  });
});

// ---- GET /files/:id/draw-settings — every knob for ONE file, and WHICH LEVEL decided it ----
// The owner's "where did this come from?": a coordinator looking at a $250 fee should never have
// to guess whether it came from the project, the capital provider or the company default.
router.get('/files/:id/draw-settings', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const out = await drawSettings.resolvedFor(appId);
  res.json(out);
});
router.patch('/settings', requirePermission('platform_setup'), async (req, res) => {
  // The allowlist is DERIVED from the settings catalog rather than retyped, so a knob added there
  // is settable here in the same commit and the two can never drift (the old hard-coded list is
  // exactly why several knobs were unreachable without a database edit).
  const allowed = new Set(drawSettings.CATALOG.filter((e) => e.company).map((e) => e.company));
  const byCompanyKey = new Map(drawSettings.CATALOG.filter((e) => e.company).map((e) => [e.company, e]));
  const PCT = new Set([...allowed].filter((k) => (byCompanyKey.get(k) || {}).type === 'pct'));
  const DAYS = new Set([...allowed].filter((k) => (byCompanyKey.get(k) || {}).type === 'days'));
  const MONEY = new Set([...allowed].filter((k) => (byCompanyKey.get(k) || {}).type === 'money_cents'));
  const CHOICE = new Set([...allowed].filter((k) => (byCompanyKey.get(k) || {}).type === 'choice'));
  const BOOL = new Set([...allowed].filter((k) => (byCompanyKey.get(k) || {}).type === 'bool'));
  // Validate + coerce each value BEFORE storing — never persist garbage a reader must defensively clamp
  // (a stored "banana" / 500% / negative is a latent surprise). `undefined` = invalid → 400.
  const coerce = (k, v) => {
    if (BOOL.has(k)) {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 0 || v === '0') return false;
      return undefined;
    }
    if (CHOICE.has(k)) {
      const e = byCompanyKey.get(k);
      return (e.choices || []).includes(String(v)) ? String(v) : undefined;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (PCT.has(k)) return n <= 100 ? n : undefined;              // percentages: 0..100
    if (k === 'wire_turnaround_hours') return n <= 8760 ? Math.round(n) : undefined; // ≤ 1 year of hours
    if (DAYS.has(k)) return n <= 3650 ? Math.round(n) : undefined; // ≤ 10 years of days
    // A money amount is integer cents, capped well under what a draw fee could ever be — a typo
    // that stores $10,000,000 as a per-draw fee is worse than a refusal.
    if (MONEY.has(k)) return n <= 100000000 ? Math.round(n) : undefined;
    return Math.round(n);
  };
  const updates = [];
  for (const k of Object.keys(req.body || {})) {
    if (!allowed.has(k)) continue;
    const val = coerce(k, req.body[k]);
    if (val === undefined) {
      const e = byCompanyKey.get(k) || {};
      return res.status(400).json({ error: `Invalid value for “${e.label || k}”. `
        + (CHOICE.has(k) ? `Pick one of: ${(e.choices || []).join(', ')}.`
          : BOOL.has(k) ? 'It is on or off.'
            : PCT.has(k) ? 'A percentage must be 0–100.'
              : 'It must be a non-negative whole number.') });
    }
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
    // Audit finding C-1 (2026-07-21): a DOC-PUSH failure (sitewire_doc_push_failed / sitewire_doc_unverified
    // / sitewire_doc_web_session) is fixed by re-running docPush.pushDocuments — NOT the regular push_file
    // (which is property + budget + SOW only and never touches the 3 property documents). The old retry path
    // re-queued push_file, the worker ran it, the review closed as "retried", and the document still wasn't
    // in Sitewire — a silent no-op loop. Route doc-* reasons through docPush directly with force:true so the
    // sha256 dedup doesn't short-circuit the retry. The 'which' slot comes from the park's `dedupe` (which
    // pushDocuments set to g.which); a missing/unknown slot falls back to all three.
    const DOC_REASONS = new Set(['sitewire_doc_push_failed', 'sitewire_doc_unverified', 'sitewire_doc_web_session']);
    if (DOC_REASONS.has(reasonClass)) {
      const docPush = require('../sitewire/doc-push');
      const parked = (await db.query(`SELECT task_id FROM sync_review_queue WHERE id=$1`, [id])).rows[0];
      const parts = parked && parked.task_id ? String(parked.task_id).split(':') : [];
      const which = docPush.SLOTS.includes(parts[parts.length - 1]) ? parts[parts.length - 1] : null;
      let result;
      try { result = await docPush.pushDocuments(row.application_id, { which, force: true, staffId: req.actor && req.actor.id, source: 'review_retry' }); }
      catch (e) { return res.status(502).json({ error: `Could not retry the document push — ${(e && e.message) || 'unknown error'}. Please try again.` }); }
      // Success or partial-success closes the review; a hard error (docs_disabled / not_managed / …) leaves it open.
      if (result && result.ok === false && !Array.isArray(result.results)) {
        return res.status(409).json({ error: `Document push can\'t retry now (${result.error || 'unknown'}). Turn on the connection or contact an admin.` });
      }
      await db.query(`UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3 WHERE id=$1`,
        [id, req.actor.id, `retried document push (${which || 'all slots'})`]);
      return res.json({ ok: true, retried_docs: true, result });
    }
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
    res.json({ enabled: switches.on('SITEWIRE_ENABLED'), outbound: switches.on('SITEWIRE_OUTBOUND_ENABLED'), dryrun: cfg.sitewireDryrun, linked_files: linked, mirrored_draws: draws, open_reviews: openReviews });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ===================================================================================
//  UNIFIED ROLLUP + PORTFOLIO (draws ↔ Scope of Work ↔ construction budget — one view)
// ===================================================================================

// ---- GET /files/:id/rollup — the unified per-line/per-unit picture for a file ----
router.get('/files/:id/rollup', requireDrawView, async (req, res) => {
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
    // Owner-directed 2026-07-22 (file 1053 Ella T Grasso Blvd): the request's own job_item_name
    // can arrive null from Sitewire (drafting-state draws often omit it); fall back FIRST to the
    // crosswalk name (which reconcile hydrates from getBudget().job_items on adopt), so the desk
    // shows "Interior Video Tour" instead of "Line 1180837". LEFT JOIN so an un-adopted item
    // still returns null and the UI's final fallback ("Line <id>") kicks in.
    //
    // Also expose `is_media_item` from the crosswalk so the UI can HIDE the "Set approved $ Save"
    // input on media items (Photo/Video Required rows carry no money — Sitewire displays them as
    // requirements, never as budget lines, and PILOT was mistakenly offering a money entry against
    // them). Owner-directed 2026-07-22.
    const requests = (await db.query(
      `SELECT r.sitewire_request_id, r.sitewire_draw_id, r.sitewire_job_item_id,
              COALESCE(NULLIF(r.job_item_name, ''), jil.name) AS job_item_name,
              COALESCE(jil.is_media_item, false) AS is_media_item,
              r.requested_cents, r.approved_cents, r.inspection_count, r.lender_comments
         FROM sitewire_draw_requests r
         JOIN sitewire_draws d ON d.sitewire_draw_id=r.sitewire_draw_id
         LEFT JOIN sitewire_job_item_links jil ON jil.application_id=d.application_id AND jil.sitewire_job_item_id=r.sitewire_job_item_id
        WHERE d.application_id=$1 ORDER BY r.sitewire_request_id`, [appId])).rows;
    const ledger = (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    // `reviewed_at`/`review_note` ride along so the desk can show whether a human has read the
    // inspector's report, and offer the stamp when nobody has. The checklist derives the same fact
    // server-side; this is what lets the BUTTON know which state it is in.
    const findings = (await db.query(`SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at, reviewed_at, review_note FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [appId])).rows;
    const changeRequests = (await db.query(
      `SELECT cr.id, cr.status, cr.reason, cr.created_at, cr.decided_at, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status, d.deltas
         FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id
        WHERE cr.application_id=$1 AND cr.field='sow_reallocation' ORDER BY cr.created_at DESC`, [appId])).rows;
    // merge risk flags onto the rollup draw summaries
    const riskByDraw = new Map(draws.map((d) => [Number(d.sitewire_draw_id), { level: d.risk_level, flags: d.risk_flags, pdf_src: d.pdf_src, quick_notify_status_id: d.quick_notify_status_id, coordinator_id: d.coordinator_id }]));
    for (const d of rollup.draws) { const r = riskByDraw.get(d.sitewire_draw_id); if (r) { d.risk_level = r.level; d.risk_flags = r.flags; d.pdf_src = r.pdf_src; d.quick_notify_status_id = r.quick_notify_status_id; d.coordinator_id = r.coordinator_id; } }
    // The per-draw STAGE TIMELINE (owner-directed: "a timestamp on every step … a unified status like
    // a loan file's stages"). Staff voice — includes the capital-partner step. The resolved shape is
    // attached here so the desk renders it without re-deriving; `stage_times` come off the rollup.
    for (const d of rollup.draws) d.timeline = drawTimeline.stageTimeline(d.stage_times, d.approval_stage, { borrower: false });
    // WHAT'S LEFT ON THIS DRAW — the same facts the refusals are built from, stated FORWARD, so a
    // coordinator sees what is missing without having to press a button and be refused. It is a
    // DESCRIPTION and never a gate: the real refusals stay exactly where they are. Also the plain
    // status, which now says "unknown" instead of quietly reading as progress.
    //
    // Best-effort per draw, and skewed to the draws somebody is actually working. Each checklist is
    // ~10 small reads, so computing one for every draw on a long-running project would put a hundred
    // queries behind one desk load for cards nobody is looking at. A draw that is finally approved
    // AND has its money recorded is finished — its checklist would be all-green — so it is skipped,
    // and the cap catches the rest.
    const CHECKLIST_MAX = 8;
    const needsChecklist = rollup.draws.filter((d) => !(d.is_final_approved && d.released)).slice(0, CHECKLIST_MAX);
    for (const d of needsChecklist) {
      try {
        const c = await drawChecklist.checklistFor(db, appId, d.sitewire_draw_id, { stage: d.approval_stage });
        if (c) {
          d.checklist = { steps: c.steps, done: c.done, total: c.total, next_up: c.nextUp, waiting_on: c.waitingOn, complete: c.complete };
          d.status_words = c.status;
          d.dates = c.dates;                 // expected inspection / decision / release
        }
      } catch (_) { /* the desk still renders without it */ }
    }
    // The stage HISTORY (when each draw actually reached each step) + how long it has sat where it
    // is. Absent history reads as null, never as "0 days" — a draw whose stages predate the history
    // is unknown, not brand new.
    // Its own bound, deliberately WIDER than the checklist's: history is ONE indexed read, and a
    // FINISHED draw is exactly where "how long did this actually take?" gets answered — so unlike
    // the checklist it is not skipped once a draw is done.
    const HISTORY_MAX = 24;
    for (const d of rollup.draws.slice(0, HISTORY_MAX)) {
      try {
        const h = await stageEvents.historyFor(appId, { sitewireDrawId: d.sitewire_draw_id });
        d.stage_history = h;
        d.days_in_stage = stageEvents.daysInCurrentStage(h);
      } catch (_) { /* history is additive */ }
    }
    // retainage held vs released + the lien-waiver register (roadmap money model)
    const held = Number((await db.query(`SELECT COALESCE(sum(retainage_held_cents),0) h FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].h) || 0;
    const rlsd = Number((await db.query(`SELECT COALESCE(sum(net_release_cents),0) r FROM draw_disbursements WHERE application_id=$1 AND kind='retainage_release'`, [appId])).rows[0].r) || 0;
    const waivers = (await db.query(`SELECT id, sitewire_draw_id, kind, scope, tier, party_name, amount_cents, status, received_at FROM draw_lien_waivers WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    const retainage = { pct: await retainagePctFor(appId), held_cents: held, released_cents: rlsd, holding_cents: Math.max(0, held - rlsd) };
    // Out-of-pocket-first KPI (owner-directed 2026-07-31): the OOP-rehab floor snapshotted on this
    // file's draw setup, and how much of it the recorded draws have already absorbed (the borrower's
    // own money that was never reimbursed). Only present when there is an exception (floor > 0), so a
    // file with no OOP exception is byte-identical. absorbed = min(cumulative approved, floor).
    const oopFloor = link ? Number(link.oop_floor_cents || 0) : 0;
    let oop = null;
    if (oopFloor > 0) {
      const drawApprovedTotal = Number((await db.query(`SELECT COALESCE(sum(approved_cents),0) s FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [appId])).rows[0].s) || 0;
      const absorbed = Math.min(drawApprovedTotal, oopFloor);
      oop = { floor_cents: oopFloor, absorbed_cents: absorbed, remaining_cents: Math.max(0, oopFloor - absorbed) };
    }
    // lien waivers are OFF by default and only surface once turned on (globally OR for this
    // project) — the panel shows only when enabled or already in use.
    const lienWaiversEnabled = await lienGateEnabled(appId);
    // WHO RELEASES THE MONEY — the answer, WHICH level gave it (this project / this capital
    // provider / the company default), whether the loan has been sold yet, and the "it isn't sold
    // yet — release it yourself?" question when the two disagree. It rides the rollup so the desk
    // card needs no second call. Best-effort: the card simply does not render if it cannot be read.
    let release = null;
    try { release = await releaseParty.releaseStateFor(db, appId); } catch (_) {}
    // WHAT THE INVESTOR SAID — the latest send per draw and the answer that came back, so the desk
    // shows "with the investor since Tuesday" or "they asked for one more photo" instead of just
    // "delivered". DISTINCT ON keeps the newest send per draw; a re-send is a separate row and the
    // one being waited on is always the newest.
    let investorDeliveries = [];
    try {
      investorDeliveries = (await db.query(
        `SELECT DISTINCT ON (sitewire_draw_id)
                id, sitewire_draw_id, funding_mode, note_buyer_label, sent_at, status,
                answer, answered_at, answer_note, expected_funding_date,
                investor_total_cents, to_borrower_cents, to_us_cents,
                GREATEST(0, EXTRACT(EPOCH FROM (now() - sent_at))/86400)::int AS days_waiting
           FROM draw_investor_deliveries
          WHERE application_id=$1
          ORDER BY sitewire_draw_id, sent_at DESC`, [appId])).rows;
    } catch (_) { /* an older database has no answer columns — the desk simply shows less */ }
    res.json({ rollup, link, draws, requests, ledger, findings, change_requests: changeRequests, retainage, oop, waivers, release,
      investor_deliveries: investorDeliveries,
      investor_answers: investorDelivery.ANSWERS.map((a) => ({ answer: a, label: investorDelivery.ANSWER_LABEL[a], next: investorDelivery.ANSWER_NEXT[a] })),
      lien_waivers_enabled: lienWaiversEnabled, lien_waivers_file_override: link ? link.require_lien_waivers : null,
      // go-forward-only status for the draw-section banner: preexisting = blocked on a pre-existing
      // Sitewire property PILOT didn't create; setup_status = the last birth-phase outcome (inline, not a
      // global error row); managed_since = when PILOT pushed (born) this property.
      preexisting, setup_status: setupStatus, managed_since: link ? link.pushed_at : null, go_live_date: cfg.sitewireGoLiveDate,
      // so the desk can show a proactive read-only banner + disable write buttons when writes are off
      // (an approve/release/finding write 503s unless BOTH the master switch and the write gate are on).
      switches: { enabled: switches.on('SITEWIRE_ENABLED'), outbound: switches.on('SITEWIRE_OUTBOUND_ENABLED'), dryrun: cfg.sitewireDryrun } });
  } catch (e) { console.warn('[sitewire] route error:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- GET /portfolio — exposure / pacing dashboard across the actor's files ----
router.get('/portfolio', requirePermission('manage_draws'), async (req, res) => {
  try {
    const sc = fileScope(req, 'a', 1);
    // per-file budget (frozen) + drawn (approved on approved draws) + pending-approval counts
    const rows = (await db.query(
      `SELECT a.id AS application_id, a.ys_loan_number, ${addrExpr('a')} AS address, a.status,
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
  for (const f of (await db.query(`SELECT sitewire_draw_id, delivered_at, accepted_at, accepted_via, disputed_at, disputed_via, resolved_at FROM draw_findings WHERE application_id=$1`, [appId])).rows) {
    push(f.delivered_at, 'findings', `Findings delivered to borrower (draw #${f.sitewire_draw_id})`);
    // A 'tpo' accept/dispute is the BROKER acting for their borrower (Phase 6d) — label it as such
    // so this staff-only timeline never mis-reads a broker's money decision as the borrower's.
    push(f.accepted_at, 'findings', f.accepted_via === 'tpo' ? 'Broker ACCEPTED findings (broker portal)' : `Borrower ACCEPTED findings (${f.accepted_via || 'portal'})`);
    push(f.disputed_at, 'findings', f.disputed_via === 'tpo' ? 'Broker DISPUTED findings' : 'Borrower DISPUTED findings');
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

// The draw packet's numbers live in src/sitewire/draw-packet.js so they can be tested directly
// against a database (see scripts/test-draw-packet-db.js).
const { buildDrawPacket } = require('../sitewire/draw-packet');

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
router.get('/files/:id/activity', requireDrawView, async (req, res) => {
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
// Audit finding B-5 (2026-07-21): validated only UUID + is_active, so ANY active staff could be named
// coordinator (a receptionist, an accountant). Now also require the target staff to actually hold the
// manage_draws capability (the coordinator's job is to review/approve draws, so they need the perm).
// Uses lib/permissions.effectivePermissions so a role default OR a staff-specific override BOTH count —
// same source of truth `requirePermission('manage_draws')` uses.
router.post('/files/:id/coordinator', requirePermission('platform_setup'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const staffId = req.body.coordinator_staff_id || null;
  if (staffId && !isUuid(staffId)) return res.status(400).json({ error: 'unknown staff user' });
  if (staffId) {
    const s = (await db.query(`SELECT role, permissions FROM staff_users WHERE id=$1 AND is_active`, [staffId])).rows[0];
    if (!s) return res.status(400).json({ error: 'unknown staff user' });
    const { effectivePermissions } = require('../lib/permissions');
    if (!effectivePermissions(s.role, s.permissions).has('manage_draws')) {
      return res.status(400).json({ error: 'That staffer isn\'t allowed to manage draws — grant them the “Manage construction draws” permission first (Team settings), or pick a draw coordinator / processor / admin.' });
    }
  }
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
/** Await `p`, but never longer than `ms` — past the budget the work keeps running to
 *  completion in the background (every step is idempotent + independently caught) and we
 *  carry on. `.unref()` so the timer can't hold the event loop open on the fast path. */
function withBudget(p, ms) {
  return Promise.race([p, new Promise((r) => {
    const t = setTimeout(() => r({ archived: 0, reports: [], pending: true }), ms);
    if (t.unref) t.unref();
  })]);
}

/**
 * The PDFs that ride along with the borrower's findings email (owner-directed 2026-07-27:
 * "he should receive two PDF attachments in the findings email"):
 *   1. OUR branded borrower report — photos + totals, partner-scrubbed by construction;
 *   2. the ADMINISTRATOR's own inspection paperwork for the same draw.
 *
 * Both are checked against the frozen rule that a note-buyer name must never reach a
 * borrower. The administrator's PDFs were decoded and scanned during the build: they name
 * the lender as "YS Capital Group" and the inspector as "Trinity" — the note buyer does not
 * appear in them. Only the BORROWER-visibility copy of our own report is ever eligible, so a
 * staff-only report can never be attached by mistake.
 *
 * Best-effort: any failure returns fewer attachments, never an exception — the findings email
 * must go out even when a PDF is missing (it still links to the full results page).
 */
const FINDING_ATTACH_MAX_BYTES = 18 * 1024 * 1024;   // keep the whole email deliverable

/**
 * A borrower-facing attachment NAME. Never leaks the administrator's name (the filename is
 * rendered in the email body and shown in the recipient's mail client), and never invents a
 * fact — it says only which draw it is and what kind of document it is.
 */
function borrowerSafeAttachmentName(filename, drawNo) {
  const f = String(filename || '');
  const n = drawNo != null ? `-draw-${drawNo}` : '';
  if (f.startsWith('pilot-')) return `inspection-report${n}.pdf`;          // our own branded report
  if (/-inspection-result-document-/.test(f)) return `inspection-findings${n}.pdf`;
  if (/-draw-report-/.test(f)) return `draw-summary${n}.pdf`;
  return `draw-document${n}.pdf`;
}

async function borrowerFindingAttachments(appId, sitewireDrawId) {
  const storage = require('../lib/storage');
  const out = [];
  // Report filenames are keyed on the draw NUMBER (`pilot-draw-2-report-borrower-…`,
  // `trustpoint-draw-2-…`), which is NOT the internal sitewire_draw_id. Resolve it first —
  // preferring the administrator's number when the draws are tied, since both filename
  // families are built from the same number.
  const num = (await db.query(
    `SELECT number AS n FROM sitewire_draws WHERE sitewire_draw_id = $1::bigint AND application_id = $2`,
    [String(sitewireDrawId), appId])).rows[0];
  const drawNo = num && num.n != null ? String(num.n) : null;

  // The two filename families are keyed on DIFFERENT numbers and must be matched separately.
  // OUR report is named from the SITEWIRE draw number; the administrator's paperwork from the
  // TRUSTPOINT one, and the two systems number draws independently (they are tied by AMOUNT in
  // mirror.linkToSitewireIntake, never by number). Resolving one number for both meant that the
  // moment they disagreed our borrower-safe report silently dropped out and ONLY the
  // administrator's staff-sourced PDFs were sent — the exact inverse of what this is for.
  const tpNo = (await db.query(
    `SELECT number FROM trustpoint_draws WHERE sitewire_draw_id = $1::bigint AND application_id = $2`,
    [String(sitewireDrawId), appId])).rows[0];

  // ONLY these two administrator documents may reach a borrower. The allow-list is by DOCUMENT
  // TYPE, not by draw prefix: `/draw_requests/{id}/documents/` also returns a "Service Invoice"
  // (the inspection vendor's bill) and anything else TrustPoint chooses to file there, all named
  // with the same prefix and all stored `visibility='staff_only'`. Only the inspection report and
  // the draw report were decoded and keyword-scanned for a note-buyer name before #876 shipped;
  // sending an unreviewed vendor invoice puts the frozen never-name-a-note-buyer rule on an
  // assumption about a document set TrustPoint controls. Widening this list requires checking the
  // new type the same way.
  const TP_BORROWER_SAFE = ['inspection-result-document', 'draw-report'];

  const rows = (await db.query(
    `SELECT d.id, d.filename, d.storage_ref, d.size_bytes
       FROM documents d
      WHERE d.application_id = $1 AND d.is_current AND d.doc_kind = 'draw_inspection_report'
        AND (
          -- our own BORROWER-safe report for this draw (a staff copy can never match)
          (d.visibility = 'borrower' AND $2::text IS NOT NULL
             AND d.filename LIKE 'pilot-draw-' || $2 || '-report-borrower-%')
          -- the administrator's reviewed paperwork, by draw number AND document type
          OR ($3::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM unnest($4::text[]) t
                 -- ANCHORED on the date+id tail storeDocument always appends, so a document
                 -- type that merely STARTS WITH an allowed one ("Inspection Result Document
                 -- and Service Invoice") can never satisfy a prefix match and ride along.
                 WHERE d.filename LIKE 'trustpoint-draw-' || $3 || '-' || t || '-____-__-__-%'))
        )
      ORDER BY d.created_at DESC`,
    [appId, drawNo, tpNo && tpNo.number != null ? String(tpNo.number) : null, TP_BORROWER_SAFE])).rows;

  const seen = new Set();
  let budget = FINDING_ATTACH_MAX_BYTES;
  for (const r of rows) {
    // one per KIND — the newest wins, so a re-inspection's latest report is the one sent
    const kind = r.filename.startsWith('pilot-') ? 'pilot' : r.filename.replace(/-\d{4}-\d{2}-\d{2}-[^.]*\.pdf$/, '');
    if (seen.has(kind)) continue;
    if (Number(r.size_bytes) > budget) continue;
    try {
      const content = await storage.read(r.storage_ref);
      if (!content || !content.length || content.length > budget) continue;
      // S1 — THE FILENAME IS BORROWER-FACING. notify.js derives `files` from
      // attachments[].filename and template.js renders them as visible chips AND a plaintext
      // "Attachments:" line; the borrower scrub covers title/body/meta/… but never attachments.
      // So `trustpoint-draw-2-…pdf` printed the draw administrator's name to the borrower twice
      // in the body plus on the file in their mail client — the frozen never-name-the-note-buyer
      // rule (borrower-safe.js lists "trust point" explicitly). Renamed to a neutral, factual
      // name; the stored document keeps its own filename for staff.
      // BASE64, NEVER A RAW BUFFER (owner-reported 2026-08-10: the attached PDF was corrupted
      // and unopenable). Both mail providers do `String(a.content)` expecting base64 — a Buffer
      // stringifies as a lossy UTF-8 decode of PDF binary, which can never open. This was the
      // repo's ONE producer passing a Buffer; the providers now also normalize (belt), but the
      // convention is base64 strings at the producer (the shape every other call site uses).
      out.push({ filename: borrowerSafeAttachmentName(r.filename, drawNo), content: content.toString('base64'), contentType: 'application/pdf' });
      seen.add(kind);
      budget -= content.length;
    } catch (e) { /* a missing file never blocks the findings email */ }
  }
  // THE SITEWIRE INSPECTOR'S OWN PER-DRAW PDF IS NEVER A `documents` ROW — it lives only in the
  // durable draw_media archive (kind='draw_pdf'), which is where the investor delivery already
  // reads it. Without this arm, a virtual-inspection file could attach at most OUR report while
  // the owner's requirement is BOTH ("we always need our PDF, the Sitewire PDF, and/or the
  // Trinity PDF"). Distinctly named so it never collides with our branded report's name.
  try {
    const m = (await db.query(
      `SELECT storage_ref FROM draw_media
        WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw_pdf' AND storage_ref IS NOT NULL
        ORDER BY archived_at DESC LIMIT 1`, [appId, sitewireDrawId])).rows[0];
    if (m) {
      const buf = await storage.read(m.storage_ref);
      if (buf && buf.length && buf.length <= budget) {
        out.push({ filename: `inspector-report${drawNo != null ? `-draw-${drawNo}` : ''}.pdf`,
          content: buf.toString('base64'), contentType: 'application/pdf' });
        budget -= buf.length;
      }
    }
  } catch (_) { /* best-effort — the findings email still goes with whatever attached */ }
  return out;
}

router.post('/files/:id/findings/:drawId/deliver', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!switches.on('SITEWIRE_ENABLED')) return res.status(503).json({ error: 'Sitewire is turned off' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  // Never re-deliver over a finding the borrower has already acted on — persisting would wipe
  // their acceptance / dispute evidence and leave a stale wire deadline (audit F2). Re-pulling
  // a still-'delivered' finding to refresh photos is fine.
  // Owner-directed 2026-07-21 (audit finding B-2): force-redeliver is a destructive escalation —
  // (a) restrict to super_admin (any manage_draws user could otherwise clobber the borrower's
  // decision), (b) REFUSE outright when a draw_disbursements release row already exists for this
  // draw (real money went out — a fresh delivery with a new wire deadline would double-count),
  // and (c) journal the override so an audit can reconstruct why the finding was reset.
  const existing = (await db.query(`SELECT status FROM draw_findings WHERE sitewire_draw_id=$1`, [drawId])).rows[0];
  if (existing && ['accepted', 'disputed', 'resolved'].includes(existing.status)) {
    if (!req.body.force) {
      return res.status(409).json({ error: `these findings were already ${existing.status} by the borrower — re-delivering would erase that. Pass force:true (super_admin only, with a note) to reset it.` });
    }
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ error: 'Only a super admin can force-redeliver findings the borrower already acted on.' });
    }
    const released = await db.query(`SELECT 1 FROM draw_disbursements WHERE application_id=$1 AND sitewire_draw_id=$2 AND kind='draw' LIMIT 1`, [appId, drawId]);
    if (released.rowCount) {
      return res.status(409).json({ error: 'A release is already recorded for this draw — force-redelivering would reset the wire deadline against money that already went out. Correct the release ledger first.' });
    }
    const forceNote = req.body.force_note ? String(req.body.force_note).trim() : '';
    if (!forceNote || forceNote.length < 8) {
      return res.status(400).json({ error: 'A force note (at least 8 characters) is required to redeliver a finding the borrower already acted on.' });
    }
    try { await orchestrator.journal({ appId, entity: 'draw', entityId: Number(drawId), field: 'force_redeliver', oldValue: { status: existing.status }, newValue: { note: forceNote.slice(0, 500), actor: req.actor && req.actor.id }, source: 'money_override' }); } catch (_) {}
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
    // ---- BUILD THE ARTIFACTS BEFORE THE BORROWER EMAIL (owner-directed 2026-07-27) ----
    // The borrower must receive TWO PDFs with the findings: the administrator's own
    // inspection report and OUR branded report (photos + totals). Both used to be produced
    // AFTER this email was sent, so there was nothing to attach. The archive+build now runs
    // first, under the same bounded budget that already protected this route — if it does not
    // finish in time the email still goes out on schedule, just with links instead of files.
    // Nothing here can fail the delivery: every step is independently caught.
    const artifacts = await withBudget(
      drawReport.autoDeliverArtifacts(appId, drawId).catch(() => ({ archived: 0, reports: [] })),
      Number(process.env.DRAW_AUTODELIVER_BUDGET_MS) || 20000);
    const findingAttachments = await borrowerFindingAttachments(appId, drawId).catch(() => []);
    // The one-email-thread result — read after the send so the response (and the desk marker
    // below) can say whether the BORROWER actually received their copy, instead of reporting
    // "delivered" when only the team was reached (owner-reported 2026-08-10).
    let sentThread = null;
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
      // retired_at IS NULL — a soft-retired line (db/242, Sitewire removed the request) must not
      // join the borrower's email grid or its sums; the public + borrower routes already filter.
      const flines = (await db.query(
        `SELECT name, requested_cents, approved_cents, not_approved_cents, photo_count, video_count FROM draw_finding_lines WHERE finding_id=$1 AND retired_at IS NULL ORDER BY id`, [result.id])).rows;
      const totReq = flines.reduce((s, l) => s + (Number(l.requested_cents) || 0), 0);
      const totAppr = flines.reduce((s, l) => s + (Number(l.approved_cents) || 0), 0);
      const photos = flines.reduce((s, l) => s + (Number(l.photo_count) || 0), 0);
      const videos = flines.reduce((s, l) => s + (Number(l.video_count) || 0), 0);
      const CAP = 14; // keep the email readable — a huge draw links out to the full page for the rest
      // WHAT ACTUALLY LANDS IN THEIR ACCOUNT (owner-directed 2026-08-03). This email is the first
      // thing the borrower reads and it used to lead with the GROSS approval labelled "Approved for
      // release" — while the report attached to the same email says $24,701 after the draw fee. Both
      // numbers now come from the SAME rollup the report is built from, so the email and its own
      // attachment can never quote different figures. Best-effort: an unreadable rollup simply
      // omits the release line rather than delaying the borrower's results.
      // A RELEASE FIGURE EXISTS ONLY WHEN THE INSPECTOR HAS ANSWERED (owner-reported 2026-08-10,
      // YSCAP258134746: the inspector approved NOTHING and this callout still promised "$0 is
      // wired to you" under a "Requested $24,750" headline). `net_release_cents` is ALWAYS a
      // number (drawMoney computes max(0, approved − fee) even off an unknown approval), so
      // gating on `!= null` promised a wire on every draw. The gate is the SAME predicate the
      // figures band uses — has_inspector_amounts — so the hero and the callout can never again
      // tell two different stories about one draw. An explicit $0 gets its own honest wording.
      let releaseLine = null;
      let inspectorZero = false;
      try {
        const rl = await rollupMod.loadRollup(db, appId);
        const d = (rl.draws || []).find((x) => Number(x.sitewire_draw_id) === Number(drawId));
        if (d && d.has_inspector_amounts && Number(d.approved_cents) <= 0) inspectorZero = true;
        if (d && d.has_inspector_amounts && d.net_release_cents != null && Number(d.net_release_cents) > 0) {
          const deductions = [];
          if (Number(d.fee_cents) > 0) deductions.push(`${usd(d.fee_cents)} draw fee`);
          if (Number(d.retainage_held_cents) > 0) deductions.push(`${usd(d.retainage_held_cents)} retainage held`);
          releaseLine = { label: d.released ? 'Released to you' : 'To be released to you',
            value: `${usd(d.net_release_cents)}${deductions.length ? ` (after the ${deductions.join(' and ')})` : ''}` };
        }
      } catch (_) { /* best-effort — the results email never waits on the money rollup */ }
      // THE RANKED MONEY BLOCK — the release big, the approval / request / held-back beneath it
      // (owner-directed 2026-08-03). Built from the same rollup the release line above and the
      // attached PDF are built from, so all three agree by construction. The per-line breakdown
      // stays in `meta` underneath: it is the DETAIL, and it reads as detail once the headline
      // figures are no longer competing with it at the same size.
      const blocks = await drawEmailBlocks(db, appId, { sitewireDrawId: drawId, borrower: true });
      const meta = [{ label: 'Property', value: addr }];
      // The release is now stated by the figure band; repeating it as a meta row said the same
      // number twice in two shapes.
      if (releaseLine && !(blocks && blocks.figures)) meta.push(releaseLine);
      for (const l of flines.slice(0, CAP)) {
        // TRI-STATE (db/518): a NULL approved amount is "the inspector has not answered this
        // line" — the email says so, never "$0 approved", which reads as denied.
        meta.push({ label: scrub(l.name) || 'Line item',
          value: l.approved_cents == null ? `${usd(l.requested_cents)} requested — not yet reviewed`
            : Number(l.not_approved_cents) > 0 ? `${usd(l.approved_cents)} approved of ${usd(l.requested_cents)}` : `${usd(l.approved_cents)} approved` });
      }
      if (flines.length > CAP) meta.push({ label: `+ ${flines.length - CAP} more line item(s)`, value: 'open the results to see them all' });
      const pv = [];
      if (photos) pv.push(`${photos} photo${photos === 1 ? '' : 's'}`);
      if (videos) pv.push(`${videos} video${videos === 1 ? '' : 's'}`);
      const disputeLink = result.reply_token ? `/draw-accept/${result.reply_token}?tab=dispute` : `/app/${appId}`;
      // ONE email with the whole team visibly on it (owner-directed 2026-08-03) — the separate
      // in-app-only staff marker below stays, so nobody on the file loses the event.
      // DELIVERING FINDINGS IS AN EXPLICIT HUMAN ACTION, NOT AN AUTOMATED NOTIFICATION
      // (owner-reported 2026-08-10: the borrower never received the findings email; the fallback
      // emailed the borrower-voiced copy to a staff assignee instead). The coordinator pressed
      // "Deliver findings to the borrower", and the wire SLA starts running the moment the finding
      // persists — so this send takes the same two escape hatches the notify layer documents for
      // exactly this shape: `_bypassLoGate` (the Notification Center's Send-now hatch — a human
      // already decided this goes out, the LO curation gate must not silently park it in Drafts)
      // and `evenIfOnHold` ("the rare message that must go out anyway" — a parked file's draw is
      // still being worked by the desk). Borrower notification PREFERENCES still apply.
      sentThread = await notify.notifyAppThread(appId, {
        type: 'draw_findings', title: 'Your inspection is complete — please confirm the amount',
        _bypassLoGate: true, evenIfOnHold: true,
        // The staff copy is STAFF-voiced with a STAFF destination — never the borrower's no-login
        // accept/dispute magic link (audit L1; enforced by notifyAppThread's staffLink handling).
        // NEUTRAL wording on purpose: this same copy is the FALLBACK email when the borrower could
        // not be reached, so it must not claim the results "went to the borrower" (the note the
        // fallback appends says what actually happened).
        staffTitle: 'Inspection results ready for the borrower — awaiting their confirmation',
        staffBody: `The inspection results for ${addr} are ready for the borrower to accept or dispute. The draw releases once they confirm.`,
        staffLink: `/internal/app/${appId}`, staffCtaLabel: 'Open the file',
        // "Draw 2 · Your inspection is complete …" — the borrower and the coordinator are both
        // on this thread and a property with three draws otherwise sends three identical subjects.
        drawTag: await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: drawId }),
        badge: { text: 'Please confirm', tone: 'action' },
        figures: (blocks && blocks.figures) || null,
        facts: (blocks && blocks.facts) || null,
        // The old hero survives only when the rollup could not be read, so the email never loses
        // its headline number.
        hero: (blocks && blocks.figures) ? null
          : { label: 'Approved by the inspector', value: usd(totAppr), sub: `of ${usd(totReq)} requested`, tone: 'positive' },
        body: `Your inspection is complete${pv.length ? ` — ${pv.join(' and ')} on file` : ''}. Here is what the inspector approved on each line. When you’re ready, confirm to release your draw — or push back on any line you disagree with.`,
        meta,
        // The callout tells the SAME story as the headline: a real release when one is known, an
        // honest "nothing releases this time" on an inspector's $0, and NO wire promise when the
        // inspector has not answered yet.
        callout: {
          title: 'What happens when you confirm',
          body: inspectorZero
            ? 'The inspector approved $0 this time, so confirming accepts the results — nothing is wired, and the amounts stay on your budget to draw once the work is done. Disagree? Push back on any line below. Want to look first? Open the results to see every photo and download your inspection report (PDF).'
            : `Confirming ${releaseLine ? `releases your draw — ${releaseLine.value.split(' (')[0]} is wired to you — funds are typically sent within a day or two` : 'accepts the inspection results'}. Want to look first? Open the results to see every photo and download your inspection report (PDF).`,
          tone: 'action',
        },
        applicationId: appId, link: acceptLink, ctaLabel: 'Review & confirm',
        cta2Label: 'Push back on a line', cta2Link: disputeLink,
        attachments: findingAttachments,
        // The team now rides a VISIBLE Cc, applied for every 'draws' notification at the notify
        // chokepoint — so the reply-all thread includes them. No Bcc needed here any more.
      }).catch(() => null);
    }
    // Did the borrower actually receive their copy? `emailedTogether` is the thread's own answer
    // (mailable AND at least one borrower row written). The reason class tells the coordinator
    // what to fix: no address on file vs. a held/muted copy.
    const borrowerEmailed = !!(sentThread && sentThread.emailedTogether);
    const borrowerEmailReason = borrowerEmailed ? null
      : (!f.borrower_id ? 'no_borrower'
        : (sentThread && sentThread.borrowerMailable === false ? 'no_borrower_email'
          : (sentThread ? 'suppressed' : 'send_failed')));
    // In-app only (owner-directed 2026-07-20): a confirmation that the coordinator
    // just delivered findings is not a whole-team EMAIL — the borrower's own
    // "results ready" email (above) is the real send; this is a desk marker.
    // The marker TELLS THE TRUTH about the borrower's copy — "delivered to the borrower" on an
    // event whose borrower email never went out is how this bug stayed invisible.
    await notify.notifyAppStaff(appId, { type: 'draw_findings', title: 'Draw findings delivered to borrower', inAppOnly: true,
      body: borrowerEmailed
        ? `Inspection findings for ${addr} were delivered to the borrower to accept or dispute.`
        : `Inspection findings for ${addr} were recorded, but the borrower could NOT be emailed (${borrowerEmailReason === 'no_borrower_email' ? 'no email address on file' : 'their copy was blocked or failed'}). Reach them another way — the draw is waiting on their confirmation.`,
      applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    // Auto-deliver artifacts: durably archive the inspector's (expiring) media NOW and pre-build the PILOT +
    // borrower-safe reports, so the durable photos + both branded PDFs are ready the instant findings land —
    // never dependent on a later manual "archive" click (a report built pre-archive had zero photos). Fully
    // best-effort: it never throws or reverses the delivery just completed. (drawReport.autoDeliverArtifacts.)
    // Bounded on the response path: we await up to a short budget so the common (fast) case confirms
    // "reports ready", but a slow/unreachable media CDN can NEVER hang this delivery request (the archive is
    // a sequential per-item fetch with only a per-item timeout). Past the budget the work keeps running in the
    // background to completion (every step is idempotent + independently caught) — we just answer promptly.
    res.json({ ok: true, ...result, media_archived: artifacts.archived, reports_ready: artifacts.reports,
      reports_pending: !!artifacts.pending, attachments_sent: findingAttachments.map((a) => a.filename),
      borrower_emailed: borrowerEmailed, borrower_email_reason: borrowerEmailReason });
  } catch (e) { console.warn('[sitewire] upstream error:', e && e.message); res.status(502).json({ error: 'the draw service is temporarily unavailable — nothing was changed; try again shortly' }); }
});

// ---- GET /findings/:findingId — full finding detail (staff) ----
router.get('/findings/:findingId', requireDrawView, async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await canSeeFile(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  const allRows = (await db.query(`SELECT * FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows
    // Never leak internal storage refs to the client: replace the raw dispute_media (which holds
    // storage_ref) with a safe descriptor the UI turns into a serving URL. Borrower dispute evidence
    // is fetched byte-by-byte through the guarded /dispute-media/:idx route below.
    .map((l) => {
      const ev = Array.isArray(l.dispute_media) ? l.dispute_media : [];
      const dispute_evidence = ev.map((m, idx) => ({ idx, filename: (m && m.filename) || `evidence ${idx + 1}`, kind: (m && m.kind) || 'file', content_type: (m && m.content_type) || null }));
      const { dispute_media, ...rest } = l;
      return { ...rest, dispute_evidence };
    });
  // Post-audit fix (2026-07-21): split live vs retired so the coordinator UI's default per-line sum
  // matches the parent totals (which mirror Sitewire's current sum, excluding retired lines).
  // A retired line — one Sitewire dropped from a fresh read on re-deliver, db/242 retired_at — stays
  // available as history under `retired_lines` (a decided dispute is NEVER retired, so this only ever
  // contains lines the borrower hadn't acted on).
  const lines = allRows.filter((l) => l.retired_at == null);
  const retired_lines = allRows.filter((l) => l.retired_at != null);
  // Never hand the borrower's no-login reply_token to a staff client — it is the borrower's own
  // accept/dispute capability, and a staffer must act as staff, not impersonate the borrower (audit L1).
  const { reply_token, ...findingSafe } = f;
  res.json({ finding: findingSafe, lines, retired_lines });
});

// ---- GET /findings/lines/:lineId/dispute-media/:idx — serve one borrower dispute-evidence file (staff) ----
// The borrower attached these when they pushed back on a line. Streamed from PILOT's durable storage
// after the manage_draws + file-visibility + line-belongs-to-file checks. GPS was stripped on upload.
router.get('/findings/lines/:lineId/dispute-media/:idx', requireDrawView, async (req, res) => {
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

  // On APPROVE, the corrected approved figure is EITHER an exact amount staff type (a negotiated figure)
  // OR, if none is typed, the borrower's requested amount. It can never exceed what the borrower requested
  // for that line (you can't approve more than was asked). Owner-directed 2026-07-21.
  if (decision === 'approved' && req.body.approved_cents != null && req.body.approved_cents !== '') {
    const v = Number(req.body.approved_cents);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'The approved amount must be a whole dollar amount of $0 or more.' });
  }
  // The corrected approved amount (cents) on APPROVE: an exact typed figure, else the borrower's requested
  // amount — capped at the requested amount, never negative (src/sitewire/money.disputeApprovedCents).
  const target = require('../sitewire/money').disputeApprovedCents({
    decision, requestedCents: line.requested_cents, typedCents: req.body.approved_cents, desiredCents: line.dispute_desired_cents,
  });

  // Push the corrected approved amount back to Sitewire (guarded, read-after-write verified) — this is the
  // OVERRIDE of Sitewire's approved figure. Audit finding B-4 (2026-07-21): a Sitewire push failure (or
  // writes-off) previously updated the local `draw_finding_lines.approved_cents` anyway, silently
  // diverging PILOT from Sitewire and `sitewire_draw_requests` with NO review row parked — a coordinator
  // could then release money against a figure Sitewire never confirmed. Now: on APPROVE with a change,
  // if the Sitewire push doesn't confirm (dry-run / writes-off / any failure), we DO NOT overwrite
  // `approved_cents` locally and we PARK a `sitewire_dispute_push_failed` review with the intended
  // figure so a human resolves it. The dispute STATUS still records ('approved'/'rejected') so the
  // dispute closes as decided — only the numeric override waits for confirmation.
  let pushed = false, pushNote = null;
  const wantsPush = decision === 'approved' && target != null && line.sitewire_request_id;
  if (wantsPush) {
    if (switches.on('SITEWIRE_ENABLED') && switches.on('SITEWIRE_OUTBOUND_ENABLED')) {
      try {
        await orchestrator.circuitCheck(1);
        const r = await client.updateRequest(line.sitewire_request_id, { approved_cents: target, lender_comments: `Dispute approved (PILOT): ${req.body.note || ''}`.slice(0, 240) });
        if (!(r && r.__dryrun)) {
          let saved = target; try { const fresh = await client.getRequest(line.sitewire_request_id); if (fresh && fresh.approved_cents != null) saved = fresh.approved_cents; } catch (_) {}
          await db.query(`UPDATE sitewire_draw_requests SET approved_cents=$2, updated_at=now() WHERE sitewire_request_id=$1`, [line.sitewire_request_id, saved]);
          await orchestrator.journal({ appId: f.application_id, entity: 'request', entityId: Number(line.sitewire_request_id), field: 'approved_cents', newValue: saved, source: 'dispute' });
          pushed = true;
        } else pushNote = 'writes are in dry-run — Sitewire not changed';
      } catch (e) { pushNote = `Sitewire push failed (${e.message}); confirm the new amount by hand`; }
    } else pushNote = 'Sitewire writes are off — a processor must confirm the new amount by hand';
    // Sitewire didn't confirm the change — park a review row so the numeric override doesn't apply
    // silently and get lost. The dispute STATE still records below (borrower gets closure); only the
    // dollar override waits. When the review is resolved the coordinator re-runs decide from the desk.
    if (!pushed) {
      try {
        await orchestrator.park({ appId: f.application_id, dedupe: `disputepush:${line.sitewire_request_id}`,
          reason: `sitewire_dispute_push_failed: could not push the negotiated approved amount ${T.usd(target)} for draw line ${line.sitewire_request_id} back to Sitewire (${pushNote || 'unknown'}). PILOT held the previous approved amount so nothing diverges — retry the decision when Sitewire is back or the push flag is on.`,
          pilotValue: line.approved_cents == null ? 'not reviewed' : String(line.approved_cents), sitewireValue: String(target) });
      } catch (_) { /* best-effort park */ }
    }
  }
  // Record the corrected approved figure on the line — BUT ONLY IF the Sitewire push CONFIRMED (or no
  // push was attempted, e.g. a plain reject / an approve with no change). If wantsPush && !pushed, we
  // record the DECISION (status/lender_comments) but LEAVE approved_cents at its prior value so PILOT
  // and Sitewire don't diverge silently — the parked row above captures the intended figure. Bind $5
  // to null when the push didn't confirm so the CASE-WHEN reverts to the prior amount.
  const persistTarget = (wantsPush && !pushed) ? null : target;
  await db.query(`UPDATE draw_finding_lines SET dispute_status=$2, lender_comments=COALESCE($3,lender_comments), dispute_decided_by=$4, dispute_decided_at=now(), approved_cents=CASE WHEN $2='approved' AND $5::bigint IS NOT NULL THEN $5::bigint ELSE approved_cents END, not_approved_cents=CASE WHEN $2='approved' AND $5::bigint IS NOT NULL THEN GREATEST(0, requested_cents - $5::bigint) ELSE not_approved_cents END, updated_at=now() WHERE id=$1`,
    [lineId, decision, req.body.note || null, req.actor.id, persistTarget]);
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
          ? (l.dispute_desired_cents != null && l.approved_cents != null ? `Approved — now ${usd(l.approved_cents)}` : 'Approved on review')
          // TRI-STATE (db/518): a rejected dispute on a line the inspector never answered must not
          // read "kept at $0" — the old denied-$0 lie on the one email a disputing borrower reads.
          : (l.approved_cents == null ? 'Reviewed — still awaiting the inspector\'s figure' : `Reviewed — kept at ${usd(l.approved_cents)}`) }));
      // The OUTCOME as a headline, not a paragraph (draw rule 15): the decision moved the draw's
      // approved amount, so the figure band leads with what the borrower is now getting. Read from
      // the rollup AFTER the per-line write above, so it reflects the decision just made.
      const blocks = await drawEmailBlocks(db, f.application_id, { sitewireDrawId: f.sitewire_draw_id, borrower: true });
      await notify.notifyAppBorrowers(f.application_id, {
        type: 'draw_dispute_resolved', title: 'We reviewed your draw dispute',
        drawTag: await drawLabel.drawTagForRef(db, f.application_id, { sitewireDrawId: f.sitewire_draw_id }),
        badge: { text: 'Reviewed', tone: approvedN ? 'positive' : 'neutral' },
        figures: (blocks && blocks.figures) || null,
        facts: (blocks && blocks.facts) || null,
        body: approvedN
          ? `We reviewed the item(s) you flagged on your inspection results — ${approvedN} of ${decided.length} ${approvedN === 1 ? 'was' : 'were'} approved for a higher amount, and the rest were reviewed and kept as-is. Your updated results are in your portal.`
          : 'We reviewed the item(s) you flagged on your inspection results. After review they were kept as-is. The full details are in your portal.',
        meta, applicationId: f.application_id, link: `/app/${f.application_id}`, ctaLabel: 'View your draw' }).catch(() => {});
    } catch (_) { /* notification is best-effort — the decision is already recorded */ }
  }
  // A dispute approval that LANDED in Sitewire changed its figures, so Sitewire
  // regenerated its report/PDF. Pull the new figures + PDF back and rebuild our
  // reports (owner-directed 2026-08-11) — in the BACKGROUND so it never slows the
  // decision. Only when the push actually confirmed (`pushed`): with writes off /
  // a failed push nothing changed in Sitewire. The authoritative refresh also runs
  // at Deliver-to-Investor, so a missed one here is never the last word.
  if (pushed) {
    setImmediate(() => {
      require('../sitewire/draw-report').refreshDrawFromSitewire(f.application_id, f.sitewire_draw_id)
        .catch((e) => console.warn(`[sitewire] post-dispute refresh failed (draw=${f.sitewire_draw_id}): ${e && e.message}`));
    });
  }
  res.json({ ok: true, decision, pushed, note: pushNote, disputes_open: openLeft });
});

// ===================================================================================
//  INVESTOR DELIVERY — send the agreed draw to the note buyer who funds it
//  (owner-directed 2026-08-03). See src/sitewire/investor-delivery.js for the rules.
//  (`investorDelivery` / `investorSend` / `releaseParty` are required at the top of the file.)
// ===================================================================================

// ---- POST /files/:id/findings/:findingId/review — a human READ the inspection ----
// Findings used to go to the borrower the moment somebody pressed Deliver, with nothing recording
// that anybody read the inspector's report first (the unbuilt "increment D" in
// docs/DRAW-WORKFLOW-STATUS-RESEARCH.md). This records the read.
//
// DELIBERATELY NOT A GATE. Deliver still works exactly as it does today — making the review a
// refusal would be a new hold on live files that nobody asked for. It drives the readiness
// checklist, which is where an unreviewed inspection now shows up before anyone presses anything.
router.post('/files/:id/findings/:findingId/review', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!/^\d+$/.test(String(req.params.findingId))) return res.status(404).json({ error: 'not found' });
  const note = req.body && req.body.note ? String(req.body.note).slice(0, 2000) : null;
  const upd = (await db.query(
    `UPDATE draw_findings SET reviewed_at=now(), reviewed_by=$3, review_note=COALESCE($4, review_note), updated_at=now()
      WHERE id=$1 AND application_id=$2 RETURNING id, sitewire_draw_id, reviewed_at`,
    [req.params.findingId, appId, req.actor.id, note])).rows[0];
  if (!upd) return res.status(404).json({ error: 'not found' });
  try {
    await stageEvents.record(appId, { sitewireDrawId: upd.sitewire_draw_id }, 'inspector_approved', {
      detail: `Inspection reviewed by us${note ? ' — ' + note.slice(0, 160) : ''}`,
      actorStaffId: req.actor.id, source: 'pilot' });
  } catch (_) {}
  res.json({ ok: true, reviewed_at: upd.reviewed_at });
});

// ---- POST /files/:id/findings/:findingId/mark-accepted ----
// The borrower agreed OUTSIDE the portal — verbally, or by email. That is a real acceptance, so it
// goes through the SAME transition their own Accept button uses; only `accepted_via='staff'` and
// the recorded note distinguish it. A note is REQUIRED: "who said the borrower agreed, and how?"
// must be answerable from the file years later.
router.post('/files/:id/findings/:findingId/mark-accepted', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1 AND application_id=$2`, [req.params.findingId, appId])).rows[0];
  if (!f) return res.status(404).json({ error: 'those findings were not found on this file' });
  const note = String((req.body && req.body.note) || '').trim();
  if (note.length < 8) {
    return res.status(400).json({ error: 'Record how the borrower gave their approval (at least 8 characters) — for example "approved by phone with Yehuda 8/3" or "emailed approval, forwarded to the file".' });
  }
  if (f.status === 'accepted') return res.json({ ok: true, already: true, wire_due_at: f.wire_due_at });
  if (f.status !== 'delivered') {
    return res.status(409).json({ error: f.status === 'disputed'
      ? 'The borrower pushed back on this draw — decide the disputed lines first.'
      : 'These findings are not awaiting the borrower’s answer.' });
  }
  let hours = 48;
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); if (Number.isFinite(h) && h > 0) hours = h; } catch (_) {}
  const upd = (await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='staff',
            accepted_by_staff_id=$3, accepted_note=$4, wire_due_at=now() + ($2 || ' hours')::interval, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING wire_due_at`, [f.id, String(hours), req.actor.id, note.slice(0, 1000)])).rows[0];
  if (!upd) return res.status(409).json({ error: 'someone else just handled these findings' });
  try { await orchestrator.journal({ appId, entity: 'draw', entityId: Number(f.sitewire_draw_id), field: 'borrower_accepted_offline', oldValue: { status: f.status }, newValue: { via: 'staff', note: note.slice(0, 500), actor: req.actor.id }, source: 'money_override' }); } catch (_) {}
  await notify.notifyAppStaff(appId, { type: 'draw_accepted', title: 'Borrower agreement recorded', inAppOnly: true,
    body: `A coordinator recorded that the borrower approved this draw (${note.slice(0, 160)}). The release is due by ${new Date(upd.wire_due_at).toLocaleString('en-US')}.`,
    applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
  res.json({ ok: true, wire_due_at: upd.wire_due_at, accepted_via: 'staff' });
});

// ---- POST /files/:id/findings/:findingId/dispute — a loan officer files a DISPUTE
// FOR THE BORROWER (owner-directed 2026-08-12): the view-only draw partner of the
// accept-on-behalf above. It mirrors the borrower's own dispute (borrower-draws.js)
// EXACTLY — same per-line IDOR (the line must belong to the finding), the same
// [0, requested] clamp on the desired amount, the same shared normalizeDisputeMedia
// (byte-sniffed, GPS-stripped, capped), the same guarded delivered→disputed flip —
// so a borrower's and a loan officer's dispute are stored identically. It is stamped
// disputed_via='staff' + disputed_by_staff_id (db/538 allows 'staff'), and a note
// recording HOW the borrower asked to dispute is required, so "who filed this?" is
// answerable. view_draws + canSeeFile: a loan officer only ever acts on their own
// files, and this is the one WRITE (besides accept) they are allowed. ----
router.post('/files/:id/findings/:findingId/dispute', requireDrawView, async (req, res) => {
  const appId = req.params.id;
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1 AND application_id=$2`, [req.params.findingId, appId])).rows[0];
  if (!f) return res.status(404).json({ error: 'those findings were not found on this file' });
  const note = String((req.body && req.body.note) || '').trim();
  if (note.length < 8) {
    return res.status(400).json({ error: 'Record how the borrower asked to dispute this draw (at least 8 characters) — for example "borrower called 8/12, disputes the roof line".' });
  }
  if (f.status === 'accepted') return res.status(409).json({ error: 'This draw was already accepted — it can no longer be disputed.' });
  if (f.status === 'resolved') return res.status(409).json({ error: 'These results have already been reviewed and resolved.' });
  if (f.status !== 'delivered') return res.status(409).json({ error: 'These findings are not awaiting the borrower’s answer.' });
  // Cap the fan-out exactly like the borrower route (a real draw never has ~200 lines).
  const lines = (Array.isArray(req.body && req.body.lines) ? req.body.lines : []).slice(0, 200);
  if (!lines.length) return res.status(400).json({ error: 'a dispute must name at least one line' });
  const updates = [];
  for (const ln of lines) {
    if (!/^\d{1,18}$/.test(String(ln && ln.line_id))) continue;
    const owned = (await db.query(`SELECT id, requested_cents FROM draw_finding_lines WHERE id=$1 AND finding_id=$2 AND retired_at IS NULL`, [ln.line_id, f.id])).rows[0];
    if (!owned) continue;
    let desired = ln.desired_cents == null ? null : Math.round(Number(ln.desired_cents));
    if (desired != null && (!Number.isFinite(desired) || desired < 0 || desired > Number(owned.requested_cents))) desired = null;
    const evidence = await normalizeDisputeMedia(ln.media);
    updates.push({ line_id: ln.line_id, desired, note: ln.note ? String(ln.note).slice(0, 2000) : null, evidence });
  }
  if (!updates.length) return res.status(400).json({ error: 'no valid dispute lines' });
  const flipped = (await db.query(
    `UPDATE draw_findings SET status='disputed', disputed_at=now(), disputed_via='staff', disputed_by_staff_id=$2, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING id`, [f.id, req.actor.id])).rows[0];
  if (!flipped) return res.status(409).json({ error: 'someone else just handled these findings' });
  for (const u of updates) {
    await db.query(
      `UPDATE draw_finding_lines SET dispute_status='open', dispute_desired_cents=$2, dispute_note=$3, dispute_media=$4, updated_at=now() WHERE id=$1`,
      [u.line_id, u.desired, u.note, u.evidence.length ? jsonbText(u.evidence) : null]);
  }
  const count = updates.length;
  try { await orchestrator.journal({ appId, entity: 'draw', entityId: Number(f.sitewire_draw_id), field: 'borrower_disputed_offline', oldValue: { status: f.status }, newValue: { via: 'staff', lines: count, note: note.slice(0, 500), actor: req.actor.id }, source: 'money_override' }); } catch (_) {}
  await notify.notifyAppStaff(appId, { type: 'draw_disputed', title: 'Dispute recorded for the borrower', badge: { text: 'Disputed', tone: 'action' },
    drawTag: await drawLabel.drawTagForRef(db, appId, { sitewireDrawId: f.sitewire_draw_id }),
    body: `A loan officer recorded that the borrower disputes ${count} item(s) on this draw (${note.slice(0, 160)}). A draw coordinator needs to review.`,
    applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
  res.json({ ok: true, disputed_lines: count, disputed_via: 'staff' });
});

// ---- POST /files/:id/draws/:drawId/funding-mode — how this draw is funded ----
// `scope:'file'` sets the file's default for every future draw; otherwise it is this draw only.
router.post('/files/:id/draws/:drawId/funding-mode', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const mode = String((req.body && req.body.mode) || '');
  if (!investorDelivery.MODES.includes(mode)) return res.status(400).json({ error: 'Pick how this draw is funded.' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  if (String((req.body && req.body.scope) || '') === 'file') {
    await db.query(`UPDATE sitewire_property_links SET investor_funding_mode=$2, updated_at=now() WHERE application_id=$1 AND matched_by='created'`, [appId, mode]);
  } else {
    const upd = await db.query(`UPDATE draw_findings SET funding_mode=$3, updated_at=now() WHERE application_id=$1 AND sitewire_draw_id=$2`, [appId, drawId, mode]);
    if (!upd.rowCount) return res.status(409).json({ error: 'Deliver the inspection findings first — the funding choice is recorded against them.' });
  }
  res.json({ ok: true, mode, release: await releaseParty.releaseStateFor(db, appId, { sitewireDrawId: drawId }).catch(() => null) });
});

// ---- GET/POST /files/:id/release-party — "who releases the money" for the whole PROJECT ----
// The per-draw switch above needs a draw to exist and a findings row to hang the choice on. This
// is the PROJECT-level answer the owner asked for ("we should be able to set every property … by
// default … released by the investor or released by us"), so it can be set the moment the file
// has a draw project — before the first draw, and for every draw after it. The capital-provider
// and company levels are set in the admin Draw Settings screen; this one belongs to the file.
// NOTE: there is deliberately no standalone GET here. The card is fed by `release` on the rollup —
// one read for the whole desk instead of two — and a per-draw variant was removed rather than left
// with no caller, which is the exact thing `test-draw-routes-wired-pure.js` exists to catch. If a
// per-draw override ever gets a surface, bring the route back together with the screen that calls it.

router.post('/files/:id/release-party', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const raw = req.body && req.body.mode;
  // An explicit blank CLEARS the project's answer, which is a real choice: it hands the decision
  // back to the capital provider's setting (and then the company default), so a coordinator can
  // undo a per-project override rather than being stuck with whatever they picked once.
  const clear = raw === null || raw === '' || raw === undefined;
  const mode = String(raw || '');
  if (!clear && !investorDelivery.MODES.includes(mode)) return res.status(400).json({ error: 'Pick who releases the money on this project.' });
  const upd = await db.query(
    `UPDATE sitewire_property_links SET investor_funding_mode=$2, updated_at=now()
      WHERE application_id=$1 AND matched_by='created' RETURNING application_id`,
    [appId, clear ? null : mode]);
  if (!upd.rowCount) return res.status(409).json({ error: 'This file has no draw project yet — start the draw process first.' });
  try {
    await orchestrator.journal({ appId, entity: 'file', entityId: appId, field: 'investor_funding_mode',
      oldValue: null, newValue: { mode: clear ? null : mode, actor: req.actor.id }, source: 'money_override' });
  } catch (_) {}
  res.json({ ok: true, release: await releaseParty.releaseStateFor(db, appId).catch(() => null) });
});

// ---- GET /files/:id/draws/:drawId/investor-delivery — the preview behind the button ----
router.get('/files/:id/draws/:drawId/investor-delivery', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  try {
    const preview = await investorSend.deliveryPreview(appId, drawId);
    // The same release answer the draw desk shows, so the "this loan isn't sold yet — do you want
    // to release it yourself?" question is in front of the coordinator on the screen where they
    // are about to ask an investor to wire money, not only back on the desk.
    const release = await releaseParty.releaseStateFor(db, appId, { sitewireDrawId: drawId }).catch(() => null);
    res.json({ ...preview, release, modes: investorDelivery.MODES.map((m) => ({ mode: m, label: investorDelivery.MODE_LABEL[m], help: investorDelivery.MODE_HELP[m] })) });
  } catch (e) { console.warn('[sitewire] investor preview:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// ---- POST /files/:id/draws/:drawId/investor-delivery — deliver it ----
// `confirm` must name the investor the desk showed, so a mis-click (or a note buyer changed in
// another tab since the preview loaded) can never mail one investor's draw to another.
router.post('/files/:id/draws/:drawId/investor-delivery', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
  if (!own.rowCount) return res.status(404).json({ error: 'draw not found on this file' });
  try {
    const confirm = String((req.body && req.body.confirm_note_buyer) || '').trim();
    const app = (await db.query(`SELECT lender FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    if (!confirm || investorSend.investorKeyFor(confirm) !== investorSend.investorKeyFor(app.lender)) {
      return res.status(400).json({ error: `Confirm the investor before sending — this file's note buyer is ${app.lender || '(not set)'}.` });
    }
    const who = (await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    const out = await investorSend.sendInvestorDelivery(appId, drawId, {
      staffId: req.actor.id, staffName: who.full_name || null,
      mode: (req.body && req.body.mode) || null,
      note: (req.body && req.body.note) || null,
    });
    try { await orchestrator.journal({ appId, entity: 'draw', entityId: Number(drawId), field: 'investor_delivery', oldValue: null, newValue: { to: out.to, mode: out.funding_mode, total: out.money.investor_total_cents, actor: req.actor.id }, source: 'money_override' }); } catch (_) {}
    await notify.notifyAppStaff(appId, { type: 'draw', title: out.manual ? 'Draw delivery recorded (handled manually)' : 'Draw delivered to the investor', inAppOnly: true,
      body: out.manual
        ? `A coordinator recorded that this draw was delivered to ${app.lender || 'the investor'} outside PILOT${out.note ? ` — ${String(out.note).slice(0, 160)}` : ''}.`
        : `Draw request sent to ${app.lender || 'the investor'} (${out.to.join(', ')}).`,
      applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, blockers: e.blockers || undefined });
    console.warn('[sitewire] investor delivery:', e && e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ---- Investor delivery CONTACTS (per note buyer) ----
// ---- POST /files/:id/draws/:drawId/investor-answer — what the investor said back ----
// Until now PILOT recorded only that we SENT a draw, so "with the investor" was a dead end that
// only a reminder ever escaped. This records the answer, the date, who wrote it down, their own
// words, and — on an approval — when they say the money will move.
router.post('/files/:id/draws/:drawId/investor-answer', requirePermission('manage_draws'), async (req, res) => {
  const appId = req.params.id, drawId = req.params.drawId;
  if (!/^\d+$/.test(drawId)) return res.status(404).json({ error: 'draw not found' });
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const chk = investorDelivery.answerProblem({ answer: b.answer, note: b.note });
  if (!chk.ok) return res.status(400).json({ error: chk.error });
  let funding = null;
  if (b.expected_funding_date != null && b.expected_funding_date !== '') {
    funding = sanitizeDateOnly(b.expected_funding_date);
    if (!funding) return res.status(400).json({ error: 'The expected funding date must be a valid calendar date (YYYY-MM-DD).' });
  }
  // The answer belongs to the delivery it answers — the LATEST send for this draw. A re-send is a
  // new row (the investor genuinely received two emails), so answering always lands on the one
  // they are actually replying to, and an older send keeps whatever it was answered with.
  const upd = (await db.query(
    `UPDATE draw_investor_deliveries SET answer=$3, answered_at=now(), answered_by=$4,
            answer_note=$5, expected_funding_date=$6
      WHERE id = (SELECT id FROM draw_investor_deliveries
                   WHERE application_id=$1 AND sitewire_draw_id=$2 AND status='sent'
                   ORDER BY sent_at DESC LIMIT 1)
      RETURNING *`,
    [appId, drawId, String(b.answer), req.actor.id, b.note ? String(b.note).slice(0, 2000) : null, funding])).rows[0];
  if (!upd) return res.status(409).json({ error: 'This draw has not been delivered to the investor yet — send it first, then record what they said.' });
  try {
    await orchestrator.journal({ appId, entity: 'draw', entityId: Number(drawId), field: 'investor_answer',
      oldValue: null, newValue: { answer: upd.answer, expected_funding_date: funding, actor: req.actor.id }, source: 'money_override' });
  } catch (_) {}
  // The answer IS a stage change — it is the rung the ladder could never see.
  try {
    await stageEvents.record(appId, { sitewireDrawId: drawId },
      upd.answer === 'approved' ? 'investor_approved' : 'with_investor', {
        detail: `Investor ${investorDelivery.ANSWER_LABEL[upd.answer] || upd.answer}${upd.answer_note ? ' — ' + String(upd.answer_note).slice(0, 160) : ''}`,
        actorStaffId: req.actor.id, source: 'pilot', force: upd.answer !== 'approved',
      });
  } catch (_) {}
  res.json({ ok: true, delivery: upd, label: investorDelivery.ANSWER_LABEL[upd.answer], next: investorDelivery.ANSWER_NEXT[upd.answer] });
});

router.get('/investor-contacts', requirePermission('manage_draws'), async (req, res) => {
  try { res.json({ contacts: await investorSend.allContacts() }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/investor-contacts', requirePermission('manage_draws'), async (req, res) => {
  const label = String((req.body && req.body.label) || '').trim();
  const emailAddr = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!label) return res.status(400).json({ error: 'Name the note buyer these contacts belong to.' });
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(emailAddr)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const key = investorSend.investorKeyFor(label);
  if (!key) return res.status(400).json({ error: 'That note-buyer name could not be read.' });
  try {
    const r = (await db.query(
      `INSERT INTO investor_delivery_contacts (label_norm, label, email, name, role, active, created_by)
       VALUES ($1,$2,$3,$4,$5,true,$6)
       ON CONFLICT (label_norm, lower(email))
         DO UPDATE SET label=EXCLUDED.label, name=EXCLUDED.name, role=EXCLUDED.role, active=true, updated_at=now()
       RETURNING id, label_norm, label, email, name, role, active`,
      [key, label, emailAddr,
        (req.body && req.body.name) ? String(req.body.name).slice(0, 160) : null,
        (req.body && req.body.role) ? String(req.body.role).slice(0, 160) : null,
        req.actor.id])).rows[0];
    res.json({ ok: true, contact: r });
  } catch (e) { console.warn('[sitewire] investor contact:', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.delete('/investor-contacts/:contactId', requirePermission('manage_draws'), async (req, res) => {
  if (!/^\d+$/.test(req.params.contactId)) return res.status(404).json({ error: 'not found' });
  // Deactivated, never deleted — a delivery record naming this address must stay explainable.
  const r = await db.query(`UPDATE investor_delivery_contacts SET active=false, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.contactId]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
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
// Audit finding B-6 (2026-07-21): two concurrent applies each SELECT status='pending', both bump
// budget_version, both enqueue a push, and the "already applied" 409 was only a check-then-act (not
// atomic). Serialize on a per-file advisory lock — the second apply either finds `status='approved'`
// and 409s cleanly, or waits then observes the applied state.
router.post('/change-requests/:crId/apply', requirePermission('manage_draws'), async (req, res) => {
  const crId = req.params.crId;
  if (!isUuid(crId)) return res.status(404).json({ error: 'not found' });
  const crCheck = (await db.query(`SELECT application_id FROM change_requests WHERE id=$1 AND field='sow_reallocation'`, [crId])).rows[0];
  if (!crCheck) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeFile(req, crCheck.application_id))) return res.status(403).json({ error: 'forbidden' });
  const appId = crCheck.application_id;
  const client_ = await db.getClient();
  try {
    await client_.query('BEGIN');
    await client_.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sw-crapply:${appId}`]);
    // Post-lock re-read: after we own the lock, another concurrent apply may have already flipped
    // status → 'approved'. Read under the same transaction.
    const cr = (await client_.query(`SELECT cr.*, d.proposed_payload, d.net_zero, d.after_ctc, d.needs_capital_partner, d.capital_partner_status FROM change_requests cr JOIN sow_change_request_details d ON d.change_request_id=cr.id WHERE cr.id=$1 AND cr.field='sow_reallocation' FOR UPDATE`, [crId])).rows[0];
    if (!cr) { await client_.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (cr.status === 'approved') { await client_.query('ROLLBACK'); return res.status(409).json({ error: 'already applied' }); }
    const a = (await client_.query(`SELECT status FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!a) { await client_.query('ROLLBACK'); return res.status(404).json({ error: 'file not found' }); }
    const phase = phaseFor(a.status);
    const proposedPayload = cr.proposed_payload;
    // re-validate against the CURRENT rollup (drawn amounts may have moved since creation)
    const rollup = await rollupMod.loadRollup(db, appId);
    const ex = reconciledExplode(rollup, proposedPayload.state);
    const cells = buildReallocationCells(rollup, ex.items);
    const plan = planReallocation(cells, { phase, variancePct: await variancePct() });
    if (!plan.ok) { await client_.query('ROLLBACK'); return res.status(422).json({ error: 'reallocation is no longer valid', plan }); }
    if (plan.needs_capital_partner && cr.capital_partner_status !== 'approved') { await client_.query('ROLLBACK'); return res.status(409).json({ error: 'capital-partner approval is required before applying' }); }

    // AFTER clear-to-close + net-zero: money moves between lines, total unchanged. Write the
    // new Scope of Work (gated by the exact-match budget check) and re-push the budget to
    // Sitewire (the crosswalk diff moves money between job items). rehab_budget never changes.
    if (phase === 'after_ctc' && plan.totals.net_zero) {
      const gate = await rehab.checkSowBudget(appId, proposedPayload);
      if (!gate.ok) { await client_.query('ROLLBACK'); return res.status(422).json({ error: `new Scope of Work must still total the frozen budget to the cent — ${gate.message || 'mismatch'}` }); }
      // Write the new Version-2 Scope of Work AND reopen its condition (→ 'issue', sign-off
      // cleared) so the borrower re-signs the revised budget — mirrors the budget-change reopen
      // pattern. A net-zero move keeps total == frozen budget, so it can be re-signed.
      await client_.query(`UPDATE checklist_items SET tool_payload=$2, status='issue', signed_off_at=NULL, signed_off_by=NULL,
        notes=COALESCE(notes,'') || CASE WHEN COALESCE(notes,'')='' THEN '' ELSE E'\n' END || '[auto] Scope of Work reallocated — please re-sign the revised budget.', updated_at=now()
        WHERE application_id=$1 AND tool_key='rehab_budget'`, [appId, JSON.stringify(proposedPayload)]);
      await client_.query(`UPDATE sitewire_property_links SET budget_version=budget_version+1, updated_at=now() WHERE application_id=$1`, [appId]);
      await client_.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), updated_at=now() WHERE id=$1`, [crId, req.actor.id]);
      await client_.query(`UPDATE sow_change_request_details SET updated_at=now() WHERE change_request_id=$1`, [crId]);
      await client_.query('COMMIT');
      enqueueSitewirePush(appId, 'push_file').catch(() => {});
      // Only claim a Sitewire push when the integration is actually on — otherwise the enqueue
      // no-ops and the DB SOW would silently diverge from Sitewire (audit E-REALLOC-FALSEPUSH).
      const willPush = switches.on('SITEWIRE_ENABLED');
      await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Budget reallocation applied', badge: { text: 'Applied', tone: 'positive' }, inAppOnly: true,
        body: willPush ? 'A net-zero Scope-of-Work reallocation was applied and is being pushed to Sitewire.' : 'A net-zero Scope-of-Work reallocation was applied to the Scope of Work (Sitewire is currently off — it will sync when turned on).',
        applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
      return res.json({ ok: true, applied: true, pushed_to_sitewire: willPush });
    }

    // BEFORE clear-to-close OR a total change: the construction total is changing, which
    // re-sizes the loan. We never silently change the frozen budget — mark the request
    // approved and flag it for product re-registration (Products & Pricing re-opens).
    await client_.query(`UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=COALESCE($3,decision_note), updated_at=now() WHERE id=$1`, [crId, req.actor.id, 'Total changed — requires product re-registration on the new budget']);
    await client_.query('COMMIT');
    await notify.notifyAppStaff(appId, { type: 'sow_reallocation', title: 'Scope-of-Work change needs re-registration', badge: { text: 'Action needed', tone: 'action' },
      body: 'A Scope-of-Work change alters the construction total. Re-register the product on the new budget in Products & Pricing before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    return res.json({ ok: true, applied: false, requires_reregister: true, plan });
  } catch (e) {
    try { await client_.query('ROLLBACK'); } catch (_) {}
    console.warn('[sitewire] change-request apply error:', e && e.message);
    return res.status(500).json({ error: 'server error' });
  } finally {
    client_.release();
  }
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
// test hook (never used by production code): the D7 retainage chokepoint
module.exports._retainagePctFor = retainagePctFor;
