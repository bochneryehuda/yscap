'use strict';

/**
 * Loan policy EXCEPTIONS — the super-admin review box (owner-directed 2026-07-22).
 * Mounted at /api/admin/exceptions behind requireAuth + requireStaff (server.js).
 * Two exception types: the co-borrower GUARANTY WAIVER and the e-sign
 * SEND-BEFORE-CLEAR-TO-CLOSE exception (per-requirement waivers, 2026-07-24).
 *
 *   • GET  /             — list exceptions (manage_pricing: admins + super-admins).
 *   • GET  /count        — open count for the nav badge.
 *   • GET  /:id/gate     — the esign exception's CLEAR VIEW: live ✓/✗ requirements
 *                          picture + request snapshot + which codes were waived.
 *   • POST /:id/decide   — SUPER-ADMIN ONLY (approve | deny). Guaranty: approve
 *                          flips applications.co_borrower_pg_waived so the term
 *                          sheet reflects it. E-sign: approve records EXACTLY the
 *                          blocker codes being waived (waivedCodes, validated
 *                          against the LIVE gate); everything not waived is still
 *                          enforced at send time.
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
    const status = ['open', 'approved', 'denied', 'withdrawn', 'cleared', 'all'].includes(req.query.status) ? req.query.status : 'open';
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

    const isGuaranty = exc.exception_type === 'guaranty_waiver';
    const isEsign = exc.exception_type === 'esign_before_ctc';

    // Per-requirement waivers (owner-directed 2026-07-24): an esign approval names
    // EXACTLY which outstanding blockers it waives. Validate against the LIVE gate
    // (never the client's list): a submitted code that is no longer outstanding is
    // dropped (it resolved — good news); an empty result refuses the approval. The
    // decision also snapshots the live picture so the gate can pin each waiver to
    // the exact blocker state that was approved. A legacy client that sends no
    // waivedCodes keeps the old meaning (waives the readiness tier only).
    let waivedCodes;               // undefined = legacy; array = explicit waivers
    let decidedGate = null;
    let liveGate = null;
    let waivedItems = [], stillRequired = [];
    if (isEsign && decision === 'approved') {
      liveGate = await require('../lib/esign/gate').esignSendGate(exc.application_id, { db });
      decidedGate = {
        at: new Date().toISOString(),
        outstanding: (liveGate.outstanding || []).map((o) => ({ code: o.code, label: o.label, reason: o.reason || null, tier: o.tier })),
      };
      if (req.body && Array.isArray(req.body.waivedCodes)) {
        const liveByCode = {};
        for (const o of liveGate.outstanding || []) if (!(o.code in liveByCode)) liveByCode[o.code] = o;
        waivedCodes = [...new Set(req.body.waivedCodes.map(String))].filter((c) => c in liveByCode);
        if (!waivedCodes.length) {
          return res.status(400).json({
            error: 'None of the selected requirements is still outstanding — refresh the picture and pick at least one requirement to waive (or deny the request).',
            outstanding: decidedGate.outstanding,
          });
        }
        waivedItems = waivedCodes.map((c) => liveByCode[c]);
        stillRequired = (liveGate.outstanding || []).filter((o) => !waivedCodes.includes(o.code));
      } else {
        // Legacy approve (no explicit selection): the readiness (ctc) tier only.
        waivedItems = (liveGate.ctcOutstanding || []);
        stillRequired = (liveGate.floorOutstanding || []);
      }
    }

    const client = await db.getClient();
    let row;
    try {
      await client.query('BEGIN');
      row = await loanExceptions.decideException(req.params.id, decision, req.actor.id, note, client,
        { waivedCodes, decidedGate });
      if (!row) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This exception was already decided or no longer exists.' }); }
      // Guaranty waiver: Approve → waive the co-borrower's personal guaranty (the
      // term-sheet display flag); Deny → both borrowers guarantee (the default).
      // esign_before_ctc: no application-column change — the APPROVED loan_exceptions
      // row (with its waived_codes) is what the e-sign send-gate reads; every
      // requirement NOT waived is still re-checked at send time.
      if (isGuaranty) {
        await client.query(
          `UPDATE applications SET co_borrower_pg_waived=$2, updated_at=now() WHERE id=$1`,
          [row.application_id, decision === 'approved']);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    auditSafe(req.actor.id, isGuaranty ? 'guaranty_exception_decided' : 'esign_before_ctc_exception_decided',
      'application', row.application_id, {
        exceptionId: row.id, exceptionType: exc.exception_type, decision, note: String(note).slice(0, 200),
        waivedCodes: waivedCodes || undefined,
        stillRequired: isEsign && decision === 'approved' ? stillRequired.map((o) => o.code) : undefined,
      });

    // Tell the file's team the verdict (best-effort). An approval reminds them what
    // it unlocked; a denial reminds them the default policy stands.
    try {
      if (isGuaranty) {
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
      } else {
        const ctx = await notify.fileContext(row.application_id, [
          { label: 'Send before clear-to-close', value: decision === 'approved' ? 'Approved' : 'Denied' },
        ]);
        // Name exactly what was waived and what is STILL required, so the team
        // never has to guess which items the approval covered.
        const waivedList = waivedItems.map((o) => o.label).join('; ');
        const requiredList = stillRequired.map((o) => o.label).join('; ');
        await notify.notifyAppStaff(row.application_id, {
          type: 'esign_before_ctc_exception_decided',
          title: decision === 'approved' ? 'Send-before-clear-to-close approved' : 'Send-before-clear-to-close denied',
          body: decision === 'approved'
            ? `A super-admin APPROVED an exception on ${ctx ? ctx.label : 'the file'}${note ? ` — ${String(note).slice(0, 200)}` : ''}. Waived: ${waivedList || 'nothing (already resolved)'}.${requiredList ? ` STILL REQUIRED before the package can send: ${requiredList}.` : ' Every other requirement is met — the package can be sent now.'}`
            : `A super-admin DENIED sending the term-sheet package on ${ctx ? ctx.label : 'the file'} early${note ? ` — ${String(note).slice(0, 200)}` : ''}. Finish the outstanding items, then it can be sent.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
          link: `/internal/app/${row.application_id}#sec-esign`, ctaLabel: 'Open the loan file',
        });
      }
    } catch (_) { /* best-effort */ }

    res.json({ ok: true, exception: row });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

