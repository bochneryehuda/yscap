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
const { underwriterActions } = require('./actions');

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
  // Snapshot the source PAGE the finding was raised from (document_findings.page_number,
  // populated by the analyzer) so the workload screen can open the source document to
  // that exact page. Null when the analyzer couldn't locate it (never a wrong page).
  // MUST short-circuit on null BEFORE Number() — Number(null) is 0 (a finite number),
  // which would store page 0 (showing "(page 0)" and, worse, defeating the live COALESCE
  // fallback: COALESCE(0, df.page_number)=0). Null in → null stored.
  const rawPage = f.pageNumber != null ? f.pageNumber : (f.page_number != null ? f.page_number : null);
  // PDF pages are 1-based — a 0/negative/non-finite page is "no page", stored NULL.
  const pageNumber = rawPage != null && Number.isFinite(Number(rawPage)) && Number(rawPage) >= 1 ? Number(rawPage) : null;
  const ins = await client.query(
    `INSERT INTO finding_escalations
       (application_id, finding_id, document_id, borrower_id,
        code, severity, field, title, how_to, doc_value, file_value, suggested_actions,
        target_role, assigned_to, status, question, requested_by, page_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16,$17)
     RETURNING *`,
    [appId, fid, f.documentId || f.document_id || null, borrowerId || null,
     f.code || null, f.severity || 'warning', f.field || null, f.title || null,
     f.howTo != null ? f.howTo : (f.how_to != null ? f.how_to : null),
     str(f.docValue != null ? f.docValue : f.doc_value),
     str(f.fileValue != null ? f.fileValue : f.file_value),
     actions ? JSON.stringify(actions) : null,
     normTargetRole(targetRole), assignedTo || null,
     question ? String(question).slice(0, 2000) : null, requestedBy || null,
     pageNumber]);
  return ins.rows[0];
}

// Common SELECT with the file + borrower + people joins the workload surface shows.
// `finding_page` is the LIVE page from the finding (a DISTINCT column name — no
// shadowing of e.page_number); listEscalations coalesces the two in JS so the
// effective page doesn't depend on SQL column ordering. This fixes escalations
// created before the snapshot was plumbed, and any the analyzer paged afterward.
//
// The other `finding_*` aliases are the LIVE state of the underlying finding, so the
// review screen can (a) offer the SAME action menu the file's own finding card offers
// and (b) say plainly whether the finding itself is still open. Same distinct-alias
// discipline as the page: never shadow an e.* column.
const LIST_SELECT = `
  SELECT e.*,
         df.page_number AS finding_page,
         df.status AS finding_status,
         df.severity AS finding_severity,
         df.blocks_ctc AS finding_blocks_ctc,
         df.suggested_actions AS finding_suggested_actions,
         a.ys_loan_number, a.property_address, a.loan_amount, a.status AS file_status,
         b.first_name, b.last_name,
         rq.full_name AS requested_by_name, rq.role AS requested_by_role,
         dc.full_name AS decided_by_name,
         asg.full_name AS assigned_to_name
    FROM finding_escalations e
    JOIN applications a ON a.id = e.application_id
    LEFT JOIN document_findings df ON df.id = e.finding_id
    LEFT JOIN borrowers b ON b.id = a.borrower_id
    LEFT JOIN staff_users rq ON rq.id = e.requested_by
    LEFT JOIN staff_users dc ON dc.id = e.decided_by
    LEFT JOIN staff_users asg ON asg.id = e.assigned_to`;

// The effective source page = the escalation's own snapshot, else the finding's
// live page. Explicit JS coalesce (not a shadowed SQL column) + drop the helper.
//
// The same pass decorates the row with the REVIEWER'S FULL ACTION MENU (owner-directed
// 2026-07-26). Before this, the review screen only rendered buttons when the escalation's
// stored `suggested_actions` snapshot happened to be non-empty — so most rows showed only
// "Mark resolved", which closes the QUEUE ITEM and leaves the finding sitting open on the
// file. The menu is now computed by the SAME `underwriterActions()` the file's own finding
// card is decorated with (src/routes/underwriting.js `decorate`), fed the LIVE finding's
// verbs/severity when the finding row still exists and the snapshot otherwise — so every
// escalation offers exactly what the desk offers, including legacy rows with a NULL snapshot.
function withEffectivePage(row) {
  const page = row.page_number != null ? row.page_number : (row.finding_page != null ? row.finding_page : null);
  const {
    finding_page, finding_status, finding_severity, finding_blocks_ctc, finding_suggested_actions,
    ...rest
  } = row;   // eslint-disable-line no-unused-vars
  // Prefer the LIVE finding (it is the thing the action is applied to); fall back to the
  // snapshot for a derived finding, which has no stored row at all.
  const severity = finding_severity || rest.severity || 'warning';
  const verbs = Array.isArray(finding_suggested_actions) ? finding_suggested_actions
    : (Array.isArray(rest.suggested_actions) ? rest.suggested_actions : undefined);
  return {
    ...rest,
    page_number: page,
    severity,
    // Live finding state: 'open' | 'resolved' | 'dismissed', or null when the escalation
    // carries a DERIVED finding (no stored row) — the screen says so instead of pretending.
    finding_status: rest.finding_id ? (finding_status || null) : null,
    finding_open: rest.finding_id ? finding_status === 'open' : false,
    // Fatal + CTC-blocking is the tier that needs senior authority to CLEAR (exceptions.js).
    finding_blocks_ctc: finding_blocks_ctc == null ? null : !!finding_blocks_ctc,
    availableActions: underwriterActions(verbs ? { severity, actions: verbs } : { severity }),
  };
}

