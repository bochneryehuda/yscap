'use strict';

/**
 * BORROWER VIEW — a staffer steps INTO a borrower's portal (owner-directed
 * 2026-07-26).
 *
 * "They should switch their view like they are this borrower … they can guide
 * them live step by step and they can see how the borrower is seeing this
 * screen."
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS (and why it is built this way)
 * ────────────────────────────────────────────────────────────────────────────
 * Every borrower endpoint in this codebase is already scoped off ONE value:
 * `req.actor.id` (see `me(req)` / `OWN_FILE_SQL` in src/routes/borrower.js). So
 * the highest-fidelity possible "see what they see" is not a parallel read-only
 * mirror of the borrower screens (which would drift the moment anyone touches
 * the borrower portal) — it is to hand the staffer a REAL borrower access token
 * for that borrower. The SPA then runs the actual borrower app, hitting the
 * actual borrower API, with the actual borrower's data and permissions. There
 * is no second implementation to keep in sync, and no screen that can be
 * "almost" right.
 *
 * The token is a normal `kind:'borrower'` access token PLUS an impersonation
 * envelope:
 *
 *     { sub: <borrowerId>, kind:'borrower', role:'borrower', tv: <borrower tv>,
 *       imp: 1,                 ← the marker every consumer keys on
 *       impBy:  <staffId>,      ← the REAL human
 *       impRole:<staffRole>,
 *       impTv:  <staff token_version>,   ← so the staffer's own logout/lockout kills it
 *       impSid: <borrower_view_sessions.id>,
 *       impAt:  <epoch seconds the session started> }   ← the absolute cap anchor
 *
 * `authenticate()` (src/auth/index.js) re-validates BOTH identities on every
 * single request: the borrower's token_version AND the staffer's row (still
 * active, token_version unchanged, session not past its absolute cap). So the
 * moment the staffer is deactivated, logs out anywhere, or the cap runs out,
 * every borrower-view request stops — it is not a token that outlives its
 * owner.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* AVAILABLE INSIDE A BORROWER VIEW
 * ────────────────────────────────────────────────────────────────────────────
 * The owner asked for "the same options … same permissions", and that is what
 * this is: full parity across the borrower portal. The BLOCKED list below is
 * deliberately tiny and covers only actions that are not "seeing what they see"
 * at all — they are irreversible acts done in another person's legal identity,
 * or acts that would damage the real borrower's own session:
 *
 *   1. E-SIGNATURE (`/esign/sign-view`). Opening the signing ceremony as the
 *      borrower would let a staff member execute loan documents in the
 *      borrower's name. Every e-signature platform (DocuSign included) treats
 *      that as forgery; no impersonation feature anywhere allows it.
 *   2. CREDENTIALS + 2FA (`/auth/logout`, `/auth/mfa/*`). `/auth/logout` bumps
 *      the borrower's token_version — a staffer "signing out" of a borrower
 *      view would kick the REAL borrower off their phone mid-upload. The MFA
 *      routes would change the borrower's second factor.
 *   3. NESTING (`/api/borrower-view/start`). A borrower view cannot start
 *      another borrower view.
 *
 * Everything else — every screen, every upload, every tool, every condition,
 * every message, every draw, every pricing action — behaves exactly as it does
 * for the borrower, and is audited with the real staffer's id attached.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHO MAY VIEW WHOM
 * ────────────────────────────────────────────────────────────────────────────
 *   • `see_all_files` capability (admin / super_admin / underwriter /
 *     loan_coordinator / closer / draw_coordinator) → ANY borrower.
 *   • everyone else (loan officers, processors) → only borrowers who are the
 *     borrower or co-borrower on a file they can already open, resolved by the
 *     SAME `VISIBLE_OFFICERS_SQL` chokepoint the rest of the staff API uses
 *     (primary LO/processor, delegated visible_officer_ids, active assignee, or
 *     an open Workflow hand-off). One definition of "my files" — so borrower
 *     view can never reach a file the staffer could not already open.
 */

const C = require('./crypto');
const { can } = require('./permissions');

// The token/blocklist half of this module is PURE (no database), so it can be
// unit-tested with no Postgres — the same discipline as the draw-report builder.
// Postgres is required lazily, only by the functions that actually query.
let _db = null;
const database = () => (_db || (_db = require('../db')));

