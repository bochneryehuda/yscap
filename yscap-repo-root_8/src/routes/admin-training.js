'use strict';

/**
 * Admin training-proposals queue (Sovereign 4/4 admin surface).
 *
 * The learning loop (src/lib/underwriting/learning.js) aggregates underwriter
 * corrections into CANDIDATE improvements and lands them in training_proposals
 * with status='pending'. NOTHING auto-promotes to production. A super-admin
 * reviews the queue here — approve promotes to shadow_testing (a subsequent
 * step would move it into production; for now it just moves the row along),
 * reject dismisses.
 *
 * Mounted at /api/admin/training behind requireAuth + requireStaff.
 * Individual routes gate:
 *   GET  /proposals          — manage_pricing (admins + super-admins).
 *   POST /run                — super-admin only (kicks off an aggregation).
 *   POST /proposals/:id/decide — super-admin only.
 */
const router = require('express').Router();
const db = require('../db');
const { requirePermission, requireRole } = require('../auth');
const learning = require('../lib/underwriting/learning');

function auditSafe(actorId, action, entityType, entityId, detail) {
  db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff',$1,$2,$3,$4,$5::jsonb)`,
    [actorId || null, action, entityType, entityId, JSON.stringify(detail || {})]).catch(() => {});
}

router.get('/proposals', requirePermission('manage_pricing'), async (req, res) => {
  try {
    const allowedStatus = ['pending', 'approved', 'rejected', 'shadow_testing', 'promoted', 'all'];
    const status = allowedStatus.includes(req.query.status) ? req.query.status : 'pending';
    const params = [];
    let where = '';
    if (status !== 'all') { params.push(status); where = 'WHERE status = $1'; }
    const r = await db.query(
      `SELECT p.*, s.full_name AS reviewed_by_name
         FROM training_proposals p
         LEFT JOIN staff_users s ON s.id = p.reviewed_by
        ${where}
        ORDER BY proposed_at DESC
        LIMIT 500`, params);
    const cnt = await db.query(`SELECT count(*)::int AS n FROM training_proposals WHERE status='pending'`);
    res.json({ proposals: r.rows, pendingCount: (cnt.rows[0] || {}).n || 0, canDecide: req.actor.role === 'super_admin' });
  } catch (e) { res.status(500).json({ error: 'could not load training proposals' }); }
});

router.post('/run', requireRole('super_admin'), async (req, res) => {
  try {
    const client = await db.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await learning.runTraining(client);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    auditSafe(req.actor.id, 'training_run', 'training_proposals', null, result);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: 'could not run the training aggregation' }); }
});

router.post('/proposals/:id/decide', requireRole('super_admin'), async (req, res) => {
  try {
    const allowed = ['approved', 'rejected', 'shadow_testing', 'promoted'];
    const decision = allowed.includes(req.body && req.body.decision) ? req.body.decision : null;
    if (!decision) return res.status(400).json({ error: 'Provide a decision: approved | rejected | shadow_testing | promoted.' });
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 1000) : null;
    const r = await db.query(
      `UPDATE training_proposals
          SET status=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4
        WHERE id=$1 AND status IN ('pending','shadow_testing')
        RETURNING *`,
      [req.params.id, decision, req.actor.id, note]);
    if (!r.rowCount) return res.status(409).json({ error: 'This proposal was already decided.' });
    auditSafe(req.actor.id, 'training_proposal_decided', 'training_proposal', req.params.id, { decision, note });
    // R2.7 — promoted-rules cache invalidation. The applier caches promoted
    // rules for 60s; when a super-admin promotes/rejects a proposal we drop
    // the cache so the next finding-insert picks it up immediately (no wait).
    try { require('../lib/underwriting/promoted-rules')._reset(); } catch (_) { /* best-effort */ }
    res.json({ ok: true, proposal: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'could not record the decision' }); }
});

module.exports = router;
