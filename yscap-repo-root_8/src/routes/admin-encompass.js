'use strict';
/**
 * Admin routes for the READ-ONLY Encompass integration.
 * Mounted at /api/admin/encompass. Gated by requireAuth + platform_setup (same
 * capability as the ClickUp / Sitewire / SharePoint control panels).
 *
 * Every route here is a READ path (from PILOT's perspective) plus two POST-driven
 * refresh triggers that only READ from Encompass and WRITE into PILOT's own DB
 * (`encompass_field_catalog` + `applications.encompass_extra`). None of them
 * write to Encompass — that's structurally impossible via `src/encompass/client.js`
 * per the CLAUDE.md READ-ONLY freeze.
 *
 *   GET  /catalog                 — the cached field catalog (custom fields, enums, milestones, folders)
 *   POST /catalog/refresh         — pull fresh tenant metadata from Encompass and upsert
 *   GET  /loan/:appId             — the cached raw loan JSON for one file (staff cross-check)
 *   POST /loan/:appId/pull        — pull the loan (by loan#) from Encompass and cache it
 *   GET  /loans/status            — list every application's encompass_last_pulled_at + last_error
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requirePermission } = require('../auth');
const reader = require('../encompass/reader');
const client = require('../encompass/client');

router.use(requireAuth, requirePermission('platform_setup'));

const fail = (res, code, e, msg) => {
  console.warn('[admin-encompass] handler error:', e && e.message ? e.message : e);
  return res.status(code).json({ error: msg, detail: e && e.message ? e.message.slice(0, 300) : undefined });
};

// GET /api/admin/encompass/catalog — the cached tenant field catalog.
// Optional ?kind=customField|enum|milestone|folder|standardField|loanTemplate to filter.
router.get('/catalog', async (req, res) => {
  try {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const rows = kind
      ? (await db.query(`SELECT kind, key, label, data_type, options, pulled_at
                           FROM encompass_field_catalog WHERE kind=$1
                          ORDER BY key`, [kind])).rows
      : (await db.query(`SELECT kind, key, label, data_type, options, pulled_at
                           FROM encompass_field_catalog
                          ORDER BY kind, key`)).rows;
    const counts = (await db.query(
      `SELECT kind, count(*)::int AS n, max(pulled_at) AS last_pulled
         FROM encompass_field_catalog GROUP BY kind ORDER BY kind`,
    )).rows;
    res.json({ configured: client.configured(), counts, rows });
  } catch (e) { return fail(res, 500, e, 'could not read encompass field catalog'); }
});

// POST /api/admin/encompass/catalog/refresh — pull the tenant's field metadata NOW.
router.post('/catalog/refresh', async (req, res) => {
  if (!client.configured()) return res.status(400).json({ error: 'Encompass not configured (set ENCOMPASS_* env)' });
  try {
    const summary = await reader.refreshFieldCatalog();
    res.json({ refreshedAt: new Date().toISOString(), summary });
  } catch (e) { return fail(res, 500, e, 'could not refresh encompass catalog'); }
});

// GET /api/admin/encompass/loan/:appId — cached raw loan JSON + freshness info.
router.get('/loan/:appId', async (req, res) => {
  try {
    const row = (await db.query(
      `SELECT id, ys_loan_number, encompass_loan_guid, encompass_extra,
              encompass_last_pulled_at, encompass_last_error
         FROM applications WHERE id=$1 LIMIT 1`,
      [req.params.appId],
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'application not found' });
    res.json({
      id: row.id,
      ysLoanNumber: row.ys_loan_number,
      encompassLoanGuid: row.encompass_loan_guid,
      lastPulledAt: row.encompass_last_pulled_at,
      lastError: row.encompass_last_error,
      loan: row.encompass_extra || null,
    });
  } catch (e) { return fail(res, 500, e, 'could not read cached encompass loan'); }
});

// POST /api/admin/encompass/loan/:appId/pull — force a fresh pull for this file.
router.post('/loan/:appId/pull', async (req, res) => {
  if (!client.configured()) return res.status(400).json({ error: 'Encompass not configured (set ENCOMPASS_* env)' });
  try {
    const result = await reader.pullLoanForApplication(req.params.appId);
    if (!result.ok) return res.status(422).json(result);
    res.json(result);
  } catch (e) { return fail(res, 500, e, 'could not pull encompass loan'); }
});

// GET /api/admin/encompass/super-dump — everything a reviewer needs to design
// PILOT-side mappings against this tenant, in ONE response. Field catalog +
// N representative loan JSONs (PII-scrubbed). ?loans=N caps the sample (default
// 20, max 100). This response can be several MB — use for reviews, not routine
// UI polling.
router.get('/super-dump', async (req, res) => {
  if (!client.configured()) return res.status(400).json({ error: 'Encompass not configured' });
  try {
    const sampleN = Number(req.query.loans) || 20;
    const dump = await reader.superDump({ sampleN });
    res.json(dump);
  } catch (e) { return fail(res, 500, e, 'super-dump failed'); }
});

// POST /api/admin/encompass/pull-all — kick off the bulk pull of every loan
// in the tenant. Runs in the BACKGROUND (this response returns immediately
// with the run id); watch progress via GET /pull-all/runs.
router.post('/pull-all', async (req, res) => {
  if (!client.configured()) return res.status(400).json({ error: 'Encompass not configured' });
  try {
    // Check if an existing run is still going — never stack.
    const existing = (await db.query(
      `SELECT id, started_at FROM encompass_bulk_pull_runs WHERE status='running' LIMIT 1`,
    )).rows[0];
    if (existing) return res.status(409).json({ error: 'a bulk pull is already running', runId: existing.id, startedAt: existing.started_at });

    // Fire and forget — response returns as soon as the run row is created.
    const startedByStaffId = (req.actor && req.actor.id) || null;
    reader.bulkPullAllLoans({ startedByStaffId }).catch((e) => console.warn('[admin-encompass] bulk pull crashed:', e.message));
    // Give it a moment to create the row, then read the id.
    setTimeout(async () => {}, 100);
    const row = (await db.query(
      `SELECT id FROM encompass_bulk_pull_runs WHERE status='running' ORDER BY started_at DESC LIMIT 1`,
    )).rows[0];
    res.json({ started: true, runId: row ? row.id : null });
  } catch (e) { return fail(res, 500, e, 'could not start bulk pull'); }
});

// GET /api/admin/encompass/pull-all/runs — last N pull runs + their live progress.
router.get('/pull-all/runs', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT id, started_at, finished_at, status, total_loans, pulled, matched, unmatched, failed, last_error, started_by
         FROM encompass_bulk_pull_runs
        ORDER BY started_at DESC LIMIT 20`,
    )).rows;
    res.json({ runs: rows });
  } catch (e) { return fail(res, 500, e, 'could not read pull-all runs'); }
});

// GET /api/admin/encompass/loans/status — pipeline-wide freshness view (staff dashboard).
router.get('/loans/status', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT id, ys_loan_number, status, encompass_loan_guid,
              encompass_last_pulled_at, encompass_last_error,
              (encompass_extra IS NOT NULL) AS has_extra
         FROM applications
        WHERE ys_loan_number IS NOT NULL
          AND status NOT IN ('declined','withdrawn')
        ORDER BY encompass_last_pulled_at NULLS FIRST, ys_loan_number
        LIMIT 500`,
    )).rows;
    res.json({ configured: client.configured(), rows });
  } catch (e) { return fail(res, 500, e, 'could not read encompass status list'); }
});

module.exports = router;