// How long a single borrower-view access token is valid before it must be
// re-minted (the SPA does that transparently via the sliding refresh header).
const TOKEN_TTL_SEC = 30 * 60;
// The ABSOLUTE cap on one borrower-view session, measured from `impAt`. Past
// this the session cannot be refreshed and the staffer lands back in their own
// console. Long enough to walk a borrower through a whole file on a call;
// short enough that a forgotten tab is never a standing key to someone's portal.
const MAX_SESSION_SEC = 4 * 60 * 60;

// ---------------------------------------------------------------------------
// Blocked-while-impersonating routes (see the header note for the rationale).
// PURE data + a pure matcher, so `scripts/test-borrower-view-pure.js` can prove
// the list without a server or a database.
// ---------------------------------------------------------------------------
const BLOCKED = [
  {
    code: 'esign',
    method: /^POST$/i,
    path: /^\/api\/borrower\/applications\/[^/]+\/esign\/sign-view\/?$/i,
    message: 'Signing documents is the borrower’s own action — a borrower view can open and read the package, but only the borrower can sign it.',
  },
  {
    code: 'logout',
    method: /^POST$/i,
    path: /^\/auth\/logout\/?$/i,
    message: 'Signing out here would sign the real borrower out of their own devices. Use “Back to my console” to leave the borrower view.',
  },
  {
    code: 'mfa',
    method: /^(POST|PUT|PATCH|DELETE)$/i,
    path: /^\/auth\/mfa\//i,
    message: 'Two-factor settings can only be changed by the borrower themselves.',
  },
  {
    code: 'nested',
    method: /^POST$/i,
    path: /^\/api\/borrower-view\/start\/?$/i,
    message: 'You are already in a borrower view. Go back to your console first.',
  },
];

/**
 * Is this request blocked while a borrower view is active?
 * @returns {{code:string,message:string}|null}
 */
function blockedReason(method, path) {
  const m = String(method || '');
  const p = String(path || '').split('?')[0];
  const hit = BLOCKED.find((b) => b.method.test(m) && b.path.test(p));
  return hit ? { code: hit.code, message: hit.message } : null;
}

/**
 * Read the impersonation envelope off verified JWT claims.
 * @returns {{staffId,role,staffTv,sessionId,startedAt}|null}
 */
function readImpersonation(claims) {
  if (!claims || !claims.imp || claims.kind !== 'borrower' || !claims.impBy) return null;
  return {
    staffId: claims.impBy,
    role: claims.impRole || null,
    staffTv: claims.impTv || 0,
    sessionId: claims.impSid || null,
    startedAt: Number(claims.impAt) || 0,
  };
}

/** Has this borrower-view session passed its absolute cap? */
function sessionExpired(imp, nowSec = Math.floor(Date.now() / 1000)) {
  if (!imp || !imp.startedAt) return true;      // no anchor = never refreshable
  return (nowSec - imp.startedAt) >= MAX_SESSION_SEC;
}

/** Mint the borrower-view access token (a real borrower token + the envelope). */
function mintToken({ borrowerId, borrowerTv, staffId, staffRole, staffTv, sessionId, startedAt }) {
  return C.signJwt({
    sub: borrowerId,
    kind: 'borrower',
    role: 'borrower',
    tv: borrowerTv || 0,
    imp: 1,
    impBy: staffId,
    impRole: staffRole || null,
    impTv: staffTv || 0,
    impSid: sessionId || null,
    impAt: startedAt,
  }, TOKEN_TTL_SEC);
}

/**
 * Global guard. Mounted ONCE in server.js (before the routers) so a blocked
 * action is refused structurally — a borrower route added tomorrow cannot
 * forget to check. It verifies the bearer token itself (stateless, no DB), so
 * it works regardless of which router the request is heading for.
 */
function guard(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!raw) return next();
  const claims = C.verifyJwt(raw);
  const imp = readImpersonation(claims);
  if (!imp) return next();
  const blocked = blockedReason(req.method, req.path);
  if (!blocked) return next();
  if (req.auditError) req.auditError(`borrower_view_blocked:${blocked.code}`);
  return res.status(403).json({ error: blocked.message, borrowerViewBlocked: blocked.code });
}

// ---------------------------------------------------------------------------
// Who may view whom
// ---------------------------------------------------------------------------

