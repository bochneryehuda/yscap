/**
 * SSE stream endpoint — /api/events?token=<jwt>
 *
 * EventSource cannot send an Authorization header, so this endpoint (alone)
 * accepts the access token as a query parameter and re-implements the same
 * verification the auth middleware does: signature, no pending-MFA challenge,
 * and the token_version revocation check. It is mounted OUTSIDE the
 * authenticated routers in server.js.
 *
 * The stream never carries message CONTENT the actor couldn't fetch anyway —
 * fan-out is membership-scoped in lib/events.js.
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const events = require('../lib/events');

router.get('/', async (req, res) => {
  const claims = C.verifyJwt(String(req.query.token || ''));
  if (!claims || claims.mfa) return res.status(401).json({ error: 'unauthenticated' });
  // BORROWER ASSISTANT (src/lib/borrower-assistant.js): a helper token is a
  // borrower-kind token carrying an assistant envelope, validated against its OWN
  // row — NOT borrower_auth — so this endpoint (which re-implements the auth
  // middleware) must re-implement that too, or a DISABLED helper keeps the live
  // stream (the one surface that bypasses authenticate()).
  // A GUEST CONDITION-LINK token (src/lib/condition-link.js) is a borrower-kind
  // token whose whole purpose is the jailed guest condition center — the live
  // stream is not on its path allowlist, so it is refused here outright (this
  // endpoint bypasses authenticate(), which is where the jail lives).
  if (require('../lib/condition-link').readGuest(claims)) {
    return res.status(403).json({ error: 'not available on a guest link' });
  }
  const asst = require('../lib/borrower-assistant').readAssistant(claims);
  if (asst) {
    const a = await db.query(
      `SELECT token_version, disabled_at, borrower_id FROM borrower_assistants WHERE id=$1`, [asst.assistantId]);
    const arow = a.rows[0];
    if (!arow || arow.disabled_at || arow.borrower_id !== claims.sub
        || (arow.token_version || 0) !== (asst.assistantTv || 0))
      return res.status(401).json({ error: 'helper access ended' });
  } else {
    // A broker (kind='tpo', Phase 6e chat) IS a staff_users row (is_external=true), so it is
    // validated like staff — same token_version + is_active gate (a deactivated broker, or a firm
    // suspend which bumps the broker's token_version, drops the live stream).
    const staffLike = claims.kind === 'staff' || claims.kind === 'tpo';
    const tbl = staffLike ? 'staff_users' : 'borrower_auth';
    const idCol = staffLike ? 'id' : 'borrower_id';
    // Staff/tpo also gets an is_active check — a deactivated staffer/broker must NOT keep the live
    // stream (S1-01). borrower_auth has no is_active column, so only select it for the staff-like kinds.
    const cols = staffLike ? 'token_version, is_active' : 'token_version';
    const r = await db.query(`SELECT ${cols} FROM ${tbl} WHERE ${idCol}=$1`, [claims.sub]);
    const row = r.rows[0];
    const tv = row ? row.token_version : null;
    if (tv === null || tv !== (claims.tv || 0)) return res.status(401).json({ error: 'session expired' });
    if (staffLike && !row.is_active) return res.status(401).json({ error: 'account disabled' });
  }
  // Per-device sign-out (db/321) must close the live stream too, or a "signed
  // out" tab keeps receiving chat/presence events. Fails OPEN — a stream is not
  // worth a hard failure if the table is briefly unavailable.
  if (claims.sid) {
    try {
      const rv = await db.query(`SELECT 1 FROM revoked_sessions WHERE sid=$1`, [claims.sid]);
      if (rv.rows.length) return res.status(401).json({ error: 'signed out' });
    } catch (_) { /* revocation table unavailable — token_version still applied above */ }
  }
  // BORROWER VIEW (src/lib/borrower-view.js): a borrower-view token authorizes
  // TWO identities, so this endpoint — which re-implements the auth middleware's
  // checks — must re-implement the staff-side check too. Otherwise a revoked or
  // deactivated staffer could still open the borrower's live event stream, the
  // one surface that bypasses `authenticate()`. Mirrors the is_active +
  // token_version + absolute-cap gate in auth/index.js.
  const bv = require('../lib/borrower-view');
  const imp = bv.readImpersonation(claims);
  if (imp) {
    if (bv.sessionExpired(imp)) return res.status(401).json({ error: 'borrower view ended' });
    const s = await db.query(
      `SELECT token_version, is_active FROM staff_users WHERE id=$1`, [imp.staffId]);
    const su = s.rows[0];
    if (!su || su.is_active === false || (su.token_version || 0) !== (imp.staffTv || 0))
      return res.status(401).json({ error: 'borrower view ended' });
  }

  // TPO VIEW (src/lib/tpo-view.js): a "view as TPO" token authorizes TWO identities — the broker
  // (validated by the staff-like token_version/is_active gate above) AND the internal staffer
  // behind the view. Same re-validation as borrower-view so a revoked / deactivated staffer can't
  // keep the broker's live stream open (this endpoint bypasses authenticate()).
  const tpv = require('../lib/tpo-view');
  const timp = tpv.readImpersonation(claims);
  if (timp) {
    if (tpv.sessionExpired(timp)) return res.status(401).json({ error: 'broker view ended' });
    const ts = await db.query(
      `SELECT token_version, is_active FROM staff_users WHERE id=$1`, [timp.staffId]);
    const tsu = ts.rows[0];
    if (!tsu || tsu.is_active === false || (tsu.token_version || 0) !== (timp.staffTv || 0))
      return res.status(401).json({ error: 'broker view ended' });
  }

  // Borrowers only receive presence for the staff on their own files.
  let teamKeys = null;
  if (claims.kind === 'borrower') {
    const t = await db.query(
      `SELECT loan_officer_id, processor_id FROM applications
        WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL`, [claims.sub]);
    teamKeys = new Set();
    for (const a of t.rows) {
      if (a.loan_officer_id) teamKeys.add(`staff:${a.loan_officer_id}`);
      if (a.processor_id) teamKeys.add(`staff:${a.processor_id}`);
    }
  }

  events.addClient(res, { kind: claims.kind, id: claims.sub, role: claims.role }, { teamKeys });
  // addClient took over the response; the connection stays open until the
  // client closes it (or the process exits).
});

module.exports = router;
