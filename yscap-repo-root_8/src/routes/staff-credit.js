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
const { can, VISIBLE_OFFICERS_SQL } = require('../lib/permissions');
const providers = require('../lib/credit/providers');
const credentials = require('../lib/credit/credentials');
const { summarizeRisk } = require('../lib/credit/risk-summary');
const { compareReports } = require('../lib/credit/compare');
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

// Per-file access uses the shared VISIBLE_OFFICERS_SQL (imported from
// ../lib/permissions — ONE canonical definition, never re-inlined): a
// see_all_files staffer reaches any file; everyone else only files they own /
// process / are an assistant on / are a visible officer for. Keeps a scoped
// officer from ordering or reading credit on another officer's file.
async function canSeeApp(req, appId) {
  if (!appId) return false;
  if (can(req.actor, 'see_all_files')) return true;
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
    [appId, req.actor.id]).catch(() => ({ rows: [] }));
  return !!r.rows[0];
}

// Load every stored "block" for ONE report, MASKED-ONLY. This is the single
// source of the block SELECTs — the detail endpoint AND the compare endpoint
// both call it, so neither can accidentally reach the encrypted account column
// or a raw reported-SSN/PAN. Account numbers come back as last-4 masks only; the
// encrypted `account_identifier_encrypted` and the raw audit jsonb are NEVER
// selected here.
async function loadReportBlocks(reportId) {
  const [scores, tradelines, inquiries, publicRecords, collections, identities, alerts] = await Promise.all([
    db.query(
      `SELECT credit_report_id, report_borrower_id, borrower_id, bureau, model, value, usable, reason, exclusion_reason, factors, score_date
         FROM credit_scores WHERE credit_report_id=$1 ORDER BY report_borrower_id, bureau`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, creditor_name, creditor_address, account_type,
              account_ownership_type, account_status_type, account_identifier_masked,
              unpaid_balance, credit_limit, high_credit, monthly_payment, past_due_amount, charge_off_amount,
              date_opened, date_reported, date_closed, last_activity_date, months_reviewed_count,
              current_rating_code, current_rating_type, late_30_count, late_60_count, late_90_count,
              payment_pattern, derogatory_indicator, is_collection, is_authorized_user
         FROM credit_tradelines WHERE credit_report_id=$1
        ORDER BY is_collection DESC, derogatory_indicator DESC NULLS LAST, creditor_name`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, inquiry_date, inquiring_party_name, business_type, loan_type
         FROM credit_inquiries WHERE credit_report_id=$1 ORDER BY inquiry_date DESC NULLS LAST`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, record_type, filed_date, reported_date,
              disposition_type, disposition_date, amount, court_name, docket_identifier, plaintiff_name, derogatory_indicator
         FROM credit_public_records WHERE credit_report_id=$1 ORDER BY filed_date DESC NULLS LAST`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, collection_agency_name, original_creditor_name, amount, status, date_reported
         FROM credit_collections WHERE credit_report_id=$1 ORDER BY date_reported DESC NULLS LAST`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, reported_name, aliases, dob, ssn_masked,
              current_address, former_addresses, employers, infile_date, alert_messages
         FROM credit_report_identities WHERE credit_report_id=$1`, [reportId]),
    db.query(
      `SELECT id, borrower_id, report_borrower_id, bureau, category, raw_type, message_text
         FROM credit_alerts WHERE credit_report_id=$1 ORDER BY category`, [reportId]),
  ]);
  return {
    scores: scores.rows, tradelines: tradelines.rows, inquiries: inquiries.rows,
    publicRecords: publicRecords.rows, collections: collections.rows,
    identities: identities.rows, alerts: alerts.rows,
  };
}

// ---- providers -------------------------------------------------------------
router.get('/credit/providers', async (req, res) => {
  try {
    const list = await providers.listEnabled();
    res.json({ providers: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- per-user credentials (write-only secret) ------------------------------
// Gated on pull_credit: only staff who can actually pull credit have any use for
// a Xactus login, and the write path can fire a live vendor auth probe
// (XACTUS_VERIFY_ON_SAVE) — keep that behind the same capability so a staffer who
// can't pull credit can't use it as a credential-testing oracle.
router.get('/credit/credentials', requirePull, async (req, res) => {
  try {
    res.json({ credentials: await credentials.listForUser(req.actor.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/credit/credentials', requirePull, async (req, res) => {
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

router.delete('/credit/credentials/:pid', requirePull, async (req, res) => {
  try {
    await credentials.removeForUser(req.actor.id, req.params.pid);
    await audit(req, 'credit_credential_removed', { providerId: Number(req.params.pid) });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// "Test my login" (E4): probe the acting user's OWN saved login against the
// provider's no-charge verify endpoint and persist the result. Never billable;
// only ever tests the caller's own credential (no id in the body can widen it).
router.post('/credit/credentials/test', requirePull, async (req, res) => {
  const b = req.body || {};
  try {
    const out = await credentials.verifyForUser(req.actor.id, b.providerId, { providerKey: b.providerKey });
    await audit(req, 'credit_credential_test', { providerId: out.providerId, status: out.status });
    res.json({ ok: out.ok, status: out.status, message: out.message, lastVerifiedAt: out.lastVerifiedAt });
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

// ---- FULL report detail (E3): every "block" for the detail interface --------
// The report + per-bureau scores + tradelines / inquiries / public records /
// collections / bureau-reported identity / alerts + the findings, for ONE report.
// Gated (pull_credit + canSeeApp) and AUDITED on open. SECURITY: account numbers
// are returned MASKED only (last-4) — the encrypted column and the raw audit blobs
// are NEVER selected, so no full PAN or reported SSN ever reaches the wire.
router.get('/credit/reports/:id/detail', requirePull, async (req, res) => {
  const reportId = req.params.id;
  try {
    const report = (await db.query(
      `SELECT id, application_id, credit_report_identifier, report_type, other_description, request_type, action_type,
              first_issued_date, last_updated_date, representative_score, representative_bracket,
              status, review_reason, bureau_status, underwriting_finding, error_detail, mismo_version,
              underwriting_finding_reconciled_at, underwriting_finding_reconciled_by, underwriting_finding_reconcile_note,
              pdf_document_id, created_at, completed_at
         FROM credit_reports WHERE id=$1`, [reportId])).rows[0];
    if (!report) return res.status(404).json({ error: 'report not found' });
    if (!(await canSeeApp(req, report.application_id))) return res.status(403).json({ error: 'forbidden' });

    const { scores, tradelines, inquiries, publicRecords, collections, identities, alerts } = await loadReportBlocks(reportId);

    // Names for the per-borrower tabs (from the file's borrowers, not the report).
    const bIds = [...new Set([...scores, ...tradelines, ...identities, ...alerts].map((x) => x.borrower_id).filter(Boolean))];
    const borrowerNames = {};
    if (bIds.length) {
      for (const b of (await db.query(`SELECT id, first_name, last_name FROM borrowers WHERE id = ANY($1)`, [bIds])).rows) {
        borrowerNames[b.id] = `${b.first_name || ''} ${b.last_name || ''}`.trim();
      }
    }

    await audit(req, 'credit_report_detail_view', { creditReportId: reportId, applicationId: report.application_id });
    // Advisory risk summary (E5-safe) computed server-side from the blocks — an
    // overall snapshot + a per-borrower breakdown (never gates; the alerts do).
    const riskSummary = summarizeRisk({ tradelines, collections, inquiries, publicRecords });
    const riskByBorrower = {};
    for (const bid of bIds) {
      riskByBorrower[bid] = summarizeRisk({
        tradelines: tradelines.filter((t) => t.borrower_id === bid),
        collections: collections.filter((c) => c.borrower_id === bid),
        inquiries: inquiries.filter((q) => q.borrower_id === bid),
        publicRecords: publicRecords.filter((p) => p.borrower_id === bid),
      });
    }

    res.json({ report, scores, tradelines, inquiries, publicRecords, collections, identities, alerts, borrowerNames, riskSummary, riskByBorrower });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- RE-PULL COMPARISON (E6): "what changed since the last pull" ------------
// This is a REISSUE feature — when a report is re-pulled, the underwriter's first
// question is "what moved since we last looked?" This diffs THIS report against
// the most recent EARLIER IMPORTED report for the same file: score moves (+
// pricing-bracket crossings), collections / public records cleared or newly
// appeared, new derogatory accounts + inquiries, utilization shift, and — the
// most useful bit — which fraud/OFAC/FICO findings CLEARED (the human story
// behind the gate's "a clean re-pull supersedes an earlier fatal" rule).
// ADVISORY (never gates). Gated (pull_credit + canSeeApp), masked-only (reuses
// loadReportBlocks), and AUDITED on open. Returns {hasPrevious:false} when this
// report isn't an imported one or there's no earlier imported report to diff.
router.get('/credit/reports/:id/compare', requirePull, async (req, res) => {
  const reportId = req.params.id;
  try {
    const cur = (await db.query(
      `SELECT id, application_id, credit_report_identifier, mismo_version, representative_score,
              representative_bracket, status, underwriting_finding, underwriting_finding_reconciled_at, created_at
         FROM credit_reports WHERE id=$1`, [reportId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'report not found' });
    if (!(await canSeeApp(req, cur.application_id))) return res.status(403).json({ error: 'forbidden' });

    // The previous IMPORTED report for this file, created strictly before this one
    // (a review/error re-pull has no blocks to diff, so it's skipped as a base).
    const prev = (await db.query(
      `SELECT id, application_id, credit_report_identifier, mismo_version, representative_score,
              representative_bracket, status, underwriting_finding, underwriting_finding_reconciled_at, created_at
         FROM credit_reports
        WHERE application_id=$1 AND status='imported' AND (created_at, id) < ($3, $2)
        ORDER BY created_at DESC, id DESC LIMIT 1`, [cur.application_id, cur.id, cur.created_at])).rows[0];

    // A comparison only makes sense when THIS report imported (has blocks) AND
    // there's an earlier imported report to compare against.
    if (cur.status !== 'imported' || !prev) {
      await audit(req, 'credit_report_compare_view', { creditReportId: reportId, applicationId: cur.application_id, hasPrevious: false });
      return res.json({ hasPrevious: false });
    }

    const [curBlocks, prevBlocks] = await Promise.all([loadReportBlocks(cur.id), loadReportBlocks(prev.id)]);
    const result = compareReports({ report: cur, ...curBlocks }, { report: prev, ...prevBlocks });
    await audit(req, 'credit_report_compare_view', { creditReportId: reportId, applicationId: cur.application_id, previousReportId: prev.id, hasPrevious: true, changed: !!result.changed });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The manual-review queue: everything that needs an underwriter's eyes —
//   (a) a frozen bureau / no score / vendor error ('review') + a timed-out order
//       ('in_doubt', may have billed) that needs reconciling before a re-order;
//   (b) an IMPORTED report that pulled fine but is BLOCKED by an unreconciled
//       FATAL finding (a FICO mismatch OR a fraud / OFAC / deceased / SSN /
//       address bureau alert). E2 leaves those at status='imported', so without
//       this they'd never show in the queue. Uses the SAME "latest imported has
//       an active fatal" signal the sign-off gate blocks on.
// Company-wide for staff who pull credit; scoped officers see only their files.
router.get('/credit/review-queue', requirePull, async (req, res) => {
  try {
    const scoped = !can(req.actor, 'see_all_files');
    const underwriting = require('../lib/credit/underwriting');
    // deleted_at IS NULL is UNCONDITIONAL (never surface a soft-deleted file); the
    // officer-visibility clause is added only for scoped staff.
    const scopeSql = scoped ? `AND ${VISIBLE_OFFICERS_SQL('a', '$1')}` : '';
    const params = scoped ? [req.actor.id] : [];

    // (a) status-based review items — a frozen/no-score 'review' or a timed-out
    // 'in_doubt'. Only when it's STILL the current state: a later successful
    // IMPORTED re-pull supersedes it (matches the gate; keeps stale rows out).
    const reviewRows = (await db.query(
      `SELECT cr.id, cr.application_id, cr.representative_score, cr.review_reason, cr.status, cr.created_at,
              b.first_name, b.last_name
         FROM credit_reports cr
         JOIN applications a ON a.id = cr.application_id AND a.deleted_at IS NULL
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE cr.status IN ('review','in_doubt')
          AND NOT EXISTS (
            SELECT 1 FROM credit_reports later
             WHERE later.application_id = cr.application_id AND later.status = 'imported'
               AND (later.created_at, later.id) > (cr.created_at, cr.id))
          ${scopeSql}
        ORDER BY cr.created_at DESC LIMIT 200`, params)).rows
      .map((r) => ({ ...r, kind: r.status, reason: r.review_reason }));

    // (b) the LATEST imported report per file, kept ONLY when it carries an active
    // fatal finding — filtered IN SQL via credit_active_fatal_count (db/214) so the
    // set is already just the blocked files (no LIMIT-before-filter that could hide
    // blocked files at scale). Matches the gate: a later clean import supersedes.
    const findingRows = (await db.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (cr.application_id)
                cr.id, cr.application_id, cr.representative_score, cr.status, cr.created_at,
                cr.underwriting_finding, cr.underwriting_finding_reconciled_at, b.first_name, b.last_name
           FROM credit_reports cr
           JOIN applications a ON a.id = cr.application_id AND a.deleted_at IS NULL
           LEFT JOIN borrowers b ON b.id = a.borrower_id
          WHERE cr.status = 'imported' ${scopeSql}
          ORDER BY cr.application_id, cr.created_at DESC, cr.id DESC
       ) latest
       WHERE credit_active_fatal_count(latest.underwriting_finding, latest.underwriting_finding_reconciled_at) > 0
       ORDER BY latest.created_at DESC LIMIT 200`, params)).rows
      .map((r) => {
        const fatal = underwriting.activeFatalFindings(r.underwriting_finding, r.underwriting_finding_reconciled_at);
        return {
          id: r.id, application_id: r.application_id, representative_score: r.representative_score,
          status: r.status, created_at: r.created_at, first_name: r.first_name, last_name: r.last_name,
          kind: 'finding', reason: fatal.map((f) => f.message).join(' • '),
        };
      });

    // Merge, newest first (a file can legitimately appear for both a stuck re-pull
    // and an earlier blocking finding — different rows, different reasons).
    const queue = [...reviewRows, ...findingRows]
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))
      .slice(0, 300);
    res.json({ queue });
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
    // Resolve the report and check per-file access BEFORE revealing anything about
    // the PDF, so an actor who can't see the file always gets 403 — consistent with
    // every other credit endpoint (404 = report doesn't exist, 403 = exists but no
    // access), never a 404-vs-403 that differs by whether a PDF happens to exist.
    const cr = (await db.query(`SELECT application_id, pdf_document_id FROM credit_reports WHERE id=$1`, [req.params.id])).rows[0];
    if (!cr) return res.status(404).json({ error: 'report not found' });
    if (!(await canSeeApp(req, cr.application_id))) return res.status(403).json({ error: 'forbidden' });
    if (!cr.pdf_document_id) return res.status(404).json({ error: 'no PDF for this report' });
    const r = await db.query(`SELECT * FROM documents WHERE id=$1`, [cr.pdf_document_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'no PDF for this report' });
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

