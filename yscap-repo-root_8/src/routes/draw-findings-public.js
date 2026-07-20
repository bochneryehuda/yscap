'use strict';
/**
 * Public (token-authenticated) draw-findings accept — the one-click "Accept" link in the
 * delivery email (research doc §14, Workflow B). The reply_token is a per-finding secret we
 * emailed to the borrower, so it is the capability: no login required to ACCEPT (a positive,
 * borrower-favorable action that only releases their own money). DISPUTES still require login
 * (they carry evidence). Mounted at /api/public/draw-findings — NO auth middleware.
 *
 * Borrower-safe: the read view scrubs any capital-partner name. Nothing is guessed — an
 * unknown/again token is a plain 404; acceptance only ever moves delivered → accepted.
 */
const express = require('express');
// safe-router forwards any async-handler rejection to the global JSON error middleware
// (fast generic 500) instead of hanging the request. These are unauthenticated public
// routes — a transient DB error must never leave the borrower's accept link spinning.
const router = require('../lib/safe-router')();
const db = require('../db');
const notify = require('../lib/notify');
const borrowerSafe = require('../lib/borrower-safe');
const scrub = (s) => (s == null ? null : borrowerSafe.scrubText(String(s)));

const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{48}$/.test(t);
// The one-click capability token is short-lived: a borrower should act within the wire SLA,
// and a leaked link shouldn't stay live forever (audit E-TOKEN-EXPIRY). After the window it
// still works in-portal (authenticated), just not via the unauthenticated email link.
const TOKEN_TTL_DAYS = 30;
const isExpired = (deliveredAt) => { if (!deliveredAt) return false; const t = Date.parse(deliveredAt); return Number.isFinite(t) && (Date.now() - t) > TOKEN_TTL_DAYS * 86400000; };

// ---- GET /:token — a borrower-safe summary for the accept landing page (no login) ----
router.get('/:token', async (req, res) => {
  if (!isToken(req.params.token)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT id, status, total_requested_cents, total_approved_cents, wire_due_at, delivered_at, accepted_at FROM draw_findings WHERE reply_token=$1`, [req.params.token])).rows[0];
  if (!f) return res.status(404).json({ error: 'not found' });
  if (isExpired(f.delivered_at) && f.status !== 'accepted') return res.status(410).json({ error: 'This link has expired — please sign in to your portal to review these results.', expired: true });
  const lines = (await db.query(`SELECT name, requested_cents, approved_cents, not_approved_cents, photo_count, video_count FROM draw_finding_lines WHERE finding_id=$1 ORDER BY id`, [f.id])).rows
    .map((l) => ({ ...l, name: scrub(l.name) }));
  res.json({ finding: { status: f.status, total_requested_cents: f.total_requested_cents, total_approved_cents: f.total_approved_cents, wire_due_at: f.wire_due_at, accepted_at: f.accepted_at }, lines });
});

// ---- POST /:token/accept — accept from the email (delivered → accepted) ----
router.post('/:token/accept', async (req, res) => {
  if (!isToken(req.params.token)) return res.status(404).json({ error: 'not found' });
  const f = (await db.query(`SELECT * FROM draw_findings WHERE reply_token=$1`, [req.params.token])).rows[0];
  if (!f) return res.status(404).json({ error: 'not found' });
  if (f.status === 'accepted') return res.json({ ok: true, already: true, wire_due_at: f.wire_due_at });
  if (isExpired(f.delivered_at)) return res.status(410).json({ error: 'This link has expired — please sign in to your portal to accept.', expired: true });
  if (f.status !== 'delivered') return res.status(409).json({ error: 'these results are not awaiting acceptance' });
  let hours = 48; try { const r = await db.query(`SELECT value FROM sitewire_settings WHERE key='wire_turnaround_hours'`); const h = Number(r.rows[0] && r.rows[0].value); if (Number.isFinite(h) && h > 0) hours = h; } catch (_) {}
  const upd = (await db.query(
    `UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='email', wire_due_at=now() + ($2 || ' hours')::interval, updated_at=now()
      WHERE id=$1 AND status='delivered' RETURNING wire_due_at`, [f.id, String(hours)])).rows[0];
  if (!upd) return res.status(409).json({ error: 'already handled' });
  await notify.notifyAppStaff(f.application_id, { type: 'draw_accepted', title: 'Borrower accepted a draw (email)',
    body: `The borrower accepted the inspection results from the email — the release is due by ${new Date(upd.wire_due_at).toLocaleString('en-US')}.`, applicationId: f.application_id, link: `/internal/app/${f.application_id}` }).catch(() => {});
  res.json({ ok: true, wire_due_at: upd.wire_due_at });
});

module.exports = router;
