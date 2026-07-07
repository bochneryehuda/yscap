/**
 * TEMPORARY post-incident diagnostics (READ-ONLY). Gated by a one-off secret
 * (INCIDENT_DIAG_TOKEN) so it needs no staff login; returns 404 when the token
 * is unset or mismatched so its existence is not disclosed. Used to establish
 * the exact blast radius of the outbound-push incident (which ClickUp tasks
 * were written, and what values were pushed) from audit_log + clickup_shadow.
 * DELETE this file + its mount once the restore is complete.
 */
const router = require('../lib/safe-router')();
const db = require('../db');

const TOKEN = process.env.INCIDENT_DIAG_TOKEN || '';
router.use((req, res, next) => {
  if (!TOKEN || TOKEN.length < 16 || req.get('x-diag-token') !== TOKEN) {
    return res.status(404).json({ error: 'not found' });
  }
  next();
});

// GET /api/_diag/incident?hours=24
// Every clickup_push audit row in the window, joined to the current app row +
// the last-pushed shadow payload (what we wrote) + current portal borrower.
router.get('/incident', async (req, res) => {
  const hours = Math.min(240, Math.max(1, Number(req.query.hours) || 24));
  try {
    const pushes = await db.query(
      `SELECT al.entity_id AS app_id,
              al.detail->>'taskId' AS task_id,
              al.created_at AS pushed_at,
              (al.detail->>'fields') AS fields
         FROM audit_log al
        WHERE al.action='clickup_push'
          AND al.created_at > now() - ($1||' hours')::interval
        ORDER BY al.created_at`, [String(hours)]);

    const appIds = [...new Set(pushes.rows.map(r => r.app_id).filter(Boolean))];
    let apps = { rows: [] };
    if (appIds.length) {
      apps = await db.query(
        `SELECT a.id, a.clickup_pipeline_task_id AS task_id, a.program, a.status,
                a.clickup_last_synced_at, a.updated_at, a.sync_state,
                a.clickup_shadow,
                b.email AS b_email, b.first_name, b.last_name, b.origin AS b_origin
           FROM applications a
           LEFT JOIN borrowers b ON b.id = a.borrower_id
          WHERE a.id = ANY($1)`, [appIds]);
    }

    // Also: any app whose CURRENT borrower email is synthetic (junk still live).
    const synthNow = await db.query(
      `SELECT a.id, a.clickup_pipeline_task_id AS task_id, b.email
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id
        WHERE b.email ILIKE '%@clickup.local' AND a.deleted_at IS NULL`);

    res.json({
      windowHours: hours,
      pushCount: pushes.rows.length,
      distinctApps: appIds.length,
      pushes: pushes.rows,
      apps: apps.rows,
      syntheticEmailNow: synthNow.rows,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// GET /api/_diag/pushbyminute?hours=48  — quick time histogram to locate the window.
router.get('/pushbyminute', async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 48));
  try {
    const r = await db.query(
      `SELECT date_trunc('minute', created_at) AS minute, count(*)::int n
         FROM audit_log
        WHERE action='clickup_push' AND created_at > now() - ($1||' hours')::interval
        GROUP BY 1 ORDER BY 1`, [String(hours)]);
    res.json({ hours, buckets: r.rows.map(x => ({ minute: x.minute, n: x.n })) });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

module.exports = router;
