'use strict';

/**
 * Staff credit-report API — mounted INTO the staff router (src/routes/staff.js),
 * so it inherits the staff auth wall (requireAuth + staff role). Individual
 * routes add capability gates on top.
 *
 * Phase 1d (this file, credentials):
 *   GET    /credit/providers            — enabled providers + capabilities (dropdown)
 *   GET    /credit/credentials          — the acting user's own logins (status only; NO secret)
 *   PUT    /credit/credentials          — set/replace the acting user's login (write-only secret)
 *   DELETE /credit/credentials/:pid     — remove the acting user's login for a provider
 *
 * Order/reissue + import routes (Phase 1e) are added below the credential block.
 * Every staffer manages ONLY their own credential — there is no path to read or
 * set another user's login here.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { can } = require('../lib/permissions');
const providers = require('../lib/credit/providers');
const credentials = require('../lib/credit/credentials');
const creditImport = require('../lib/credit/import');
const adverseAction = require('../lib/credit/adverse-action');
const { serveDocument } = require('../lib/serve-document');

// Best-effort audit trail (never blocks the request).
async function audit(req, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,'credit_credential',NULL,$3,$4,$5::jsonb)`,
      [req.actor.id, action, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort */ }
}

const requirePull = (req, res, next) =>
  can(req.actor, 'pull_credit') ? next() : res.status(403).json({ error: 'You do not have permission to pull credit.' });

// Per-file access, mirroring staff.js VISIBLE_OFFICERS_SQL: a see_all_files
// staffer reaches any file; everyone else only files they own / process / are an
// assistant on / are a visible officer for. Keeps a scoped officer from ordering
// or reading credit on another officer's file.
const VISIBLE_OFFICERS_SQL = (alias, p) =>
  `(${alias}.loan_officer_id=${p} OR ${alias}.processor_id=${p}` +
  ` OR ${alias}.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p})` +
  ` OR EXISTS (SELECT 1 FROM application_assignees aa` +
  ` WHERE aa.application_id=${alias}.id AND aa.staff_id=${p} AND aa.removed_at IS NULL))`;
async function canSeeApp(req, appId) {
  if (!appId) return false;
  if (can(req.actor, 'see_all_files')) return true;
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
    [appId, req.actor.id]).catch(() => ({ rows: [] }));
  return !!r.rows[0];
}

