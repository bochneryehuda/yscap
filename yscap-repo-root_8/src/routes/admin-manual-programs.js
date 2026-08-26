'use strict';

/**
 * Manual Program admin + the super-admin ESCALATION box (owner-directed
 * 2026-07-20). Mounted at /api/admin/manual-programs behind requireAuth +
 * requireStaff (see server.js). Individual routes add their own capability/role
 * gate:
 *   • GET/PUT  /settings           — manage_pricing (the Manual Program config:
 *                                     default LTV/LTC/ARV ceilings + REQUIRED
 *                                     default liquidity months).
 *   • GET      /escalations        — manage_pricing (admins/super-admins).
 *   • GET      /escalations/count  — pending count for the nav badge.
 *   • POST     /escalations/:id/decide  — manage_pricing, but never your OWN
 *   • POST     /escalations/:id/counter   request (owner-directed 2026-07-27;
 *                                         see mayDecide below).
 */

const router = require('express').Router();
const db = require('../db');
const { requirePermission } = require('../auth');
const perms = require('../lib/permissions');
const manualProgram = require('../lib/manual-program');
const notify = require('../lib/notify');
const pricing = require('../lib/pricing');
// The ONE composer for every pricing / exception email — the decision is rendered by the same
// module that rendered the request (owner-directed 2026-08-07).
const pricingEmail = require('../lib/email/pricing-email');

/**
 * WHO may decide an escalation (owner-directed 2026-07-27 — "this should be sent
 * to the admin for approval"). Widened from super-admin-only to any holder of
 * `manage_pricing` (admins + super-admins), matching the loan-exception register,
 * with ONE independent control kept: you can never approve your OWN request.
 *
 * The super-admin is exempt from that control on purpose — they are the top
 * authority and, in a one-super-admin shop, requiring a second approver would be
 * a dead end with no way out. Every decision is audited either way. Changing WHO
 * decides is an owner call; do not narrow or widen this without one.
 */
