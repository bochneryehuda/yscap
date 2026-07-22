'use strict';

/**
 * Loan policy EXCEPTIONS — the super-admin review box (owner-directed 2026-07-22).
 * Mounted at /api/admin/exceptions behind requireAuth + requireStaff (server.js).
 * Today the only exception type is a co-borrower GUARANTY WAIVER.
 *
 *   • GET  /             — list exceptions (manage_pricing: admins + super-admins).
 *   • GET  /count        — open count for the nav badge.
 *   • POST /:id/decide   — SUPER-ADMIN ONLY (approve | deny). Approve flips
 *                          applications.co_borrower_pg_waived so the term sheet
 *                          reflects it; deny leaves both borrowers guaranteeing.
 *
 * Segregation of duties: the approver cannot be the requester (enforced here).
 * Requesting + withdrawing are file-scoped and live in staff.js so they run
 * behind the /applications/:id access middleware.
 */

const router = require('express').Router();
const db = require('../db');
const { requirePermission, requireRole } = require('../auth');
const loanExceptions = require('../lib/loan-exceptions');
const notify = require('../lib/notify');

function auditSafe(actorId, action, entityType, entityId, detail) {
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff',$1,$2,$3,$4,$5::jsonb)`,
    [actorId || null, action, entityType, entityId, JSON.stringify(detail || {})]).catch(() => {});
}

// The list carries borrower/property identity for every file, so it is gated to
// manage_pricing (admins + super-admins) — never a file-scoped LO/processor.
// Deciding is super-admin only (below). `canDecide` tells the UI which buttons
// to show; `reasonCodes` labels the structured reasons.
router.get('/', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const status = ['open', 'approved', 'denied', 'withdrawn', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const [rows, pending] = await Promise.all([
      loanExceptions.listExceptions({ status }),
      loanExceptions.pendingCount(),
    ]);
    res.json({
      exceptions: rows,
      pendingCount: pending,
      canDecide: req.actor.role === 'super_admin',
      reasonCodes: loanExceptions.REASON_CODES,
      actorId: req.actor.id,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/count', requirePermission('manage_pricing'), async (req, res) => {
  try { res.json({ pendingCount: await loanExceptions.pendingCount() }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/:id/decide', requireRole('super_admin'), async (req, res) => {
  try {
    const decision = req.body && req.body.decision === 'approved' ? 'approved' : 'denied';
    const note = req.body && req.body.note;
    if (!note || !String(note).trim()) {
      return res.status(400).json({ error: 'Add a short note explaining your decision.' });
    }
    // Segregation of duties: the approver cannot be the person who requested it.
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (exc.status !== 'requested') return res.status(409).json({ error: 'This exception was already decided.' });
    if (exc.requested_by && exc.requested_by === req.actor.id) {
      return res.status(403).json({ error: 'The person who requested an exception cannot approve their own request.' });
    }

    const client = await db.getClient();
    let row;
    try {
      await client.query('BEGIN');
      row = await loanExceptions.decideException(req.params.id, decision, req.actor.id, note, client);
      if (!row) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This exception was already decided or no longer exists.' }); }
      // Approve → waive the co-borrower's personal guaranty on the file (the
      // term-sheet display flag). Deny → both borrowers guarantee (the default).
      await client.query(
        `UPDATE applications SET co_borrower_pg_waived=$2, updated_at=now() WHERE id=$1`,
        [row.application_id, decision === 'approved']);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    auditSafe(req.actor.id, 'guaranty_exception_decided', 'application', row.application_id,
      { exceptionId: row.id, decision, note: String(note).slice(0, 200) });

    // Tell the file's team the verdict (best-effort). A waiver changes the term
    // sheet wording, so the note reminds them to re-issue it.
    try {
      const subject = [exc.subject_first, exc.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
      const ctx = await notify.fileContext(row.application_id, [
        { label: 'Guaranty waiver', value: decision === 'approved' ? 'Approved' : 'Denied' },
      ]);
      await notify.notifyAppStaff(row.application_id, {
        type: 'guaranty_exception_decided',
        title: decision === 'approved' ? 'Guaranty waiver approved' : 'Guaranty waiver denied',
        body: decision === 'approved'
          ? `The request to waive ${subject}'s personal guaranty on ${ctx ? ctx.label : 'the file'} was APPROVED by a super-admin${note ? ` — ${String(note).slice(0, 200)}` : ''}. ${subject} will show as a member of the borrowing entity (not a personal guarantor). Re-issue the term sheet so it reflects the change.`
          : `The request to waive ${subject}'s personal guaranty on ${ctx ? ctx.label : 'the file'} was DENIED by a super-admin${note ? ` — ${String(note).slice(0, 200)}` : ''}. Both borrowers remain personal guarantors (full recourse).`,
        meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
        link: `/internal/app/${row.application_id}`, ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }

    res.json({ ok: true, exception: row });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

module.exports = router;
