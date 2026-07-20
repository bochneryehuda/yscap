'use strict';
/**
 * Public (token-authenticated) draw-findings flow — the Accept / Review / Dispute actions the
 * borrower can take straight from the delivery email with NO portal login (research doc §14,
 * Workflow B). The reply_token is a per-finding secret we emailed to the borrower, so it IS the
 * capability. Mounted at /api/public/draw-findings — NO auth middleware (rate-limited upstream).
 *
 * What the token unlocks (all borrower-safe — capital-partner names scrubbed, GPS stripped,
 * lender fee/net never exposed):
 *   GET  /:token                 — the full per-line findings summary for the landing page
 *   GET  /:token/media/:mediaId  — a durable (PILOT-stored) inspection photo/video — never an
 *                                  expiring Sitewire URL, so the gallery keeps working
 *   GET  /:token/report          — the PILOT-branded, borrower-safe inspection PDF
 *   POST /:token/accept          — accept (delivered → accepted), starts the wire SLA
 *   POST /:token/dispute         — push back per line (desired amount + reason) → staff review
 *
 * Never guessed: an unknown/expired token is a plain 404/410; acceptance only ever moves
 * delivered → accepted; a dispute only ever moves delivered → disputed. Photo EVIDENCE on a
 * dispute is a portal-only feature (an unauthenticated file upload is an abuse surface) — the
 * email dispute captures the amount + reason, and the page points the borrower to their portal
 * to attach photos.
 */
const express = require('express');
// safe-router forwards any async-handler rejection to the global JSON error middleware
// (fast generic 500) instead of hanging the request. These are unauthenticated public
// routes — a transient DB error must never leave the borrower's accept link spinning.
const router = require('../lib/safe-router')();
const db = require('../db');
const notify = require('../lib/notify');
const borrowerSafe = require('../lib/borrower-safe');
const storage = require('../lib/storage');
const drawReport = require('../sitewire/draw-report');
const { serveDocument } = require('../lib/serve-document');
const scrub = (s) => (s == null ? null : borrowerSafe.scrubText(String(s)));

const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{48}$/.test(t);
// The one-click capability token is short-lived: a borrower should act within the wire SLA,
// and a leaked link shouldn't stay live forever (audit E-TOKEN-EXPIRY). After the window it
// still works in-portal (authenticated), just not via the unauthenticated email link.
const TOKEN_TTL_DAYS = 30;
const isExpired = (deliveredAt) => { if (!deliveredAt) return false; const t = Date.parse(deliveredAt); return Number.isFinite(t) && (Date.now() - t) > TOKEN_TTL_DAYS * 86400000; };

// Load the finding for a token, or null. Centralizes the token→finding lookup so every route
// applies the same shape check + expiry rule. `allowExpired` lets read-only, already-accepted
// views keep working past the window.
async function findingByToken(token) {
  if (!isToken(token)) return null;
  return (await db.query(`SELECT * FROM draw_findings WHERE reply_token=$1`, [token])).rows[0] || null;
}
async function wireTurnaroundHours() {
  try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); return Number.isFinite(h) && h > 0 ? h : 48; } catch (_) { return 48; }
}

