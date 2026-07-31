'use strict';

/**
 * Loan policy EXCEPTIONS — the review box (owner-directed 2026-07-22; redesigned
 * 2026-07-24 — docs/EXCEPTION-WORKFLOW-REDESIGN.md). Mounted at
 * /api/admin/exceptions behind requireAuth + requireStaff (server.js).
 *
 * The register hosts every exception type (guaranty_waiver, esign_before_ctc,
 * pricing_exception, issuance_override — see lib/loan-exceptions EXCEPTION_TYPES).
 *
 *   • GET  /               — list (manage_pricing), filter by status AND type,
 *                            each row carrying aging + deal-drift advisories.
 *   • GET  /count          — open count for the nav badge.
 *   • GET  /metrics        — the register report: counts, approval rate, median
 *                            time-to-decision, aging, by-requester (manage_pricing).
 *   • GET  /export.xlsx    — the exception REGISTER export for loan-sale /
 *                            diligence conversations (manage_pricing).
 *   • GET  /:id/gate       — the esign exception's CLEAR VIEW: live ✓/✗
 *                            requirements + request snapshot + waived codes.
 *   • GET  /:id/conditions — conditions/document-requests tagged to it.
 *   • POST /:id/decide     — SUPER-ADMIN ONLY (approve | deny). Guaranty:
 *                            approve flips applications.co_borrower_pg_waived.
 *                            E-sign: approve records EXACTLY the waived blocker
 *                            codes (validated against the LIVE gate). Pricing:
 *                            approve records the grant DECISION — the terms
 *                            themselves are applied in the studio (admin
 *                            override + re-register); nothing here touches a
 *                            frozen engine number. Expirable types may carry an
 *                            approval validity (expiresAt).
 *   • POST /:id/clear      — archive a HANDLED exception (an open request must
 *                            be withdrawn or decided first — never buried).
 *   • GET/POST /:id/comments — the staff-only thread (type-aware copy).
 *
 * Segregation of duties: the approver cannot be the requester (enforced here) —
 * this stays regardless of who may decide.
 * Decide gate = `manage_pricing` (admins + super-admins). Owner-directed
 * 2026-07-26 ("let any Admin approve") — WIDENED from the original
 * super-admin-only rule. Narrowing it again is an owner decision; the
 * requester≠approver control above is independent and must not be removed
 * without separate owner direction. Requesting + withdrawing are file-scoped
 * and live in staff.js behind the /applications/:id middleware.
 */

const router = require('express').Router();
const db = require('../db');
const { requirePermission } = require('../auth');
const { can } = require('../lib/permissions');
const loanExceptions = require('../lib/loan-exceptions');
const notify = require('../lib/notify');
const { buildXlsx } = require('../lib/xlsx');

function auditSafe(actorId, action, entityType, entityId, detail) {
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff',$1,$2,$3,$4,$5::jsonb)`,
    [actorId || null, action, entityType, entityId, JSON.stringify(detail || {})]).catch(() => {});
}

// Per-type action names for the audit trail (the esign comment previously
// audited as guaranty — type-aware everywhere now).
const DECIDED_AUDIT = {
  guaranty_waiver: 'guaranty_exception_decided',
  esign_before_ctc: 'esign_before_ctc_exception_decided',
  pricing_exception: 'pricing_exception_decided',
  oop_rehab: 'oop_rehab_exception_decided',
  issuance_override: 'issuance_override_decided',
};
const CLEARED_AUDIT = {
  guaranty_waiver: 'guaranty_exception_cleared',
  esign_before_ctc: 'esign_before_ctc_exception_cleared',
  pricing_exception: 'pricing_exception_cleared',
  oop_rehab: 'oop_rehab_exception_cleared',
  issuance_override: 'issuance_override_cleared',
};
const COMMENT_AUDIT = {
  guaranty_waiver: 'guaranty_exception_comment',
  esign_before_ctc: 'esign_before_ctc_exception_comment',
  pricing_exception: 'pricing_exception_comment',
  oop_rehab: 'oop_rehab_exception_comment',
  issuance_override: 'issuance_override_comment',
};

// The maps/labels every exception screen needs, shipped once per list call.
function registryPayload() {
  const reasonCodesByType = {};
  for (const t of Object.keys(loanExceptions.EXCEPTION_TYPES)) reasonCodesByType[t] = loanExceptions.reasonCodesFor(t);
  return {
    reasonCodes: loanExceptions.REASON_CODES, // legacy clients
    reasonCodesByType,
    typeLabels: Object.fromEntries(Object.entries(loanExceptions.EXCEPTION_TYPES).map(([k, v]) => [k, v.label])),
    expirableTypes: Object.keys(loanExceptions.EXCEPTION_TYPES).filter((t) => loanExceptions.EXCEPTION_TYPES[t].expirable),
    compensatingFactors: loanExceptions.COMPENSATING_FACTORS,
  };
}

