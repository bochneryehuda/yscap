'use strict';
/**
 * Sitewire reconcile (pull) — polls Sitewire for OUR properties only (only-ours rule)
 * and mirrors draws / requests / events into PILOT, plus keeps the capital-partner
 * directory and the staff<->Sitewire-user map fresh. Read-only against Sitewire.
 *
 * draw_events come back UNSORTED, so submitted_at/approved_at are derived by sorting
 * on occurred_at (never array order). Inbound is scoped to properties we created — a
 * property with no link row is structurally invisible.
 */
const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const T = require('./transforms');
const rollupMod = require('./rollup');
const risk = require('./risk');

// ---- capital-partner directory cache (+ which are on our lender) ----
async function syncCapitalPartners() {
  const list = await client.listCapitalPartners();
  const onOurLender = new Set();
  try { const lender = await client.getLender(cfg.sitewireLenderId); (lender.capital_partners || []).forEach((c) => onOurLender.add(c.id)); } catch (_) {}
  for (const c of (list || [])) {
    await db.query(
      `INSERT INTO sitewire_capital_partners (sitewire_id, name, on_our_lender, synced_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (sitewire_id) DO UPDATE SET name=EXCLUDED.name, on_our_lender=EXCLUDED.on_our_lender, synced_at=now()`,
      [c.id, String(c.name || '').trim(), onOurLender.has(c.id)]);
  }
  return { count: (list || []).length };
}

// ---- match staff_users.email to the lender's Sitewire users -> sitewire_user_id ----
async function syncStaffUsers() {
  let lender;
  try { lender = await client.getLender(cfg.sitewireLenderId); } catch (_) { return { matched: 0 }; }
  let matched = 0;
  for (const u of (lender.users || [])) {
    if (!u.email) continue;
    const r = await db.query(`UPDATE staff_users SET sitewire_user_id=$1, updated_at=now() WHERE lower(email)=lower($2) AND (sitewire_user_id IS NULL OR sitewire_user_id<>$1)`, [u.id, u.email]);
    matched += r.rowCount;
  }
  return { matched };
}

function deriveTimes(events) {
  const ev = (events || []).slice().sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')));
  let submitted = null, approved = null;
  for (const e of ev) {
    if (!submitted && (e.event === 'created' || e.event === 'submit' || e.event === 'delegate_submit')) submitted = e.occurred_at;
    if (e.event === 'lender_approve') approved = e.occurred_at;
  }
  return { submitted: submitted && T.isoDay(submitted), approved: approved && T.isoDay(approved) };
}

