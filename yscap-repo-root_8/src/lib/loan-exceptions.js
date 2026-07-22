'use strict';

/**
 * Loan policy EXCEPTIONS (owner-directed 2026-07-22).
 *
 * A clean, purpose-built exception record with its own lifecycle — the "single
 * source of truth" for a policy exception so the request → approval workflow is
 * auditable and the term sheet can never disagree with the exception. Today the
 * only type is a co-borrower GUARANTY WAIVER (waive the co-borrower's personal
 * guaranty; they stay a member of the borrowing entity but are not a guarantor).
 *
 * Lifecycle: requested → approved | denied | withdrawn.
 *   • ANY staff member may REQUEST (with a structured reason + note).
 *   • Only a SUPER-ADMIN may APPROVE / DENY (segregation of duties — the approver
 *     cannot be the requester; enforced in the route).
 *   • On APPROVE the route flips applications.co_borrower_pg_waived = true (the
 *     term-sheet display flag); on DENY it stays false (both guarantee).
 *
 * At most ONE open (requested) exception of a type per file — a new request
 * supersedes any prior open one (mirrors the manual-program escalation queue).
 * Every state change is audited by the caller (audit_log); this module owns the
 * table writes only. Nothing here touches a frozen pricing-engine number.
 */

const db = require('../db');

// Structured reasons a co-borrower's personal guaranty is waived. Free-text notes
// still accompany the code; the code makes the exception reportable across files.
const REASON_CODES = Object.freeze({
  passive_member:   'Co-borrower is a passive / minority / capital-only member',
  primary_strong:   'Primary guarantor is strong enough on their own',
  structural:       'Structural / legal constraint (e.g. SDIRA, institutional, foreign national, trust)',
  cannot_sign:      'Co-borrower cannot / will not sign a personal guaranty',
  relationship:     'Relationship / repeat sponsor exception',
  other:            'Other (see note)',
});
function isReasonCode(c) { return !!c && Object.prototype.hasOwnProperty.call(REASON_CODES, c); }

const OPEN = 'requested';

/**
 * Request a co-borrower guaranty waiver. Supersedes any prior OPEN (requested)
 * guaranty-waiver on the file (→ withdrawn) so the one-open-per-file invariant
 * holds, then inserts a fresh 'requested' row. Runs on the caller's client
 * (inside a transaction when the caller supplies one). Returns the new row.
 */
async function requestGuarantyWaiver(client, { appId, subjectBorrowerId, reasonCode, reasonNote, requestedBy }) {
  await client.query(
    `UPDATE loan_exceptions
        SET status='withdrawn', updated_at=now(),
            decision_note=COALESCE(decision_note,'Superseded by a newer request')
      WHERE application_id=$1 AND exception_type='guaranty_waiver' AND status=$2`,
    [appId, OPEN]);
  const ins = await client.query(
    `INSERT INTO loan_exceptions
       (application_id, exception_type, subject_borrower_id, status, reason_code, reason_note, requested_by)
     VALUES ($1,'guaranty_waiver',$2,'requested',$3,$4,$5)
     RETURNING *`,
    [appId, subjectBorrowerId || null,
     isReasonCode(reasonCode) ? reasonCode : 'other',
     reasonNote ? String(reasonNote).slice(0, 2000) : null,
     requestedBy || null]);
  return ins.rows[0];
}

/**
 * Decide (approve|deny) an OPEN exception. Guarded so a row can be decided once.
 * Returns the updated row, or null if it was already decided / no longer open.
 * The caller flips applications.co_borrower_pg_waived and audits.
 */
async function decideException(id, decision, staffId, note, client = db) {
  const status = decision === 'approved' ? 'approved' : 'denied';
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4, updated_at=now()
      WHERE id=$1 AND status=$5
      RETURNING *`,
    [id, status, staffId || null, note ? String(note).slice(0, 1000) : null, OPEN]);
  return r.rows[0] || null;
}

/** The requester (or an admin) withdraws an OPEN exception. Returns the row or null. */
async function withdrawException(id, staffId, client = db) {
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status='withdrawn', decided_by=$2, decided_at=now(), updated_at=now()
      WHERE id=$1 AND status=$3
      RETURNING *`,
    [id, staffId || null, OPEN]);
  return r.rows[0] || null;
}

