'use strict';
/**
 * HTTP for STAFF VIEW — a super-admin steps into a team member's own console,
 * read-only. The third sibling of routes/borrower-view.js and routes/tpo-view.js,
 * same doors: eligible / start / session / exit / history.
 *
 * Owner-directed 2026-08-23, and the owner's own framing is the security model:
 * "when I'm going on as MY SUPER ADMIN ... I can make myself see the screen that
 * they see". Starting is super-admin only; the session is read-only structurally
 * (src/lib/staff-view.js guard, mounted globally); every session is on the
 * record (db/620).
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, mintStaffSession } = require('../auth');
const staffView = require('../lib/staff-view');

// Every door here needs a verified actor; the session/exit pair additionally
// reads the impersonation auth attaches. Same wall as the sibling routers.
router.use(requireAuth);

/** Only a live super-admin opens any of these doors. */
function requireSuperAdmin(req, res, next) {
  const a = req.actor;
  if (!a || a.kind !== 'staff' || String(a.role) !== 'super_admin') {
    return res.status(403).json({ error: 'Only a super admin can look through somebody else\'s screen.' });
  }
  // NO NESTING, second copy on the door itself: the read-only guard already blocks
  // every POST inside a view, but a guard and a door agreeing costs one line.
  if (req.staffImpersonation) {
    return res.status(403).json({ error: 'You are already viewing as somebody — exit that view first.' });
  }
  next();
}

/** Who can be viewed: every active internal staffer except yourself. */
router.get('/eligible', requireSuperAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, email, role
         FROM staff_users
        WHERE is_active = true AND is_external = false AND id <> $1::uuid
          AND ($2 = '' OR lower(full_name) LIKE '%'||$2||'%' OR lower(email) LIKE '%'||$2||'%')
        ORDER BY full_name
        LIMIT 60`,
      [req.actor.id, q]);
    res.json({ people: rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not list the team right now.' });
  }
});

router.post('/start', requireSuperAdmin, async (req, res) => {
  const targetId = String((req.body && req.body.staffId) || '').trim();
  if (!targetId) return res.status(400).json({ error: 'Whose screen? Nobody was named.' });
  if (targetId === String(req.actor.id)) {
    return res.status(400).json({ error: 'That is your own screen — you are already looking at it.' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, role, token_version
         FROM staff_users
        WHERE id = $1::uuid AND is_active = true AND is_external = false`,
      [targetId]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: 'That team member does not exist or is not active.' });

    const session = await staffView.startSession({
      viewer: { id: req.actor.id },
      target: { id: target.id },
      ip: req.ip || null,
      userAgent: req.get('user-agent') || null,
    });
    /* THE VIEWER'S OWN token_version, READ FROM THE DATABASE — exactly as the borrower-
       view and TPO-view siblings do (borrower-view.js startSession, tpo-view.js). This
       used to read `req.actor.tokenVersion ?? req.actor.tv`, and neither property exists
       on req.actor (auth builds it as {id, kind, role, sid}), so every minted token
       carried viewerTv 0. The very next request re-validates the viewer against the
       row's real token_version (auth/index.js) — non-zero for anyone who ever set a
       password from an invite, reset it, or signed out everywhere — found a mismatch,
       ended the session as 'revoked' and answered 401 session:invalid, which the RTL
       client treats as "signed out" and bounces to the sign-in screen (owner-reported
       2026-09-01: "When I click on See my screen, I'm popping back up to the sign-in
       window"). The LT screen only looked like it worked because its HTTP client has
       no global session-expiry handling. */
    const viewer = (await db.query(
      `SELECT token_version FROM staff_users WHERE id = $1::uuid AND is_active = true AND is_external = false`,
      [req.actor.id])).rows[0];
    if (!viewer) return res.status(403).json({ error: 'Your own account could not be verified — sign in again and retry.' });
    const token = staffView.mintToken({
      targetId: target.id, targetRole: target.role, targetTv: target.token_version || 0,
      viewerId: req.actor.id, viewerRole: req.actor.role,
      viewerTv: viewer.token_version || 0,
      sessionId: session.id, startedAt: session.startedAt,
    });
    res.json({ ok: true, token, viewing: { id: target.id, name: target.full_name, role: target.role },
               maxSessionSec: staffView.MAX_SESSION_SEC });
  } catch (e) {
    res.status(500).json({ error: 'Could not start the view.' });
  }
});

/** What the banner draws: whether THIS token is a view, and of whom. */
router.get('/session', async (req, res) => {
  if (!req.staffImpersonation) return res.json({ active: false });
  const imp = req.staffImpersonation;
  res.json({
    active: true,
    viewing: { id: req.actor.id, name: req.actor.fullName || null, role: req.actor.role || null },
    viewer: { id: imp.viewerId, name: imp.viewerName, role: imp.viewerRole },
    startedAt: imp.startedAt,
    maxSessionSec: staffView.MAX_SESSION_SEC,
    readOnly: true,
  });
});

/** The one POST the read-only guard lets through. Hands the VIEWER a fresh token
 *  of their own — authoritative, exactly like the sibling exits — so leaving the
 *  view works even if the parked copy in the browser aged out while inside. */
router.post('/exit', async (req, res) => {
  if (!req.staffImpersonation) return res.json({ ok: true, wasActive: false });
  staffView.endSession(req.staffImpersonation.sessionId, 'exited');
  const token = await mintStaffSession(req.staffImpersonation.viewerId);
  if (!token) {
    return res.status(401).json({ error: 'Your own sign-in is no longer valid — please sign in again.' });
  }
  res.json({ ok: true, wasActive: true, token, kind: 'staff' });
});

/** The register, for the auditor's question. Super-admin only, like starting. */
router.get('/history', requireSuperAdmin, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.started_at, s.ended_at, s.ended_reason,
              t.full_name AS viewed_name, v.full_name AS viewer_name
         FROM staff_view_sessions s
         JOIN staff_users t ON t.id = s.staff_id
         JOIN staff_users v ON v.id = s.viewer_staff_id
        ORDER BY s.started_at DESC
        LIMIT $1`, [limit]);
    res.json({ sessions: rows });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the history right now.' });
  }
});

module.exports = router;
