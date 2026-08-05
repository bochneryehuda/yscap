'use strict';

/**
 * TPO VIEW — an internal staffer steps INTO a TPO broker's login (owner-directed
 * 2026-08-04; TPO blueprint decision 6). The exact mirror of BORROWER VIEW
 * (src/lib/borrower-view.js) for the external brokerage portal:
 *
 *   "our account executives & account managers can step INTO any of their TPO
 *    users' logins and see exactly what the broker sees — the same machinery as
 *    staff 'borrower view'."
 *
 * ────────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS (identical to borrower view, one identity swapped)
 * ────────────────────────────────────────────────────────────────────────────
 * Every /api/tpo endpoint is firm-scoped off the acting external user's id
 * (`permissions.tpoFirmScopeSql`), so the highest-fidelity "see what they see"
 * is to hand the staffer a REAL tpo access token for that broker. The SPA then
 * runs the actual TPO portal, hitting the actual /api/tpo API, with the actual
 * firm's data and the exact borrower-safe filters — there is no second
 * implementation to keep in sync.
 *
 * The token is a normal `kind:'tpo'` access token PLUS an impersonation envelope:
 *
 *     { sub: <tpoUserId>, kind:'tpo', role:<broker role>, tv: <broker tv>,
 *       imp: 1,                 ← the marker every consumer keys on
 *       impBy:  <staffId>,      ← the REAL internal human
 *       impRole:<staffRole>,
 *       impTv:  <staff token_version>,   ← so a password reset / "sign out everywhere" / deactivation kills it
 *       impSid: <tpo_view_sessions.id>,
 *       impAt:  <epoch seconds the session started> }   ← the absolute cap anchor
 *
 * `authenticate()` (src/auth/index.js) re-validates BOTH identities on every
 * request: the broker's token_version (the main session query, because
 * claims.sub is the broker) AND the internal staffer's row (still active,
 * INTERNAL, token_version unchanged, session inside its absolute cap). So the
 * moment the staffer is deactivated, has their password reset / "signs out
 * everywhere" (both bump their tv), the firm is suspended (which bumps the
 * broker's tv), or the 4-hour absolute cap runs out, every tpo-view request
 * stops. (A plain per-device sign-out does NOT bump token_version — the same
 * bounded behavior as borrower view; the token lives only in the staffer's own
 * browser and is hard-capped at 4 hours.)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY *NOT* AVAILABLE INSIDE A TPO VIEW
 * ────────────────────────────────────────────────────────────────────────────
 * Full parity, minus a tiny blocklist that covers only acts that are not
 * "seeing what they see" — an irreversible external side-effect fired in the
 * broker's name, or acts that damage the real broker's own session:
 *
 *   1. ORDER CREDIT (`POST /api/tpo/applications/:id/credit/order`). This is a
 *      LIVE Xactus pull — a real hard inquiry on the borrower's credit + a real
 *      cost, recorded as the broker's action and impossible to undo. A staffer
 *      "looking at what they see" must not fire it in the broker's name; WE can
 *      order credit from the staff console under our own identity. This is the
 *      TPO analogue of borrower view blocking the e-sign ceremony.
 *   2. CREDENTIALS + 2FA (`/auth/logout`, `/auth/mfa/*`). `/auth/logout` bumps
 *      the broker's token_version — a staffer "signing out" of a broker view
 *      would sign the REAL broker out of their own devices. The MFA routes would
 *      change the broker's second factor.
 *   3. NESTING (`/api/tpo-view/start`). A tpo view cannot start another view.
 *
 * There is deliberately NO term-sheet-send block here: sending the official term
 * sheet on DocuSign is lender-only (`send_term_sheet`), the send route is
 * staff-only, and `can()` refuses a tpo actor — so a broker (and therefore a
 * broker view) is structurally unable to send it. Nothing to block.
 *
 * Everything else — every screen, every upload, every tool, every condition,
 * pricing/register, the appraisal + draw views — behaves exactly as it does for
 * the broker, and is audited with the real staffer's id attached.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHO MAY VIEW WHOM
 * ────────────────────────────────────────────────────────────────────────────
 *   • `see_all_files` capability (admin / super_admin / …) → ANY active broker
 *     at ANY active firm.
 *   • everyone else (the AE / AM on the file team) → only brokers whose FIRM has
 *     a file they can already open, resolved by the SAME `visibleOfficersSql`
 *     chokepoint the rest of the staff API uses. One definition of "my files" —
 *     so a tpo view can never reach a firm the staffer could not already reach.
 */

