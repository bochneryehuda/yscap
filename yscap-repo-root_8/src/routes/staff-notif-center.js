/**
 * Loan-officer NOTIFICATION CENTER — the master routes behind the settings +
 * draft queue screen. Mounted under /api/staff via
 *   router.use(require('./staff-notif-center'))
 * at the bottom of staff.js.
 *
 * All routes below are namespaced under /notification-center/*, so the full
 * path is /api/staff/notification-center/...
 *
 * Catalog:
 *   GET  /catalog                       — every notification + its metadata
 *   GET  /prefs                         — my saved catalog-level overrides
 *   PUT  /prefs/:key                    — set one row
 *   POST /prefs/bulk                    — set many at once
 *
 * Drafts:
 *   GET  /drafts?status=...&filter=...  — my drafts (list)
 *   GET  /drafts/count                  — pending count (nav badge)
 *   GET  /drafts/:id/preview            — the FULL rendered email HTML
 *   POST /drafts/:id/send               — send now (with optional edits)
 *   POST /drafts/:id/discard            — discard
 *   POST /drafts/:id/schedule           — schedule to send later
 *   POST /drafts/:id/snooze             — hide until later
 *   POST /drafts/bulk                   — bulk send / discard / snooze / schedule
 *
 * Rules (quiet hours, workdays, learning mode, auto-send SLA, compose default):
 *   GET  /rules
 *   PUT  /rules
 *
 * Per-file overrides (for the assigned LO — VIP mode / silence-all / per-key):
 *   GET  /overrides?applicationId=...
 *   PUT  /overrides                     — upsert one (staff, application, key, enabled, mode)
 *   DELETE /overrides                   — clear one (falls back to LO defaults)
 *
 * Compose (LO writes their own notification off-schedule):
 *   POST /compose                       — send or draft an ad-hoc message
 *
 * Analytics (last-30-days: fired, sent, drafted, discarded, dropped, opened):
 *   GET  /analytics
 */
'use strict';
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const catalog = require('../lib/notification-catalog');
const notify = require('../lib/notify');
const gate = require('../lib/lo-notification-gate');
const selfGate = require('../lib/lo-self-gate');

// Lightweight presence probe — any hit on the notification-center stamps the
// LO's staff_users.last_active_at so the "presence-aware" self-gate rule
// (skip live email if they were just in the portal) has fresh data. Throttled
// per-process to at most once per staffer per 60s to keep write cost near zero.
const _presenceStampAt = new Map();
router.use('/notification-center', (req, _res, next) => {
  const id = req.actor && req.actor.id;
  if (!id) return next();
  const now = Date.now();
  const last = _presenceStampAt.get(id) || 0;
  if (now - last < 60_000) return next();
  _presenceStampAt.set(id, now);
  // Cap the memory the throttle map holds.
  if (_presenceStampAt.size > 500) {
    const first = _presenceStampAt.keys().next().value;
    if (first !== undefined) _presenceStampAt.delete(first);
  }
  db.query(`UPDATE staff_users SET last_active_at=now() WHERE id=$1`, [id]).catch(() => {});
  next();
});

// ─── CATALOG + PREFS ────────────────────────────────────────────────────────

router.get('/notification-center/catalog', async (req, res) => {
  res.json({
    categories: catalog.CATEGORIES,
    items: catalog.CATALOG.map((e) => ({
      key: e.key, label: e.label, description: e.description,
      category: e.category, audience: e.audience, forced: !!e.forced,
      defaultMode: e.default_mode, defaultEnabled: true,
    })),
  });
});

router.get('/notification-center/prefs', async (req, res) => {
  const r = await db.query(
    `SELECT notif_key, enabled, mode, updated_at FROM lo_notification_prefs WHERE staff_id=$1`,
    [req.actor.id]);
  res.json({ prefs: r.rows });
});

function _validKey(k) { return catalog.entryForKey(k) != null; }

router.put('/notification-center/prefs/:key', async (req, res) => {
  const key = String(req.params.key || '');
  if (!_validKey(key)) return res.status(400).json({ error: 'Unknown notification key.' });
  const entry = catalog.entryForKey(key);
  if (entry.forced) return res.status(400).json({ error: 'This notification is required and can’t be turned off or delayed.' });
  const enabled = req.body.enabled !== false;
  const mode = req.body.mode === 'manual' ? 'manual' : 'automatic';
  await db.query(
    `INSERT INTO lo_notification_prefs (staff_id, notif_key, enabled, mode, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$1, now())
     ON CONFLICT (staff_id, notif_key)
     DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode,
                   updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [req.actor.id, key, enabled, mode]);
  res.json({ ok: true, key, enabled, mode });
});

router.post('/notification-center/prefs/bulk', async (req, res) => {
  const changes = Array.isArray(req.body && req.body.changes) ? req.body.changes : [];
  if (!changes.length) return res.json({ ok: true, applied: 0 });
  let applied = 0;
  for (const c of changes) {
    const key = String(c && c.key || '');
    if (!_validKey(key)) continue;
    const entry = catalog.entryForKey(key);
    if (entry.forced) continue;
    const enabled = c.enabled !== false;
    const mode = c.mode === 'manual' ? 'manual' : 'automatic';
    await db.query(
      `INSERT INTO lo_notification_prefs (staff_id, notif_key, enabled, mode, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$1, now())
       ON CONFLICT (staff_id, notif_key)
       DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.actor.id, key, enabled, mode]);
    applied += 1;
  }
  res.json({ ok: true, applied });
});

// ─── RULES (quiet hours, workdays, learning mode, auto-send, compose) ──────

