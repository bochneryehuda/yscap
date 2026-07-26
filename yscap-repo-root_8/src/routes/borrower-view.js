/**
 * BORROWER VIEW routes — "see the portal exactly as this borrower sees it"
 * (owner-directed 2026-07-26). Design + the security model live in
 * src/lib/borrower-view.js; this file is just the doors.
 *
 *   GET  /api/borrower-view/eligible?q=   (staff)   borrowers I may step into
 *   POST /api/borrower-view/start         (staff)   → a borrower-view token
 *   GET  /api/borrower-view/session       (either)  what am I in right now
 *   POST /api/borrower-view/exit          (in-view) → my own staff token back
 *   GET  /api/borrower-view/history       (staff)   the register (mine, or all
 *                                                   with view_audit_log)
 *
 * This router is mounted OUTSIDE /api/staff on purpose: `session` and `exit`
 * must be callable while holding a BORROWER-kind token (the whole point), which
 * the staff router's `requireRole` wall would refuse.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff, mintStaffSession } = require('../auth');
const bv = require('../lib/borrower-view');

router.use(requireAuth);

async function audit(req, action, detail, entityId) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail,impersonator_staff_id)
       VALUES ($1,$2,$3,'borrower',$4,$5,$6,$7,$8)`,
      [req.actor.kind, req.actor.id, action, entityId || null, req.ip,
       req.get('user-agent') || null, detail || null,
       (req.impersonation && req.impersonation.staffId) || null]);
  } catch (e) {
    console.warn(`[borrower-view] audit write failed (${action}):`,
      db.describeError ? db.describeError(e) : e.message);
  }
}

const borrowerName = (b) => [b.first_name, b.last_name].filter(Boolean).join(' ').trim() || b.email || 'Borrower';

// ---- the picker: which borrowers may I step into --------------------------
router.get('/eligible', requireStaff, async (req, res) => {
  const rows = await bv.listEligible(req.actor, { q: req.query.q, limit: req.query.limit });
  res.json({
    borrowers: rows.map((b) => ({
      id: b.id,
      name: borrowerName(b),
      email: b.email,
      hasLogin: !!b.has_login,
      fileCount: b.file_count || 0,
      openItems: b.open_items || 0,
      lastLoginAt: b.last_login_at,
      lastSeenAt: b.last_seen_at,
      lastFileActivity: b.last_file_activity,
    })),
    // The SPA shows a different empty-state for "you have no files yet" vs
    // "nobody matched your search".
    scope: require('../lib/permissions').can(req.actor, 'see_all_files') ? 'all' : 'assigned',
  });
});

// ---- step in --------------------------------------------------------------
router.post('/start', requireStaff, async (req, res) => {
  const borrowerId = String((req.body || {}).borrowerId || '').trim();
  const applicationId = ((req.body || {}).applicationId || null) || null;
  if (!borrowerId) return res.status(400).json({ error: 'borrowerId required' });

  const borrower = await bv.resolveViewable(req.actor, borrowerId);
  if (!borrower) {
    // Same answer whether the borrower does not exist or is simply outside this
    // staffer's pipeline — a scoped officer must not be able to probe for who
    // exists by id.
    if (req.auditError) req.auditError('borrower_view_denied');
    return res.status(403).json({ error: 'You can only open a borrower view for borrowers on your own files.' });
  }
  // A borrower with no login row has no portal to look at. Say so plainly
  // instead of dropping the staffer into an empty session.
  if (!borrower.has_login) {
    return res.status(409).json({
      error: `${borrowerName(borrower)} hasn’t set up their PILOT login yet, so there is no borrower view to open. Invite them from the Borrowers screen first.`,
      needsInvite: true,
      borrowerId: borrower.id,
    });
  }
  // The file the staffer entered from is recorded for the register — but only
  // when it really is one of that borrower's files.
  let appId = null;
  if (applicationId) {
    const a = await db.query(
      `SELECT id FROM applications
        WHERE id=$1 AND deleted_at IS NULL AND (borrower_id=$2 OR co_borrower_id=$2)`,
      [applicationId, borrower.id]).catch(() => ({ rows: [] }));
    appId = a.rows[0] ? a.rows[0].id : null;
  }

  const session = await bv.startSession({
    actor: req.actor,
    borrower,
    applicationId: appId,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  if (!session) return res.status(403).json({ error: 'forbidden' });

  await audit(req, 'borrower_view_start', {
    borrowerId: borrower.id, borrowerName: borrowerName(borrower),
    applicationId: appId, sessionId: session.sessionId,
  }, borrower.id);

  res.json({
    token: session.token,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    borrower: { id: borrower.id, name: borrowerName(borrower), email: borrower.email },
    // Where to land: straight in the file when they came from one.
    landing: appId ? `/app/${appId}` : '/dashboard',
  });
});

// ---- where am I ------------------------------------------------------------
// Callable with EITHER token kind: inside a view it describes the view; outside
// it answers `active:false` so the SPA can clear a stale local banner.
router.get('/session', async (req, res) => {
  if (!req.impersonation) return res.json({ active: false });
  const b = await db.query(
    `SELECT id, first_name, last_name, email FROM borrowers WHERE id=$1`, [req.actor.id]);
  const row = b.rows[0] || {};
  res.json({
    active: true,
    borrower: { id: req.actor.id, name: borrowerName(row), email: row.email || null },
    staff: {
      id: req.impersonation.staffId,
      name: req.impersonation.name,
      role: req.impersonation.role,
    },
    sessionId: req.impersonation.sessionId,
    startedAt: req.impersonation.startedAt * 1000,
    expiresAt: (req.impersonation.startedAt + bv.MAX_SESSION_SEC) * 1000,
  });
});

// ---- step back out ---------------------------------------------------------
// Hands back a FRESH staff token rather than trusting whatever the browser had
// stashed, so leaving a borrower view always works — even if the staffer's own
// token expired while they were inside one.
router.post('/exit', async (req, res) => {
  if (!req.impersonation) return res.status(400).json({ error: 'not in a borrower view' });
  const { staffId, sessionId } = req.impersonation;
  await bv.endSession(sessionId, 'exit');
  await audit(req, 'borrower_view_exit', { borrowerId: req.actor.id, sessionId }, req.actor.id);
  const token = await mintStaffSession(staffId);
  if (!token) {
    // Their staff account was deactivated while they were inside. The borrower
    // view is closed either way; they have to sign in again.
    return res.status(401).json({ error: 'Your internal session is no longer valid — please sign in again.' });
  }
  res.json({ token, kind: 'staff' });
});

// ---- the register ----------------------------------------------------------
router.get('/history', requireStaff, async (req, res) => {
  const rows = await bv.history(req.actor, { limit: req.query.limit });
  res.json({
    sessions: rows.map((v) => ({
      id: v.id,
      staff: { id: v.staff_id, name: v.staff_name, email: v.staff_email, role: v.staff_role },
      borrower: { id: v.borrower_id, name: borrowerName(v), email: v.borrower_email },
      applicationId: v.application_id,
      startedAt: v.started_at,
      lastSeenAt: v.last_seen_at,
      endedAt: v.ended_at,
      endReason: v.end_reason,
      requestCount: v.request_count,
    })),
    scope: require('../lib/permissions').can(req.actor, 'view_audit_log') ? 'all' : 'mine',
  });
});

module.exports = router;