const C = require('./crypto');
const perms = require('./permissions');

// The token/blocklist half of this module is PURE (no database), so it can be
// unit-tested with no Postgres — the same discipline as borrower-view.js.
let _db = null;
const database = () => (_db || (_db = require('../db')));

// How long a single tpo-view access token is valid before the SPA re-mints it
// transparently via the sliding refresh header.
const TOKEN_TTL_SEC = 30 * 60;
// The ABSOLUTE cap on one tpo-view session, measured from `impAt`. Past this the
// session cannot be refreshed and the staffer lands back in their own console.
const MAX_SESSION_SEC = 4 * 60 * 60;

// ---------------------------------------------------------------------------
// Blocked-while-impersonating routes (see the header note for the rationale).
// PURE data + a pure matcher, so the pure test can prove the list without a
// server or a database.
// ---------------------------------------------------------------------------
const BLOCKED = [
  {
    code: 'credit_order',
    method: /^POST$/i,
    path: /^\/api\/tpo\/applications\/[^/]+\/credit\/order\/?$/i,
    message: 'Ordering a credit pull runs a real credit check in the broker’s name — that is the broker’s own action. You can order credit from your console instead.',
  },
  {
    // Accepting a draw inspection result RELEASES MONEY (starts the wire SLA) and a dispute is a
    // formal decision — both in the broker's name. Like the credit-order block above (and the
    // borrower-view e-sign block), these irreversible/money decisions must be made by the broker
    // under their own identity, not by a staffer wearing it. A staffer accepts/disputes on our side
    // from the staff draw desk (attributed to them, accepted_via='staff').
    code: 'draw_action',
    method: /^POST$/i,
    path: /^\/api\/tpo\/applications\/[^/]+\/findings\/[^/]+\/(accept|dispute)\/?$/i,
    message: 'Accepting or disputing a draw releases money in the broker’s name — that is the broker’s own decision. Handle it from the draw desk on your own console instead.',
  },
  {
    code: 'logout',
    method: /^POST$/i,
    path: /^\/auth\/logout\/?$/i,
    message: 'Signing out here would sign the real broker out of their own devices. Use “Back to my console” to leave the broker view.',
  },
  {
    code: 'mfa',
    method: /^(POST|PUT|PATCH|DELETE)$/i,
    path: /^\/auth\/mfa\//i,
    message: 'Two-factor settings can only be changed by the broker themselves.',
  },
  {
    code: 'nested',
    method: /^POST$/i,
    path: /^\/api\/tpo-view\/start\/?$/i,
    message: 'You are already in a broker view. Go back to your console first.',
  },
];

/**
 * Is this request blocked while a tpo view is active?
 * @returns {{code:string,message:string}|null}
 */
function blockedReason(method, path) {
  const m = String(method || '');
  const p = String(path || '').split('?')[0];
  const hit = BLOCKED.find((b) => b.method.test(m) && b.path.test(p));
  return hit ? { code: hit.code, message: hit.message } : null;
}

/**
 * Read the impersonation envelope off verified JWT claims. Only meaningful on a
 * `kind:'tpo'` token — the envelope on any other kind is ignored, so a borrower
 * view (kind:'borrower') and a tpo view never resolve each other's envelope.
 * @returns {{staffId,role,staffTv,sessionId,startedAt}|null}
 */
function readImpersonation(claims) {
  if (!claims || !claims.imp || claims.kind !== 'tpo' || !claims.impBy) return null;
  return {
    staffId: claims.impBy,
    role: claims.impRole || null,
    staffTv: claims.impTv || 0,
    sessionId: claims.impSid || null,
    startedAt: Number(claims.impAt) || 0,
  };
}

/** Has this tpo-view session passed its absolute cap? */
function sessionExpired(imp, nowSec = Math.floor(Date.now() / 1000)) {
  if (!imp || !imp.startedAt) return true;      // no anchor = never refreshable
  return (nowSec - imp.startedAt) >= MAX_SESSION_SEC;
}