router.get('/notification-center/rules', async (req, res) => {
  const r = await db.query(
    `SELECT timezone, quiet_hours_start, quiet_hours_end, work_days_mask,
            learning_mode_until, auto_send_after_hours, compose_default,
            undo_window_seconds
       FROM lo_notification_rules WHERE staff_id=$1`, [req.actor.id]);
  res.json({ rules: r.rows[0] || {
    timezone: 'America/New_York', quiet_hours_start: null, quiet_hours_end: null,
    work_days_mask: 127, learning_mode_until: null, auto_send_after_hours: 48,
    compose_default: 'send', undo_window_seconds: 8,
  } });
});

function _isValidHHMM(s) {
  if (s == null || s === '') return true;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
}

router.put('/notification-center/rules', async (req, res) => {
  const b = req.body || {};
  if (!_isValidHHMM(b.quiet_hours_start)) return res.status(400).json({ error: 'quiet_hours_start must be HH:MM' });
  if (!_isValidHHMM(b.quiet_hours_end))   return res.status(400).json({ error: 'quiet_hours_end must be HH:MM' });
  const tz = typeof b.timezone === 'string' && b.timezone ? b.timezone : 'America/New_York';
  const mask = Math.max(0, Math.min(127, parseInt(b.work_days_mask, 10) || 127));
  // 0 = "off" (drafts wait forever) — must survive the parseInt fallback,
  // otherwise the UI's "Set to 0 to turn off" is a lie and safety-send keeps
  // firing at the default 48h.
  let auto;
  if (b.auto_send_after_hours == null) auto = null;
  else {
    const raw = parseInt(b.auto_send_after_hours, 10);
    if (!Number.isFinite(raw) || raw < 0) auto = 48;         // garbage → sensible default
    else if (raw === 0) auto = null;                          // 0 = off
    else auto = Math.min(24 * 30, raw);
  }
  const undo = Math.max(0, Math.min(60, parseInt(b.undo_window_seconds, 10) || 8));
  const composeDefault = b.compose_default === 'draft' ? 'draft' : 'send';
  let learnUntil = null;
  if (b.learning_mode_hours != null) {
    // The UI passes a number of hours; convert to a timestamp.
    const h = Math.max(0, Math.min(24 * 30, parseInt(b.learning_mode_hours, 10) || 0));
    if (h > 0) learnUntil = new Date(Date.now() + h * 3600 * 1000);
  } else if (b.learning_mode_until) {
    learnUntil = new Date(b.learning_mode_until);
    if (Number.isNaN(learnUntil.getTime())) return res.status(400).json({ error: 'learning_mode_until must be a valid timestamp' });
  }
  await db.query(
    `INSERT INTO lo_notification_rules (staff_id, timezone, quiet_hours_start, quiet_hours_end,
                                         work_days_mask, learning_mode_until,
                                         auto_send_after_hours, compose_default, undo_window_seconds, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (staff_id) DO UPDATE SET
       timezone=EXCLUDED.timezone,
       quiet_hours_start=EXCLUDED.quiet_hours_start,
       quiet_hours_end=EXCLUDED.quiet_hours_end,
       work_days_mask=EXCLUDED.work_days_mask,
       learning_mode_until=EXCLUDED.learning_mode_until,
       auto_send_after_hours=EXCLUDED.auto_send_after_hours,
       compose_default=EXCLUDED.compose_default,
       undo_window_seconds=EXCLUDED.undo_window_seconds,
       updated_at=now()`,
    [req.actor.id, tz, b.quiet_hours_start || null, b.quiet_hours_end || null,
     mask, learnUntil, auto, composeDefault, undo]);
  gate.invalidateRules(req.actor.id);
  res.json({ ok: true });
});

// ─── PER-FILE OVERRIDES ─────────────────────────────────────────────────────

// Show the effective per-file setup for one file: LO defaults + any overrides.
router.get('/notification-center/overrides', async (req, res) => {
  const appId = req.query.applicationId;
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  const r = await db.query(
    `SELECT notif_key, enabled, mode, note, updated_at
       FROM lo_notification_file_overrides
      WHERE staff_id=$1 AND application_id=$2
      ORDER BY notif_key`, [req.actor.id, appId]);
  res.json({ overrides: r.rows });
});