// Clear (archive / close out) an exception. A super-admin can clear any; the person
// who REQUESTED it can clear their own (housekeeping — it does NOT change the
// waiver flag). Mounted behind requireStaff so a requesting loan officer reaches it.
router.post('/:id/clear', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (exc.status === 'cleared') return res.status(409).json({ error: 'That exception is already cleared.' });
    const isSuper = req.actor.role === 'super_admin';
    const isRequester = exc.requested_by && exc.requested_by === req.actor.id;
    if (!isSuper && !isRequester) {
      return res.status(403).json({ error: 'Only a super-admin or the person who requested it can clear an exception.' });
    }
    const note = req.body && req.body.note;
    const row = await loanExceptions.clearException(req.params.id, req.actor.id, note);
    if (!row) return res.status(409).json({ error: 'That exception is already cleared.' });
    const clrAction = exc.exception_type === 'esign_before_ctc' ? 'esign_before_ctc_exception_cleared' : 'guaranty_exception_cleared';
    auditSafe(req.actor.id, clrAction, 'application', row.application_id,
      { exceptionId: row.id, exceptionType: exc.exception_type, note: note ? String(note).slice(0, 200) : null });
    res.json({ ok: true, exception: row });
  } catch (e) { res.status(500).json({ error: 'could not clear the exception' }); }
});

