'use strict';

/**
 * Manual Program admin + the super-admin ESCALATION box (owner-directed
 * 2026-07-20). Mounted at /api/admin/manual-programs behind requireAuth +
 * requireStaff (see server.js). Individual routes add their own capability/role
 * gate:
 *   • GET/PUT  /settings           — manage_pricing (the Manual Program config:
 *                                     default LTV/LTC/ARV ceilings + REQUIRED
 *                                     default liquidity months).
 *   • GET      /escalations        — any staff (admins/super-admins see the box).
 *   • GET      /escalations/count  — pending count for the nav badge.
 *   • POST     /escalations/:id/decide — SUPER-ADMIN ONLY (approve / decline).
 */

const router = require('express').Router();
const db = require('../db');
const { requirePermission, requireRole } = require('../auth');
const manualProgram = require('../lib/manual-program');
const notify = require('../lib/notify');

function auditSafe(actorId, action, entityType, entityId, detail) {
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff',$1,$2,$3,$4,$5::jsonb)`,
    [actorId || null, action, entityType, entityId, JSON.stringify(detail || {})]).catch(() => {});
}

// ---- Manual Program settings (company-level config) ----
router.get('/settings', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const settings = await manualProgram.loadSettings();
    res.json({ settings, defaults: manualProgram.SETTINGS_DEFAULTS });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.put('/settings', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const saved = await manualProgram.saveSettings(req.body || {}, req.actor.id);
    auditSafe(req.actor.id, 'update_manual_program_settings', 'manual_program_settings', null, saved);
    res.json({ ok: true, settings: saved });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'could not save manual program settings' });
  }
});

// ---- Escalation box ----
// Gated to manage_pricing (admins + super-admins, who implicitly hold it) — the
// list carries borrower/property/loan identity for EVERY manual file, so it must
// NOT be reachable by a file-scoped loan officer / processor. Deciding is
// super-admin only (below).
router.get('/escalations', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const status = ['pending', 'approved', 'declined', 'all'].includes(req.query.status) ? req.query.status : 'pending';
    const [rows, pending] = await Promise.all([
      manualProgram.listEscalations({ status }),
      manualProgram.pendingCount(),
    ]);
    // Never leak the note-buyer name into the box — the summary/overrides carry
    // only leverage numbers, and the property/loan identity is staff-only anyway.
    res.json({ escalations: rows, pendingCount: pending, canDecide: req.actor.role === 'super_admin' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/escalations/count', requirePermission('manage_pricing'), async (req, res) => {
  try { res.json({ pendingCount: await manualProgram.pendingCount() }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/escalations/:id/decide', requireRole('super_admin'), async (req, res) => {
  try {
    const decision = req.body && req.body.decision === 'approved' ? 'approved' : 'declined';
    const note = req.body && req.body.note;
    const row = await manualProgram.decideEscalation(req.params.id, decision, req.actor.id, note);
    if (!row) return res.status(409).json({ error: 'This escalation was already decided or no longer exists.' });
    auditSafe(req.actor.id, 'manual_program_escalation_decided', 'application', row.application_id,
      { escalationId: row.id, decision, note: note ? String(note).slice(0, 200) : null });
    // Tell the loan team the verdict (best-effort, in-app + email to the file's team).
    try {
      const ctx = await notify.fileContext(row.application_id, [
        { label: 'Manual product', value: decision === 'approved' ? 'Approved' : 'Declined' },
      ]);
      await notify.notifyAppStaff(row.application_id, {
        type: 'manual_escalation_decided',
        title: decision === 'approved' ? 'Manual product approved' : 'Manual product declined',
        body: `The Manual Program on ${ctx ? ctx.label : 'the file'} was ${decision === 'approved' ? 'approved' : 'declined'} by a super-admin${note ? ` — ${String(note).slice(0, 200)}` : ''}.`,
        meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
        link: `/internal/app/${row.application_id}`, ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, escalation: row });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

module.exports = router;