router.put('/notification-center/overrides', async (req, res) => {
  const b = req.body || {};
  const appId = b.applicationId || b.application_id;
  const key = String(b.key || b.notif_key || '');
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  if (key !== '*' && !_validKey(key)) return res.status(400).json({ error: 'Unknown notification key.' });
  const entry = key === '*' ? null : catalog.entryForKey(key);
  if (entry && entry.forced) return res.status(400).json({ error: 'That notification is required and can’t be overridden.' });
  // Staff must be able to see the file — reuse the LO check: is the LO on it?
  const owned = await db.query(
    `SELECT loan_officer_id FROM applications WHERE id=$1`, [appId]);
  if (!owned.rows[0] || String(owned.rows[0].loan_officer_id) !== String(req.actor.id)) {
    return res.status(403).json({ error: 'Only the file’s assigned loan officer can set overrides on it.' });
  }
  const enabled = b.enabled !== false;
  const mode = b.mode === 'manual' ? 'manual' : 'automatic';
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
  await db.query(
    `INSERT INTO lo_notification_file_overrides (staff_id, application_id, notif_key, enabled, mode, note, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$1, now())
     ON CONFLICT (staff_id, application_id, notif_key)
     DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode, note=EXCLUDED.note,
                   updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [req.actor.id, appId, key, enabled, mode, note]);
  res.json({ ok: true });
});

router.delete('/notification-center/overrides', async (req, res) => {
  const appId = req.query.applicationId || (req.body && req.body.applicationId);
  const key = req.query.key || (req.body && req.body.key);
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  // key='__all__' clears every override on this file in one shot (the "Follow
  // my defaults" preset). Explicit sentinel — never accept a missing key as
  // "delete everything" (that would be a footgun for any typo in the client).
  if (key === '__all__') {
    const r = await db.query(
      `DELETE FROM lo_notification_file_overrides WHERE staff_id=$1 AND application_id=$2`,
      [req.actor.id, appId]);
    return res.json({ ok: true, cleared: r.rowCount || 0 });
  }
  if (!key) return res.status(400).json({ error: 'key required' });
  await db.query(
    `DELETE FROM lo_notification_file_overrides WHERE staff_id=$1 AND application_id=$2 AND notif_key=$3`,
    [req.actor.id, appId, key]);
  res.json({ ok: true });
});

// ─── DRAFTS ─────────────────────────────────────────────────────────────────

router.get('/notification-center/drafts', async (req, res) => {
  const status = ['pending', 'sent', 'discarded'].includes(req.query.status) ? req.query.status : 'pending';
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  const filterKey = req.query.key || null;
  const filterApp = req.query.applicationId || null;
  const filterQ = req.query.q ? `%${String(req.query.q).replace(/[%_]/g, '')}%` : null;
  const p = [req.actor.id, status]; let where = `d.staff_id=$1 AND d.status=$2`;
  if (status === 'pending') where += ` AND (d.snoozed_until IS NULL OR d.snoozed_until <= now())`;
  if (filterKey) { p.push(filterKey); where += ` AND d.notif_key = $${p.length}`; }
  if (filterApp) { p.push(filterApp); where += ` AND d.application_id = $${p.length}`; }
  if (filterQ)   { p.push(filterQ);   where += ` AND (d.subject_preview ILIKE $${p.length} OR d.body_preview ILIKE $${p.length} OR d.recipient_label ILIKE $${p.length})`; }
  p.push(limit);
  const rows = await db.query(
    `SELECT d.id, d.notif_key, d.audience, d.recipient_kind, d.recipient_id, d.recipient_label,
            d.application_id, d.notif_type, d.subject_preview, d.body_preview,
            d.status, d.created_at, d.sent_at, d.discarded_at,
            d.scheduled_for, d.snoozed_until, d.auto_send_at,
            d.priority, d.tags, d.compose_source,
            d.edited_subject, d.edited_body, d.edited_note,
            a.ys_loan_number, a.property_address
       FROM lo_notification_drafts d
       LEFT JOIN applications a ON a.id = d.application_id
      WHERE ${where}
      ORDER BY (d.priority = 'high') DESC, d.created_at DESC
      LIMIT $${p.length}`, p);
  const items = rows.rows.map((r) => {
    const pa = r.property_address || {};
    const addr = pa.oneLine || [pa.street || pa.line1, pa.city, pa.state].filter(Boolean).join(', ') || null;
    return {
      id: r.id, key: r.notif_key, audience: r.audience,
      recipientKind: r.recipient_kind, recipientId: r.recipient_id, recipientLabel: r.recipient_label,
      applicationId: r.application_id, loanNumber: r.ys_loan_number ? String(r.ys_loan_number).toUpperCase() : null,
      address: addr, notifType: r.notif_type,
      subject: r.edited_subject || r.subject_preview,
      body: r.edited_body || r.body_preview,
      status: r.status,
      createdAt: r.created_at, sentAt: r.sent_at, discardedAt: r.discarded_at,
      scheduledFor: r.scheduled_for, snoozedUntil: r.snoozed_until, autoSendAt: r.auto_send_at,
      priority: r.priority, tags: r.tags || [], composeSource: r.compose_source,
      entry: catalog.entryForKey(r.notif_key),
    };
  });
  res.json({ items });
});

router.get('/notification-center/drafts/count', async (req, res) => {
  const r = await db.query(
    `SELECT
        count(*) FILTER (WHERE status='pending' AND (snoozed_until IS NULL OR snoozed_until <= now()))::int AS pending,
        count(*) FILTER (WHERE status='pending' AND priority='high')::int AS high,
        count(*) FILTER (WHERE status='pending' AND snoozed_until > now())::int AS snoozed,
        count(*) FILTER (WHERE status='pending' AND scheduled_for IS NOT NULL AND scheduled_for > now())::int AS scheduled
       FROM lo_notification_drafts WHERE staff_id=$1`, [req.actor.id]);
  const row = r.rows[0] || {};
  res.json({ pending: row.pending || 0, high: row.high || 0, snoozed: row.snoozed || 0, scheduled: row.scheduled || 0 });
});

async function _loadPendingDraft(id, staffId) {
  const r = await db.query(
    `SELECT id, staff_id, notif_key, audience, recipient_kind, recipient_id,
            application_id, notif_type, opts, status,
            edited_subject, edited_body, edited_note
       FROM lo_notification_drafts WHERE id=$1`, [id]);
  const d = r.rows[0];
  if (!d) return null;
  if (String(d.staff_id) !== String(staffId)) return { forbidden: true };
  if (d.status !== 'pending') return { alreadyResolved: d.status };
  return d;
}

// Render the FULL PILOT-branded email for the draft (for the live preview iframe).
router.get('/notification-center/drafts/:id/preview', async (req, res) => {
  const r = await db.query(
    `SELECT staff_id, audience, application_id, notif_type, opts,
            edited_subject, edited_body, edited_note
       FROM lo_notification_drafts WHERE id=$1`, [req.params.id]);
  const d = r.rows[0];
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (String(d.staff_id) !== String(req.actor.id)) return res.status(403).json({ error: 'Not your draft' });
  const opts = { ...(d.opts || {}) };
  if (d.edited_subject) opts.title = d.edited_subject;
  if (d.edited_body) opts.body = d.edited_body;
  if (d.edited_note) opts.note = d.edited_note;
  opts.type = d.notif_type;
  opts.applicationId = d.application_id;
  const msg = notify.buildEmail(opts, d.audience || 'borrower');
  res.json({ subject: msg.subject, html: msg.html, text: msg.text });
});

router.post('/notification-center/drafts/:id/send', async (req, res) => {
  const d = await _loadPendingDraft(req.params.id, req.actor.id);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  if (d.forbidden) return res.status(403).json({ error: 'Not your draft.' });
  if (d.alreadyResolved) return res.status(409).json({ error: `This draft was already ${d.alreadyResolved}.` });
  const edits = (req.body && typeof req.body === 'object') ? req.body : {};
  // Persist edits FIRST so the audit trail records what actually went out.
  if (typeof edits.title === 'string' || typeof edits.body === 'string' || typeof edits.note === 'string') {
    await db.query(
      `UPDATE lo_notification_drafts
          SET edited_subject = COALESCE($2, edited_subject),
              edited_body    = COALESCE($3, edited_body),
              edited_note    = COALESCE($4, edited_note)
        WHERE id=$1`, [d.id,
          typeof edits.title === 'string' ? edits.title.trim() || null : null,
          typeof edits.body === 'string' ? edits.body : null,
          typeof edits.note === 'string' ? edits.note : null]);
  }
  // ATOMIC CLAIM — flip 'pending' → 'sending' in a single UPDATE. Only one
  // caller (this request OR the background worker) can win; the other 409s.
  // This is the same trick the worker's drainScheduledSends uses (db/228).
  const claim = await db.query(
    `UPDATE lo_notification_drafts SET status='sending', claimed_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`, [d.id]);
  if (!claim.rows[0]) return res.status(409).json({ error: 'This draft is already being sent.' });
  const claimed = claim.rows[0];
  const opts = { ...(claimed.opts || {}), _bypassLoGate: true };
  if (typeof edits.title === 'string' && edits.title.trim()) opts.title = edits.title.trim();
  else if (claimed.edited_subject) opts.title = claimed.edited_subject;
  if (typeof edits.body === 'string') opts.body = edits.body;
  else if (claimed.edited_body) opts.body = claimed.edited_body;
  if (typeof edits.note === 'string') opts.note = edits.note;
  else if (claimed.edited_note) opts.note = claimed.edited_note;
  opts.type = claimed.notif_type;
  opts.applicationId = claimed.application_id;

  let sentId = null;
  try {
    if (claimed.recipient_kind === 'borrower' && claimed.recipient_id) {
      sentId = await notify.notifyBorrower(claimed.recipient_id, opts);
    } else if (claimed.recipient_kind === 'staff' && claimed.recipient_id) {
      sentId = await notify.notifyStaff(claimed.recipient_id, opts);
    } else {
      // Revert the claim — bad row.
      await db.query(`UPDATE lo_notification_drafts SET status='pending', claimed_at=NULL WHERE id=$1 AND status='sending'`, [d.id]);
      return res.status(400).json({ error: 'Draft is missing a recipient.' });
    }
  } catch (e) {
    // Revert the claim so the LO / worker can retry.
    await db.query(`UPDATE lo_notification_drafts SET status='pending', claimed_at=NULL WHERE id=$1 AND status='sending'`, [d.id]);
    return res.status(500).json({ error: 'Could not send: ' + (e.message || 'unknown error') });
  }
  await db.query(
    `UPDATE lo_notification_drafts SET status='sent', sent_at=now(), sent_notification_id=$2
      WHERE id=$1 AND status='sending'`, [d.id, sentId || null]);
  res.json({ ok: true, notificationId: sentId });
});

router.post('/notification-center/drafts/:id/discard', async (req, res) => {
  const d = await _loadPendingDraft(req.params.id, req.actor.id);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  if (d.forbidden) return res.status(403).json({ error: 'Not your draft.' });
  if (d.alreadyResolved) return res.status(409).json({ error: `This draft was already ${d.alreadyResolved}.` });
  await db.query(
    `UPDATE lo_notification_drafts SET status='discarded', discarded_at=now(), discarded_by=$2
      WHERE id=$1 AND status='pending'`, [d.id, req.actor.id]);
  res.json({ ok: true });
});

router.post('/notification-center/drafts/:id/schedule', async (req, res) => {
  const d = await _loadPendingDraft(req.params.id, req.actor.id);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  if (d.forbidden) return res.status(403).json({ error: 'Not your draft.' });
  if (d.alreadyResolved) return res.status(409).json({ error: `This draft was already ${d.alreadyResolved}.` });
  const when = new Date(req.body && req.body.at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 30_000) {
    return res.status(400).json({ error: 'Pick a time at least a minute from now.' });
  }
  await db.query(
    `UPDATE lo_notification_drafts SET scheduled_for=$2 WHERE id=$1 AND status='pending'`,
    [d.id, when]);
  res.json({ ok: true, scheduledFor: when.toISOString() });
});

router.post('/notification-center/drafts/:id/snooze', async (req, res) => {
  const d = await _loadPendingDraft(req.params.id, req.actor.id);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  if (d.forbidden) return res.status(403).json({ error: 'Not your draft.' });
  if (d.alreadyResolved) return res.status(409).json({ error: `This draft was already ${d.alreadyResolved}.` });
  const minutes = Math.max(5, Math.min(60 * 24 * 30, parseInt(req.body && req.body.minutes, 10) || 60));
  const until = new Date(Date.now() + minutes * 60_000);
  await db.query(
    `UPDATE lo_notification_drafts SET snoozed_until=$2 WHERE id=$1 AND status='pending'`,
    [d.id, until]);
  res.json({ ok: true, snoozedUntil: until.toISOString() });
});

router.post('/notification-center/drafts/bulk', async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.slice(0, 200) : [];
  const action = String(b.action || '');
  if (!ids.length) return res.json({ ok: true, applied: 0 });
  if (!['send', 'discard', 'snooze', 'schedule'].includes(action)) return res.status(400).json({ error: 'Unknown bulk action.' });
  let applied = 0, failed = 0;
  for (const id of ids) {
    try {
      const d = await _loadPendingDraft(id, req.actor.id);
      if (!d || d.forbidden || d.alreadyResolved) { failed += 1; continue; }
      if (action === 'send') {
        const claim = await db.query(
          `UPDATE lo_notification_drafts SET status='sending', claimed_at=now()
            WHERE id=$1 AND status='pending' RETURNING *`, [d.id]);
        if (!claim.rows[0]) { failed += 1; continue; }
        const c = claim.rows[0];
        const opts = { ...(c.opts || {}), _bypassLoGate: true };
        if (c.edited_subject) opts.title = c.edited_subject;
        if (c.edited_body) opts.body = c.edited_body;
        if (c.edited_note) opts.note = c.edited_note;
        opts.type = c.notif_type;
        opts.applicationId = c.application_id;
        let sentId = null;
        try {
          if (c.recipient_kind === 'borrower' && c.recipient_id) sentId = await notify.notifyBorrower(c.recipient_id, opts);
          else if (c.recipient_kind === 'staff' && c.recipient_id) sentId = await notify.notifyStaff(c.recipient_id, opts);
        } catch (e) {
          await db.query(`UPDATE lo_notification_drafts SET status='pending', claimed_at=NULL WHERE id=$1 AND status='sending'`, [d.id]);
          failed += 1; continue;
        }
        await db.query(
          `UPDATE lo_notification_drafts SET status='sent', sent_at=now(), sent_notification_id=$2 WHERE id=$1 AND status='sending'`,
          [d.id, sentId || null]);
      } else if (action === 'discard') {
        await db.query(
          `UPDATE lo_notification_drafts SET status='discarded', discarded_at=now(), discarded_by=$2 WHERE id=$1 AND status='pending'`,
          [d.id, req.actor.id]);
      } else if (action === 'snooze') {
        const minutes = Math.max(5, Math.min(60 * 24 * 30, parseInt(b.minutes, 10) || 60));
        const until = new Date(Date.now() + minutes * 60_000);
        await db.query(
          `UPDATE lo_notification_drafts SET snoozed_until=$2 WHERE id=$1 AND status='pending'`,
          [d.id, until]);
      } else if (action === 'schedule') {
        const when = new Date(b.at);
        // Mirror the single /schedule route: no past-times, no NaN dates.
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 30_000) { failed += 1; continue; }
        await db.query(
          `UPDATE lo_notification_drafts SET scheduled_for=$2 WHERE id=$1 AND status='pending'`,
          [d.id, when]);
      }
      applied += 1;
    } catch (_) { failed += 1; }
  }
  res.json({ ok: true, applied, failed });
});

// ─── COMPOSE — LO writes an ad-hoc notification and picks a recipient ───────

router.post('/notification-center/compose', async (req, res) => {
  const b = req.body || {};
  const appId = b.applicationId;
  const recipientKind = b.recipientKind === 'staff' ? 'staff' : 'borrower';
  const recipientId = b.recipientId;
  const subject = String(b.subject || '').trim();
  const body = String(b.body || '').trim();
  const key = b.key && _validKey(b.key) ? b.key : 'message';
  const mode = b.mode === 'draft' ? 'draft' : (b.mode === 'send' ? 'send' : null);
  if (!appId || !recipientId) return res.status(400).json({ error: 'applicationId and recipientId are required.' });
  if (!subject || !body) return res.status(400).json({ error: 'A subject and message are required.' });
  // Verify the LO owns the file.
  const owned = await db.query(
    `SELECT loan_officer_id, borrower_id, co_borrower_id FROM applications WHERE id=$1`, [appId]);
  if (!owned.rows[0] || String(owned.rows[0].loan_officer_id) !== String(req.actor.id)) {
    return res.status(403).json({ error: 'Only the file’s assigned loan officer can compose on it.' });
  }
  // IDOR guard: `recipientId` must actually belong to this file. Without this,
  // any LO could POST an arbitrary borrower/staff UUID and PILOT would fire
  // a branded email + in-app row to that stranger with the file context on it.
  const app = owned.rows[0];
  if (recipientKind === 'borrower') {
    const validBorrower = [app.borrower_id, app.co_borrower_id].filter(Boolean).map(String);
    if (!validBorrower.includes(String(recipientId))) {
      return res.status(403).json({ error: 'That recipient is not on this file.' });
    }
  } else {
    const chk = await db.query(
      `SELECT 1 FROM application_assignees
        WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL LIMIT 1`,
      [appId, recipientId]);
    if (!chk.rows[0]) {
      return res.status(403).json({ error: 'That team member is not assigned to this file.' });
    }
  }
  // Which default? The LO can override on the request; else read their rules.
  let effectiveMode = mode;
  if (!effectiveMode) {
    const r = await db.query(`SELECT compose_default FROM lo_notification_rules WHERE staff_id=$1`, [req.actor.id]);
    effectiveMode = (r.rows[0] && r.rows[0].compose_default) === 'draft' ? 'draft' : 'send';
  }
  const opts = {
    type: 'message', title: subject, body,
    applicationId: appId,
    // Compose always bypasses the LO gate for its OWN traffic (the LO wrote it —
    // it shouldn't be silenced by an unrelated pref).
    _bypassLoGate: true,
    kicker: 'From your loan officer',
    notifKey: key,
  };
  if (effectiveMode === 'draft') {
    // Park it as a draft the LO can double-check + send from Drafts.
    let label = null;
    if (recipientKind === 'borrower') {
      try {
        const rr = await db.query(`SELECT first_name, last_name, email FROM borrowers WHERE id=$1`, [recipientId]);
        const bb = rr.rows[0]; if (bb) label = [bb.first_name, bb.last_name].filter(Boolean).join(' ') || bb.email || null;
      } catch (_) { /* label optional */ }
    }
    await gate.recordDraft({ officerId: req.actor.id, key, audience: recipientKind,
      recipientKind, recipientId, applicationId: appId, type: 'message',
      opts, recipientLabel: label, composeSource: 'compose' });
    return res.json({ ok: true, mode: 'draft' });
  }
  let sentId = null;
  if (recipientKind === 'borrower') sentId = await notify.notifyBorrower(recipientId, opts);
  else sentId = await notify.notifyStaff(recipientId, opts);
  res.json({ ok: true, mode: 'send', notificationId: sentId });
});

// ─── ANALYTICS — last 30 days per notification key ──────────────────────────

router.get('/notification-center/analytics', async (req, res) => {
  const staffId = req.actor.id;
  const days = Math.max(7, Math.min(90, parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * 86400 * 1000);
  // Drafts: fired-through-the-gate counts (drafted vs sent vs discarded vs still-pending) per key.
  const drafts = await db.query(
    `SELECT notif_key,
            count(*) FILTER (WHERE status='pending')::int   AS pending,
            count(*) FILTER (WHERE status='sent')::int      AS sent_from_draft,
            count(*) FILTER (WHERE status='discarded')::int AS discarded
       FROM lo_notification_drafts
      WHERE staff_id=$1 AND created_at >= $2
      GROUP BY notif_key`, [staffId, since]);
  // Actual sends: the notifications table (in-app rows). We can't filter these by "on
  // MY files" cheaply from notifications alone — LEFT JOIN applications and match
  // the LO. Includes email delivery + open counts.
  let sends;
  let partial = false;
  try {
    sends = await db.query(
      `SELECT n.type AS notif_type,
              count(*)::int AS fired,
              count(*) FILTER (WHERE n.email_status='sent')::int AS emailed,
              count(*) FILTER (WHERE n.email_status='error')::int AS email_failed,
              count(*) FILTER (WHERE n.emailed_at IS NOT NULL AND EXISTS
                (SELECT 1 FROM email_opens eo WHERE eo.notification_id=n.id)
              )::int AS opened
         FROM notifications n
         JOIN applications a ON a.id = n.application_id
        WHERE a.loan_officer_id=$1 AND n.created_at >= $2 AND n.application_id IS NOT NULL
        GROUP BY n.type`, [staffId, since]);
  } catch (e) {
    console.warn('[notif-analytics] send query failed:', e && e.message);
    sends = { rows: [] };
    partial = true;
  }
  // Roll up to catalog keys.
  const byKey = {};
  for (const e of catalog.CATALOG) {
    byKey[e.key] = { key: e.key, label: e.label, category: e.category, forced: !!e.forced,
      fired: 0, emailed: 0, emailFailed: 0, opened: 0,
      pending: 0, sentFromDraft: 0, discarded: 0 };
  }
  for (const r of sends.rows) {
    const k = catalog.keyForType(r.notif_type, {});
    if (!byKey[k]) continue;
    byKey[k].fired += r.fired || 0;
    byKey[k].emailed += r.emailed || 0;
    byKey[k].emailFailed += r.email_failed || 0;
    byKey[k].opened += r.opened || 0;
  }
  for (const r of drafts.rows) {
    if (!byKey[r.notif_key]) continue;
    byKey[r.notif_key].pending += r.pending || 0;
    byKey[r.notif_key].sentFromDraft += r.sent_from_draft || 0;
    byKey[r.notif_key].discarded += r.discarded || 0;
  }
  // Overall totals + top movers.
  const totals = Object.values(byKey).reduce((a, r) => ({
    fired: a.fired + r.fired, emailed: a.emailed + r.emailed,
    emailFailed: a.emailFailed + r.emailFailed, opened: a.opened + r.opened,
    pending: a.pending + r.pending, sentFromDraft: a.sentFromDraft + r.sentFromDraft,
    discarded: a.discarded + r.discarded,
  }), { fired: 0, emailed: 0, emailFailed: 0, opened: 0, pending: 0, sentFromDraft: 0, discarded: 0 });
  res.json({ days, since: since.toISOString(), byKey: Object.values(byKey), totals, partial });
});

// ─── FOR ME — the LO's own inbox controls ──────────────────────────────────
// Companion to the borrower-facing preferences above. These endpoints govern
// what the LO THEMSELVES receives (channel + frequency per notification, plus
// delivery rules like batching, vacation, quiet hours, weekend hold, presence-
// aware, and per-file mute/star). See src/lib/lo-self-gate.js.

const CHANNELS = new Set(['both', 'email', 'inapp', 'off']);
const FREQS = new Set(['instant', 'hourly', 'daily', 'weekly']);
const MASTER = new Set(['instant', 'batched', 'digest_only', 'off']);

router.get('/notification-center/self-prefs', async (req, res) => {
  const r = await db.query(
    `SELECT notif_key, channel, frequency, updated_at
       FROM lo_self_notification_prefs WHERE staff_id=$1`,
    [req.actor.id]);
  res.json({ prefs: r.rows });
});

router.put('/notification-center/self-prefs/:key', async (req, res) => {
  const key = String(req.params.key || '');
  if (!_validKey(key)) return res.status(400).json({ error: 'Unknown notification key.' });
  const entry = catalog.entryForKey(key);
  // Forced notifications: allow saving a preference for UI symmetry, but the
  // gate ignores them anyway. Explain to the user.
  if (entry.forced) return res.status(400).json({ error: 'This notification is required and can’t be turned off or delayed.' });
  const channel = CHANNELS.has(req.body.channel) ? req.body.channel : 'both';
  const frequency = FREQS.has(req.body.frequency) ? req.body.frequency : 'instant';
  await db.query(
    `INSERT INTO lo_self_notification_prefs (staff_id, notif_key, channel, frequency, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$1, now())
     ON CONFLICT (staff_id, notif_key)
     DO UPDATE SET channel=EXCLUDED.channel, frequency=EXCLUDED.frequency,
                   updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [req.actor.id, key, channel, frequency]);
  res.json({ ok: true });
});

