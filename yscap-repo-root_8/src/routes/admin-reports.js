'use strict';
/**
 * THE REPORTING DATABASE API (owner-directed 2026-08-28: "Massive reporting
 * database available for the admin super admin back office"). Admin +
 * super-admin ONLY (requireRole('admin') — super_admin satisfies every role
 * gate) — this surface can read every file's economics and the note buyer, so
 * it is never opened to per-file-scoped roles.
 *
 *   GET    /fields          — the field dictionary (key/label/group/type/ops)
 *   POST   /run             — run a definition {filters,columns,sort,limit}
 *   POST   /export.xlsx     — the same run, as a real Excel workbook (audited)
 *   GET    /saved           — every saved report (shared across the back office)
 *   POST   /saved           — save one {name, description, definition}
 *   PUT    /saved/:id       — update one
 *   DELETE /saved/:id       — delete one
 *
 * Everything queryable goes through src/lib/reporting.js — the curated
 * catalog + bound-value filter compiler. No SQL, expression, or column name is
 * ever accepted from the client; a bad definition is a plain 400 in the
 * builder's own words (ReportError), never an unexplained 500.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');
const reporting = require('../lib/reporting');

router.use(requireAuth, requireRole('admin'));

const fail = (res, e, msg) => {
  if (e instanceof reporting.ReportError) return res.status(400).json({ error: e.message });
  console.warn('[admin-reports] handler error:', db.describeError ? db.describeError(e) : (e && e.message));
  return res.status(500).json({ error: msg || 'server error' });
};

// Best-effort audit — never blocks the action it describes.
async function audit(req, action, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, ip_address, user_agent, detail)
            VALUES ('staff', $1, $2, 'report', NULL, $3, $4, $5)`,
      [req.actor.id, action, req.ip, req.get('user-agent') || null, JSON.stringify(detail || {})]);
  } catch (_) { /* best-effort */ }
}

router.get('/fields', (req, res) => {
  res.json({ fields: reporting.catalog(), maxRows: reporting.MAX_ROWS, defaultRows: reporting.DEFAULT_ROWS });
});

// THE VALUE DROPDOWN (owner-directed 2026-08-29): the distinct values a
// faceted field actually holds, busiest first, so filters are picked off the
// live data instead of typed from memory.
router.get('/field-values', async (req, res) => {
  try {
    res.json(await reporting.distinctValues(req.query.field));
  } catch (e) { fail(res, e); }
});

router.post('/run', async (req, res) => {
  try {
    const out = await reporting.runReport(req.body || {});
    res.json(out);
  } catch (e) { fail(res, e); }
});

router.post('/export.xlsx', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await reporting.runReport(body);
    const name = String(body.name || 'Report').trim() || 'Report';
    const buf = reporting.buildReportXlsx(out, { name });
    await audit(req, 'report_exported', {
      name, rows: out.rows.length, total: out.total, capped: out.capped, mode: out.mode || 'list',
      columns: (out.columns || [...(out.groupBy || []), ...(out.metrics || [])]).map((c) => c.key),
      groups: (reporting.normalizeDefinition(body).groups || []).length,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${name.replace(/[^A-Za-z0-9 ._-]+/g, '_').slice(0, 60) || 'Report'}.xlsx"`);
    res.send(buf);
  } catch (e) { fail(res, e); }
});

router.get('/saved', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT rd.id, rd.name, rd.description, rd.definition, rd.schedule, rd.last_sent_at,
              rd.created_at, rd.updated_at,
              cu.full_name AS created_by_name, uu.full_name AS updated_by_name
         FROM report_definitions rd
         LEFT JOIN staff_users cu ON cu.id = rd.created_by
         LEFT JOIN staff_users uu ON uu.id = rd.updated_by
        ORDER BY rd.updated_at DESC`);
    res.json({ reports: r.rows });
  } catch (e) { fail(res, e); }
});

router.post('/saved', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'the report needs a name' });
    // Validate the definition NOW so a saved report is always runnable today.
    const def = reporting.normalizeDefinition(req.body?.definition);
    reporting.compileReport(def);
    const r = await db.query(
      `INSERT INTO report_definitions (name, description, created_by, updated_by, definition)
       VALUES ($1,$2,$3,$3,$4) RETURNING id, name, description, definition, created_at, updated_at`,
      [name, String(req.body?.description || '').trim().slice(0, 1000) || null, req.actor.id, JSON.stringify(def)]);
    await audit(req, 'report_saved', { id: r.rows[0].id, name });
    res.status(201).json({ report: r.rows[0] });
  } catch (e) { fail(res, e); }
});

router.put('/saved/:id', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 200);
    if (!name) return res.status(400).json({ error: 'the report needs a name' });
    const def = reporting.normalizeDefinition(req.body?.definition);
    reporting.compileReport(def);
    const r = await db.query(
      `UPDATE report_definitions
          SET name=$2, description=$3, definition=$4, updated_by=$5, updated_at=now()
        WHERE id=$1
        RETURNING id, name, description, definition, created_at, updated_at`,
      [req.params.id, name, String(req.body?.description || '').trim().slice(0, 1000) || null,
        JSON.stringify(def), req.actor.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'report not found' });
    await audit(req, 'report_saved', { id: req.params.id, name, updated: true });
    res.json({ report: r.rows[0] });
  } catch (e) { fail(res, e); }
});

// SCHEDULE a saved report (db/641): body {schedule: {...}} sets it, {schedule: null}
// clears it. The shape is validated by report-scheduler.validateSchedule — the ONE
// definition — and recipients are checked against the ACTIVE INTERNAL roster here
// too, so a typo'd or external address is refused at save, not discovered at 8am.
router.put('/saved/:id/schedule', async (req, res) => {
  try {
    const scheduler = require('../lib/report-scheduler');
    const schedule = scheduler.validateSchedule(req.body ? req.body.schedule : null);
    if (schedule) {
      const okEmails = await scheduler._internals.validRecipients(schedule.recipients);
      const bad = schedule.recipients.filter((e) => !okEmails.includes(e));
      if (bad.length) {
        return res.status(400).json({
          error: `not on the active internal team: ${bad.join(', ')} — scheduled reports only go to active internal staff`,
        });
      }
    }
    const r = await db.query(
      `UPDATE report_definitions SET schedule=$2, updated_by=$3, updated_at=now()
        WHERE id=$1 RETURNING id, name, schedule, last_sent_at`,
      [req.params.id, schedule ? JSON.stringify(schedule) : null, req.actor.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'report not found' });
    await audit(req, 'report_scheduled', { id: req.params.id, schedule });
    res.json({ report: r.rows[0] });
  } catch (e) { fail(res, e); }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const r = await db.query(`DELETE FROM report_definitions WHERE id=$1 RETURNING id, name`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'report not found' });
    await audit(req, 'report_deleted', { id: r.rows[0].id, name: r.rows[0].name });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
