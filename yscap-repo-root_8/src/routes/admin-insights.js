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
    ]).catch(() => {
      // On any single-query failure, return an empty shape rather than 500 the whole dashboard.
      return [ { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ cents: 0, n: 0 }] }, { rows: [] } ];
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
      recentDecisions,
    });
  } catch (e) { res.status(500).json({ error: e.message || 'insights load failed' }); }
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