// Comments on an exception (staff-only back-and-forth). Reachable by the two
// parties + admins: a super-admin, an admin (manage_pricing — they see the box),
// the person who REQUESTED it, or the person who DECIDED it.
function canParticipate(exc, actor) {
  return actor.role === 'super_admin' || actor.role === 'admin' ||
    (exc.requested_by && exc.requested_by === actor.id) ||
    (exc.decided_by && exc.decided_by === actor.id);
}

router.get('/:id/comments', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (!canParticipate(exc, req.actor)) return res.status(403).json({ error: 'You don’t have access to this exception.' });
    res.json({ comments: await loanExceptions.listComments(req.params.id), actorId: req.actor.id });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/:id/comments', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (!canParticipate(exc, req.actor)) return res.status(403).json({ error: 'You don’t have access to this exception.' });
    const body = String((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Write a comment first.' });
    const row = await loanExceptions.addComment(req.params.id, req.actor.id, body);
    auditSafe(req.actor.id, 'guaranty_exception_comment', 'application', exc.application_id, { exceptionId: exc.id });
    // Notify the OTHER participants (requester + decider + prior commenters) so the
    // conversation reaches whoever isn't the author — the requester hears about a
    // super-admin's comment, and vice-versa.
    try {
      const participants = (await loanExceptions.commentParticipants(req.params.id))
        .filter((sid) => sid && sid !== req.actor.id);
      const subject = [exc.subject_first, exc.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
      const ctx = await notify.fileContext(exc.application_id);
      for (const sid of participants) {
        // The requester reads their queue; a reviewer reads the box.
        const link = exc.requested_by && sid === exc.requested_by ? '/internal/my-exceptions' : '/internal/exceptions';
        await notify.notifyStaff(sid, {
          type: 'guaranty_exception_comment',
          title: 'New comment on a guaranty-waiver exception',
          body: `${req.actor.name || 'A team member'} commented on the request to waive ${subject}'s personal guaranty on ${ctx ? ctx.label : 'a file'}:\n\n${body.slice(0, 600)}`,
          meta: (ctx && ctx.meta) || undefined, applicationId: exc.application_id,
          link, ctaLabel: 'Open the exception',
        });
      }
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, comment: row });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'could not post the comment' });
  }
});

// The CLEAR VIEW for a send-before-clear-to-close exception (owner-directed
// 2026-07-24): the LIVE requirements picture (every ✓ done / ✗ outstanding, with
// tiers + waive warnings), the snapshot taken at request time, and — once
// decided — which codes the approval waived. The super-admin decides from this;
// the requester reads the same picture. Same participant gate as comments.
router.get('/:id/gate', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (exc.exception_type !== 'esign_before_ctc') return res.status(400).json({ error: 'This exception has no send-gate view.' });
    if (!canParticipate(exc, req.actor)) return res.status(403).json({ error: 'You don’t have access to this exception.' });
    const g = await require('../lib/esign/gate').esignSendGate(exc.application_id, { db });
    res.json({
      applicationId: exc.application_id,
      status: exc.status,
      live: {
        ready: g.ready,
        sendAllowed: g.sendAllowed,
        floorMet: g.floorMet,
        checks: g.checks || [],
        outstanding: g.outstanding || [],
      },
      requestSnapshot: exc.gate_snapshot || null,
      decidedGate: exc.decided_gate || null,
      waivedCodes: Array.isArray(exc.waived_codes) ? exc.waived_codes : null,
      canDecide: req.actor.role === 'super_admin' && exc.status === 'requested'
        && !(exc.requested_by && exc.requested_by === req.actor.id),
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The conditions / document-requests tagged to this exception, each with the
// documents uploaded against it. Same participant gate as comments — a
// super-admin, an admin, the requester, or the decider. The documents are
// listed by identity only (id/filename); bytes stream through the normal
// authorized document-download path, never from here.
router.get('/:id/conditions', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (!canParticipate(exc, req.actor)) return res.status(403).json({ error: 'You don’t have access to this exception.' });
    res.json({ conditions: await loanExceptions.listConditions(req.params.id), applicationId: exc.application_id });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