// ---- reconcile ONE file's draws (scoped to a property WE created) ----
async function reconcileOne(appId) {
  const link = (await db.query(`SELECT sitewire_property_id, budget_version FROM sitewire_property_links WHERE application_id=$1 AND sitewire_property_id IS NOT NULL AND matched_by IN ('created','linked')`, [appId])).rows[0];
  if (!link) return { skipped: 'not linked' };
  let prop;
  try { prop = await client.getProperty(link.sitewire_property_id); } catch (e) { return { error: e.message }; }
  const draws = (prop.budget && prop.budget.draws) || [];
  let n = 0;
  for (const d of draws) {
   // A poison draw (null id, bad cents, a constraint violation) must skip to the NEXT draw — not throw
   // out of the whole file's reconcile, which would strand every LATER draw's mirror on that file. Park
   // it (deduped) so it's visible, never silently dropped.
   try {
    // full detail for requests + events
    let full;
    try { full = await client.getDraw(d.id); } catch (_) { full = d; }
    const times = deriveTimes(full.draw_events);
    await db.query(
      `INSERT INTO sitewire_draws (application_id, sitewire_draw_id, sitewire_property_id, number, name, status, historical, total_requested_cents, total_approved_cents, coordinator_id, quick_notify_status_id, pdf_src, submitted_at, approved_at, budget_version_at_draw, events, sitewire_updated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
       ON CONFLICT (sitewire_draw_id) DO UPDATE SET status=EXCLUDED.status, total_requested_cents=EXCLUDED.total_requested_cents, total_approved_cents=EXCLUDED.total_approved_cents,
         -- coordinator_id / quick_notify_status_id are draw-DETAIL fields (set via PATCH /draws); the /draws
         -- summary may omit them, so if the per-draw getDraw failed (full=d) EXCLUDED is NULL — COALESCE
         -- so a failed detail read never WIPES a previously-good coordinator / quick-notify value either.
         coordinator_id=COALESCE(EXCLUDED.coordinator_id, sitewire_draws.coordinator_id), quick_notify_status_id=COALESCE(EXCLUDED.quick_notify_status_id, sitewire_draws.quick_notify_status_id),
         -- detail-only columns come from the per-draw getDraw; if that call failed (rate-limit/timeout) they arrive
         -- NULL — COALESCE so a failed detail read never WIPES a good submitted/approved/events/pdf on the desk.
         pdf_src=COALESCE(EXCLUDED.pdf_src, sitewire_draws.pdf_src), submitted_at=COALESCE(EXCLUDED.submitted_at, sitewire_draws.submitted_at), approved_at=COALESCE(EXCLUDED.approved_at, sitewire_draws.approved_at), events=COALESCE(EXCLUDED.events, sitewire_draws.events), sitewire_updated_at=EXCLUDED.sitewire_updated_at, updated_at=now()`,
      [appId, d.id, link.sitewire_property_id, d.number, d.name, d.status, !!d.historical,
       d.total_requested_cents || 0, d.total_approved_cents || 0, full.coordinator_id || d.coordinator_id || null,
       full.quick_notify_status_id || d.quick_notify_status_id || null, full.pdf_src || null,
       times.submitted || null, times.approved || null, link.budget_version || null,
       full.draw_events ? JSON.stringify(full.draw_events) : null, d.updated_at || null]);
    // mirror requests — per-row guarded so one poison row can't strand the whole file's mirror
    for (const r of (full.requests || [])) {
      try {
        await db.query(
          `INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, job_item_name, requested_cents, approved_cents, lender_comments, inspector_comments, inspection_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
           ON CONFLICT (sitewire_request_id) DO UPDATE SET requested_cents=EXCLUDED.requested_cents, approved_cents=EXCLUDED.approved_cents, lender_comments=EXCLUDED.lender_comments, inspector_comments=EXCLUDED.inspector_comments, updated_at=now()`,
          [d.id, r.id, (r.job_item && r.job_item.id) || null, (r.job_item && r.job_item.name) || null,
           r.requested_cents || 0, r.approved_cents == null ? null : r.approved_cents, r.lender_comments || null, r.inspector_comments || null,
           Array.isArray(r.inspections) ? r.inspections.length : 0]);
      } catch (rowErr) {
        console.warn(`[sitewire] reconcile: skipped a bad request row (draw ${d.id}, request ${r && r.id}): ${db.describeError ? db.describeError(rowErr) : rowErr.message}`);
      }
    }
    n++;
   } catch (drawErr) {
     const emsg = db.describeError ? db.describeError(drawErr) : (drawErr && drawErr.message) || String(drawErr);
     console.warn(`[sitewire] reconcile: skipped a bad draw row (draw ${d && d.id}): ${emsg}`);
     try { await require('./orchestrator').park({ appId, dedupe: `drawrow:${d && d.id}`, reason: `sitewire_reconcile_draw_error: could not mirror Sitewire draw ${d && d.id} — ${String(emsg).slice(0, 200)}. It won't appear on the desk until reconciled by hand.` }); } catch (_) {}
   }
  }
  await db.query(`UPDATE sitewire_property_links SET last_reconciled_at=now() WHERE application_id=$1`, [appId]);
  // refresh the advisory draw-risk snapshot (best-effort — never fail the reconcile on it)
  try { await assessAndStoreRisk(appId); } catch (_) {}
  return { draws: n };
}

// ---- admin-tunable risk / reallocation thresholds ----
async function settingsMap() {
  const rows = (await db.query(`SELECT key, value FROM sitewire_settings`)).rows;
  const m = {}; for (const r of rows) m[r.key] = r.value; return m;
}

/**
 * Refresh the advisory red-flag snapshot for a file's active draws (research doc §15).
 * Assess each non-historical draw against the unified rollup (already-drawn EXCLUDES the
 * pending draw, since drawn counts only APPROVED draws) and store level+flags. Advisory
 * only — this never moves or blocks money.
 */
