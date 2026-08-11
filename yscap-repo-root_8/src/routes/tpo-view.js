/**
 * TPO VIEW routes — "see the broker portal exactly as this broker sees it"
 * (owner-directed 2026-08-04; TPO blueprint decision 6). Design + the security
 * model live in src/lib/tpo-view.js; this file is just the doors.
 *
 *   GET  /api/tpo-view/eligible?q=   (staff)   brokers I may step into
 *   POST /api/tpo-view/start         (staff)   → a tpo-view token
 *   GET  /api/tpo-view/session       (either)  what am I in right now
 *   POST /api/tpo-view/exit          (in-view) → my own staff token back
 *   GET  /api/tpo-view/history       (staff)   the register (mine, or all with
 *                                              view_audit_log)
 *
 * Mounted OUTSIDE /api/staff on purpose: `session` and `exit` must be callable
 * while holding a TPO-kind token (the whole point), which the staff router's
 * requireStaff wall would refuse. This is the exact mirror of the borrower-view
 * router.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff, mintStaffSession } = require('../auth');
const tv = require('../lib/tpo-view');

router.use(requireAuth);

async function audit(req, action, detail, entityId) {
  try {
    // A TPO user IS a staff_users row, so an audited action logs as actor_kind
    // 'staff' (the only allowed value that carries their id — the audit_log CHECK
    // is borrower|staff|system); the impersonator column names the real internal
    // human behind the view. Same convention as routes/tpo.js tpoAudit().
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail,impersonator_staff_id)
       VALUES ('staff',$1,$2,'tpo_user',$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entityId || null, req.ip,
       req.get('user-agent') || null, detail || null,
       (req.impersonation && req.impersonation.staffId) || null]);
  } catch (e) {
    console.warn(`[tpo-view] audit write failed (${action}):`,
      db.describeError ? db.describeError(e) : e.message);
  }
}

const brokerName = (b) => (String(b.full_name || '').trim() || b.email || 'Broker');

// ---- the picker: which brokers may I step into ----------------------------
router.get('/eligible', requireStaff, async (req, res) => {
  const rows = await tv.listEligible(req.actor, { q: req.query.q, limit: req.query.limit });
  res.json({
    brokers: rows.map((b) => ({
      id: b.id,
      name: brokerName(b),
      email: b.email,
      role: b.role,
      isFirmAdmin: !!b.is_firm_admin,
      firmId: b.tpo_firm_id,
      firmName: b.firm_name,
      hasLogin: !!b.has_login,
      firmFileCount: b.firm_file_count || 0,
      lastLoginAt: b.last_login_at,
    })),
    // The SPA shows a different empty-state for "you handle no firms yet" vs
    // "nobody matched your search".
    scope: require('../lib/permissions').can(req.actor, 'see_all_files') ? 'all' : 'assigned',
  });
});

// ---- step in --------------------------------------------------------------
router.post('/start', requireStaff, async (req, res) => {
  const tpoUserId = String((req.body || {}).tpoUserId || '').trim();
  const applicationId = ((req.body || {}).applicationId || null) || null;
  if (!tpoUserId) return res.status(400).json({ error: 'tpoUserId required' });

  const broker = await tv.resolveViewable(req.actor, tpoUserId);
  if (!broker) {
    // Same answer whether the broker does not exist, is not an active external
    // user, their firm is not active, or is simply outside this staffer's
    // pipeline — a scoped staffer must not be able to probe for who exists by id.
    if (req.auditError) req.auditError('tpo_view_denied');
    return res.status(403).json({ error: 'You can only open a broker view for a firm you handle.' });
  }
  // A broker who has not accepted their invite yet has no login to look at.
  if (!broker.has_login) {
    return res.status(409).json({
      error: `${brokerName(broker)} hasn’t set up their login yet, so there is no broker view to open.`,
      needsInvite: true,
      tpoUserId: broker.id,
    });
  }
  // The file the staffer entered from is recorded for the register — but only
  // when it really is one of that broker's firm's files.
  let appId = null;
  if (applicationId) {
    const a = await db.query(
      `SELECT id FROM applications
        WHERE id=$1 AND deleted_at IS NULL AND is_tpo=true AND tpo_firm_id=$2`,
      [applicationId, broker.tpo_firm_id]).catch(() => ({ rows: [] }));
    appId = a.rows[0] ? a.rows[0].id : null;
  }

  const session = await tv.startSession({
    actor: req.actor,
    broker,
    applicationId: appId,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  if (!session) return res.status(403).json({ error: 'forbidden' });

  await audit(req, 'tpo_view_start', {
    tpoUserId: broker.id, brokerName: brokerName(broker),
    firmId: broker.tpo_firm_id, firmName: broker.firm_name,
    applicationId: appId, sessionId: session.sessionId,
  }, broker.id);

  res.json({
    token: session.token,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    broker: { id: broker.id, name: brokerName(broker), email: broker.email,
              firmId: broker.tpo_firm_id, firmName: broker.firm_name },
    // Where to land: straight in the file when they came from one, else the
    // firm's pipeline (the broker's own landing screen).
    landing: appId ? `/tpo/file/${appId}` : '/tpo',
  });
});

// ---- where am I ------------------------------------------------------------
// Callable with EITHER token kind: inside a view it describes the view; outside
// it answers `active:false` so the SPA can clear a stale local banner.
router.get('/session', async (req, res) => {
  if (!req.impersonation || req.impersonation.surface !== 'tpo') return res.json({ active: false });
  const b = await db.query(
    `SELECT t.id, t.full_name, t.email, t.tpo_firm_id, f.name AS firm_name
       FROM staff_users t LEFT JOIN tpo_firms f ON f.id = t.tpo_firm_id
      WHERE t.id=$1`, [req.actor.id]);
  const row = b.rows[0] || {};
  res.json({
    active: true,
    broker: { id: req.actor.id, name: brokerName(row), email: row.email || null,
              firmId: row.tpo_firm_id || null, firmName: row.firm_name || null },
    staff: {
      id: req.impersonation.staffId,
      name: req.impersonation.name,
      role: req.impersonation.role,
    },
    sessionId: req.impersonation.sessionId,
    startedAt: req.impersonation.startedAt * 1000,
    expiresAt: (req.impersonation.startedAt + tv.MAX_SESSION_SEC) * 1000,
  });
});

// ---- step back out ---------------------------------------------------------
// Hands back a FRESH staff token rather than trusting whatever the browser had
// stashed, so leaving a broker view always works — even if the staffer's own
// token expired while they were inside one.
router.post('/exit', async (req, res) => {
  if (!req.impersonation || req.impersonation.surface !== 'tpo')
    return res.status(400).json({ error: 'not in a broker view' });
  const { staffId, sessionId } = req.impersonation;
  await tv.endSession(sessionId, 'exit');
  await audit(req, 'tpo_view_exit', { tpoUserId: req.actor.id, sessionId }, req.actor.id);
  const token = await mintStaffSession(staffId);
  if (!token) {
    return res.status(401).json({ error: 'Your internal session is no longer valid — please sign in again.' });
  }
  res.json({ token, kind: 'staff' });
});

// ---- the register ----------------------------------------------------------
router.get('/history', requireStaff, async (req, res) => {
  const rows = await tv.history(req.actor, { limit: req.query.limit });
  res.json({
    sessions: rows.map((v) => ({
      id: v.id,
      staff: { id: v.staff_id, name: v.staff_name, email: v.staff_email, role: v.staff_role },
      broker: { id: v.tpo_user_id, name: (String(v.broker_name || '').trim() || v.broker_email || 'Broker'), email: v.broker_email },
      firmId: v.tpo_firm_id,
      firmName: v.firm_name,
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
