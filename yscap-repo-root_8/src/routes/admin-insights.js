'use strict';
/**
 * Sovereign Insights portfolio dashboard (R2.6, owner-directed 2026-07-22).
 *
 * One SQL round-trip per widget → JSON blob for the admin dashboard. Each
 * query is defensive (LEFT JOIN + COALESCE) so an empty DB never 500s.
 *
 * Mounted at /api/admin/insights behind requireAuth + requireStaff + role.
 * seesAll roles (admin / super_admin / underwriter) get the FULL portfolio;
 * a loan_officer / processor sees only their own files.
 */
const router = require('express').Router();
const db = require('../db');
const { requireRole } = require('../auth');

// Admin / super-admin only for now — a follow-up will scope per assignee.
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const [
      openFindings,
      openSuggestions,
      certificates,
      trainingProposals,
      aiSpendMonth,
      topSuggestionCodes,
      agedFatalAiFiles,
      decisionsThisWeek,
      aiCostByOfficer,
    ] = await Promise.all([
      db.query(
        `SELECT severity, COUNT(*)::int AS n
           FROM document_findings df
           JOIN applications a ON a.id = df.application_id
          WHERE df.status='open' AND a.deleted_at IS NULL
            AND a.status NOT IN ('withdrawn','cancelled')
          GROUP BY severity`),
      db.query(
        `SELECT source, COUNT(*)::int AS n
           FROM ai_suggestions
          WHERE status IN ('open','asked_admin')
          GROUP BY source ORDER BY n DESC`),
      db.query(
        `SELECT milestone, COUNT(*)::int AS n
           FROM decision_certificates
          WHERE issued_at > now() - interval '30 days'
          GROUP BY milestone ORDER BY n DESC`),
      db.query(
        `SELECT status, COUNT(*)::int AS n
           FROM training_proposals
          GROUP BY status`),
      db.query(
        `SELECT COALESCE(SUM(cost_cents),0)::int AS cents,
                COUNT(*)::int AS n
           FROM ai_cost_events
          WHERE created_at > now() - interval '30 days'`),
      db.query(
        `SELECT
            COALESCE(NULLIF(evidence->>'code',''), source)         AS bucket,
            COUNT(*)::int                                          AS n
           FROM ai_suggestions
          WHERE status IN ('open','marked_important')
          GROUP BY bucket
          ORDER BY n DESC
          LIMIT 15`),
      // R3.41 — top-N files with open fatal AI findings, oldest-first.
      db.query(
        `SELECT a.id AS application_id, a.property_address, a.status AS app_status, a.program,
                b.first_name, b.last_name,
                COUNT(*)::int AS open_fatal,
                EXTRACT(EPOCH FROM (now() - MIN(s.created_at)))/86400 AS oldest_days,
                MAX(s.created_at) AS most_recent
           FROM ai_suggestions s
           JOIN applications a ON a.id = s.application_id AND a.deleted_at IS NULL
           LEFT JOIN borrowers b ON b.id = a.borrower_id
          WHERE s.severity='fatal'
            AND s.status IN ('open','marked_important','escalated','asked_admin')
            AND a.status NOT IN ('withdrawn','cancelled','declined')
          GROUP BY a.id, a.property_address, a.status, a.program, b.first_name, b.last_name
          ORDER BY oldest_days DESC NULLS LAST
          LIMIT 20`),
      // R4.4 — Weekly decision velocity per status.
      db.query(
        `SELECT status, COUNT(*)::int AS n
           FROM ai_suggestions
          WHERE decided_at > now() - interval '7 days'
          GROUP BY status ORDER BY n DESC`),
      // R4.9 — Top-10 loan officers by AI spend in the last 30 days.
      db.query(
        `SELECT COALESCE(u.email, 'unassigned') AS officer_email,
                COALESCE(u.full_name, 'Unassigned') AS officer_name,
                COALESCE(SUM(e.cost_cents),0)::int AS cents,
                COUNT(*)::int AS calls,
                COUNT(DISTINCT e.application_id)::int AS files
           FROM ai_cost_events e
           LEFT JOIN applications a ON a.id = e.application_id AND a.deleted_at IS NULL
           LEFT JOIN staff_users u ON u.id = a.loan_officer_id
          WHERE e.created_at > now() - interval '30 days'
          GROUP BY u.email, u.full_name
         HAVING COALESCE(SUM(e.cost_cents),0) > 0
          ORDER BY cents DESC
          LIMIT 10`),
    ]).catch(() => {
      // On any single-query failure, return an empty shape rather than 500 the whole dashboard.
      return [ { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ cents: 0, n: 0 }] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] } ];
    });

    // Recent AI-related audit trail (best-effort — table may not always exist on
    // the dev DB, guarded).
    let recentDecisions = [];
    try {
      const r = await db.query(
        `SELECT id, source, kind, title, status, decided_at, decided_by_staff_id, application_id
           FROM ai_suggestions
          WHERE decided_at IS NOT NULL AND decided_at > now() - interval '14 days'
          ORDER BY decided_at DESC LIMIT 20`);
      recentDecisions = r.rows;
    } catch (_) { recentDecisions = []; }

    res.json({
      ok: true,
      openFindings: openFindings.rows,
      openSuggestions: openSuggestions.rows,
      certificates30d: certificates.rows,
      trainingProposals: trainingProposals.rows,
      aiSpend30d: aiSpendMonth.rows[0] || { cents: 0, n: 0 },
      topSuggestionCodes: topSuggestionCodes.rows,
      agedFatalAiFiles: agedFatalAiFiles.rows,
      decisionsThisWeek: decisionsThisWeek.rows,
      aiCostByOfficer: aiCostByOfficer.rows,
      recentDecisions,
    });
  } catch (e) { res.status(500).json({ error: e.message || 'insights load failed' }); }
});