// ---- providers -------------------------------------------------------------
router.get('/credit/providers', async (req, res) => {
  try {
    const list = await providers.listEnabled();
    res.json({ providers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- per-user credentials (write-only secret) ------------------------------
router.get('/credit/credentials', async (req, res) => {
  try {
    res.json({ credentials: await credentials.listForUser(req.actor.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/credit/credentials', async (req, res) => {
  const { providerKey, providerId, operatorIdentifier, password } = req.body || {};
  try {
    const out = await credentials.setForUser(req.actor.id, {
      providerKey, providerId, operatorIdentifier, secret: password,
    });
    // Audit records only NON-secret facts (which provider, resulting status).
    await audit(req, 'credit_credential_set', { providerId: out.providerId, providerKey: out.providerKey, status: out.status });
    res.json({ ok: true, status: out.status, message: out.message });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.delete('/credit/credentials/:pid', async (req, res) => {
  try {
    await credentials.removeForUser(req.actor.id, req.params.pid);
    await audit(req, 'credit_credential_removed', { providerId: Number(req.params.pid) });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- order / reissue (BILLABLE — pull_credit only) -------------------------
// Body: { applicationId, product?, action?, creditReportIdentifier?,
//         repositories?, providerKey?, idempotencyKey }. The idempotency key
// makes a double-click / retry bill at most once. Data is imported from the XML;
// the response never includes an SSN or the raw report.
router.post('/credit/order', requirePull, async (req, res) => {
  const b = req.body || {};
  if (!b.applicationId) return res.status(400).json({ error: 'applicationId is required' });
  if (!(await canSeeApp(req, b.applicationId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const out = await creditImport.orderAndImport({
      applicationId: b.applicationId,
      actorId: req.actor.id,
      product: b.product,
      action: b.action,
      mismoVersion: b.mismoVersion,   // '2.3.1' | '3.4'; defaults to config
      creditReportIdentifier: b.creditReportIdentifier,
      repositories: b.repositories,
      providerKey: b.providerKey,
      providerId: b.providerId,
      // A fresh key per click (client sends one; else random) so a legitimate
      // retry is a NEW intent — never a deterministic key that replays a prior
      // failure forever. Same-click double-fires reuse the client key + the
      // in-flight window collapses them.
      idempotencyKey: (b.idempotencyKey && String(b.idempotencyKey).trim()) || require('crypto').randomUUID(),
    });
    await audit(req, 'credit_order', { applicationId: b.applicationId, reportId: out.reportId, status: out.status,
      representativeScore: out.representativeScore, froze: out.froze, deduped: !!out.deduped });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, kind: e.kind, retriable: !!e.retriable, reportId: e.reportId || null });
  }
});

// ---- report views (staff) --------------------------------------------------
// Reports for one file (most recent first), each with its per-bureau scores.
router.get('/credit/reports', requirePull, async (req, res) => {
  const appId = req.query.applicationId;
  if (!appId) return res.status(400).json({ error: 'applicationId is required' });
  if (!(await canSeeApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const reports = (await db.query(
      `SELECT id, credit_report_identifier, report_type, other_description, request_type, action_type,
              first_issued_date, last_updated_date, representative_score, representative_bracket,
              status, review_reason, bureau_status, underwriting_finding, error_detail, mismo_version,
              underwriting_finding_reconciled_at, underwriting_finding_reconciled_by, underwriting_finding_reconcile_note,
              pdf_document_id, created_at, completed_at
         FROM credit_reports WHERE application_id=$1 ORDER BY created_at DESC, id DESC`, [appId])).rows;
    const ids = reports.map((r) => r.id);
    let scores = [];
    if (ids.length) {
      scores = (await db.query(
        `SELECT credit_report_id, report_borrower_id, borrower_id, bureau, model, value, usable, reason, exclusion_reason, factors, score_date
           FROM credit_scores WHERE credit_report_id = ANY($1) ORDER BY report_borrower_id, bureau`, [ids])).rows;
    }
    const byReport = new Map(reports.map((r) => [r.id, { ...r, scores: [] }]));
    for (const s of scores) { const r = byReport.get(s.credit_report_id); if (r) r.scores.push(s); }
    res.json({ reports: [...byReport.values()] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The manual-review queue: reports needing a human — a frozen bureau / no score /
// vendor error ('review'), PLUS 'in_doubt' orders (timed out; the vendor may have
// billed) that need reconciliation before a re-order. Company-wide for staff who
// pull credit; scoped officers see only their own files.
router.get('/credit/review-queue', requirePull, async (req, res) => {
  try {
    const scoped = !can(req.actor, 'see_all_files');
    const rows = (await db.query(
      `SELECT cr.id, cr.application_id, cr.representative_score, cr.review_reason, cr.status, cr.created_at,
              b.first_name, b.last_name
         FROM credit_reports cr
         LEFT JOIN applications a ON a.id = cr.application_id
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE cr.status IN ('review','in_doubt')
          ${scoped ? `AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$1')}` : ''}
        ORDER BY cr.created_at DESC LIMIT 200`,
      scoped ? [req.actor.id] : [])).rows;
    res.json({ queue: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Integration health (see_all_files): in-flight / in-doubt counts + a 24h
// outcome + latency summary from the append-only event log. Read-only.
router.get('/credit/health', requirePull, async (req, res) => {
  if (!can(req.actor, 'see_all_files')) return res.status(403).json({ error: 'forbidden' });
  try {
    const [state, outcomes24, latency] = await Promise.all([
      db.query(`SELECT count(*) FILTER (WHERE status='in_doubt')::int AS in_doubt,
                       count(*) FILTER (WHERE status='ordering')::int AS ordering,
                       count(*) FILTER (WHERE status='review')::int AS review,
                       count(*) FILTER (WHERE status='imported' AND completed_at > now()-interval '24 hours')::int AS imported_24h
                  FROM credit_reports`),
      db.query(`SELECT outcome, count(*)::int AS n FROM credit_order_events
                 WHERE created_at > now()-interval '24 hours' AND phase IN ('post','error','in_doubt','parse')
                 GROUP BY outcome ORDER BY n DESC`),
      db.query(`SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
                       percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
                  FROM credit_order_events WHERE phase='post' AND latency_ms IS NOT NULL AND created_at > now()-interval '24 hours'`),
    ]);
    res.json({ state: state.rows[0], outcomes24h: outcomes24.rows, latencyMs: latency.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Serve a report PDF (staff, inline). The PDF is stored staff_only; staff view it here.
router.get('/credit/reports/:id/pdf', requirePull, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT d.*, cr.application_id FROM credit_reports cr JOIN documents d ON d.id = cr.pdf_document_id WHERE cr.id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'no PDF for this report' });
    if (!(await canSeeApp(req, r.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    await audit(req, 'credit_report_pdf_view', { reportId: req.params.id });
    return serveDocument(res, r.rows[0], { inline: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- adverse-action DRAFT scaffolding (compliance review ONLY — never sends) --
// RTL loans are business-purpose (ECOA/Reg B business-credit path). These routes
// materialize a STRUCTURED DRAFT for a human compliance reviewer to edit + decide;
// nothing here issues, delivers, or finalizes a notice. A guarantor is generally
// NOT owed a notice — the draft body flags that. Per-file access + capability gated.
const AA_DECISIONS = new Set(['declined', 'counteroffer', 'incomplete']);

// Create a draft for a file+borrower (auto-seeds the principal reasons from the
// bureau factor codes; the reviewer confirms/edits). Never sends.
router.post('/credit/adverse-action', requirePull, async (req, res) => {
  const b = req.body || {};
  if (!b.applicationId) return res.status(400).json({ error: 'applicationId is required' });
  if (!(await canSeeApp(req, b.applicationId))) return res.status(403).json({ error: 'forbidden' });
  const decision = b.decision == null ? 'declined' : String(b.decision);
  if (!AA_DECISIONS.has(decision)) return res.status(400).json({ error: 'decision must be declined, counteroffer, or incomplete' });
  try {
    // The borrower (if given) must actually be on THIS file — never draft for an unrelated borrower.
    if (b.borrowerId) {
      const on = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [b.applicationId, b.borrowerId]);
      if (!on.rows[0]) return res.status(400).json({ error: 'that borrower is not on this file' });
    }
    // The report (if given) must belong to this file too.
    if (b.creditReportId) {
      const rr = await db.query(`SELECT 1 FROM credit_reports WHERE id=$1 AND application_id=$2`, [b.creditReportId, b.applicationId]);
      if (!rr.rows[0]) return res.status(400).json({ error: 'that credit report is not on this file' });
    }
    const id = await adverseAction.draftForApplication({
      applicationId: b.applicationId, borrowerId: b.borrowerId || null, creditReportId: b.creditReportId || null,
      decision, principalReasons: Array.isArray(b.principalReasons) ? b.principalReasons : [],
      partyRole: b.partyRole, actorId: req.actor.id,
    });
    await audit(req, 'credit_adverse_action_draft', { applicationId: b.applicationId, borrowerId: b.borrowerId || null, letterId: id, decision });
    const row = (await db.query(
      `SELECT id, borrower_id, credit_report_id, decision, principal_reasons, scores_disclosed, notice_body, party_role, status, created_at
         FROM adverse_action_letters WHERE id=$1`, [id])).rows[0];
    res.json({ ok: true, draft: row });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// List drafts for a file (compliance review).
router.get('/credit/adverse-action', requirePull, async (req, res) => {
  const appId = req.query.applicationId;
  if (!appId) return res.status(400).json({ error: 'applicationId is required' });
  if (!(await canSeeApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const rows = (await db.query(
      `SELECT id, borrower_id, credit_report_id, decision, principal_reasons, scores_disclosed, notice_body, party_role, status, created_at
         FROM adverse_action_letters WHERE application_id=$1 ORDER BY created_at DESC`, [appId])).rows;
    res.json({ drafts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Advance a draft through the REVIEW workflow only — 'reviewed' or 'cancelled'.
// Issuance/delivery is intentionally NOT here: this scaffold never sends a notice.
router.patch('/credit/adverse-action/:id', requirePull, async (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (!['reviewed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'status must be reviewed or cancelled (issuing/sending is not done here)' });
  try {
    const row = (await db.query(`SELECT application_id FROM adverse_action_letters WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'draft not found' });
    if (!(await canSeeApp(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
    await db.query(`UPDATE adverse_action_letters SET status=$2, reviewed_by=$3, reviewed_at=now() WHERE id=$1`, [req.params.id, status, req.actor.id]);
    // The letter id is a uuid — keep it as a string. Number(uuid) is NaN, which
    // serializes to null and erases WHICH draft was acted on from the compliance
    // (GLBA) audit trail.
    await audit(req, 'credit_adverse_action_status', { letterId: req.params.id, status });
    res.json({ ok: true, status });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---- reconcile a fatal FICO-mismatch finding (documented exception) ---------
// A fatal FICO-mismatch finding (the verified representative score lands in a
// different pricing bracket than the claimed score the loan was structured on)
// HARD-blocks completing the credit condition (signOffGate + the db/168 trigger).
// The normal resolution is to correct the file and re-pull — a fresh, matching
// report clears the finding on its own. This route is the deliberate escape
// hatch: an underwriter/processor attests the discrepancy is understood and
// accepted, which clears the gate WITHOUT changing the verified score. A short
// note is required (it lands in the audit trail), and it can be undone.
router.post('/credit/reconcile-finding', requirePull, async (req, res) => {
  const b = req.body || {};
  const reportId = b.creditReportId;
  if (!reportId) return res.status(400).json({ error: 'creditReportId is required' });
  // Reconciling a fatal underwriting finding is an underwriting decision — a
  // higher bar than merely pulling credit. Require the sign-off capability (the
  // same processors/underwriters/admins who complete conditions).
  if (!can(req.actor, 'sign_off_conditions')) {
    return res.status(403).json({ error: 'Only a processor or underwriter can reconcile a credit finding.' });
  }
  try {
    const r = (await db.query(
      `SELECT application_id, underwriting_finding FROM credit_reports WHERE id=$1`, [reportId])).rows[0];
    if (!r) return res.status(404).json({ error: 'report not found' });
    if (!(await canSeeApp(req, r.application_id))) return res.status(403).json({ error: 'forbidden' });

    if (b.undo === true) {
      await db.query(
        `UPDATE credit_reports
            SET underwriting_finding_reconciled_at=NULL, underwriting_finding_reconciled_by=NULL,
                underwriting_finding_reconcile_note=NULL
          WHERE id=$1`, [reportId]);
      await audit(req, 'credit_finding_reconcile_undo', { creditReportId: reportId, applicationId: r.application_id });
      return res.json({ ok: true, reconciled: false });
    }

    const f = r.underwriting_finding;
    if (!f || typeof f !== 'object' || f.severity !== 'fatal') {
      return res.status(422).json({ error: 'this report has no unresolved fatal finding to reconcile' });
    }
    const note = String(b.note || '').trim();
    if (!note) return res.status(400).json({ error: 'a short note explaining the reconciliation is required' });
    await db.query(
      `UPDATE credit_reports
          SET underwriting_finding_reconciled_at=now(), underwriting_finding_reconciled_by=$2,
              underwriting_finding_reconcile_note=$3
        WHERE id=$1`, [reportId, req.actor.id, note]);
    await audit(req, 'credit_finding_reconcile', { creditReportId: reportId, applicationId: r.application_id, note });
    res.json({ ok: true, reconciled: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
module.exports.requirePull = requirePull;
