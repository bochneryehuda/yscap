'use strict';
/**
 * Borrower-facing draw management (mounted at /api/borrower). The borrower SUBMITS draws and
 * uploads photos in Sitewire's own app; here in PILOT they:
 *   · see each draw's live status + the unified per-line picture (drawn / remaining / %),
 *   · review inspection FINDINGS (photos, notes, approved / not-approved per line) and either
 *     ACCEPT (which starts our wire SLA) or DISPUTE (per-line evidence + the amount they
 *     believe is right) — the accept/dispute happens IN PILOT, never in Sitewire, and
 *   · request a Scope-of-Work change (a budget reallocation), validated by the same rules
 *     the staff desk uses.
 *
 * Every capital-partner name is scrubbed from borrower-facing text (borrower-safe). Ownership
 * is enforced on every read/write. Nothing is guessed — a dispute is queued for a human.
 */
const express = require('express');
// safe-router forwards any async-handler rejection to the global JSON error middleware
// (fast generic 500/503) instead of letting the request hang — Express 4 does not catch
// rejected promises from async handlers. Every borrower draw write must be hang-proof.
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireBorrower } = require('../auth');
const rollupMod = require('../sitewire/rollup');
const { planReallocation } = require('../sitewire/reallocation');
const M = require('../sitewire/mapper');
const notify = require('../lib/notify');
const borrowerSafe = require('../lib/borrower-safe');
const drawReport = require('../sitewire/draw-report');
const { serveDocument } = require('../lib/serve-document');
const storage = require('../lib/storage');
const { decodeUploadBase64, sniffKind } = require('../lib/upload-bytes');
const { stripLocationExif } = require('../lib/image-exif');