/**
 * Clear (archive / close out) an exception — housekeeping only. Moves any
 * non-cleared row to 'cleared'; does NOT change co_borrower_pg_waived (an approved
 * waiver stays in effect). Guarded so a cleared row can't be re-cleared. Returns
 * the row or null.
 */
async function clearException(id, staffId, note, client = db) {
  const r = await client.query(
    `UPDATE loan_exceptions
        SET status='cleared', cleared_by=$2, cleared_at=now(),
            clear_note=$3, updated_at=now()
      WHERE id=$1 AND status <> 'cleared'
      RETURNING *`,
    [id, staffId || null, note ? String(note).slice(0, 1000) : null]);
  return r.rows[0] || null;
}

/**
 * A staffer's OWN exceptions (the loan-officer's personal queue, outside any one
 * file). status: 'open' (requested) | 'all-active' (not cleared) | any specific status.
 */
async function listForRequester(staffId, { status = 'open', limit = 100 } = {}, client = db) {
  let where = 'WHERE e.requested_by = $1';
  const params = [staffId];
  if (status === 'open') where += ` AND e.status = 'requested'`;
  else if (status === 'all-active') where += ` AND e.status <> 'cleared'`;
  else if (status && status !== 'all') { where += ` AND e.status = $2`; params.push(status); }
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            dc.full_name AS decided_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, params);
  return r.rows;
}

/* ---------------- comments (staff-only thread on an exception) ---------------- */

/** Post a comment on an exception. Returns the row (with author name), or throws. */
async function addComment(exceptionId, staffId, body, client = db) {
  const text = String(body || '').trim();
  if (!text) { const e = new Error('empty comment'); e.status = 400; throw e; }
  const ins = await client.query(
    `INSERT INTO loan_exception_comments (loan_exception_id, author_staff_id, body)
     VALUES ($1,$2,$3) RETURNING *`,
    [exceptionId, staffId || null, text.slice(0, 4000)]);
  const row = ins.rows[0];
  const name = staffId ? (await client.query(`SELECT full_name FROM staff_users WHERE id=$1`, [staffId])).rows[0] : null;
  row.author_name = name ? name.full_name : null;
  return row;
}

/** All comments on an exception, oldest first, with author names. */
async function listComments(exceptionId, client = db) {
  const r = await client.query(
    `SELECT c.*, su.full_name AS author_name
       FROM loan_exception_comments c
       LEFT JOIN staff_users su ON su.id = c.author_staff_id
      WHERE c.loan_exception_id = $1
      ORDER BY c.created_at ASC`, [exceptionId]);
  return r.rows;
}

/** The distinct staff who should hear about activity on an exception — the
 *  requester, the decider, and everyone who has commented. Used to notify the
 *  OTHER participants when a new comment lands. */
async function commentParticipants(exceptionId, client = db) {
  const r = await client.query(
    `SELECT DISTINCT sid FROM (
       SELECT requested_by AS sid FROM loan_exceptions WHERE id=$1
       UNION SELECT decided_by FROM loan_exceptions WHERE id=$1
       UNION SELECT author_staff_id FROM loan_exception_comments WHERE loan_exception_id=$1
     ) s WHERE sid IS NOT NULL`, [exceptionId]);
  return r.rows.map((x) => x.sid);
}