// ONE definition of "a borrower I can step into", mirroring the staff API's
// file scope. `p` is the acting-staff-id placeholder (e.g. '$2') — a FUNCTION,
// not a fixed string, exactly like `VISIBLE_OFFICERS_SQL` / `assigneeExistsSql`,
// because a `see_all_files` caller drops this clause entirely and a hardcoded
// `$1` would then be an unreferenced parameter (Postgres 42P18, "could not
// determine data type of parameter" — it would break borrower view for every
// admin). A staffer reaches a borrower when that borrower is the borrower OR
// co-borrower on a file they can already open.
const ELIGIBLE_BORROWER_SQL = (p) => `
  EXISTS (SELECT 1 FROM applications a
           WHERE (a.borrower_id = b.id OR a.co_borrower_id = b.id)
             AND a.deleted_at IS NULL
             AND (a.loan_officer_id = ${p}
                  OR a.processor_id = ${p}
                  OR a.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id = ${p})
                  OR EXISTS (SELECT 1 FROM application_assignees aa
                              WHERE aa.application_id = a.id AND aa.staff_id = ${p} AND aa.removed_at IS NULL)
                  OR EXISTS (SELECT 1 FROM workflow_items wi
                              WHERE wi.application_id = a.id AND wi.to_staff_id = ${p}
                                AND wi.status IN ('open','in_progress'))))`;

const seesAll = (actor) => can(actor, 'see_all_files');

/**
 * May this staffer open a borrower view as this borrower?
 * Returns the borrower row (id/name/email + whether they even have a login) or
 * null when the staffer is not allowed to.
 */
async function resolveViewable(actor, borrowerId, dbc) {
  if (!actor || actor.kind !== 'staff' || !borrowerId) return null;
  dbc = dbc || database();
  // Only bind the staff id when the scope clause actually references it.
  const params = [borrowerId];
  let scope = '';
  if (!seesAll(actor)) { params.push(actor.id); scope = `AND ${ELIGIBLE_BORROWER_SQL('$' + params.length)}`; }
  const r = await dbc.query(
    `SELECT b.id, b.first_name, b.last_name, b.email,
            (ba.borrower_id IS NOT NULL) AS has_login,
            COALESCE(ba.token_version, 0) AS token_version
       FROM borrowers b
       LEFT JOIN borrower_auth ba ON ba.borrower_id = b.id
      WHERE b.id = $1 ${scope}
      LIMIT 1`,
    params);
  return r.rows[0] || null;
}

/**
 * The borrowers this staffer may step into, newest-file-first, with enough
 * context to pick the right one (their files + last activity).
 */
async function listEligible(actor, { q = '', limit = 60 } = {}, dbc) {
  if (!actor || actor.kind !== 'staff') return [];
  dbc = dbc || database();
  const term = String(q || '').trim().slice(0, 80);
  // Same rule as resolveViewable: never bind a parameter the query does not
  // reference (an admin drops the scope clause; a blank search drops the search
  // clause), or Postgres cannot type it.
  const params = [];
  let scope = '';
  if (!seesAll(actor)) { params.push(actor.id); scope = `AND ${ELIGIBLE_BORROWER_SQL('$' + params.length)}`; }
  let search = '';
  if (term.length >= 2) {
    params.push('%' + term + '%');
    search = `AND (b.first_name ILIKE $${params.length} OR b.last_name ILIKE $${params.length}
                   OR (b.first_name || ' ' || b.last_name) ILIKE $${params.length}
                   OR COALESCE(b.email,'') ILIKE $${params.length})`;
  }
  params.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 60)));
  const r = await dbc.query(
    `SELECT b.id, b.first_name, b.last_name, b.email, b.last_seen_at,
            (ba.borrower_id IS NOT NULL) AS has_login,
            ba.last_login_at,
            (SELECT count(*)::int FROM applications a
              WHERE (a.borrower_id = b.id OR a.co_borrower_id = b.id) AND a.deleted_at IS NULL) AS file_count,
            (SELECT count(*)::int FROM applications a
               JOIN checklist_items ci ON ci.application_id = a.id
              WHERE (a.borrower_id = b.id OR a.co_borrower_id = b.id) AND a.deleted_at IS NULL
                AND ci.audience IN ('borrower','both')
                AND ci.status IN ('outstanding','requested','issue')) AS open_items,
            (SELECT max(a.updated_at) FROM applications a
              WHERE (a.borrower_id = b.id OR a.co_borrower_id = b.id) AND a.deleted_at IS NULL) AS last_file_activity
       FROM borrowers b
       LEFT JOIN borrower_auth ba ON ba.borrower_id = b.id
      WHERE EXISTS (SELECT 1 FROM applications a
                     WHERE (a.borrower_id = b.id OR a.co_borrower_id = b.id) AND a.deleted_at IS NULL)
        ${scope} ${search}
      ORDER BY last_file_activity DESC NULLS LAST, b.last_name, b.first_name
      LIMIT $${params.length}`,
    params);
  return r.rows;
}