// R4.8 — Portfolio-wide mute list for AI finding codes. super_admin only.
// GET returns current mute list. POST {code, reason} adds one. DELETE removes.
router.get('/silenced-codes', requireRole('super_admin'), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.code, s.reason, s.silenced_at, u.email AS silenced_by_email
         FROM ai_silenced_codes s
         LEFT JOIN staff_users u ON u.id = s.silenced_by
        ORDER BY s.silenced_at DESC`);
    res.json({ ok: true, codes: r.rows });
  } catch (e) { res.status(500).json({ error: e.message || 'load failed' }); }
});
router.post('/silenced-codes', requireRole('super_admin'), async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim().slice(0, 100);
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 400);
    if (!code) return res.status(400).json({ error: 'code required' });
    if (!reason) return res.status(400).json({ error: 'reason required — mute list is auditable' });
    await db.query(
      `INSERT INTO ai_silenced_codes (code, reason, silenced_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET reason=EXCLUDED.reason, silenced_by=EXCLUDED.silenced_by, silenced_at=now()`,
      [code, reason, req.actor.staffId || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || 'mute failed' }); }
});
router.delete('/silenced-codes/:code', requireRole('super_admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM ai_silenced_codes WHERE code=$1`, [req.params.code]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || 'unmute failed' }); }
});