// The list carries borrower/property identity for every file, so it is gated to
// manage_pricing (admins + super-admins) — never a file-scoped LO/processor.
// Deciding is also manage_pricing now (owner-directed 2026-07-26: "let any Admin
// approve" — widened from super-admin-only; requester≠approver still enforced
// below). `canDecide` tells the UI which buttons to show.
router.get('/', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const status = ['open', 'approved', 'denied', 'withdrawn', 'cleared', 'expired', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const type = loanExceptions.isExceptionType(req.query.type) ? req.query.type : null;
    const [rows, pending] = await Promise.all([
      loanExceptions.listExceptions({ status, type }),
      loanExceptions.pendingCount(),
    ]);
    res.json({
      exceptions: rows,
      pendingCount: pending,
      canDecide: can(req.actor, 'manage_pricing'),
      actorId: req.actor.id,
      ...registryPayload(),
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/count', requirePermission('manage_pricing'), async (req, res) => {
  try { res.json({ pendingCount: await loanExceptions.pendingCount() }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The register REPORT — how many, how decided, how fast, what's aging. All
// aggregates (no borrower rows), for the box's summary strip + the owner's
// "are we granting too many" view.
router.get('/metrics', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const m = await loanExceptions.metrics();
    if (!m) return res.status(500).json({ error: 'metrics unavailable' });
    res.json({ metrics: m, typeLabels: registryPayload().typeLabels });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The exception REGISTER export (xlsx) — the loan-sale / diligence artifact:
// one row per exception with its reference number, quantified picture, factors,
// and decision trail. Same status/type filters as the list.
router.get('/export.xlsx', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const status = ['open', 'approved', 'denied', 'withdrawn', 'cleared', 'expired', 'all'].includes(req.query.status) ? req.query.status : 'all';
    const type = loanExceptions.isExceptionType(req.query.type) ? req.query.type : null;
    const rows = await loanExceptions.listExceptions({ status, type, limit: 500 });
    const labels = registryPayload().typeLabels;
    const fmtWhen = (ts) => (ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '');
    const addr = (a) => {
      if (!a) return '';
      if (typeof a === 'string') return a;
      return [a.line1 || a.address || a.oneLine, a.city, a.state].filter(Boolean).join(', ');
    };
    // buildXlsx takes an ARRAY OF ARRAYS (first row = header) — never objects.
    const HEADER = ['Ref', 'Type', 'Status', 'Severity', 'Borrower', 'Loan #', 'Property', 'Loan amount',
      'Reason', 'Reason note', 'Compensating factors', 'Requested by', 'Requested at', 'Review due',
      'Decided by', 'Decided at', 'Decision note', 'Valid until', 'Waived requirements',
      'Deal changed since request', 'File status'];
    const out = rows.map((r) => ([
      r.exception_seq != null ? `EX-${r.exception_seq}` : '',
      labels[r.exception_type] || r.exception_type,
      r.status,
      r.severity || 'standard',
      require('../lib/person-name').displayName(r),
      r.ys_loan_number || '',
      addr(r.property_address),
      r.loan_amount != null ? Number(r.loan_amount) : '',
      r.reason_label || r.reason_code || '',
      r.reason_note || '',
      Array.isArray(r.compensating_factors)
        ? r.compensating_factors.map((f) => loanExceptions.COMPENSATING_FACTORS[f.code] || f.code).join('; ') : '',
      r.requested_by_kind === 'borrower' ? 'Borrower' : (r.requested_by_name || ''),
      fmtWhen(r.requested_at || r.created_at),
      fmtWhen(r.due_at),
      r.decided_by_name || '',
      fmtWhen(r.decided_at),
      r.decision_note || '',
      fmtWhen(r.expires_at),
      Array.isArray(r.waived_codes) ? r.waived_codes.join('; ') : '',
      (r.deal_drift || []).map((d) => `${d.field}: ${d.was} → ${d.now}`).join('; '),
      r.file_status ? String(r.file_status).replace(/_/g, ' ') : '',
    ]));
    const buf = buildXlsx([HEADER, ...out], 'Exception register');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="exception-register-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
    auditSafe(req.actor.id, 'exception_register_exported', 'system', null, { status, type, rows: out.length });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/:id/decide', requirePermission('manage_pricing'), async (req, res) => {
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
    const isPricing = exc.exception_type === 'pricing_exception';

    // Approval validity (expirable types only — the engine re-validates the
    // type + window; a bad value simply stores no expiry).
    const expiresAt = decision === 'approved' && req.body && req.body.expiresAt ? req.body.expiresAt : null;

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
        { waivedCodes, decidedGate, expiresAt });
      if (!row) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This exception was already decided or no longer exists.' }); }
      // Guaranty waiver: Approve → waive the co-borrower's personal guaranty (the
      // term-sheet display flag); Deny → both borrowers guarantee (the default).
      // esign_before_ctc: no application-column change — the APPROVED loan_exceptions
      // row (with its waived_codes) is what the e-sign send-gate reads; every
      // requirement NOT waived is still re-checked at send time.
      // pricing_exception: no application change either — the approval is the
      // recorded DECISION; the terms are applied in the studio (admin override +
      // re-register), never here (frozen-engine rule).
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

    auditSafe(req.actor.id, DECIDED_AUDIT[exc.exception_type] || 'loan_exception_decided',
      'application', row.application_id, {
        exceptionId: row.id, exceptionType: exc.exception_type, decision, note: String(note).slice(0, 200),
        waivedCodes: waivedCodes || undefined,
        stillRequired: isEsign && decision === 'approved' ? stillRequired.map((o) => o.code) : undefined,
        expiresAt: row.expires_at || undefined,
      });

    // Tell the file's team the verdict (best-effort). An approval reminds them what
    // it unlocked; a denial reminds them the default policy stands.
    try {
      const validityLine = row.expires_at
        ? ` This approval is valid until ${new Date(row.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — past that it expires on its own.`
        : '';
      if (isGuaranty) {
        const subject = [exc.subject_first, exc.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
        const ctx = await notify.fileContext(row.application_id, [
          { label: 'Guaranty waiver', value: decision === 'approved' ? 'Approved' : 'Denied' },
        ]);
        await notify.notifyAppStaff(row.application_id, {
          type: 'guaranty_exception_decided',
          title: decision === 'approved' ? 'Guaranty waiver approved' : 'Guaranty waiver denied',
          body: decision === 'approved'
            ? `The request to waive ${subject}'s personal guaranty on ${ctx ? ctx.label : 'the file'} was APPROVED by an administrator${note ? ` — ${String(note).slice(0, 200)}` : ''}. ${subject} will show as a member of the borrowing entity (not a personal guarantor). Re-issue the term sheet so it reflects the change.`
            : `The request to waive ${subject}'s personal guaranty on ${ctx ? ctx.label : 'the file'} was DENIED by an administrator${note ? ` — ${String(note).slice(0, 200)}` : ''}. Both borrowers remain personal guarantors (full recourse).`,
          meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
          link: `/internal/app/${row.application_id}`, ctaLabel: 'Open the loan file',
        });
      } else if (isPricing) {
        const ctx = await notify.fileContext(row.application_id, [
          { label: 'Pricing exception', value: decision === 'approved' ? 'Approved' : 'Denied' },
        ]);
        await notify.notifyAppStaff(row.application_id, {
          type: 'pricing_exception_decided',
          title: decision === 'approved' ? 'Pricing exception approved' : 'Pricing exception denied',
          body: decision === 'approved'
            ? `The pricing/guideline exception on ${ctx ? ctx.label : 'the file'} (EX-${row.exception_seq}) was APPROVED by an administrator${note ? ` — ${String(note).slice(0, 200)}` : ''}.${validityLine} To put it into effect, an admin applies the approved terms in the Term Sheet Studio (admin override) and re-registers the file — the approval itself changes no numbers.`
            : `The pricing/guideline exception on ${ctx ? ctx.label : 'the file'} (EX-${row.exception_seq}) was DENIED by an administrator${note ? ` — ${String(note).slice(0, 200)}` : ''}. The registered product stands exactly as the program prices it.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
          link: `/internal/app/${row.application_id}#sec-pricing`, ctaLabel: 'Open the loan file',
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
            ? `An administrator APPROVED an exception on ${ctx ? ctx.label : 'the file'}${note ? ` — ${String(note).slice(0, 200)}` : ''}. Waived: ${waivedList || 'nothing (already resolved)'}.${requiredList ? ` STILL REQUIRED before the package can send: ${requiredList}.` : ' Every other requirement is met — the package can be sent now.'}${validityLine}`
            : `An administrator DENIED sending the term-sheet package on ${ctx ? ctx.label : 'the file'} early${note ? ` — ${String(note).slice(0, 200)}` : ''}. Finish the outstanding items, then it can be sent.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
          link: `/internal/app/${row.application_id}#sec-esign`, ctaLabel: 'Open the loan file',
        });
      }
    } catch (_) { /* best-effort */ }

    res.json({ ok: true, exception: row });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

// Clear (archive / close out) a HANDLED exception. A super-admin can clear any;
// the person who REQUESTED it can clear their own. An OPEN request can NOT be
// cleared — withdraw or decide it first (clearing used to bury open asks with
// no decision trail). Housekeeping only — it does NOT change the waiver flag.
router.post('/:id/clear', async (req, res) => {
  try {
    const exc = await loanExceptions.getById(req.params.id);
    if (!exc) return res.status(404).json({ error: 'That exception no longer exists.' });
    if (exc.status === 'cleared') return res.status(409).json({ error: 'That exception is already cleared.' });
    if (exc.status === 'requested') {
      return res.status(409).json({ error: 'This exception is still awaiting review — withdraw it (or decide it) instead of clearing it.' });
    }
    // Clearing tracks the decide policy: anyone who can decide (manage_pricing —
    // admins + super-admins) or the person who requested it can archive a handled one.
    const canManage = can(req.actor, 'manage_pricing');
    const isRequester = exc.requested_by && exc.requested_by === req.actor.id;
    if (!canManage && !isRequester) {
      return res.status(403).json({ error: 'Only an admin/super-admin or the person who requested it can clear an exception.' });
    }
    const note = req.body && req.body.note;
    const row = await loanExceptions.clearException(req.params.id, req.actor.id, note);
    if (!row) return res.status(409).json({ error: 'That exception can’t be cleared right now.' });
    auditSafe(req.actor.id, CLEARED_AUDIT[exc.exception_type] || 'loan_exception_cleared', 'application', row.application_id,
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
    auditSafe(req.actor.id, COMMENT_AUDIT[exc.exception_type] || 'loan_exception_comment', 'application', exc.application_id, { exceptionId: exc.id });
    // Notify the OTHER participants (requester + decider + prior commenters) so the
    // conversation reaches whoever isn't the author — the requester hears about a
    // super-admin's comment, and vice-versa. Copy is TYPE-AWARE (a comment on a
    // send-before-CTC or pricing exception used to email guaranty-waiver wording).
    try {
      const participants = (await loanExceptions.commentParticipants(req.params.id))
        .filter((sid) => sid && sid !== req.actor.id);
      const ctx = await notify.fileContext(exc.application_id);
      const typeLabel = (loanExceptions.EXCEPTION_TYPES[exc.exception_type] || {}).label || 'exception';
      let what;
      if (exc.exception_type === 'guaranty_waiver') {
        const subject = [exc.subject_first, exc.subject_last].filter(Boolean).join(' ') || 'the co-borrower';
        what = `the request to waive ${subject}'s personal guaranty`;
      } else if (exc.exception_type === 'esign_before_ctc') {
        what = 'the request to send the term-sheet package before clear-to-close';
      } else if (exc.exception_type === 'pricing_exception') {
        what = 'the pricing/guideline exception request';
      } else {
        what = `the ${typeLabel.toLowerCase()}`;
      }
      const notifType = exc.exception_type === 'guaranty_waiver' ? 'guaranty_exception_comment' : 'exception_comment';
      for (const sid of participants) {
        // The requester reads their queue; a reviewer reads the box.
        const isRequester = !!(exc.requested_by && sid === exc.requested_by);
        const link = isRequester ? '/internal/my-exceptions' : '/internal/exceptions';
        // A reply TO THE REQUESTER on their OWN exception is FORCED (owner-directed
        // 2026-07-29) — the loan officer who raised it can never turn this one off,
        // so a super-admin's "why do you need this exception?" always reaches them.
        // Everyone else on the thread gets the ordinary (disableable) comment type.
        await notify.notifyStaff(sid, {
          type: isRequester ? 'exception_request_reply' : notifType,
          title: isRequester
            ? `Reply on your ${typeLabel.toLowerCase()} exception request`
            : `New comment on a ${typeLabel.toLowerCase()} exception`,
          body: `${req.actor.name || 'A team member'} commented on ${what} on ${ctx ? ctx.label : 'a file'}:\n\n${body.slice(0, 600)}`,
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
      canDecide: can(req.actor, 'manage_pricing') && exc.status === 'requested'
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
