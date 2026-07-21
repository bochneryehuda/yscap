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
  const auto = b.auto_send_after_hours == null ? null
    : Math.max(1, Math.min(24 * 30, parseInt(b.auto_send_after_hours, 10) || 48));
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
  if (!appId || !key) return res.status(400).json({ error: 'applicationId and key required' });
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
  const opts = { ...(d.opts || {}), _bypassLoGate: true };
  if (typeof edits.title === 'string' && edits.title.trim()) opts.title = edits.title.trim();
  else if (d.edited_subject) opts.title = d.edited_subject;
  if (typeof edits.body === 'string') opts.body = edits.body;
  else if (d.edited_body) opts.body = d.edited_body;
  if (typeof edits.note === 'string') opts.note = edits.note;
  else if (d.edited_note) opts.note = d.edited_note;
  opts.type = d.notif_type;
  opts.applicationId = d.application_id;

  let sentId = null;
  try {
    if (d.recipient_kind === 'borrower' && d.recipient_id) {
      sentId = await notify.notifyBorrower(d.recipient_id, opts);
    } else if (d.recipient_kind === 'staff' && d.recipient_id) {
      sentId = await notify.notifyStaff(d.recipient_id, opts);
    } else {
      return res.status(400).json({ error: 'Draft is missing a recipient.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Could not send: ' + (e.message || 'unknown error') });
  }
  await db.query(
    `UPDATE lo_notification_drafts SET status='sent', sent_at=now(), sent_notification_id=$2
      WHERE id=$1 AND status='pending'`, [d.id, sentId || null]);
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
        const opts = { ...(d.opts || {}), _bypassLoGate: true };
        if (d.edited_subject) opts.title = d.edited_subject;
        if (d.edited_body) opts.body = d.edited_body;
        if (d.edited_note) opts.note = d.edited_note;
        opts.type = d.notif_type;
        opts.applicationId = d.application_id;
        let sentId = null;
        if (d.recipient_kind === 'borrower' && d.recipient_id) sentId = await notify.notifyBorrower(d.recipient_id, opts);
        else if (d.recipient_kind === 'staff' && d.recipient_id) sentId = await notify.notifyStaff(d.recipient_id, opts);
        await db.query(
          `UPDATE lo_notification_drafts SET status='sent', sent_at=now(), sent_notification_id=$2 WHERE id=$1 AND status='pending'`,
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
        if (Number.isNaN(when.getTime())) { failed += 1; continue; }
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
    `SELECT loan_officer_id FROM applications WHERE id=$1`, [appId]);
  if (!owned.rows[0] || String(owned.rows[0].loan_officer_id) !== String(req.actor.id)) {
    return res.status(403).json({ error: 'Only the file’s assigned loan officer can compose on it.' });
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
  const sends = await db.query(
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
      GROUP BY n.type`, [staffId, since]).catch(() => ({ rows: [] }));
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
  res.json({ days, since: since.toISOString(), byKey: Object.values(byKey), totals });
});

module.exports = router;