/** Count of a staffer's OWN still-open (requested) exceptions — for the nav badge. */
async function requesterOpenCount(staffId, client = db) {
  try {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM loan_exceptions WHERE requested_by=$1 AND status='requested'`, [staffId]);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

/** The current OPEN (requested) exception for a file+type, or null. */
async function openForApp(appId, type = 'guaranty_waiver', client = db) {
  const r = await client.query(
    `SELECT * FROM loan_exceptions
      WHERE application_id=$1 AND exception_type=$2 AND status='requested'
      ORDER BY created_at DESC LIMIT 1`, [appId, type]);
  return r.rows[0] || null;
}

/** The most-recent exception (any status) for a file+type — for showing state on the file. */
async function latestForApp(appId, type = 'guaranty_waiver', client = db) {
  const r = await client.query(
    `SELECT * FROM loan_exceptions
      WHERE application_id=$1 AND exception_type=$2
      ORDER BY created_at DESC LIMIT 1`, [appId, type]);
  return r.rows[0] || null;
}

/** A single exception row with file/requester/decider identity, or null. */
async function getById(id, client = db) {
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
      WHERE e.id=$1`, [id]);
  return r.rows[0] || null;
}

/**
 * List exceptions for the super-admin review box.
 *   status: 'open' (requested) | 'approved' | 'denied' | 'withdrawn' | 'all'
 */
async function listExceptions({ status = 'open', limit = 100 } = {}, client = db) {
  let where = '';
  let params = [];
  if (status === 'open') where = `WHERE e.status = 'requested'`;
  else if (status && status !== 'all') { where = `WHERE e.status = $1`; params = [status]; }
  const r = await client.query(
    `SELECT e.*, e.exception_type AS type,
            a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
            a.co_borrower_id, a.co_borrower_pg_waived,
            b.first_name, b.last_name,
            sb.first_name AS subject_first, sb.last_name AS subject_last,
            rq.full_name AS requested_by_name, dc.full_name AS decided_by_name
       FROM loan_exceptions e
       JOIN applications a ON a.id = e.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers sb ON sb.id = e.subject_borrower_id
       LEFT JOIN staff_users rq ON rq.id = e.requested_by
       LEFT JOIN staff_users dc ON dc.id = e.decided_by
       ${where}
      ORDER BY e.created_at DESC
      LIMIT ${Math.min(500, Math.max(1, Number(limit) || 100))}`, params);
  return r.rows;
}

/**
 * The conditions (most often DOCUMENT REQUESTS) tagged to an exception, each with
 * the documents uploaded against it (owner-directed 2026-07-22). The conditions
 * still live on the file's checklist; this just gathers the ones tagged to THIS
 * exception so the exception detail can show the paperwork it depends on. Returns
 * [] when nothing is attached (or the column isn't present yet — fails soft).
 */
async function listConditions(exceptionId, client = db) {
  try {
    const items = await client.query(
      `SELECT id, label, borrower_label, status, item_kind, audience, is_required, signed_off_at, due_date, created_at
         FROM checklist_items
        WHERE loan_exception_id = $1
        ORDER BY created_at`, [exceptionId]);
    if (!items.rows.length) return [];
    const ids = items.rows.map((r) => r.id);
    const docs = await client.query(
      `SELECT id, checklist_item_id, filename, content_type, created_at
         FROM documents
        WHERE checklist_item_id = ANY($1) AND COALESCE(is_current, true)
        ORDER BY created_at DESC`, [ids]);
    const byItem = {};
    for (const d of docs.rows) { (byItem[d.checklist_item_id] = byItem[d.checklist_item_id] || []).push(d); }
    return items.rows.map((r) => ({ ...r, documents: byItem[r.id] || [] }));
  } catch (e) { console.warn('[loan-exceptions] listConditions skipped:', e.message); return []; }
}

/** Count of OPEN (requested) exceptions — for the nav badge. Fails soft. */
async function pendingCount(client = db) {
  try {
    const r = await client.query(`SELECT count(*)::int AS n FROM loan_exceptions WHERE status='requested'`);
    return r.rows[0] ? r.rows[0].n : 0;
  } catch (_) { return 0; }
}

module.exports = {
  REASON_CODES, isReasonCode,
  requestGuarantyWaiver, decideException, withdrawException, clearException,
  openForApp, latestForApp, getById, listExceptions, pendingCount,
  listForRequester, requesterOpenCount,
  addComment, listComments, commentParticipants,
  listConditions,
};
