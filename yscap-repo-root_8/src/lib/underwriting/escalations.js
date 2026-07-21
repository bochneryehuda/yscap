'use strict';
/**
 * Per-finding escalation queue (owner-directed 2026-07-21, Items 7 + 12).
 *
 * A staffer reviewing PILOT's underwriting findings can ESCALATE any finding they
 * can't decide — to a super-admin, a processor, or an underwriter. That creates a
 * WORKLOAD item carrying a snapshot of the finding (its title, explanation, the
 * two disagreeing values, and the framed action options) plus a direct pointer to
 * the file and the finding. The reviewer picks it up, advises, and closes it.
 *
 * This is the "don't make up things — ask" backstop: instead of guessing, the desk
 * routes the question to someone who can answer. Mirrors the manual-program
 * escalation box (src/lib/manual-program.js) — a durable table, one open row per
 * finding, list/count/decide.
 *
 * Every function takes a `client` (a pg client/pool) so callers control the
 * transaction, matching the rest of the underwriting store.
 */
const db = require('../../db');
const { assigneeExistsSql } = require('../permissions');

const TARGET_ROLES = ['super_admin', 'processor', 'underwriter'];
const TARGET_LABEL = {
  super_admin: 'Super-admin', processor: 'Processor', underwriter: 'Underwriter',
};

function normTargetRole(v) {
  const s = String(v || '').trim().toLowerCase();
  return TARGET_ROLES.includes(s) ? s : 'super_admin';
}