// ---- GET /:token — the full borrower-safe findings summary for the accept/dispute landing page ----
router.get('/:token', async (req, res) => {
  const f = await findingByToken(req.params.token);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (isExpired(f.delivered_at) && f.status !== 'accepted') return res.status(410).json({ error: 'This link has expired — please sign in to your portal to review these results.', expired: true });
  // per-line detail + durable media (joined by the draw line the photo belongs to). We return
  // token-scoped media URLs (never the expiring Sitewire src) so the page gallery keeps working.
  const rawLines = (await db.query(
    `SELECT id, sitewire_request_id, name, requested_cents, approved_cents, not_approved_cents, inspector_comments,
            photo_count, video_count, dispute_status, dispute_desired_cents, dispute_note
       FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows;
  const media = (await db.query(
    `SELECT id, sitewire_request_id, kind FROM draw_media WHERE sitewire_draw_id=$1 AND kind IN ('image','video') ORDER BY id`, [f.sitewire_draw_id])).rows;
  const byReq = new Map();
  for (const m of media) { const k = String(m.sitewire_request_id); if (!byReq.has(k)) byReq.set(k, []); byReq.get(k).push({ id: m.id, kind: m.kind, url: `/api/public/draw-findings/${req.params.token}/media/${m.id}` }); }
  const lines = rawLines.map((l) => ({
    id: l.id,
    name: scrub(l.name),
    requested_cents: l.requested_cents,
    approved_cents: l.approved_cents,
    not_approved_cents: l.not_approved_cents,
    inspector_comments: scrub(l.inspector_comments),
    photo_count: l.photo_count,
    video_count: l.video_count,
    media: byReq.get(String(l.sitewire_request_id)) || [],
    dispute_status: l.dispute_status,
    dispute_desired_cents: l.dispute_desired_cents,
    dispute_note: scrub(l.dispute_note),
  }));
  // report is available once findings are persisted — the page shows a Download button.
  const reportReady = rawLines.length > 0;
  res.json({
    finding: {
      status: f.status, number: null,
      total_requested_cents: f.total_requested_cents, total_approved_cents: f.total_approved_cents,
      wire_due_at: f.wire_due_at, accepted_at: f.accepted_at, disputed_at: f.disputed_at, resolved_at: f.resolved_at,
    },
    lines,
    wire_turnaround_hours: await wireTurnaroundHours(),
    report_ready: reportReady,
  });
});

// ---- GET /:token/media/:mediaId — a durable inspection photo/video (borrower-safe) ----
// Streams PILOT's OWN stored copy (GPS already stripped at archive), never an expiring Sitewire
// URL. Scoped to the finding's draw so a token can only ever see its own draw's media.
router.get('/:token/media/:mediaId', async (req, res) => {
  const f = await findingByToken(req.params.token);
  if (!f) return res.status(404).end();
  if (isExpired(f.delivered_at) && f.status !== 'accepted') return res.status(410).end();
  if (!/^\d{1,18}$/.test(String(req.params.mediaId))) return res.status(404).end();
  const m = (await db.query(
    `SELECT storage_ref, content_type, kind FROM draw_media WHERE id=$1 AND sitewire_draw_id=$2 AND kind IN ('image','video')`,
    [req.params.mediaId, f.sitewire_draw_id])).rows[0];
  if (!m || !m.storage_ref) return res.status(404).end();
  let buf; try { buf = await storage.read(m.storage_ref); } catch (_) { return res.status(404).end(); }
  if (!buf || !buf.length) return res.status(404).end();
  res.setHeader('Content-Type', m.content_type || (m.kind === 'video' ? 'video/mp4' : 'image/jpeg'));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(buf);
});

// ---- GET /:token/report — the PILOT-branded, borrower-safe inspection PDF ----
router.get('/:token/report', async (req, res) => {
  const f = await findingByToken(req.params.token);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (isExpired(f.delivered_at) && f.status !== 'accepted') return res.status(410).json({ error: 'This link has expired — please sign in to your portal.', expired: true });
  try {
    const appId = f.application_id; const drawId = String(f.sitewire_draw_id);
    const meta = await drawReport.loadReportMeta(appId, { sitewireDrawId: drawId, mode: 'borrower' });
    if (!meta || !meta.hasScope || !meta.sections.length) return res.status(404).json({ error: 'Your inspection report isn’t ready yet.' });
    const drawNumber = meta.sections[0] ? meta.sections[0].number : null;
    const filename = drawReport.reportFilename({ scope: 'draw', mode: 'borrower', drawNumber, version: meta.version, loanNo: meta.app.loanNo });
    const borrowerId = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    let doc = (await db.query(`SELECT * FROM documents WHERE application_id=$1 AND doc_kind='draw_inspection_report' AND filename=$2 LIMIT 1`, [appId, filename])).rows[0];
    if (!doc) {
      await drawReport.attachPhotoBytes(meta.sections);
      const bytes = drawReport.buildDrawReport({ app: meta.app, rollup: meta.rollup, sections: meta.sections, scope: 'draw', mode: 'borrower' });
      const docId = await drawReport.storeDrawReport({ appId, borrowerId: borrowerId.borrower_id, filename, bytes, mode: 'borrower' });
      doc = (await db.query(`SELECT * FROM documents WHERE id=$1`, [docId])).rows[0];
    }
    return serveDocument(res, doc, { inline: true });
  } catch (e) { return res.status(500).json({ error: 'Could not build your report right now — please try again shortly.' }); }
});

// ---- POST /:token/accept — accept from the email (delivered → accepted) ----
router.post('/:token/accept', async (req, res) => {
  const f = await findingByToken(req.params.token);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (f.status === 'accepted') return res.json({ ok: true, already: true, wire_due_at: f.wire_due_at });
  if (isExpired(f.delivered_at)) return res.status(410).json({ error: 'This link has expired — please sign in to your portal to accept.', expired: true });
  if (f.status !== 'delivered') return res.status(409).json({ error: 'these results are not awaiting acceptance' });
  const hours = await wireTurnaroundHours();
  const upd = (await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='email', wire_due_at=now() + ($2 || ' hours')::interval, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING wire_due_at`, [f.id, String(hours)])).rows[0];
  if (!upd) return res.status(409).json({ error: 'already handled' });
  await notify.notifyAppStaff(f.application_id, { type: 'draw_accepted', title: 'Borrower accepted a draw (email)', badge: { text: 'Accepted', tone: 'positive' },
    body: `The borrower accepted the inspection results from the email — the release is due by ${new Date(upd.wire_due_at).toLocaleString('en-US')}.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, wire_due_at: upd.wire_due_at });
});

// ---- POST /:token/dispute — push back per line from the email (amount + reason; no login) ----
// Mirrors the authenticated portal dispute, minus photo evidence (an unauthenticated file upload
// is an abuse surface — the borrower attaches photos from their portal). delivered → disputed.
router.post('/:token/dispute', async (req, res) => {
  const f = await findingByToken(req.params.token);
  if (!f) return res.status(404).json({ error: 'not found' });
  if (f.status === 'accepted') return res.status(409).json({ error: 'you already accepted these results' });
  if (f.status === 'resolved') return res.status(409).json({ error: 'these results have already been reviewed and resolved' });
  if (isExpired(f.delivered_at)) return res.status(410).json({ error: 'This link has expired — please sign in to your portal to dispute.', expired: true });
  // cap the number of lines so a giant body can't fan out into thousands of sequential queries
  // on one pooled connection (an unauthenticated DoS). A real draw never has near 200 lines.
  const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).slice(0, 200);
  if (!lines.length) return res.status(400).json({ error: 'a dispute must name at least one line' });
  // Validate + collect the line changes FIRST — no writes yet. Then flip the finding status with a
  // guarded UPDATE, and only touch the lines if that transition actually won (audit MEDIUM): this
  // makes accept-vs-dispute atomic — a concurrent accept flips the finding to 'accepted' and our
  // guarded UPDATE affects 0 rows → 409 with ZERO orphaned line writes on a releasing finding.
  const updates = [];
  for (const ln of lines) {
    if (!/^\d+$/.test(String(ln.line_id))) continue;
    const owned = (await db.query(`SELECT id, requested_cents FROM draw_finding_lines WHERE id=$1 AND finding_id=$2`, [ln.line_id, f.id])).rows[0];
    if (!owned) continue;
    let desired = ln.desired_cents == null ? null : Math.round(Number(ln.desired_cents));
    if (desired != null && (!Number.isFinite(desired) || desired < 0 || desired > Number(owned.requested_cents))) desired = null; // never guess an out-of-range amount
    updates.push({ line_id: ln.line_id, desired, note: ln.note ? String(ln.note).slice(0, 2000) : null });
  }
  if (!updates.length) return res.status(400).json({ error: 'no valid dispute lines' });
  const upd = (await db.query(`UPDATE draw_findings SET status='disputed', disputed_at=now(), disputed_via='email', updated_at=now() WHERE id=$1 AND status='delivered' RETURNING id`, [f.id])).rows[0];
  if (!upd) return res.status(409).json({ error: 'these results are no longer awaiting your response' });
  for (const u of updates) {
    await db.query(`UPDATE draw_finding_lines SET dispute_status='open', dispute_desired_cents=$2, dispute_note=$3, updated_at=now() WHERE id=$1`, [u.line_id, u.desired, u.note]);
  }
  const count = updates.length;
  await notify.notifyAppStaff(f.application_id, { type: 'draw_disputed', title: 'Borrower disputed a draw (email)', badge: { text: 'Disputed', tone: 'action' },
    body: `The borrower pushed back on ${count} item(s) on their draw results from the email. A draw coordinator needs to review — the borrower can add photo evidence from their portal.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, disputed_lines: count });
});

module.exports = router;
