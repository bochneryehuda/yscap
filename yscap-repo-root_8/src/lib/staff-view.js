'use strict';

/**
 * STAFF VIEW — a super-admin steps into a TEAM MEMBER's own console, read-only.
 *
 * Owner-directed 2026-08-23: *"When I go to People, basically my team, I can make
 * myself see the screen that they see when they log into long-term view — not
 * only long-term: on this screen I switch from long-term view to short-term
 * view, whatever. I can test that out to see if everybody sees their own files."*
 *
 * THE THIRD SIBLING of borrower-view and tpo-view, same architecture on purpose:
 * the viewer gets a REAL staff access token for the TARGET person plus an
 * impersonation envelope, so the SPA runs the actual staff app with the target's
 * actual role, permissions and scope. The product switch works inside the view
 * for free — it is the same console the target uses, so "their entire screen"
 * means exactly that, and there is no preview implementation to drift.
 *
 * WHERE IT IS DELIBERATELY STRICTER THAN ITS SIBLINGS, and why:
 *
 *   READ-ONLY, WHOLESALE. A borrower view may act, because the staffer is
 *   walking a client through the client's own choices, in the client's name,
 *   on a recorded session. A staffer acting AS ANOTHER STAFFER has no honest
 *   attribution: every audit row, sign-off and comment would carry the wrong
 *   person's name. So the guard blocks EVERY state-changing request while the
 *   envelope is present — not a blocklist of the dangerous ones, an allowlist
 *   of none — and the only POSTs that pass are exiting the view itself.
 *   Looking is the feature ("I can test that out to SEE").
 *
 *   SUPER-ADMIN ONLY to start ("when I'm going on as my super admin"), the
 *   target must be an ACTIVE, INTERNAL staffer, and never yourself. No nesting:
 *   a view cannot start another view — of any kind — which the read-only guard
 *   already enforces (all three /start doors are POSTs) and /start re-checks
 *   anyway, because a guard and a door agreeing is worth one line each.
 *
 * The envelope keys are impStaff* rather than the siblings' imp* so no reader
 * can ever mistake one surface's envelope for another's: a staff token carrying
 * impBy would read as nothing anywhere, and vice versa.
 */

const C = require('./crypto');   // the shared signJwt — the same pen its two siblings sign with

let _db = null;
const database = () => (_db || (_db = require('../db')));

// Same clocks as borrower-view, for the same reasons: the token slides, the
// session cannot outlive its absolute cap, a forgotten tab dies on its own.
const TOKEN_TTL_SEC = 30 * 60;
const MAX_SESSION_SEC = 4 * 60 * 60;

/**
 * MAY THIS REQUEST PASS WHILE A STAFF VIEW IS ACTIVE? Pure, so the test proves
 * the whole rule without a server. GET/HEAD/OPTIONS see everything the target
 * sees; the ONLY writes allowed are leaving the view. `/auth/logout` is blocked
 * with everything else — it bumps the TARGET's token_version, which would kick
 * the real person off their own devices mid-work.
 */
function writeAllowed(method, path) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const p = String(path || '');
  return p === '/api/staff-view/exit' || p.startsWith('/api/staff-view/exit?');
}

/** The plain-words refusal, one place, so every blocked write says the same thing. */
const READ_ONLY_MESSAGE = 'You are viewing this console as somebody else, and a view is read-only — '
  + 'changing things in their name would put your actions on their record. Exit the view to act as yourself.';

/**
 * Express guard, mounted ONCE in server.js before the routers — exactly like its
 * siblings, and for the same structural reason: a route added tomorrow cannot
 * forget to check. It verifies the bearer itself (stateless, no DB) rather than
 * reading anything auth sets, because it runs BEFORE authentication: the first
 * draft read req.staffImpersonation here, which at this point in the chain is
 * never set — a guard that would have quietly allowed every write it exists to
 * block. Auth still re-validates the envelope's humans on every request; this
 * only answers "is a write allowed to even reach a router".
 */
function guard(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!raw) return next();
  const C2 = require('./crypto');
  const imp = readImpersonation(C2.verifyJwt(raw));
  if (!imp) return next();
  if (writeAllowed(req.method, req.path)) return next();
  if (req.auditError) req.auditError('staff_view_blocked:read_only');
  return res.status(403).json({ error: READ_ONLY_MESSAGE, staffViewReadOnly: true });
}

/** The envelope off a verified token's claims, or null. Keys on kind + marker. */
function readImpersonation(claims) {
  if (!claims || claims.kind !== 'staff' || claims.impStaff !== 1) return null;
  if (!claims.impStaffBy || !claims.impStaffSid) return null;
  return {
    viewerId: String(claims.impStaffBy),
    viewerRole: claims.impStaffRole || null,
    viewerTv: Number(claims.impStaffTv) || 0,
    sessionId: String(claims.impStaffSid),
    startedAt: Number(claims.impStaffAt) || 0,
  };
}

function sessionExpired(imp, nowSec = Math.floor(Date.now() / 1000)) {
  return !imp || !imp.startedAt || (nowSec - imp.startedAt) > MAX_SESSION_SEC;
}

/** A real staff token for the TARGET, plus the envelope naming the viewer. */
function mintToken({ targetId, targetRole, targetTv, viewerId, viewerRole, viewerTv, sessionId, startedAt }) {
  return C.signJwt({
    sub: String(targetId), kind: 'staff', role: targetRole || 'staff',
    tv: Number(targetTv) || 0,
    impStaff: 1,
    impStaffBy: String(viewerId),
    impStaffRole: viewerRole || null,
    impStaffTv: Number(viewerTv) || 0,
    impStaffSid: String(sessionId),
    impStaffAt: Number(startedAt),
  }, TOKEN_TTL_SEC);
}

async function startSession({ viewer, target, ip = null, userAgent = null }, dbc = database()) {
  const { rows } = await dbc.query(
    `INSERT INTO staff_view_sessions (staff_id, viewer_staff_id, ip, user_agent)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     RETURNING id, extract(epoch FROM started_at)::bigint AS started_at`,
    [target.id, viewer.id, ip, userAgent]);
  return { id: rows[0].id, startedAt: Number(rows[0].started_at) };
}

/** Best-effort enders — a session register failure must never block a request. */
function endSession(sessionId, reason) {
  if (!sessionId) return;
  database().query(
    `UPDATE staff_view_sessions SET ended_at = now(), ended_reason = $2
      WHERE id = $1::uuid AND ended_at IS NULL`, [sessionId, String(reason || 'exited')],
  ).catch(() => {});
}
function touchSession(sessionId) {
  if (!sessionId) return;
  database().query(
    `UPDATE staff_view_sessions SET last_seen_at = now() WHERE id = $1::uuid`, [sessionId],
  ).catch(() => {});
}

module.exports = {
  TOKEN_TTL_SEC, MAX_SESSION_SEC, READ_ONLY_MESSAGE,
  writeAllowed, guard, readImpersonation, sessionExpired, mintToken,
  startSession, endSession, touchSession,
};