// ---- reconcile a fatal underwriting finding (documented exception) ----------
// A report can now carry a LIST of fatal findings — a FICO mismatch AND/OR a
// bureau alert (fraud / OFAC / deceased / SSN / address-discrepancy). Any
// unreconciled fatal finding HARD-blocks completing the credit condition
// (signOffGate + the db/213 trigger). The normal resolution is to correct the
// file and re-pull (a fresh, clean report clears everything). This route is the
// deliberate escape hatch: an underwriter/processor attests a specific finding
// (or all of them) is understood and accepted, clearing the gate WITHOUT changing
// the verified score. A short note is required (audit trail); it can be undone.
//
//   body { creditReportId, note, undo?, findingType? }
//   - findingType present → reconcile just THAT finding (flip findings[].reconciled)
//   - findingType absent   → whole-report reconcile (the reconciled_at flag)
// OFAC / deceased findings are COMPLIANCE-ONLY: a loan officer or processor may
// NOT clear them — only an admin (compliance/BSA-AML) after a documented review.
const underwritingEngine = require('../lib/credit/underwriting');
const { COMPLIANCE_ONLY } = require('../lib/credit/alerts');
// A finding is compliance-only (admin-clear ONLY) if it SAYS so OR its category is
// authoritatively compliance-only (OFAC / deceased) — belt-and-suspenders so a
// stored finding missing/with a wrong reconcilableBy can't be cleared by an officer.
const isComplianceReconcilable = (f) => !!f && (f.reconcilableBy === 'compliance' || COMPLIANCE_ONLY.has(f.type) || COMPLIANCE_ONLY.has(f.code));
router.post('/credit/reconcile-finding', requirePull, async (req, res) => {
  const b = req.body || {};
  const reportId = b.creditReportId;
  const findingType = b.findingType ? String(b.findingType) : null;
  if (!reportId) return res.status(400).json({ error: 'creditReportId is required' });
  // Reconciling a fatal underwriting finding is an underwriting decision — a
  // higher bar than merely pulling credit. Require the sign-off capability.
  if (!can(req.actor, 'sign_off_conditions')) {
    return res.status(403).json({ error: 'Only a processor or underwriter can reconcile a credit finding.' });
  }
  const isAdmin = ['admin', 'super_admin'].includes(req.actor.role);
  try {
    const r = (await db.query(
      `SELECT application_id, underwriting_finding, underwriting_finding_reconciled_at FROM credit_reports WHERE id=$1`, [reportId])).rows[0];
    if (!r) return res.status(404).json({ error: 'report not found' });
    if (!(await canSeeApp(req, r.application_id))) return res.status(403).json({ error: 'forbidden' });

    // ---------- PER-FINDING reconcile (E2) ----------
    if (findingType) {
      const findings = underwritingEngine.normalizeFindings(r.underwriting_finding);
      const target = findings.find((f) => f.type === findingType || f.code === findingType);
      if (!target) return res.status(422).json({ error: 'this report has no finding of that type' });
      if (isComplianceReconcilable(target) && !isAdmin) {
        return res.status(403).json({ error: 'This is a compliance finding (OFAC / deceased). Only an admin can clear it, after a documented compliance review — not a loan officer or processor.' });
      }
      const reconcile = b.undo !== true;
      if (reconcile && !String(b.note || '').trim()) {
        return res.status(400).json({ error: 'a short note explaining the reconciliation is required' });
      }
      const note = String(b.note || '').trim();
      const updated = underwritingEngine.recomputeWrapper({
        findings: findings.map((f) => (f === target
          ? (reconcile
            ? { ...f, reconciled: true, reconcileNote: note, reconciledBy: req.actor.id }
            : { ...f, reconciled: false, reconcileNote: undefined, reconciledBy: undefined })
          : f)),
      });
      await db.query(`UPDATE credit_reports SET underwriting_finding=$2::jsonb WHERE id=$1`, [reportId, JSON.stringify(updated)]);
      await audit(req, reconcile ? 'credit_finding_reconcile' : 'credit_finding_reconcile_undo',
        { creditReportId: reportId, applicationId: r.application_id, findingType, note: reconcile ? note : undefined });
      return res.json({ ok: true, reconciled: reconcile, findingType });
    }

    // ---------- WHOLE-REPORT reconcile (clears every finding at once) ----------
    if (b.undo === true) {
      await db.query(
        `UPDATE credit_reports
            SET underwriting_finding_reconciled_at=NULL, underwriting_finding_reconciled_by=NULL,
                underwriting_finding_reconcile_note=NULL
          WHERE id=$1`, [reportId]);
      await audit(req, 'credit_finding_reconcile_undo', { creditReportId: reportId, applicationId: r.application_id });
      return res.json({ ok: true, reconciled: false });
    }
    const fatal = underwritingEngine.activeFatalFindings(r.underwriting_finding, r.underwriting_finding_reconciled_at);
    if (!fatal.length) {
      return res.status(422).json({ error: 'this report has no unresolved fatal finding to reconcile' });
    }
    // A whole-report reconcile that would clear an OFAC/deceased finding needs an
    // admin — an officer can't blanket-clear a compliance finding by omitting the type.
    if (fatal.some(isComplianceReconcilable) && !isAdmin) {
      return res.status(403).json({ error: 'This report has a compliance finding (OFAC / deceased). Only an admin can clear it, after a documented compliance review. Reconcile the other findings individually if needed.' });
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