async function assessAndStoreRisk(appId) {
  const links = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, name, budgeted_cents, is_media_item, unit_index, state
       FROM sitewire_job_item_links WHERE application_id=$1`, [appId])).rows;
  const rollup = await rollupMod.loadRollup(db, appId);
  // CLAUDE.md rule 5: an UNKNOWN inbound draw line (a Sitewire job item with no crosswalk row)
  // must PARK a review row — never just an advisory flag that vanishes when the draw is approved.
  if (rollup.unknown && rollup.unknown.length) {
    try {
      await require('./orchestrator').park({
        appId, dedupe: rollup.unknown.slice().sort((a, b) => a - b).join('-'),
        reason: `sitewire_unknown_draw_line: Sitewire draw line id(s) ${rollup.unknown.join(', ')} have no Scope-of-Work match — reconcile by hand, never auto-applied`,
        current: rollup.unknown.join(','),
      });
    } catch (_) {}
  }
  const s = await settingsMap();
  const opts = { frontLoadPct: Number(s.front_load_pct) || 40, firstDrawMaxPct: Number(s.first_draw_max_pct) || 30 };
  const draws = (await db.query(
    `SELECT sitewire_draw_id, number, status, total_requested_cents, total_approved_cents, historical FROM sitewire_draws WHERE application_id=$1`, [appId])).rows;
  let assessed = 0;
  for (const d of draws) {
    // Only assess OPEN draws. An approved/funded draw's approved_cents is already inside
    // rollup.drawn, so assessing it against `remaining` would double-count and mislabel a
    // perfectly legitimate funded draw as high-risk (pre-merge audit #1). Approved draws get
    // their advisory snapshot CLEARED so a stale pending-era flag never lingers post-approval.
    if (d.historical || d.status === 'approved') {
      await db.query(`UPDATE sitewire_draws SET risk_level=NULL, risk_flags=NULL, risk_assessed_at=now() WHERE sitewire_draw_id=$1`, [d.sitewire_draw_id]);
      continue;
    }
    const reqs = (await db.query(
      `SELECT sitewire_job_item_id, requested_cents, approved_cents, inspection_count FROM sitewire_draw_requests WHERE sitewire_draw_id=$1`, [d.sitewire_draw_id])).rows;
    const a = risk.assessDraw({ draw: d, requests: reqs, links, rollup, opts });
    await db.query(`UPDATE sitewire_draws SET risk_level=$2, risk_flags=$3, risk_assessed_at=now() WHERE sitewire_draw_id=$1`,
      [d.sitewire_draw_id, a.level, JSON.stringify(a.flags)]);
    assessed++;
  }
  return { assessed };
}

// ---- reconcile ALL linked files (the poll pass) ----
async function reconcileAll() {
  const rows = (await db.query(`SELECT application_id FROM sitewire_property_links WHERE sitewire_property_id IS NOT NULL AND matched_by IN ('created','linked')`)).rows;
  let total = 0;
  for (const r of rows) {
    try {
      const res = await reconcileOne(r.application_id);
      total += res.draws || 0;
      // a per-file error is surfaced, never silently swallowed (a stranded mirror must be visible)
      if (res && res.error) console.warn(`[sitewire] reconcile: file ${r.application_id} could not sync: ${res.error}`);
    } catch (err) {
      console.warn(`[sitewire] reconcile: file ${r.application_id} threw: ${db.describeError ? db.describeError(err) : err.message}`);
    }
  }
  return { files: rows.length, draws: total };
}

/**
 * Fetch the full per-line findings of a draw (for delivery to the borrower). Pulls each
 * request's detail so every inspection photo/note + approved/not-approved is included.
 * Returns { lines:[{request_id,job_item_id,name,requested_cents,approved_cents,not_approved_cents,
 *   inspector_comments,lender_comments,photo_count,video_count,media:[…]}], totals }.
 */
async function fetchDrawFindings(sitewireDrawId) {
  const draw = await client.getDraw(sitewireDrawId);
  const lines = [];
  let treq = 0, tappr = 0;
  for (const r of (draw.requests || [])) {
    let detail = r;
    try { detail = await client.getRequest(r.id); } catch (_) {}
    const ins = detail.inspections || [];
    const media = ins.map((i) => ({
      src: (i.media && i.media.src) || null, thumbnail: (i.media && i.media.thumbnail) || null,
      type: (i.media && i.media.media_type) || null, lat: i.latitude, lng: i.longitude, captured_at: i.captured_at, note: i.note,
    })).filter((m) => m.src);
    const req = r.requested_cents || 0; const appr = r.approved_cents == null ? 0 : r.approved_cents;
    treq += req; tappr += appr;
    lines.push({
      request_id: r.id, job_item_id: (r.job_item && r.job_item.id) || (detail.job_item && detail.job_item.id) || null,
      name: (r.job_item && r.job_item.name) || (detail.job_item && detail.job_item.name) || null,
      requested_cents: req, approved_cents: appr, not_approved_cents: Math.max(0, req - appr),
      inspector_comments: detail.inspector_comments || r.inspector_comments || null,
      lender_comments: detail.lender_comments || r.lender_comments || null,
      photo_count: media.filter((m) => m.type === 'image').length, video_count: media.filter((m) => m.type === 'video').length,
      media,
    });
  }
  return { draw_id: sitewireDrawId, status: draw.status, pdf_src: draw.pdf_src || null, lines, totals: { requested_cents: treq, approved_cents: tappr, not_approved_cents: Math.max(0, treq - tappr) } };
}

/**
 * Persist a draw's findings for delivery to the borrower (research doc §14, Workflow B).
 * Pulls the full per-line findings (photos/notes/approved-not-approved) and stores them,
 * mapping each line back through the crosswalk to our SOW line/unit (only-ours). Returns
 * the finding id + a reply_token for one-click email acceptance. Reads Sitewire only.
 */
async function persistDrawFindings(appId, sitewireDrawId, deliveredTo = null) {
  const crypto = require('crypto');
  const detail = await fetchDrawFindings(sitewireDrawId);
  // crosswalk map: job_item_id -> {sow_line_key, unit_index}
  const links = (await db.query(
    `SELECT sitewire_job_item_id, sow_line_key, unit_index FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_job_item_id IS NOT NULL`, [appId])).rows;
  const byJid = new Map(links.map((l) => [Number(l.sitewire_job_item_id), l]));

  const token = crypto.randomBytes(24).toString('hex');
  const finding = (await db.query(
    `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, reply_token, delivered_to, delivered_at, updated_at)
     VALUES ($1,$2,'delivered',$3,$4,$5,$6,now(),now())
     ON CONFLICT (sitewire_draw_id) DO UPDATE SET status='delivered', total_requested_cents=EXCLUDED.total_requested_cents, total_approved_cents=EXCLUDED.total_approved_cents,
       reply_token=COALESCE(draw_findings.reply_token, EXCLUDED.reply_token), delivered_to=EXCLUDED.delivered_to, delivered_at=now(), accepted_at=NULL, accepted_via=NULL, disputed_at=NULL, resolved_at=NULL, updated_at=now()
     RETURNING id, reply_token`,
    [appId, sitewireDrawId, detail.totals.requested_cents, detail.totals.approved_cents, token, deliveredTo ? JSON.stringify(deliveredTo) : null])).rows[0];

  // replace the finding lines (idempotent re-deliver)
  await db.query(`DELETE FROM draw_finding_lines WHERE finding_id=$1`, [finding.id]);
  for (const ln of detail.lines) {
    const x = byJid.get(Number(ln.job_item_id)) || {};
    await db.query(
      `INSERT INTO draw_finding_lines (finding_id, sitewire_request_id, sitewire_job_item_id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments, lender_comments, photo_count, video_count, media, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`,
      [finding.id, ln.request_id || null, ln.job_item_id || null, x.sow_line_key || null, x.unit_index || null,
       ln.name || null, ln.requested_cents || 0, ln.approved_cents || 0, ln.not_approved_cents || 0,
       ln.inspector_comments || null, ln.lender_comments || null, ln.photo_count || 0, ln.video_count || 0,
       ln.media ? JSON.stringify(ln.media) : null]);
  }
  return { finding_id: finding.id, reply_token: finding.reply_token, lines: detail.lines.length, totals: detail.totals, status: detail.status };
}

module.exports = { syncCapitalPartners, syncStaffUsers, reconcileOne, reconcileAll, fetchDrawFindings, deriveTimes, assessAndStoreRisk, persistDrawFindings, settingsMap };