/**
 * May `viewer` DECIDE this escalation? (owner-directed widening 2026-07-26.)
 *
 * The old rule was: a super-admin, the person it was routed to by role, or a personal
 * assignee. That forced ordinary findings to wait on a super-admin even when the admin
 * or processor already looking at the file could handle them. Now any staffer who can
 * SIGN OFF conditions and can see the file may take it — the queue is a work list, not
 * a super-admin-only inbox.
 *
 * The one control kept: you may not decide an escalation YOU raised (a super-admin is
 * exempt, as before) — the whole point of escalating is a second pair of eyes.
 *
 * `can(actor, permission)` is the permission predicate; `hasFileAccess` says whether the
 * viewer can reach the escalation's file (the list query already scopes to that, so the
 * caller passes true for rows it returned).
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function mayDecide({ viewer, row, can, hasFileAccess = true } = {}) {
  const v = viewer || {};
  const isSuper = v.role === 'super_admin';
  if (isSuper) return { ok: true };
  if (!row) return { ok: false, reason: 'not found' };
  if (row.requested_by && row.requested_by === v.id) {
    return { ok: false, reason: 'you raised this finding — another reviewer must decide it' };
  }
  if (row.assigned_to && row.assigned_to === v.id) return { ok: true };
  if (!hasFileAccess) return { ok: false, reason: 'this escalation is on a file you do not have access to' };
  if (row.target_role && row.target_role === v.role) return { ok: true };
  // The widening: an admin / processor / underwriter (anyone who signs off conditions on
  // this file) may clear the queue item without bouncing it to a super-admin.
  if (typeof can === 'function' && can(v, 'sign_off_conditions')) return { ok: true };
  return { ok: false, reason: 'this escalation was routed to someone else' };
}

/**
 * The per-viewer scope fragment, as SQL. ONE definition used by both the list and the
 * badge count so the two can never disagree about what a staffer is looking at.
 *
 * Assigned to me (a deliberate personal hand-off grants me the context), raised by me, OR
 * on a file I am actually on. Every branch stays inside the existing per-file scope
 * (CLAUDE.md: non-see-all staff are scoped to their assigned files) — a role-routed row
 * never leaks a borrower/file identity to someone who isn't on that file.
 *
 * `anyOnFile` (owner-directed 2026-07-26) is what lets a processor / underwriter clear a
 * finding that was escalated to a SUPER-ADMIN: a signer who is on the file sees every
 * escalation on that file, not only the ones addressed to their own role. Without it the
 * old rule applies — the row must ALSO be routed to my role.
 *
 * @param {string} meParam    the placeholder holding the viewer's staff id
 * @param {string} roleParam  the placeholder holding the viewer's role
 * @param {boolean} anyOnFile viewer signs off conditions → any escalation on their files
 */
// NOTE the params discipline: the role placeholder is only ADDED when the SQL actually
// references it. An unreferenced placeholder is not harmless in Postgres — it fails the
// bind ("supplies N parameters, but prepared statement requires N-1"), the same class of
// bug the borrower-view scope hit. So this returns BOTH the fragment and its params.
function viewerScope(viewer, anyOnFile, startAt = 0) {
  const params = [viewer.id];
  const me = `$${startAt + 1}`;
  let onFile;
  if (anyOnFile) {
    onFile = assigneeExistsSql('a', me);
  } else {
    params.push(viewer.role || '');
    onFile = `(e.target_role = $${startAt + 2} AND ${assigneeExistsSql('a', me)})`;
  }
  return { sql: `(e.assigned_to = ${me} OR e.requested_by = ${me} OR ${onFile})`, params };
}

/**
 * List escalations for the workload surface. When `viewer` is passed (a non-see-all
 * staffer), the list is scoped by viewerScopeSql above. A super-admin (or a caller
 * passing seeAll) sees everything. status: 'open'|'resolved'|'dismissed'|'all'.
 */
async function listEscalations({ status = 'open', limit = 200, viewer = null, seeAll = false, anyOnFile = false } = {}, client = db) {
  const where = [];
  const params = [];
  if (status && status !== 'all') { params.push(status); where.push(`e.status = $${params.length}`); }
  if (viewer && !seeAll) {
    const scope = viewerScope(viewer, anyOnFile, params.length);
    params.push(...scope.params);
    where.push(scope.sql);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const r = await client.query(`${LIST_SELECT} ${clause} ORDER BY e.created_at DESC LIMIT ${lim}`, params);
  return r.rows.map(withEffectivePage);
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
async function pendingCount({ viewer = null, seeAll = false, anyOnFile = false } = {}, client = db) {
  try {
    if (seeAll || !viewer) {
      const r = await client.query(`SELECT count(*)::int AS n FROM finding_escalations WHERE status='open'`);
      return r.rows[0] ? r.rows[0].n : 0;
    }
    const scope = viewerScope(viewer, anyOnFile, 0);
    const r = await client.query(
      `SELECT count(*)::int AS n FROM finding_escalations e
         JOIN applications a ON a.id = e.application_id
        WHERE e.status='open' AND ${scope.sql}`,
      scope.params);
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
  openEscalation, listEscalations, forFile, pendingCount, decideEscalation, mayDecide,
  _internals: { withEffectivePage, viewerScope },
};