// R4.3 — Regulator-ready AI decision audit CSV export. Every ai_suggestion
// decide event with actor + timestamp + reason + linked condition/task + trace
// url. Filterable by date range (?since=YYYY-MM-DD&until=YYYY-MM-DD). super_admin
// only — audit-trail data is sensitive.
router.get('/ai-audit.csv', requireRole('super_admin'), async (req, res) => {
  try {
    const since = req.query.since ? String(req.query.since).slice(0, 10) : '1970-01-01';
    const until = req.query.until ? String(req.query.until).slice(0, 10) : '2999-12-31';
    const r = await db.query(
      `SELECT s.id, s.application_id, a.ys_loan_number, a.property_address,
              s.source, s.kind, s.severity, s.title, s.status, s.status_reason,
              s.decided_at, s.decided_by_staff_id, u.email AS decided_by_email,
              s.created_at, s.trace_url, s.evidence->>'code' AS finding_code,
              s.linked_condition_id, s.linked_task_id
         FROM ai_suggestions s
         LEFT JOIN applications a ON a.id = s.application_id
         LEFT JOIN staff_users u ON u.id = s.decided_by_staff_id
        WHERE s.decided_at IS NOT NULL
          AND s.decided_at::date BETWEEN $1::date AND $2::date
        ORDER BY s.decided_at DESC
        LIMIT 10000`, [since, until]);
    const headers = [
      'suggestion_id', 'application_id', 'ys_loan_number', 'property',
      'source', 'kind', 'severity', 'code', 'title',
      'status', 'status_reason', 'created_at', 'decided_at',
      'decided_by_email', 'linked_condition_id', 'linked_task_id', 'trace_url',
    ];
    const esc = (v) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const rows = r.rows.map((row) => headers.map((h) => {
      switch (h) {
        case 'suggestion_id':    return esc(row.id);
        case 'application_id':   return esc(row.application_id);
        case 'ys_loan_number':   return esc(row.ys_loan_number);
        case 'property':         return esc((row.property_address && (row.property_address.line1 || row.property_address.address || row.property_address.oneLine)) || '');
        case 'source':           return esc(row.source);
        case 'kind':             return esc(row.kind);
        case 'severity':         return esc(row.severity);
        case 'code':             return esc(row.finding_code);
        case 'title':            return esc(row.title);
        case 'status':           return esc(row.status);
        case 'status_reason':    return esc(row.status_reason);
        case 'created_at':       return esc(row.created_at && new Date(row.created_at).toISOString());
        case 'decided_at':       return esc(row.decided_at && new Date(row.decided_at).toISOString());
        case 'decided_by_email': return esc(row.decided_by_email);
        case 'linked_condition_id': return esc(row.linked_condition_id);
        case 'linked_task_id':   return esc(row.linked_task_id);
        case 'trace_url':        return esc(row.trace_url);
        default:                 return '';
      }
    }).join(','));
    const body = [headers.join(','), ...rows].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-audit-${since}-to-${until}.csv"`);
    res.send(body);
  } catch (e) { res.status(500).json({ error: e.message || 'audit export failed' }); }
});

// R3.36 — 7-day AI cost trend (per-day $ + call count). admin+ only.
router.get('/ai-cost-trend', requireRole('admin'), async (req, res) => {
  try {
    const r = await db.query(
      `SELECT date_trunc('day', created_at)::date AS d,
              COALESCE(SUM(cost_cents),0)::int AS cents,
              COUNT(*)::int AS n
         FROM ai_cost_events
        WHERE created_at > now() - interval '7 days'
        GROUP BY d ORDER BY d`);
    res.json({ ok: true, days: r.rows });
  } catch (e) { res.status(500).json({ error: e.message || 'trend load failed' }); }
});

// R3.30 — Portfolio search: files with a given AI suggestion open.
//   GET /files-with-suggestion?source=assignment_fraud&severity=fatal&limit=50
// admin+ only. Returns application_id + address + last-modified so the insights
// dashboard's top-code table can link "N files".
router.get('/files-with-suggestion', requireRole('admin'), async (req, res) => {
  try {
    const source = req.query.source ? String(req.query.source) : null;
    const severity = req.query.severity ? String(req.query.severity) : null;
    const code = req.query.code ? String(req.query.code) : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const params = [];
    const conds = [`s.status IN ('open','marked_important','escalated','asked_admin')`];
    if (source) { params.push(source); conds.push(`s.source=$${params.length}`); }
    if (severity) { params.push(severity); conds.push(`s.severity=$${params.length}`); }
    if (code) { params.push(code); conds.push(`s.evidence->>'code'=$${params.length}`); }
    const r = await db.query(
      `SELECT s.application_id, s.title, s.source, s.severity, s.created_at,
              a.property_address, a.status AS app_status, a.program,
              b.first_name, b.last_name
         FROM ai_suggestions s
         JOIN applications a ON a.id = s.application_id AND a.deleted_at IS NULL
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE ${conds.join(' AND ')}
        ORDER BY s.created_at DESC
        LIMIT ${limit}`, params);
    res.json({ ok: true, files: r.rows, filter: { source, severity, code } });
  } catch (e) { res.status(500).json({ error: e.message || 'search failed' }); }
});

module.exports = router;
