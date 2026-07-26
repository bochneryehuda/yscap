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
  const tbl = claims.kind === 'staff' ? 'staff_users' : 'borrower_auth';
  const idCol = claims.kind === 'staff' ? 'id' : 'borrower_id';
  // Staff also gets an is_active check — a deactivated staffer must NOT keep the
  // live stream (S1-01). borrower_auth has no is_active column, so only select it
  // for staff.
  const cols = claims.kind === 'staff' ? 'token_version, is_active' : 'token_version';
  const r = await db.query(`SELECT ${cols} FROM ${tbl} WHERE ${idCol}=$1`, [claims.sub]);
  const row = r.rows[0];
  const tv = row ? row.token_version : null;
  if (tv === null || tv !== (claims.tv || 0)) return res.status(401).json({ error: 'session expired' });
  if (claims.kind === 'staff' && !row.is_active) return res.status(401).json({ error: 'account disabled' });
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
