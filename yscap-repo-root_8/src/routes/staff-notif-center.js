/**
 * Loan-officer NOTIFICATION CENTER — routes that back the settings + draft
 * queue screen. Mounted under /api/staff (same auth chain as staff.js) via
 *   router.use(require('./staff-notif-center'))
 * at the bottom of staff.js.
 *
 *   GET  /api/staff/notification-center/catalog     — the full catalog + defaults
 *   GET  /api/staff/notification-center/prefs       — my saved overrides
 *   PUT  /api/staff/notification-center/prefs/:key  — update one row (upsert)
 *   POST /api/staff/notification-center/prefs/bulk  — bulk-set many at once
 *   GET  /api/staff/notification-center/drafts      — list my drafts (pending / sent / discarded)
 *   POST /api/staff/notification-center/drafts/:id/send    — send a queued draft
 *   POST /api/staff/notification-center/drafts/:id/discard — discard it
 *   GET  /api/staff/notification-center/drafts/count       — pending count for the nav bell
 */
'use strict';
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const catalog = require('../lib/notification-catalog');
const notify = require('../lib/notify');

// The catalog + a friendly grouping for the settings screen.
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

// My saved preference overrides. Any catalog key without a row here uses the
// defaults (enabled=true, mode=default_mode).
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
  // Forced entries can't be silenced or delayed — reject the change loudly
  // instead of pretending to save.
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

// The drafts queue — my parked notifications. Optional ?status=pending|sent|discarded (default pending).
router.get('/notification-center/drafts', async (req, res) => {
  const status = ['pending', 'sent', 'discarded'].includes(req.query.status) ? req.query.status : 'pending';
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = await db.query(
    `SELECT d.id, d.notif_key, d.audience, d.recipient_kind, d.recipient_id, d.recipient_label,
            d.application_id, d.notif_type, d.subject_preview, d.body_preview,
            d.status, d.created_at, d.sent_at, d.discarded_at,
            a.ys_loan_number, a.property_address
       FROM lo_notification_drafts d
       LEFT JOIN applications a ON a.id = d.application_id
      WHERE d.staff_id=$1 AND d.status=$2
      ORDER BY d.created_at DESC
      LIMIT $3`,
    [req.actor.id, status, limit]);
  const items = rows.rows.map((r) => {
    const pa = r.property_address || {};
    const addr = pa.oneLine || [pa.street || pa.line1, pa.city, pa.state].filter(Boolean).join(', ') || null;
    return {
      id: r.id, key: r.notif_key, audience: r.audience,
      recipientKind: r.recipient_kind, recipientId: r.recipient_id, recipientLabel: r.recipient_label,
      applicationId: r.application_id, loanNumber: r.ys_loan_number ? String(r.ys_loan_number).toUpperCase() : null,
      address: addr, notifType: r.notif_type,
      subject: r.subject_preview, body: r.body_preview, status: r.status,
      createdAt: r.created_at, sentAt: r.sent_at, discardedAt: r.discarded_at,
      entry: catalog.entryForKey(r.notif_key),
    };
  });
  res.json({ items });
});

router.get('/notification-center/drafts/count', async (req, res) => {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM lo_notification_drafts WHERE staff_id=$1 AND status='pending'`,
    [req.actor.id]);
  res.json({ pending: r.rows[0] && r.rows[0].n || 0 });
});

async function _loadPendingDraft(id, staffId) {
  const r = await db.query(
    `SELECT id, staff_id, notif_key, audience, recipient_kind, recipient_id,
            application_id, notif_type, opts, status
       FROM lo_notification_drafts WHERE id=$1`, [id]);
  const d = r.rows[0];
  if (!d) return null;
  if (String(d.staff_id) !== String(staffId)) return { forbidden: true };
  if (d.status !== 'pending') return { alreadyResolved: d.status };
  return d;
}

router.post('/notification-center/drafts/:id/send', async (req, res) => {
  const d = await _loadPendingDraft(req.params.id, req.actor.id);
  if (!d) return res.status(404).json({ error: 'Draft not found.' });
  if (d.forbidden) return res.status(403).json({ error: 'Not your draft.' });
  if (d.alreadyResolved) return res.status(409).json({ error: `This draft was already ${d.alreadyResolved}.` });
  // Optional last-mile edits from the LO (they can tweak title / body / add a note
  // before hitting Send).
  const edits = (req.body && typeof req.body === 'object') ? req.body : {};
  const opts = { ...(d.opts || {}), _bypassLoGate: true };
  if (typeof edits.title === 'string' && edits.title.trim()) opts.title = edits.title.trim();
  if (typeof edits.body === 'string')                        opts.body = edits.body;
  if (typeof edits.note === 'string')                        opts.note = edits.note;
  // Never trust the client to change the type/application/recipient — those come from the row.
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

module.exports = router;