// ---------------------------------------------------------------------------
// Session register
// ---------------------------------------------------------------------------

/**
 * Open a borrower-view session and mint its token. Any session this staffer
 * still had open is closed first ('superseded') so the register always shows at
 * most one live view per person — the same way the UI works.
 */
async function startSession({ actor, borrower, applicationId = null, ip = null, userAgent = null }, dbc) {
  dbc = dbc || database();
  await dbc.query(
    `UPDATE borrower_view_sessions
        SET ended_at = now(), end_reason = 'superseded'
      WHERE staff_id = $1 AND ended_at IS NULL`, [actor.id]).catch(() => {});
  const staff = await dbc.query(
    `SELECT token_version, role FROM staff_users WHERE id = $1 AND is_active = true`, [actor.id]);
  if (!staff.rows[0]) return null;
  const s = await dbc.query(
    `INSERT INTO borrower_view_sessions
       (staff_id, borrower_id, staff_role, application_id, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, extract(epoch FROM started_at)::bigint AS started_epoch`,
    [actor.id, borrower.id, actor.role || staff.rows[0].role || null,
     applicationId || null, ip || null, (userAgent || '').slice(0, 500) || null]);
  const row = s.rows[0];
  const startedAt = Number(row.started_epoch);
  const token = mintToken({
    borrowerId: borrower.id,
    borrowerTv: borrower.token_version || 0,
    staffId: actor.id,
    staffRole: actor.role || staff.rows[0].role || null,
    staffTv: staff.rows[0].token_version || 0,
    sessionId: row.id,
    startedAt,
  });
  return {
    token,
    sessionId: row.id,
    startedAt,
    expiresAt: (startedAt + MAX_SESSION_SEC) * 1000,
  };
}

/** Heartbeat — keeps `last_seen_at` + the request counter honest. Best-effort. */
function touchSession(sessionId, dbc) {
  if (!sessionId) return Promise.resolve();
  return (dbc || database()).query(
    `UPDATE borrower_view_sessions
        SET last_seen_at = now(), request_count = request_count + 1
      WHERE id = $1 AND ended_at IS NULL`, [sessionId]).catch(() => {});
}

/** Close a session. `reason`: exit | expired | revoked | superseded. */
function endSession(sessionId, reason = 'exit', dbc) {
  if (!sessionId) return Promise.resolve();
  return (dbc || database()).query(
    `UPDATE borrower_view_sessions
        SET ended_at = now(), end_reason = $2
      WHERE id = $1 AND ended_at IS NULL`, [sessionId, String(reason).slice(0, 40)]).catch(() => {});
}

/**
 * The register, newest first. A staffer sees their OWN history; anyone with
 * `view_audit_log` (admins) sees everyone's.
 */
async function history(actor, { limit = 100 } = {}, dbc) {
  dbc = dbc || database();
  const all = can(actor, 'view_audit_log');
  const params = [];
  let scope = '';
  if (!all) { params.push(actor.id); scope = `WHERE v.staff_id = $${params.length}`; }
  params.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 100)));
  const r = await dbc.query(
    `SELECT v.id, v.staff_id, v.borrower_id, v.staff_role, v.application_id,
            v.started_at, v.last_seen_at, v.ended_at, v.end_reason, v.request_count,
            s.full_name AS staff_name, s.email AS staff_email,
            b.first_name, b.last_name, b.email AS borrower_email
       FROM borrower_view_sessions v
       JOIN staff_users s ON s.id = v.staff_id
       JOIN borrowers b ON b.id = v.borrower_id
       ${scope}
      ORDER BY v.started_at DESC
      LIMIT $${params.length}`, params);
  return r.rows;
}

module.exports = {
  TOKEN_TTL_SEC, MAX_SESSION_SEC,
  BLOCKED, blockedReason, readImpersonation, sessionExpired, mintToken, guard,
  ELIGIBLE_BORROWER_SQL,
  resolveViewable, listEligible,
  startSession, touchSession, endSession, history,
};