function mayDecide(actor, row) {
  if (!actor || actor.kind !== 'staff') return false;
  if (!perms.can(actor, 'manage_pricing')) return false;
  if (actor.role === 'super_admin') return true;
  return !(row && row.requested_by && String(row.requested_by) === String(actor.id));
}

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
    const status = ['open', 'pending', 'countered', 'approved', 'declined', 'all'].includes(req.query.status) ? req.query.status : 'open';
    /* NO SILENT CAP, the same rule as the exception register: a screen printing
       `rows.length` beside "showing matches for …" reads a LIMIT as a COUNT.
       Ask for one MORE than the page and drop it, so the next page is MEASURED
       rather than inferred from a full one — a full page can equally BE the
       whole answer. */
    const PAGE = 100;
    const [raw, pending] = await Promise.all([
      // Loan number / address / borrower — the same search the exception register takes.
      manualProgram.listEscalations({ status, q: String(req.query.q || '').trim(), limit: PAGE + 1 }),
      manualProgram.pendingCount(),
    ]);
    const hasMore = raw.length > PAGE;
    const rows = hasMore ? raw.slice(0, PAGE) : raw;
    // Never leak the note-buyer name into the box — the summary/overrides carry
    // only leverage numbers, and the property/loan identity is staff-only anyway.
    // canDecide: any admin / super-admin may decide (owner-directed 2026-07-27 —
    // "sent to the admin for approval"); per-row, you can never approve your OWN
    // request unless you are the super-admin (see mayDecide below).
    res.json({
      escalations: rows.map((r) => ({ ...r, canDecide: mayDecide(req.actor, r) })),
      hasMore,
      pageSize: PAGE,
      pendingCount: pending,
      canDecide: perms.can(req.actor, 'manage_pricing'),
      viewerId: req.actor.id,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/escalations/count', requirePermission('manage_pricing'), async (req, res) => {
  try { res.json({ pendingCount: await manualProgram.pendingCount() }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/escalations/:id/decide', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const decision = req.body && req.body.decision === 'approved' ? 'approved' : 'declined';
    const note = req.body && req.body.note;
    // Requester ≠ approver: re-read the row and refuse BEFORE deciding, so an
    // admin can never bless their own exception (super-admin exempt — see
    // mayDecide). Checked server-side; the UI hiding the buttons is not the gate.
    const open = (await db.query(`SELECT id, requested_by FROM manual_program_escalations WHERE id=$1`, [req.params.id])).rows[0];
    if (!open) return res.status(409).json({ error: 'This escalation was already decided or no longer exists.' });
    if (!mayDecide(req.actor, open)) {
      return res.status(403).json({ error: 'You requested this exception — someone else has to approve or decline it.' });
    }
    const row = await manualProgram.decideEscalation(req.params.id, decision, req.actor.id, note);
    if (!row) return res.status(409).json({ error: 'This escalation was already decided or no longer exists.' });
    auditSafe(req.actor.id, 'manual_program_escalation_decided', 'application', row.application_id,
      { escalationId: row.id, decision, note: note ? String(note).slice(0, 200) : null });
    // Tell the loan team the verdict (best-effort, in-app + email to the file's team).
    try {
      // SAY WHAT WAS ACTUALLY APPROVED (owner-directed 2026-08-07: *"emails like this should
      // clearly show what exception was approved, nicely laid out"*). The old copy — "The
      // manual-review exception on <file> was approved by a super-admin" — told the reader that an
      // exception existed, not WHICH one, even though the escalation row has carried the full
      // structured change list (`summary.overrideChanges` / `overrideLines` / `manualReasons`)
      // since the day it was opened. It is rendered by the SAME composer that built the request,
      // so the approval and the thing approved can never describe themselves differently.
      const sum = (row.summary && typeof row.summary === 'object') ? row.summary : {};
      const ctx = await notify.fileContext(row.application_id, []);
      const built = pricingEmail.approvalDecidedEmail({
        kind: sum.kind || 'manual_review',
        decision,
        decidedBy: 'a super-admin',
        note: note ? String(note).slice(0, 500) : null,
        deal: {
          loanAmount: sum.totalLoan,
          noteRate: sum.noteRate != null ? require('../lib/rate-format').fmtRatePct(sum.noteRate) + '%' : null,
          programLabel: sum.program ? pricing.PROGRAM_LABEL[sum.program] || sum.program : null,
          productLabel: sum.productLabel,
          acqLtvPct: sum.acqLtvPct != null ? Number(sum.acqLtvPct) * 100 : null,
          arvPct: sum.arvPct != null ? Number(sum.arvPct) * 100 : null,
          ltcPct: sum.ltcPct != null ? Number(sum.ltcPct) * 100 : null,
          assetMonths: sum.assetMonths,
        },
        overrideChanges: sum.overrideChanges || [],
        overrideLines: sum.overrideLines || [],
        manualReasons: sum.manualReasons || [],
      });
      await notify.notifyAppStaff(row.application_id, {
        type: 'manual_escalation_decided',
        ...built,
        meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
        link: `/internal/app/${row.application_id}`, ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }

    // On APPROVAL the terms are CONFIRMED — now (and only now) send the borrower
    // their "your loan terms are ready" email, which was withheld at registration
    // because the file needed super-admin sign-off (owner-directed 2026-07-21). A
    // decline sends the borrower nothing. Best-effort; never breaks the decision.
    if (decision === 'approved') {
      try {
        // ALSO withheld while a fatal appraisal finding is open (owner-directed
        // 2026-07-31: appraisal fatals hold off generating term sheets; pre-merge
        // audit #1 — this door bypassed the register routes' hold). Fails open.
        const apprHold = await require('../lib/underwriting/appraisal-advisory').appraisalTermSheetHold(db, row.application_id);
        const rq = await db.query(
          `SELECT quote, inputs, total_loan FROM product_registrations
            WHERE id=$1 AND is_current`, [row.registration_id]);
        const reg = rq.rows[0];
        if (reg && !apprHold) {
          const quote = typeof reg.quote === 'string' ? JSON.parse(reg.quote) : reg.quote;
          const inputs = typeof reg.inputs === 'string' ? JSON.parse(reg.inputs) : (reg.inputs || {});
          await require('../lib/terms-notify').sendBorrowerTerms(row.application_id, {
            quote, total: Number(reg.total_loan), termMonths: inputs && inputs.term,
          });
        }
      } catch (_) { /* borrower terms email is best-effort */ }
    }
    // Take the escalation hand-off off the super-admin Workflow now that it's
    // decided (best-effort).
    try { await require('../lib/workflow-automation').closeEscalationWorkflow(row.application_id, decision === 'approved' ? 'Approved' : 'Declined'); } catch (_) {}
    res.json({ ok: true, escalation: row });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

/* The countered terms, in plain words. Ratios (LTV/LTC/rate/points) arrive as 0–1 fractions from
   the escalation screen; the loan amount as dollars. An unrecognised or non-numeric entry is
   dropped rather than printed as "NaN%" — a wrong number in a counter-offer email is worse than
   an omitted one (the note still carries the admin's own words). */
function counterTermLines(terms) {
  const t = terms && typeof terms === 'object' ? terms : {};
  const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(3).replace(/\.?0+$/, '')}%` : null);
  const usd = (v) => (Number.isFinite(Number(v)) ? `$${Math.round(Number(v)).toLocaleString('en-US')}` : null);
  const defs = [
    ['maxAcqLtv', 'Max purchase advance (LTV)', pct],
    ['maxArvLtv', 'Max of after-repair value (ARV)', pct],
    ['maxLtc', 'Max of total cost (LTC)', pct],
    ['noteRate', 'Interest rate', pct],
    ['origPct', 'Origination points', pct],
    ['loanAmount', 'Loan amount', usd],
  ];
  const out = [];
  for (const [key, label, fmt] of defs) {
    if (t[key] == null || t[key] === '') continue;
    const v = fmt(t[key]);
    if (v != null) out.push({ label, value: v });
  }
  return out;
}

// Counter-offer an escalation (owner-directed 2026-07-21). Super-admin only —
// records the proposed terms + a plain-language note, moves the escalation to
// `countered` (still on the queue, awaiting the loan officer's action), and
// notifies the loan team with the exact counter-offer.
router.post('/escalations/:id/counter', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const counterTerms = req.body && typeof req.body.counterTerms === 'object' && req.body.counterTerms ? req.body.counterTerms : {};
    const counterNote  = req.body && req.body.counterNote;
    if (!counterNote || !String(counterNote).trim()) {
      return res.status(400).json({ error: 'Add a plain-language note explaining the counter-offer so the loan officer knows what you would accept.' });
    }
    // Same requester ≠ approver control as decide — a counter-offer is a decision.
    const open = (await db.query(`SELECT id, requested_by FROM manual_program_escalations WHERE id=$1`, [req.params.id])).rows[0];
    if (!open) return res.status(409).json({ error: 'This escalation was already decided or no longer exists.' });
    if (!mayDecide(req.actor, open)) {
      return res.status(403).json({ error: 'You requested this exception — someone else has to counter, approve or decline it.' });
    }
    const row = await manualProgram.counterEscalation(req.params.id, req.actor.id, { counterTerms, counterNote });
    if (!row) return res.status(409).json({ error: 'This escalation was already decided or no longer exists.' });
    auditSafe(req.actor.id, 'manual_program_escalation_countered', 'application', row.application_id,
      { escalationId: row.id, counterTerms, counterNote: String(counterNote).slice(0, 400) });
    // Notify the file's team — redesigned (owner-directed 2026-08-10, "the counter-offer
    // notification was not redesigned"): the PROPOSED TERMS are itemized as their own rows
    // (the old body carried only the free-text note, so the numbers the whole message is
    // about never appeared), the note rides underneath in plain words, and the next step is
    // one short sentence. `counterTermLines` is the ONE place a counterTerms blob becomes
    // human wording — the email and any future surface must read it from here.
    try {
      const termLines = counterTermLines(counterTerms);
      const ctx = await notify.fileContext(row.application_id, [
        ...termLines.map((l) => ({ label: l.label, value: l.value })),
        { label: 'Counter-offer', value: 'Awaiting your action' },
      ]);
      const termText = termLines.length ? `\n\nWhat they proposed:\n${termLines.map((l) => `• ${l.label}: ${l.value}`).join('\n')}` : '';
      await notify.notifyAppStaff(row.application_id, {
        type: 'manual_escalation_countered',
        title: 'Counter-offer on your pricing exception',
        body: `The admin did not approve the exception as requested — they proposed terms they WOULD accept.${termText}\n\nTheir note: ${String(counterNote).slice(0, 800)}\n\nTo accept, re-register the product with the countered terms; or request a new exception with different numbers.`,
        meta: (ctx && ctx.meta) || undefined, applicationId: row.application_id,
        link: `/internal/app/${row.application_id}`, ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, escalation: row });
  } catch (e) { res.status(500).json({ error: 'could not record the counter-offer' }); }
});

module.exports = router;