router.post('/notification-center/self-prefs/bulk', async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  let wrote = 0;
  for (const it of items) {
    if (!it || !_validKey(it.key)) continue;
    const entry = catalog.entryForKey(it.key);
    if (entry.forced) continue;
    const channel = CHANNELS.has(it.channel) ? it.channel : 'both';
    const frequency = FREQS.has(it.frequency) ? it.frequency : 'instant';
    await db.query(
      `INSERT INTO lo_self_notification_prefs (staff_id, notif_key, channel, frequency, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$1, now())
       ON CONFLICT (staff_id, notif_key)
       DO UPDATE SET channel=EXCLUDED.channel, frequency=EXCLUDED.frequency,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [req.actor.id, it.key, channel, frequency]);
    wrote++;
  }
  res.json({ ok: true, wrote });
});

router.get('/notification-center/delivery-rules', async (req, res) => {
  const r = await db.query(
    `SELECT * FROM lo_self_delivery_rules WHERE staff_id=$1`, [req.actor.id]);
  const row = r.rows[0] || {
    staff_id: req.actor.id,
    master_mode: 'instant', batch_minutes: 60,
    daily_digest_enabled: true, daily_digest_hour: 8,
    weekly_digest_enabled: true, weekly_digest_dow: 1,
    vacation_from: null, vacation_to: null, vacation_drop: false, vacation_note: null,
    weekend_hold: false, timezone: 'America/New_York',
    quiet_hours_start: null, quiet_hours_end: null, work_days_mask: 127,
    presence_hold_minutes: 0, suppress_email_if_read: false,
    per_file_batch_minutes: 0, per_file_batch_threshold: 3,
    volume_cap_per_hour: 0,
  };
  res.json({ rules: row });
});

router.put('/notification-center/delivery-rules', async (req, res) => {
  const b = req.body || {};
  const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const num = (v, d, min, max) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return d;
    return Math.max(min, Math.min(max, n));
  };
  // Parse a datetime-local (`YYYY-MM-DDTHH:MM`) as WALL TIME in the given
  // tz — else "vacation from Aug 1 midnight" on an NY LO ends up 4-5h early
  // when the server is UTC. A full ISO with offset is kept as-is.
  const wallInTz = (s, tz) => {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      const [d, t] = s.split('T');
      const [y, mo, da] = d.split('-').map((x) => parseInt(x, 10));
      const [hh, mm] = t.split(':').map((x) => parseInt(x, 10));
      const utcGuess = new Date(Date.UTC(y, mo - 1, da, hh, mm, 0));
      try {
        const dtf = new Intl.DateTimeFormat('en-US', {
          timeZone: tz || 'UTC', hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const parts = dtf.formatToParts(utcGuess);
        const g = (k) => parts.find((p) => p.type === k)?.value;
        const asIfUtc = Date.UTC(+g('year'), +g('month') - 1, +g('day'),
          +g('hour') % 24, +g('minute'), +g('second'));
        const off = (asIfUtc - utcGuess.getTime()) / 60000;
        return new Date(utcGuess.getTime() - off * 60000);
      } catch (_) { return utcGuess; }
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };
  const master_mode = MASTER.has(b.master_mode) ? b.master_mode : 'instant';
  const batch_minutes = num(b.batch_minutes, 60, 5, 24 * 60);
  const daily_digest_enabled = b.daily_digest_enabled !== false;
  const daily_digest_hour = num(b.daily_digest_hour, 8, 0, 23);
  const weekly_digest_enabled = b.weekly_digest_enabled !== false;
  const weekly_digest_dow = num(b.weekly_digest_dow, 1, 1, 7);
  const vacation_from = wallInTz(b.vacation_from, b.timezone || timezone);
  const vacation_to = wallInTz(b.vacation_to, b.timezone || timezone);
  const vacation_drop = !!b.vacation_drop;
  const vacation_note = b.vacation_note ? String(b.vacation_note).slice(0, 400) : null;
  const weekend_hold = !!b.weekend_hold;
  const timezone = b.timezone && String(b.timezone).length < 64 ? String(b.timezone) : 'America/New_York';
  const quiet_hours_start = HH_MM.test(String(b.quiet_hours_start || '')) ? b.quiet_hours_start : null;
  const quiet_hours_end = HH_MM.test(String(b.quiet_hours_end || '')) ? b.quiet_hours_end : null;
  const work_days_mask = num(b.work_days_mask, 127, 0, 127);
  const presence_hold_minutes = num(b.presence_hold_minutes, 0, 0, 24 * 60);
  const suppress_email_if_read = !!b.suppress_email_if_read;
  const per_file_batch_minutes = num(b.per_file_batch_minutes, 0, 0, 24 * 60);
  const per_file_batch_threshold = num(b.per_file_batch_threshold, 3, 2, 100);
  const volume_cap_per_hour = num(b.volume_cap_per_hour, 0, 0, 1000);
  await db.query(
    `INSERT INTO lo_self_delivery_rules (
        staff_id, master_mode, batch_minutes,
        daily_digest_enabled, daily_digest_hour,
        weekly_digest_enabled, weekly_digest_dow,
        vacation_from, vacation_to, vacation_drop, vacation_note,
        weekend_hold, timezone, quiet_hours_start, quiet_hours_end, work_days_mask,
        presence_hold_minutes, suppress_email_if_read,
        per_file_batch_minutes, per_file_batch_threshold,
        volume_cap_per_hour, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     ON CONFLICT (staff_id) DO UPDATE SET
        master_mode=EXCLUDED.master_mode, batch_minutes=EXCLUDED.batch_minutes,
        daily_digest_enabled=EXCLUDED.daily_digest_enabled,
        daily_digest_hour=EXCLUDED.daily_digest_hour,
        weekly_digest_enabled=EXCLUDED.weekly_digest_enabled,
        weekly_digest_dow=EXCLUDED.weekly_digest_dow,
        vacation_from=EXCLUDED.vacation_from, vacation_to=EXCLUDED.vacation_to,
        vacation_drop=EXCLUDED.vacation_drop, vacation_note=EXCLUDED.vacation_note,
        weekend_hold=EXCLUDED.weekend_hold, timezone=EXCLUDED.timezone,
        quiet_hours_start=EXCLUDED.quiet_hours_start,
        quiet_hours_end=EXCLUDED.quiet_hours_end,
        work_days_mask=EXCLUDED.work_days_mask,
        presence_hold_minutes=EXCLUDED.presence_hold_minutes,
        suppress_email_if_read=EXCLUDED.suppress_email_if_read,
        per_file_batch_minutes=EXCLUDED.per_file_batch_minutes,
        per_file_batch_threshold=EXCLUDED.per_file_batch_threshold,
        volume_cap_per_hour=EXCLUDED.volume_cap_per_hour,
        updated_at=now()`,
    [req.actor.id, master_mode, batch_minutes,
     daily_digest_enabled, daily_digest_hour,
     weekly_digest_enabled, weekly_digest_dow,
     vacation_from, vacation_to, vacation_drop, vacation_note,
     weekend_hold, timezone, quiet_hours_start, quiet_hours_end, work_days_mask,
     presence_hold_minutes, suppress_email_if_read,
     per_file_batch_minutes, per_file_batch_threshold,
     volume_cap_per_hour]);
  selfGate.invalidateRules(req.actor.id);
  res.json({ ok: true });
});

// Per-file mute / star. IDOR-guarded: the LO must be on the file's team.
async function _staffOnFile(staffId, appId) {
  if (!staffId || !appId) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM application_assignees
        WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL LIMIT 1`,
      [appId, staffId]);
    return r.rows.length > 0;
  } catch (_) { return false; }
}

router.post('/notification-center/mute-file', async (req, res) => {
  const appId = String(req.body.applicationId || '');
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  if (!(await _staffOnFile(req.actor.id, appId))) return res.status(403).json({ error: 'Not on this file' });
  const until = req.body.muteUntil ? new Date(req.body.muteUntil) : null;
  const note = req.body.note ? String(req.body.note).slice(0, 400) : null;
  await db.query(
    `INSERT INTO lo_muted_files (staff_id, application_id, mute_until, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (staff_id, application_id)
     DO UPDATE SET mute_until=EXCLUDED.mute_until, note=EXCLUDED.note, muted_at=now()`,
    [req.actor.id, appId, until, note]);
  res.json({ ok: true });
});

router.delete('/notification-center/mute-file', async (req, res) => {
  const appId = String(req.query.applicationId || (req.body || {}).applicationId || '');
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  await db.query(
    `DELETE FROM lo_muted_files WHERE staff_id=$1 AND application_id=$2`,
    [req.actor.id, appId]);
  res.json({ ok: true });
});

router.get('/notification-center/muted-files', async (req, res) => {
  const r = await db.query(
    `SELECT m.application_id, m.muted_at, m.mute_until, m.note,
            a.ys_loan_number, a.property_address
       FROM lo_muted_files m
       JOIN applications a ON a.id = m.application_id
      WHERE m.staff_id=$1
        AND (m.mute_until IS NULL OR m.mute_until > now())
      ORDER BY m.muted_at DESC`,
    [req.actor.id]);
  res.json({ files: r.rows });
});

router.post('/notification-center/star-file', async (req, res) => {
  const appId = String(req.body.applicationId || '');
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  if (!(await _staffOnFile(req.actor.id, appId))) return res.status(403).json({ error: 'Not on this file' });
  await db.query(
    `INSERT INTO lo_starred_files (staff_id, application_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.actor.id, appId]);
  res.json({ ok: true });
});

router.delete('/notification-center/star-file', async (req, res) => {
  const appId = String(req.query.applicationId || (req.body || {}).applicationId || '');
  if (!appId) return res.status(400).json({ error: 'applicationId required' });
  await db.query(
    `DELETE FROM lo_starred_files WHERE staff_id=$1 AND application_id=$2`,
    [req.actor.id, appId]);
  res.json({ ok: true });
});

router.get('/notification-center/starred-files', async (req, res) => {
  const r = await db.query(
    `SELECT s.application_id, s.starred_at,
            a.ys_loan_number, a.property_address
       FROM lo_starred_files s
       JOIN applications a ON a.id = s.application_id
      WHERE s.staff_id=$1
      ORDER BY s.starred_at DESC`,
    [req.actor.id]);
  res.json({ files: r.rows });
});

// Live summary: how many emails did this LO's own inbox receive over the last
// N days? Powers the "For me" tab's "you're getting ~X/week" line.
router.get('/notification-center/self-volume', async (req, res) => {
  const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 7));
  const since = new Date(Date.now() - days * 24 * 3600_000);
  try {
    const r = await db.query(
      `SELECT count(*)::int AS in_app,
              count(*) FILTER (WHERE email_status='sent')::int AS emailed,
              count(*) FILTER (WHERE email_status='skipped')::int AS suppressed
         FROM notifications
        WHERE staff_id=$1 AND created_at >= $2`,
      [req.actor.id, since]);
    const b = await db.query(
      `SELECT count(*)::int AS pending
         FROM lo_batched_emails
        WHERE staff_id=$1 AND status='pending'`, [req.actor.id]);
    res.json({ days, since: since.toISOString(),
      inApp: r.rows[0].in_app, emailed: r.rows[0].emailed,
      suppressed: r.rows[0].suppressed, batchedPending: b.rows[0].pending });
  } catch (e) {
    res.json({ days, since: since.toISOString(), inApp: 0, emailed: 0, suppressed: 0, batchedPending: 0, partial: true });
  }
});

module.exports = router;