function str(v) {
  if (v == null) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * Open (or re-open) an escalation for a finding. Any prior OPEN escalation for the
 * SAME stored finding is superseded first so the one-open-per-finding index holds.
 * Accepts a finding SNAPSHOT (title/how_to/values/actions) so a derived finding
 * with no stored row can still be escalated. Runs on the caller's client. Returns
 * the new escalation row.
 *
 * @param {object} p
 * @param {string}  p.appId
 * @param {string} [p.findingId]  stored document_findings id, or null for a derived finding
 * @param {object}  p.finding     the finding snapshot { code, severity, field, title, howTo|how_to,
 *                                docValue|doc_value, fileValue|file_value, documentId|document_id,
 *                                availableActions|suggested_actions|actions }
 * @param {string}  p.targetRole  'super_admin' | 'processor' | 'underwriter'
 * @param {string} [p.assignedTo] a specific staffer to route to (optional)
 * @param {string} [p.question]   the escalator's note / explanation
 * @param {string} [p.borrowerId]
 * @param {string}  p.requestedBy staff id
 */
async function openEscalation(client, { appId, findingId, finding, targetRole, assignedTo, question, borrowerId, requestedBy } = {}) {
  if (!appId) throw new Error('openEscalation requires appId');
  const f = finding || {};
  const fid = findingId || null;
  // Supersede any prior OPEN escalation for the SAME stored finding — a derived
  // finding (no id) can't be deduped this way, so the caller confirms re-sends.
  if (fid) {
    await client.query(
      `UPDATE finding_escalations
          SET status='dismissed', decided_at=now(), updated_at=now(),
              decision='dismissed',
              decision_note=COALESCE(decision_note,'Superseded by a newer escalation of the same finding')
        WHERE finding_id=$1 AND status='open'`, [fid]);
  }
  // The framed options: prefer the finding's decorated menu, then its stored /
  // computed action verbs — a plain jsonb array either way.
  const actions = Array.isArray(f.availableActions) ? f.availableActions
    : Array.isArray(f.suggested_actions) ? f.suggested_actions
    : Array.isArray(f.actions) ? f.actions : null;
  const ins = await client.query(
    `INSERT INTO finding_escalations
       (application_id, finding_id, document_id, borrower_id,
        code, severity, field, title, how_to, doc_value, file_value, suggested_actions,
        target_role, assigned_to, status, question, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16)
     RETURNING *`,
    [appId, fid, f.documentId || f.document_id || null, borrowerId || null,
     f.code || null, f.severity || 'warning', f.field || null, f.title || null,
     f.howTo != null ? f.howTo : (f.how_to != null ? f.how_to : null),
     str(f.docValue != null ? f.docValue : f.doc_value),
     str(f.fileValue != null ? f.fileValue : f.file_value),
     actions ? JSON.stringify(actions) : null,
     normTargetRole(targetRole), assignedTo || null,
     question ? String(question).slice(0, 2000) : null, requestedBy || null]);
  return ins.rows[0];
}

// Common SELECT with the file + borrower + people joins the workload surface shows.
const LIST_SELECT = `
  SELECT e.*,
         a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
         b.first_name, b.last_name,
         rq.full_name AS requested_by_name, rq.role AS requested_by_role,
         dc.full_name AS decided_by_name,
         asg.full_name AS assigned_to_name
    FROM finding_escalations e
    JOIN applications a ON a.id = e.application_id
    LEFT JOIN borrowers b ON b.id = a.borrower_id
    LEFT JOIN staff_users rq ON rq.id = e.requested_by
    LEFT JOIN staff_users dc ON dc.id = e.decided_by
    LEFT JOIN staff_users asg ON asg.id = e.assigned_to`;

/**
 * List escalations for the workload surface. When `viewer` is passed (a non-super
 * staffer), the list is scoped to what they should act on: rows routed to their
 * ROLE, rows assigned to them personally, or rows they raised. A super-admin (or a
 * caller passing seeAll) sees everything. status: 'open'|'resolved'|'dismissed'|'all'.
 */
async function listEscalations({ status = 'open', limit = 200, viewer = null, seeAll = false } = {}, client = db) {
  const where = [];
  const params = [];
  if (status && status !== 'all') { params.push(status); where.push(`e.status = $${params.length}`); }
  if (viewer && !seeAll) {
    const role = viewer.role || '';
    params.push(viewer.id);
    const meParam = `$${params.length}`;
    params.push(role);
    const roleParam = `$${params.length}`;
    // Assigned to me (a deliberate personal hand-off grants me the context), raised by me, OR
    // routed to my role AND I actually have access to the file. Role-routing must NOT leak a
    // file's borrower/identity to a scoped staffer who isn't on that file — it stays inside the
    // existing per-file scope (CLAUDE.md: non-see-all staff are scoped to their assigned files).
    where.push(`(e.assigned_to = ${meParam} OR e.requested_by = ${meParam} OR (e.target_role = ${roleParam} AND ${assigneeExistsSql('a', meParam)}))`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const r = await client.query(`${LIST_SELECT} ${clause} ORDER BY e.created_at DESC LIMIT ${lim}`, params);
  return r.rows;
}

/** Open escalations for ONE file (to show state next to each finding). */
async function forFile(appId, client = db) {
  const r = await client.query(
    `SELECT id, finding_id, code, title, target_role, assigned_to, status, created_at
       FROM finding_escalations WHERE application_id=$1 AND status='open'
      ORDER BY created_at DESC`, [appId]);
  return r.rows;
}

/**
 * Count of OPEN escalations for the nav badge, scoped to what the viewer acts on
 * (their role / assigned / raised), or all for a super-admin.
 */
async function pendingCount({ viewer = null, seeAll = false } = {}, client = db) {
  try {
    if (seeAll || !viewer) {
      const r = await client.query(`SELECT count(*)::int AS n FROM finding_escalations WHERE status='open'`);
      return r.rows[0] ? r.rows[0].n : 0;
    }
    const r = await client.query(
      `SELECT count(*)::int AS n FROM finding_escalations e
         JOIN applications a ON a.id = e.application_id
        WHERE e.status='open'
          AND (e.assigned_to=$2 OR e.requested_by=$2 OR (e.target_role=$1 AND ${assigneeExistsSql('a', '$2')}))`,
      [viewer.role || '', viewer.id]);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/** Resolve/dismiss an escalation. decision: 'resolved'|'dismissed'. Returns the row. */
async function decideEscalation(client, { id, decision, staffId, note } = {}) {
  const status = decision === 'dismissed' ? 'dismissed' : 'resolved';
  const r = await client.query(
    `UPDATE finding_escalations
        SET status=$2, decision=$2, decided_by=$3, decided_at=now(),
            decision_note=$4, updated_at=now()
      WHERE id=$1 AND status='open'
      RETURNING *`,
    [id, status, staffId || null, note ? String(note).slice(0, 1000) : null]);
  return r.rows[0] || null;
}

module.exports = {
  TARGET_ROLES, TARGET_LABEL, normTargetRole,
  openEscalation, listEscalations, forFile, pendingCount, decideEscalation,
};