// Determine the REAL image type from the bytes' magic number — never trust the client's declared
// content-type (audit H1: a borrower-supplied 'image/svg+xml'/'text/html' served inline is stored
// XSS against the staff who open the evidence). Returns a safe image mime, or null to REJECT
// (svg/html/pdf/zip/unknown all sniff to something we don't allow → dropped, never stored).
function sniffImageMime(buf) {
  const k = sniffKind(buf);
  if (k === 'png') return 'image/png';
  if (k === 'jpg') return 'image/jpeg';
  if (k === 'gif') return 'image/gif';
  if (buf && buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // HEIC: an ISO-BMFF `ftyp` box whose MAJOR BRAND is actually a HEIF still-image brand. sniffKind's
  // plain `ftyp` match also catches MP4/MOV video, so verify the brand here rather than mislabel a
  // video as a HEIC image (audit LOW). A video attached as photo evidence is simply not stored.
  if (buf && buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
      && /^(heic|heix|heif|hevc|hevx|mif1|msf1)/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

// Normalize borrower-uploaded dispute evidence into DURABLE stored copies. We only ever accept
// freshly-uploaded bytes ({filename, dataBase64, contentType}) — never a client-supplied storage
// ref (that would let a borrower point at someone else's file). Each image has its GPS stripped
// (privacy) and is capped in size + count. Returns [{storage_ref, filename, content_type, kind}].
const EVIDENCE_MAX_PER_LINE = 8;
const EVIDENCE_MAX_BYTES = 12 * 1024 * 1024;
async function normalizeDisputeMedia(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const m of items.slice(0, EVIDENCE_MAX_PER_LINE)) {
    if (!m || typeof m !== 'object' || !m.dataBase64) continue;   // only accept real uploads
    let buf;
    try { buf = decodeUploadBase64(m.dataBase64, { maxBytes: EVIDENCE_MAX_BYTES }).buf; } catch (_) { continue; }  // {buf, sha256}; caps size (413)
    if (!buf || !buf.length) continue;
    // Derive the type from the BYTES, not the client. Anything that isn't a real photo (svg/html/pdf/
    // unknown) is rejected here so a malicious "image" can never be stored or served inline (audit H1).
    const ct = sniffImageMime(buf);
    if (!ct) continue;
    try { buf = stripLocationExif(buf, ct) || buf; } catch (_) { /* keep original on any failure */ }
    let saved;
    try { saved = await storage.save(buf, { filename: m.filename || 'evidence' }); } catch (_) { continue; }
    out.push({ storage_ref: saved.ref, storage_provider: saved.provider, filename: String(m.filename || 'evidence').slice(0, 180), content_type: ct, kind: 'image', bytes: buf.length });
  }
  return out;
}

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
const OWN_FILE_SQL = (alias, p) => {
  const a = alias ? alias + '.' : '';
  return `(${a}borrower_id=${p} OR ${a}co_borrower_id=${p}` +
    ` OR ${a}borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p})` +
    ` OR ${a}co_borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p}))`;
};
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
async function ownsApp(req, appId) {
  if (!isUuid(appId)) return false; // malformed id → no ownership (avoid a 22P02 async-rejection hang, audit F1)
  const r = await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND (${OWN_FILE_SQL('a', '$2')})`, [appId, me(req)]);
  return r.rowCount > 0;
}
const scrub = (s) => (s == null ? null : borrowerSafe.scrubText(String(s)));

// ---- GET /draws — every draw across the borrower's files (borrower-safe) ----
router.get('/draws', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT d.sitewire_draw_id, d.application_id, d.number, d.status, d.total_requested_cents, d.total_approved_cents,
              d.submitted_at, d.approved_at, a.property_address->>'oneLine' AS address,
              (SELECT status FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS findings_status,
              (SELECT id FROM draw_findings f WHERE f.sitewire_draw_id=d.sitewire_draw_id) AS finding_id
         FROM sitewire_draws d JOIN applications a ON a.id=d.application_id
        WHERE a.deleted_at IS NULL AND (${OWN_FILE_SQL('a', '$1')})
        ORDER BY d.updated_at DESC NULLS LAST LIMIT 200`, [me(req)])).rows;
    res.json({ draws: rows });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- GET /draws/:appId/rollup — the unified per-line picture (borrower-safe) ----
router.get('/draws/:appId/rollup', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [req.params.appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, req.params.appId, { sowState });
    for (const l of rollup.lines) l.label = scrub(l.label);
    // borrower-safe: loadRollup folds our internal per-draw economics onto each draw (our fee, net
    // release, fee kind, release date, the released flag). NEVER expose the fee or net wired to the
    // borrower — strip them from the response even though the UI doesn't render them (they'd still
    // be visible in the network payload). The borrower keeps requested/approved/status/number.
    if (Array.isArray(rollup.draws)) {
      rollup.draws = rollup.draws.map((d) => {
        const { fee_cents, fee_kind, net_release_cents, released, release_date, ...safe } = d;
        return safe;
      });
    }
    res.json({ rollup });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- GET /draws/:appId/eligibility — can the borrower request another draw right now? (borrower-safe) ----
// A guided, honest read used by the borrower draw screen: how much budget remains, whether the project is
// still open, and what (if anything) is holding up a new draw — plus where to go to submit one (Sitewire).
router.get('/draws/:appId/eligibility', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    let sowState = null;
    try { const s = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0]; sowState = s && s.tool_payload && s.tool_payload.state ? s.tool_payload.state : null; } catch (_) {}
    const rollup = await rollupMod.loadRollup(db, appId, { sowState });
    const proj = (rollup && rollup.project) || {};
    const budget = Number(proj.budget) || 0;
    const remaining = Number.isFinite(Number(proj.remaining)) ? Number(proj.remaining) : Math.max(0, budget - (Number(proj.drawn) || 0));
    // project lifecycle: a finished / paid-off project accepts no new draws (Sitewire is deactivated on close).
    const link = (await db.query(
      `SELECT COALESCE(lifecycle_state,'active') AS lifecycle_state FROM sitewire_property_links WHERE application_id=$1 AND matched_by='created' LIMIT 1`, [appId])).rows[0];
    const lifecycle = (link && link.lifecycle_state) || 'active';
    // an inspection result the borrower still has to act on holds the release clock — surface it as the next step.
    const awaiting = Number((await db.query(
      `SELECT count(*)::int c FROM draw_findings WHERE application_id=$1 AND status='delivered'`, [appId])).rows[0].c) || 0;
    // a draw already moving through Sitewire (submitted, not yet approved) — informational, not a hard block.
    const inFlight = Number((await db.query(
      `SELECT count(*)::int c FROM sitewire_draws WHERE application_id=$1 AND status IN ('pending_borrower','inspecting','pending','pending_capital_partner')`, [appId])).rows[0].c) || 0;

    const blocking = [];
    if (lifecycle !== 'active') blocking.push('Your construction project is complete — no further draws can be requested.');
    if (budget > 0 && remaining <= 0) blocking.push('Your full construction budget has been drawn — there is nothing left to request.');
    const nextSteps = [];
    if (awaiting > 0) nextSteps.push(awaiting === 1 ? 'Review and accept your latest inspection result below — that starts your release.' : `Review your ${awaiting} inspection results below — accepting them starts each release.`);
    if (inFlight > 0) nextSteps.push('You already have a draw moving through inspection — you can track it below.');

    res.json({
      eligible: blocking.length === 0,
      budget_cents: budget, drawn_cents: Number(proj.drawn) || 0, remaining_cents: Math.max(0, remaining),
      pct_complete: Number(proj.pct_complete) || 0,
      lifecycle_state: lifecycle, awaiting_review: awaiting, in_flight: inFlight,
      blocking, next_steps: nextSteps,
      sitewire_portal_url: require('../config').sitewireBaseUrl || 'https://app.sitewire.co',
    });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- GET /draws/:appId/findings — inspection findings delivered for this file ----
router.get('/draws/:appId/findings', async (req, res) => {
  if (!(await ownsApp(req, req.params.appId))) return res.status(403).json({ error: 'forbidden' });
  try {
  const findings = (await db.query(
    `SELECT id, sitewire_draw_id, status, total_requested_cents, total_approved_cents, delivered_at, accepted_at, accepted_via, disputed_at, resolved_at, wire_due_at, reply_token,
            EXISTS (SELECT 1 FROM draw_disbursements dd WHERE dd.sitewire_draw_id=draw_findings.sitewire_draw_id AND dd.kind='draw' AND dd.funded_status='released') AS released
       FROM draw_findings WHERE application_id=$1 ORDER BY delivered_at DESC`, [req.params.appId])).rows;
  const out = [];
  for (const f of findings) {
    // Durable inspector media (PILOT's own stored copies) grouped by the draw line — served via the
    // borrower's OWN reply_token so an <img>/<video> tag works without an auth header, and the
    // thumbnail never breaks when Sitewire's pre-signed link expires. GPS is already stripped at archive.
    const durable = (await db.query(
      `SELECT id, sitewire_request_id, kind FROM draw_media WHERE sitewire_draw_id=$1 AND kind IN ('image','video') ORDER BY id`, [f.sitewire_draw_id])).rows;
    const durByReq = new Map();
    for (const m of durable) { const k = String(m.sitewire_request_id); if (!durByReq.has(k)) durByReq.set(k, []); durByReq.get(k).push({ url: f.reply_token ? `/api/public/draw-findings/${f.reply_token}/media/${m.id}` : null, kind: m.kind }); }
    const lines = (await db.query(
      `SELECT id, sitewire_request_id, sow_line_key, unit_index, name, requested_cents, approved_cents, not_approved_cents, inspector_comments, photo_count, video_count, media, dispute_status, dispute_desired_cents, dispute_note
         FROM draw_finding_lines WHERE finding_id=$1 AND retired_at IS NULL ORDER BY id`, [f.id])).rows
      // scrub every free-text field a capital-partner name could hide in — including each inspection
      // media NOTE (was leaking unscrubbed to the borrower). Keep the photo/video src (inspection
      // evidence) but drop the media GPS lat/lng. lender_comments is a staff-leaning field the borrower
      // never needs — not selected at all above. `photos` = durable copies (preferred by the UI).
      .map((l) => ({
        ...l,
        name: scrub(l.name),
        inspector_comments: scrub(l.inspector_comments),
        photos: (durByReq.get(String(l.sitewire_request_id)) || []).filter((p) => p.url),
        media: Array.isArray(l.media) ? l.media.map((m) => { if (!m || typeof m !== 'object') return m; const { lat, lng, ...mm } = m; return { ...mm, note: scrub(mm.note) }; }) : l.media,
      }));
    // don't leak the raw token as a top-level field; the per-line photo URLs already embed it.
    const { reply_token, ...fSafe } = f;
    out.push({ ...fSafe, lines });
  }
  res.json({ findings: out });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

// ---- POST /findings/:findingId/accept — borrower accepts (IN PILOT) → starts the wire SLA ----
router.post('/findings/:findingId/accept', async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await ownsApp(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (f.status === 'accepted') return res.json({ ok: true, already: true, wire_due_at: f.wire_due_at });
  if (f.status !== 'delivered') return res.status(409).json({ error: 'these results are not awaiting your acceptance' });
  const hours = await wireTurnaroundHours();
  const upd = (await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='portal', wire_due_at=now() + ($2 || ' hours')::interval, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING wire_due_at`, [f.id, String(hours)])).rows[0];
  if (!upd) return res.status(409).json({ error: 'already handled' });
  await notify.notifyAppStaff(f.application_id, { type: 'draw_accepted', title: 'Borrower accepted a draw', badge: { text: 'Accepted', tone: 'positive' },
    body: `The borrower accepted the inspection results — the release is due by ${new Date(upd.wire_due_at).toLocaleString('en-US')}.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, wire_due_at: upd.wire_due_at });
});

// ---- POST /findings/:findingId/dispute — borrower disputes per line (evidence + desired amount) ----
router.post('/findings/:findingId/dispute', async (req, res) => {
  if (!/^\d+$/.test(req.params.findingId)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE id=$1`, [req.params.findingId])).rows[0];
  if (!f || !(await ownsApp(req, f.application_id))) return res.status(403).json({ error: 'forbidden' });
  if (f.status === 'accepted') return res.status(409).json({ error: 'you already accepted these results' });
  if (f.status === 'resolved') return res.status(409).json({ error: 'these results have already been reviewed and resolved' }); // audit F4 — resolved is terminal
  // cap the number of lines so a giant body can't fan out into hundreds of thousands of sequential
  // queries on one pooled connection (authenticated DoS). A real draw never has anywhere near 200 lines.
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).slice(0, 200);
  if (!lines.length) return res.status(400).json({ error: 'a dispute must name at least one line' });
  // Validate + store any photo evidence FIRST (into durable storage), collecting the line changes,
  // then flip the finding status with a guarded UPDATE and only write the lines if that transition
  // won (audit MEDIUM): a concurrent accept flips the finding to 'accepted', our guarded UPDATE
  // affects 0 rows → 409, and no dispute lines are orphaned on a releasing finding. (Evidence bytes
  // stored before a lost race are just unused blobs — harmless.)
  const updates = [];
  for (const ln of lines) {
    if (!/^\d+$/.test(String(ln.line_id))) continue;
    const owned = (await db.query(`SELECT id, requested_cents FROM draw_finding_lines WHERE id=$1 AND finding_id=$2 AND retired_at IS NULL`, [ln.line_id, f.id])).rows[0];
    if (!owned) continue;
    let desired = ln.desired_cents == null ? null : Math.round(Number(ln.desired_cents));
    if (desired != null && (!Number.isFinite(desired) || desired < 0 || desired > Number(owned.requested_cents))) desired = null; // never guess an out-of-range amount
    const evidence = await normalizeDisputeMedia(ln.media);   // durable stored copies, GPS-stripped
    updates.push({ line_id: ln.line_id, desired, note: ln.note ? String(ln.note).slice(0, 2000) : null, evidence });
  }
  if (!updates.length) return res.status(400).json({ error: 'no valid dispute lines' });
  const flipped = (await db.query(`UPDATE draw_findings SET status='disputed', disputed_at=now(), disputed_via='portal', updated_at=now() WHERE id=$1 AND status='delivered' RETURNING id`, [f.id])).rows[0];
  if (!flipped) return res.status(409).json({ error: 'these results are no longer awaiting your response' });
  for (const u of updates) {
    await db.query(
      `UPDATE draw_finding_lines SET dispute_status='open', dispute_desired_cents=$2, dispute_note=$3, dispute_media=$4, updated_at=now() WHERE id=$1`,
      [u.line_id, u.desired, u.note, u.evidence.length ? JSON.stringify(u.evidence) : null]);
  }
  const count = updates.length;
  await notify.notifyAppStaff(f.application_id, { type: 'draw_disputed', title: 'Borrower disputed a draw', badge: { text: 'Disputed', tone: 'action' },
    body: `The borrower disputed ${count} item(s) on their draw results and provided evidence. A draw coordinator needs to review.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, disputed_lines: count });
});

// ---- GET /draws/:appId/report — the borrower's OWN branded inspection report (PDF, always borrower-safe) ----
// mode is HARD-FORCED to 'borrower' (a borrower can never obtain the staff copy). ?drawId=N → that draw;
// omitted → the whole-project report. Idempotent + cached by the same version-hashed filename as the staff
// route; the stored copy is visibility='borrower'. own-file only + per-draw IDOR.
router.get('/draws/:appId/report', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const drawId = /^\d{1,18}$/.test(String(req.query.drawId || '')) ? req.query.drawId : null; // 1..18 digits stays in bigint range (a 19+-digit id would 22003 the ownership query as a 500, not a clean 404)
  if (drawId) {
    const own = await db.query(`SELECT 1 FROM sitewire_draws WHERE sitewire_draw_id=$1 AND application_id=$2`, [drawId, appId]);
    if (!own.rowCount) return res.status(404).json({ error: 'That draw was not found on your file.' });
  }
  try {
    const meta = await drawReport.loadReportMeta(appId, { sitewireDrawId: drawId, mode: 'borrower' });
    if (!meta || !meta.hasScope || !meta.sections.length) return res.status(404).json({ error: 'Your inspection report isn’t ready yet — it appears once your draw results are in.' });
    const scope = drawId ? 'draw' : 'project';
    const drawNumber = drawId && meta.sections[0] ? meta.sections[0].number : null;
    const filename = drawReport.reportFilename({ scope, mode: 'borrower', drawNumber, version: meta.version, loanNo: meta.app.loanNo });
    const borrowerId = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    let doc = (await db.query(
      `SELECT * FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' AND filename=$2 LIMIT 1`, [appId, filename])).rows[0];
    if (!doc) {
      await drawReport.attachPhotoBytes(meta.sections);
      const bytes = drawReport.buildDrawReport({ app: meta.app, rollup: meta.rollup, sections: meta.sections, scope, mode: 'borrower' });
      const docId = await drawReport.storeDrawReport({ appId, borrowerId: borrowerId.borrower_id, filename, bytes, mode: 'borrower' });
      doc = (await db.query(`SELECT * FROM documents WHERE id=$1`, [docId])).rows[0];
    }
    return serveDocument(res, doc, { inline: true });
  } catch (e) { res.status(500).json({ error: 'Could not build your report right now — please try again shortly.' }); }
});

// ---- POST /draws/:appId/change-request — borrower proposes a Scope-of-Work change ----
router.post('/draws/:appId/change-request', async (req, res) => {
  const appId = req.params.appId;
  if (!(await ownsApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const proposedPayload = req.body.proposed_payload;
  if (!proposedPayload || !proposedPayload.state) return res.status(400).json({ error: 'A proposed Scope of Work is required.' });
  try {
    const a = (await db.query(`SELECT status FROM applications WHERE id=$1`, [appId])).rows[0];
    const rollup = await rollupMod.loadRollup(db, appId);
    // Reconcile the proposed explosion to the frozen budget (same target the crosswalk was reconciled
    // to at birth) so a ≤$1 rounding drift can't make a genuine net-zero move read as non-net-zero.
    const rawEx = M.explodeSow(proposedPayload.state, {});
    const budgetCents = Number(rollup && rollup.project && rollup.project.budget) || 0;
    const ex = budgetCents > 0 ? M.reconcileToBudget(rawEx, budgetCents) : rawEx;
    const cells = rollupMod.buildReallocationCells(rollup, ex.items); // per-unit on multi-unit lines (audit F3)
    const phase = String(a && a.status) === 'funded' ? 'after_ctc' : 'before_ctc';
    let vpct = 10; try { const v = (await db.query(`SELECT value FROM sitewire_settings WHERE key='variance_pct'`)).rows[0]; vpct = Number(v && v.value) || 10; } catch (_) {}
    const plan = planReallocation(cells, { phase, variancePct: vpct });
    const cr = (await db.query(
      `INSERT INTO change_requests (application_id, field, field_label, old_value, new_value, reason, status, requested_by_kind, requested_by_id)
       VALUES ($1,'sow_reallocation','Scope of Work reallocation',$2,$3,$4,'pending','borrower',$5) RETURNING id`,
      [appId, JSON.stringify(cells.map((c) => ({ key: c.key, label: c.label, cents: c.budget_cents }))), JSON.stringify(cells.map((c) => ({ key: c.key, label: c.label, cents: c.new_cents }))), req.body.reason ? String(req.body.reason).slice(0, 2000) : null, me(req)])).rows[0];
    await db.query(
      `INSERT INTO sow_change_request_details (change_request_id, application_id, proposed_payload, deltas, net_zero, after_ctc, needs_capital_partner, capital_partner_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cr.id, appId, JSON.stringify(proposedPayload), JSON.stringify(plan.cells), plan.totals.net_zero, phase === 'after_ctc', plan.needs_capital_partner, plan.needs_capital_partner ? 'pending' : null]);
    await notify.notifyAppStaff(appId, { type: 'sow_change_request', title: 'Borrower requested a budget change', badge: { text: 'Review needed', tone: 'gold' },
      body: 'The borrower proposed a Scope-of-Work change. Review it on the file before it flows to draws.', applicationId: appId, link: `/internal/app/${appId}` }).catch(() => {});
    // borrower-safe: never echo capital-partner review status detail back to the borrower
    res.json({ ok: true, submitted: true, net_zero: plan.totals.net_zero });
  } catch (e) { res.status(500).json({ error: 'Something went wrong — please try again.' }); }
});

async function wireTurnaroundHours() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); return Number.isFinite(h) && h > 0 ? h : 48; } catch (_) { return 48; }
}

module.exports = router;