/** Mint the tpo-view access token (a real tpo token + the envelope). */
function mintToken({ tpoUserId, tpoTv, tpoRole, staffId, staffRole, staffTv, sessionId, startedAt }) {
  return C.signJwt({
    sub: tpoUserId,
    kind: 'tpo',
    role: tpoRole || null,
    tv: tpoTv || 0,
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
 * action is refused structurally — a /api/tpo route added tomorrow cannot forget
 * to check. It verifies the bearer token itself (stateless, no DB).
 */
function guard(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!raw) return next();
  const claims = C.verifyJwt(raw);
  const imp = readImpersonation(claims);
  if (!imp) return next();
  const blocked = blockedReason(req.method, req.path);
  if (!blocked) return next();
  if (req.auditError) req.auditError(`tpo_view_blocked:${blocked.code}`);
  return res.status(403).json({ error: blocked.message, tpoViewBlocked: blocked.code });
}

// ---------------------------------------------------------------------------
// Who may view whom
// ---------------------------------------------------------------------------

// ONE definition of "a broker I can step into", built on the SAME file-scope the
// rest of the staff API uses. `p` is the acting-internal-staff-id placeholder —
// a FUNCTION, not a fixed string, exactly like `visibleOfficersSql`, because a
// `see_all_files` caller drops this clause entirely and a hardcoded `$1` would
// then be an unreferenced parameter (Postgres 42P18). `t` is the outer tpo-user
// (broker) alias. A staffer reaches a broker when that broker's FIRM has a file
// the staffer can already open. On a TPO file `a.loan_officer_id` is the broker
// (external), so the staffer never matches through it — the AE/AM match comes
// through the assignee / workflow terms inside `visibleOfficersSql`, which is
// exactly the account_executive / account_manager relationship.
const ELIGIBLE_TPO_SQL = (p) => `
  EXISTS (SELECT 1 FROM applications a
           WHERE a.is_tpo = true
             AND a.tpo_firm_id = t.tpo_firm_id
             AND a.deleted_at IS NULL
             AND ${perms.visibleOfficersSql('a', p)})`;

const seesAll = (actor) => perms.can(actor, 'see_all_files');

/**
 * May this internal staffer open a tpo view as this broker? Returns the broker
 * row (id/name/email/role/firm + whether they even have a login) or null when
 * the staffer is not allowed to, the broker is not an active external user, or
 * the firm is not active.
 */
async function resolveViewable(actor, tpoUserId, dbc) {
  if (!actor || actor.kind !== 'staff' || !tpoUserId) return null;
  dbc = dbc || database();
  const params = [tpoUserId];
  let scope = '';
  if (!seesAll(actor)) { params.push(actor.id); scope = `AND ${ELIGIBLE_TPO_SQL('$' + params.length)}`; }
  const r = await dbc.query(
    `SELECT t.id, t.full_name, t.email, t.role, t.tpo_firm_id,
            f.name AS firm_name, f.status AS firm_status,
            (t.password_hash IS NOT NULL) AS has_login,
            COALESCE(t.token_version, 0) AS token_version
       FROM staff_users t
       JOIN tpo_firms f ON f.id = t.tpo_firm_id
      WHERE t.id = $1 AND t.is_external = true AND t.is_active = true
        AND f.status = 'active'
        ${scope}
      LIMIT 1`,
    params);
  return r.rows[0] || null;
}

/**
 * The brokers this staffer may step into, grouped by firm, newest-file-first,
 * with enough context to pick the right one.
 */
async function listEligible(actor, { q = '', limit = 60 } = {}, dbc) {
  if (!actor || actor.kind !== 'staff') return [];
  dbc = dbc || database();
  const term = String(q || '').trim().slice(0, 80);
  const params = [];
  let scope = '';
  if (!seesAll(actor)) { params.push(actor.id); scope = `AND ${ELIGIBLE_TPO_SQL('$' + params.length)}`; }
  let search = '';
  if (term.length >= 2) {
    params.push('%' + term + '%');
    search = `AND (t.full_name ILIKE $${params.length}
                   OR COALESCE(t.email,'') ILIKE $${params.length}
                   OR f.name ILIKE $${params.length})`;
  }
  params.push(Math.min(200, Math.max(1, parseInt(limit, 10) || 60)));
  const r = await dbc.query(
    `SELECT t.id, t.full_name, t.email, t.role, t.is_firm_admin, t.last_login_at,
            t.tpo_firm_id, f.name AS firm_name,
            (t.password_hash IS NOT NULL) AS has_login,
            (SELECT count(*)::int FROM applications a
              WHERE a.tpo_firm_id = t.tpo_firm_id AND a.deleted_at IS NULL) AS firm_file_count
       FROM staff_users t
       JOIN tpo_firms f ON f.id = t.tpo_firm_id
      WHERE t.is_external = true AND t.is_active = true AND f.status = 'active'
        ${scope} ${search}
      ORDER BY f.name, t.is_firm_admin DESC, t.full_name
      LIMIT $${params.length}`,
    params);
  return r.rows;
}

// ---------------------------------------------------------------------------
// Session register
// ---------------------------------------------------------------------------

/**
 * Open a tpo-view session and mint its token. Any session this staffer still had
 * open is closed first ('superseded') so the register always shows at most one
 * live view per person.
 */
async function startSession({ actor, broker, applicationId = null, ip = null, userAgent = null }, dbc) {
  dbc = dbc || database();
  await dbc.query(
    `UPDATE tpo_view_sessions
        SET ended_at = now(), end_reason = 'superseded'
      WHERE staff_id = $1 AND ended_at IS NULL`, [actor.id]).catch(() => {});
  // The impersonator MUST be an INTERNAL staffer (never external) and active.
  const staff = await dbc.query(
    `SELECT token_version, role FROM staff_users WHERE id = $1 AND is_active = true AND is_external = false`, [actor.id]);
  if (!staff.rows[0]) return null;
  const s = await dbc.query(
    `INSERT INTO tpo_view_sessions
       (staff_id, tpo_user_id, tpo_firm_id, staff_role, application_id, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, extract(epoch FROM started_at)::bigint AS started_epoch`,
    [actor.id, broker.id, broker.tpo_firm_id, actor.role || staff.rows[0].role || null,
     applicationId || null, ip || null, (userAgent || '').slice(0, 500) || null]);
  const row = s.rows[0];
  const startedAt = Number(row.started_epoch);
  const token = mintToken({
    tpoUserId: broker.id,
    tpoTv: broker.token_version || 0,
    tpoRole: broker.role || null,
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
    `UPDATE tpo_view_sessions
        SET last_seen_at = now(), request_count = request_count + 1
      WHERE id = $1 AND ended_at IS NULL`, [sessionId]).catch(() => {});
}

/** Close a session. `reason`: exit | expired | revoked | superseded. */
function endSession(sessionId, reason = 'exit', dbc) {
  if (!sessionId) return Promise.resolve();
  return (dbc || database()).query(
    `UPDATE tpo_view_sessions
        SET ended_at = now(), end_reason = $2
      WHERE id = $1 AND ended_at IS NULL`, [sessionId, String(reason).slice(0, 40)]).catch(() => {});
}

/**
 * The register, newest first. A staffer sees their OWN history; anyone with
 * `view_audit_log` (admins) sees everyone's.
 */
async function history(actor, { limit = 100 } = {}, dbc) {
  dbc = dbc || database();
  const all = perms.can(actor, 'view_audit_log');
  const params = [];
  let scope = '';
  if (!all) { params.push(actor.id); scope = `WHERE v.staff_id = $${params.length}`; }
  params.push(Math.min(500, Math.max(1, parseInt(limit, 10) || 100)));
  const r = await dbc.query(
    `SELECT v.id, v.staff_id, v.tpo_user_id, v.tpo_firm_id, v.staff_role, v.application_id,
            v.started_at, v.last_seen_at, v.ended_at, v.end_reason, v.request_count,
            s.full_name AS staff_name, s.email AS staff_email,
            t.full_name AS broker_name, t.email AS broker_email,
            f.name AS firm_name
       FROM tpo_view_sessions v
       JOIN staff_users s ON s.id = v.staff_id
       JOIN staff_users t ON t.id = v.tpo_user_id
       LEFT JOIN tpo_firms f ON f.id = v.tpo_firm_id
       ${scope}
      ORDER BY v.started_at DESC
      LIMIT $${params.length}`, params);
  return r.rows;
}

module.exports = {
  TOKEN_TTL_SEC, MAX_SESSION_SEC,
  BLOCKED, blockedReason, readImpersonation, sessionExpired, mintToken, guard,
  ELIGIBLE_TPO_SQL,
  resolveViewable, listEligible,
  startSession, touchSession, endSession, history,
};
