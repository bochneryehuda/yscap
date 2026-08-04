/**
 * Auth spine — borrowers (self-service + MFA) and staff (admin-provisioned).
 * Real crypto via src/lib/crypto (scrypt / HS256 JWT / TOTP). Session
 * revocation via token_version. Borrowers self-register; staff are created by
 * an admin or via an invite token.
 *
 *   POST /auth/borrower/register      {email,password,firstName,lastName}
 *   POST /auth/borrower/login         {email,password} -> token | {mfaRequired,challenge}
 *   POST /auth/borrower/mfa/verify    {challenge,code} -> token
 *   POST /auth/mfa/setup   (auth)     -> {secret, otpauthUrl}
 *   POST /auth/mfa/enable  (auth)     {code}
 *   POST /auth/staff/login            {email,password} (+MFA)
 *   POST /auth/staff       (admin)    {email,fullName,role} create staff
 *   POST /auth/invite      (admin)    {email,kind,role} -> {token}
 *   POST /auth/accept                 {token,password}
 *   POST /auth/logout      (auth)     -> bumps token_version
 *   GET  /auth/me          (auth)
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const mail = require('../lib/email/catalog');
const perms = require('../lib/permissions');
const borrowerView = require('../lib/borrower-view');
const { randomInt } = require('crypto');

const MAX_FAILED = 6;
const sixDigit = () => String(randomInt(0, 1000000)).padStart(6, '0');

/**
 * Issue a single-use email token/code and store only its hash.
 * Returns { token, code } — the raw values, which live only in the email.
 */
async function issueEmailToken({ borrowerId = null, staffId = null, email = null,
                                 kind, ttlMin, withToken = true, withCode = false }) {
  const token = withToken ? C.randomToken(24) : null;
  const code  = withCode  ? sixDigit()        : null;
  await db.query(
    `INSERT INTO email_tokens (borrower_id, staff_id, email, kind, token_hash, code_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
    [borrowerId, staffId, email, kind,
     token ? C.sha256(token) : null,
     code  ? C.sha256(code)  : null,
     ttlMin]);
  return { token, code };
}

// ---------------- middleware ----------------
/**
 * Answer a session-level 401 with a MACHINE-READABLE reason, and log it.
 *
 * Every 401 the SPA sees is treated as "your session is dead" — it wipes the
 * stored token and bounces to the login screen. So a 401 must (a) only ever be
 * a real session problem (see the res.status chokepoint below) and (b) say
 * WHICH problem, so the user reads "your account was turned off" instead of the
 * catch-all "your session expired" and support isn't guessing (owner-reported
 * 2026-07-26: staff signed out with no way to tell why).
 */
/* Has db/321 (revoked_sessions) landed yet? Unknown until the first query.
   The per-device revocation check rides inside the main auth query, so if that
   table were missing every authenticated request would 503 — a total outage on
   a migration hiccup. Instead we FAIL OPEN once: the first failure drops the
   sid sub-select for the life of the process (per-device sign-out degrades to
   "the token stays valid until it expires"; nothing else changes), and the
   query is retried immediately so the request still succeeds. */
let _sidRevocationReady = null;   // null = unprobed, true = live, false = degraded

async function sessionQuery(claims) {
  const sid = claims.sid || null;
  const withSid = _sidRevocationReady !== false && !!sid;
  const revoked = withSid
    ? `, EXISTS(SELECT 1 FROM revoked_sessions WHERE sid=$2) AS sid_revoked`
    : `, false AS sid_revoked`;
  const params = withSid ? [claims.sub, sid] : [claims.sub];
  // A tpo session is an external staff_users row (db/467), so it reads the same
  // columns as a staff session.
  const sql = (claims.kind === 'staff' || claims.kind === 'tpo')
    ? `SELECT token_version, role, permissions, is_active${revoked} FROM staff_users WHERE id=$1`
    : `SELECT token_version${revoked} FROM borrower_auth WHERE borrower_id=$1`;
  try {
    const r = await db.query(sql, params);
    if (withSid) _sidRevocationReady = true;
    return r;
  } catch (e) {
    if (!withSid || _sidRevocationReady === true) throw e;   // a real DB problem
    console.error('[auth] per-device session revocation unavailable, falling back:', db.describeError(e));
    _sidRevocationReady = false;
    return sessionQuery(claims);
  }
}

function sessionDenied(req, res, code, message, extra, detail) {
  // One line per rejection, so "why was I signed out" is answerable from the
  // logs instead of reconstructed. No token, no PII — reason + route only.
  // `detail` narrows a code that covers several distinct causes (bad_token is
  // four different bugs wearing one name); it is logged, never returned.
  console.warn('[auth] 401', code, req.method, req.path, detail ? `(${detail})` : '');
  // `extra` carries any caller-specific field the SPA already keys on (e.g.
  // borrowerViewEnded) — it rides ALONGSIDE the standard marker, never instead.
  return res.status(401).json({ error: message, code, session: 'invalid', ...(extra || {}) });
}

async function authenticate(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = C.verifyJwt(raw);
  if (!claims) return sessionDenied(req, res, 'bad_token', 'unauthenticated', null,
    C.jwtFailureReason(raw));
  // A pending-MFA challenge is NOT an access token — it only authorizes the
  // /mfa/verify step. Reject it here or the second factor is bypassable.
  if (claims.mfa) return sessionDenied(req, res, 'mfa_incomplete', 'mfa not completed');
  // Access tokens are ONLY 'staff', 'borrower' or 'tpo' (the external brokerage
  // portal, db/467). Any other kind — the e-sign magic-link tokens
  // ('esign_magic'/'esign_return'), or any future special-purpose signed token —
  // must NEVER be usable as a Bearer session, even if its `sub` happened to
  // collide with a real id. Belt-and-suspenders alongside those tokens
  // deliberately carrying a non-borrower `sub`.
  if (claims.kind !== 'staff' && claims.kind !== 'borrower' && claims.kind !== 'tpo')
    return sessionDenied(req, res, 'wrong_token_kind', 'unauthenticated');
  // A TPO user is an EXTERNAL staff_users row (is_external=true), so a tpo
  // session reads and revokes off the SAME tables as a staff session — role,
  // permissions, is_active, token_version. Only the actor.kind differs, which is
  // what routes them to the third front door and keeps them out of /api/staff.
  const staffBacked = claims.kind === 'staff' || claims.kind === 'tpo';
  // token_version check (revocation). This runs on EVERY authenticated request,
  // so a DB blip here must answer 503 fast — never reject and hang the request.
  const tbl = staffBacked ? 'staff_users' : 'borrower_auth';
  const idCol = staffBacked ? 'id' : 'borrower_id';
  let r;
  try {
    // For staff, also read the CURRENT role + permission overrides so a role or
    // grant change takes effect immediately (not only after re-login) and so
    // capability gates can run synchronously off req.actor.perms.
    // The per-device `sid` revocation (db/321) rides along in the SAME query so
    // signing out on one device costs no extra round-trip on every request.
    r = await sessionQuery(claims);
  } catch (e) {
    console.error('[auth] token check failed (db):', db.describeError(e));
    return res.status(503).json({ error: 'The service is briefly unavailable — please try again in a moment.' });
  }
  const tv = r.rows[0] ? r.rows[0].token_version : null;
  if (tv === null || tv !== (claims.tv || 0))
    return sessionDenied(req, res, 'session_revoked',
      'You were signed out on all devices (a password change, or "sign out everywhere"). Please sign in again.');
  // This device was signed out. Only this one — every other device the person
  // is signed in on keeps working (that's the whole point of db/321).
  if (r.rows[0].sid_revoked === true)
    return sessionDenied(req, res, 'signed_out', 'You signed out on this device. Please sign in again.');
  // BORROWER VIEW (src/lib/borrower-view.js): the token is a real borrower
  // access token carrying an impersonation envelope. It authorizes the borrower
  // side (checked above) AND the staffer behind it — re-validated HERE, on every
  // single request, so the view dies the moment the human behind it does:
  //   • past the session's ABSOLUTE cap  → over, cannot be refreshed;
  //   • staff row gone / deactivated     → over;
  //   • staff token_version moved (they logged out, their password was reset,
  //     an admin revoked them)           → over.
  // Without this a borrower-view token would be a standing key to someone's
  // portal that outlives its owner's own session.
  const impersonation = borrowerView.readImpersonation(claims);
  if (impersonation) {
    if (borrowerView.sessionExpired(impersonation)) {
      borrowerView.endSession(impersonation.sessionId, 'expired');
      return sessionDenied(req, res, 'borrower_view_ended', 'This borrower view has ended. Sign in again to carry on.',
        { borrowerViewEnded: 'expired' });
    }
    let s;
    try {
      s = await db.query(
        `SELECT token_version, role, permissions, is_active, full_name, email FROM staff_users WHERE id=$1`,
        [impersonation.staffId]);
    } catch (e) {
      console.error('[auth] borrower-view staff check failed (db):', db.describeError(e));
      return res.status(503).json({ error: 'The service is briefly unavailable — please try again in a moment.' });
    }
    const su = s.rows[0];
    if (!su || su.is_active === false || (su.token_version || 0) !== (impersonation.staffTv || 0)) {
      borrowerView.endSession(impersonation.sessionId, 'revoked');
      return sessionDenied(req, res, 'borrower_view_ended', 'This borrower view has ended. Sign in again to carry on.',
        { borrowerViewEnded: 'revoked' });
    }
    req.impersonation = {
      staffId: impersonation.staffId,
      role: su.role || impersonation.role || null,
      name: su.full_name || null,
      email: su.email || null,
      sessionId: impersonation.sessionId,
      startedAt: impersonation.startedAt,
      staffTv: su.token_version || 0,
      perms: perms.effectivePermissions(su.role, su.permissions),
    };
    // Best-effort heartbeat on the session register (never blocks the request).
    borrowerView.touchSession(impersonation.sessionId);
  }
  // SECURITY: a deactivated staffer must lose access immediately. Deactivation
  // (admin toggle) doesn't bump token_version, so without this check an existing
  // session would keep renewing (sliding token) and retain access to loan files,
  // borrower PII and decrypted SSNs until a separate password reset.
  if (staffBacked && r.rows[0].is_active === false)
    return sessionDenied(req, res, 'account_deactivated',
      'This account has been turned off. Ask an admin to re-enable it.');
  // CHOKEPOINT — past this line the SESSION IS PROVEN GOOD, so nothing
  // downstream may answer 401. The SPA reads any 401 as "the session died" and
  // signs the user out; several routes relay an UPSTREAM integration's HTTP
  // status verbatim (`res.status(e.status)`), so a 401 from Sitewire/ClickUp/
  // TrustPoint/a vendor whose token rotated used to sign the STAFFER out of
  // PILOT. Three modules worked around it one at a time (sync-file-review.js,
  // clickup/relink.js, sync-autoresolve.js all document the trap); this kills
  // the whole class in one place, for every route that exists today or later.
  // 502 = "an upstream system refused us", which is what it actually is.
  const _status = res.status.bind(res);
  res.status = (code) => _status(code === 401 ? 502 : code);
  req.actor = { id: claims.sub, kind: claims.kind, role: claims.role, sid: claims.sid || null };
  // The real human behind a borrower view rides ON the actor, so every audit
  // helper (borrower.js / staff.js `audit()`, the request firehose) can stamp
  // WHO actually did it without each call site knowing about impersonation.
  if (req.impersonation) req.actor.impersonator = req.impersonation;
  if (staffBacked) {
    // Trust the DB role over the JWT claim (role can change mid-session). For a
    // staff actor this also resolves the capability Set; a tpo actor carries the
    // Set too, but `can()` refuses it (kind !== 'staff'), so it can never satisfy
    // a staff capability gate — TPO powers are gated in the /api/tpo router.
    req.actor.role = r.rows[0].role || claims.role;
    req.actor.perms = perms.effectivePermissions(req.actor.role, r.rows[0].permissions);
  }
  // Sliding session: hand back a fresh token so an active user never gets
  // logged out mid-work. The SPA stores it from this header on every response;
  // revocation still wins because tv (and the sid) are re-checked every request.
  //
  // This used to wait for the token's HALF-LIFE, which meant a token was only
  // renewed after days of use — anyone whose tab happened to be running an
  // older token got no benefit from being active. Now it renews once the token
  // is older than cfg.sessionRefreshAfterSec (12h by default) OR past half-life,
  // whichever comes first, so a person who signs in every day is riding a token
  // that is never more than a day old and can never age out under them.
  // The `sid` is CARRIED OVER, not re-minted: the refreshed token is the same
  // session, so "sign out on this device" still revokes it.
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.iat) {
    const life = claims.exp - claims.iat;
    const age  = nowSec - claims.iat;
    // The half-life cap keeps SHORT-lived tokens sliding exactly as they did
    // before — a borrower-view token lives 30 minutes and still renews at 15,
    // well inside its own absolute cap.
    if (age > Math.min(cfg.sessionRefreshAfterSec, life / 2)) {
      // A borrower-view token must NEVER slide into a plain borrower token — that
      // would silently strip the impersonation envelope and turn a bounded,
      // audited, 4-hour view into a permanent unattributed borrower session. It
      // re-mints WITH the same envelope (same `impAt`), so the absolute cap above
      // still governs and the refresh simply keeps a live session alive.
      const fresh = req.impersonation
        ? borrowerView.mintToken({
            borrowerId: claims.sub, borrowerTv: tv,
            staffId: req.impersonation.staffId, staffRole: req.impersonation.role,
            staffTv: req.impersonation.staffTv, sessionId: req.impersonation.sessionId,
            startedAt: req.impersonation.startedAt,
          })
        : claims.kind === 'staff'
          ? staffToken(claims.sub, r.rows[0].role || claims.role, tv, claims.sid)
          : claims.kind === 'tpo'
            // A tpo token must slide into a tpo token, never a staff one — the
            // kind is what confines the external user to the third front door.
            ? tpoToken(claims.sub, r.rows[0].role || claims.role, tv, claims.sid)
            : borrowerToken(claims.sub, tv, claims.sid);
      res.set('X-Refresh-Token', fresh);
    }
  }
  // Presence heartbeat (best-effort, non-blocking, throttled to ~1 write/min per
  // user) so chat can show who is currently online. SKIPPED inside a borrower
  // view: a staffer looking at a borrower's screen must not make that borrower
  // appear online to the rest of the team (the presence dot would be a lie, and
  // "they're online, message them" is a decision people make off it).
  if (!req.impersonation) {
    const ptbl = staffBacked ? 'staff_users' : 'borrowers';
    db.query(`UPDATE ${ptbl} SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`, [claims.sub]).catch(() => {});
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.actor || req.actor.kind !== 'staff') return res.status(403).json({ error: 'forbidden' });
    // super_admin is the top of the hierarchy and satisfies every role gate.
    if (req.actor.role === 'super_admin' || roles.includes(req.actor.role)) return next();
    return res.status(403).json({ error: 'forbidden' });
  };
}
// Capability gate — checks req.actor.perms (resolved in authenticate).
// cap may be a single capability string OR an array of capabilities — an array passes if the actor
// holds ANY of them (e.g. a reader that both a manage_draws desk user and a platform_setup admin need).
function requirePermission(cap) {
  const caps = Array.isArray(cap) ? cap : [cap];
  return (req, res, next) => {
    if (!req.actor || req.actor.kind !== 'staff') return res.status(403).json({ error: 'forbidden' });
    if (caps.some((c) => perms.can(req.actor, c))) return next();
    return res.status(403).json({ error: 'forbidden' });
  };
}
const requireAuth = authenticate;
const requireBorrower = (req, res, next) =>
  req.actor?.kind === 'borrower' ? next() : res.status(403).json({ error: 'borrower only' });
// A single "must be authenticated staff" wall for the admin surface (S1-16).
// Defense-in-depth: every /api/admin route already gates internally, but a
// blanket gate at the mount means a newly-added admin route can never
// accidentally ship borrower-reachable. It is LOOSER than the per-route role
// checks (any staff kind passes), so it never blocks a legitimately-permitted
// staffer — the specific role/permission gate inside still applies.
const requireStaff = (req, res, next) =>
  req.actor?.kind === 'staff' ? next() : res.status(403).json({ error: 'staff only' });
// The external-brokerage wall for /api/tpo. A tpo session is a real staff_users
// row but with kind='tpo', so requireStaff / requireBorrower already refuse it;
// this is the mirror image — only a tpo session reaches the TPO portal API.
const requireTpo = (req, res, next) =>
  req.actor?.kind === 'tpo' ? next() : res.status(403).json({ error: 'tpo only' });

// ---------------- token helpers ----------------
// `sid` = this DEVICE's session id. Minted fresh on every real sign-in and
// CARRIED OVER by the sliding refresh, so signing out on one device revokes
// exactly that device (db/321) instead of every session the person has.
const newSid = () => C.randomToken(12);
const borrowerToken = (id, tv, sid) => C.signJwt({ sub: id, kind: 'borrower', role: 'borrower', tv, sid: sid || newSid() });
const staffToken    = (id, role, tv, sid) => C.signJwt({ sub: id, kind: 'staff', role, tv, sid: sid || newSid() });
// A TPO (external brokerage) session. Same shape as a staff token — the row is
// in staff_users — but `kind:'tpo'` routes it to the third front door and keeps
// it out of every /api/staff and /api/borrower gate (db/467).
const tpoToken      = (id, role, tv, sid) => C.signJwt({ sub: id, kind: 'tpo', role, tv, sid: sid || newSid() });

/**
 * Mint a real borrower access session for an existing borrower id (reads the CURRENT
 * token_version so it's revocable like any other session). Returns the JWT, or null
 * if the borrower has no login row. Used by the e-sign magic-link session handoff
 * (esign-public /claim-session) — the ONLY caller — so a borrower who signed from
 * PILOT's branded email lands back INSIDE their loan file already logged in.
 */
/**
 * Mint a fresh STAFF access session for an existing staff id (reads the CURRENT
 * role + token_version, so it is revocable like any other session). Returns the
 * JWT, or null if the account is gone or deactivated. Used by the borrower-view
 * EXIT handoff (/api/borrower-view/exit) — the staffer hands back the borrower
 * token and gets their own console session, without re-typing a password.
 */
async function mintStaffSession(staffId) {
  const r = await db.query(
    `SELECT role, token_version FROM staff_users WHERE id=$1 AND is_active=true`, [staffId]);
  if (!r.rows[0]) return null;
  return staffToken(staffId, r.rows[0].role, r.rows[0].token_version || 0);
}

async function mintBorrowerSession(borrowerId) {
  const r = await db.query(`SELECT token_version FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]);
  if (!r.rows.length) return null;
  return borrowerToken(borrowerId, r.rows[0].token_version || 0);
}

// ---------------- borrower register / login ----------------
router.post('/borrower/register', async (req, res) => {
  const { email, password, firstName, lastName, middleName, cellPhone } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  { const w = C.passwordProblem(password, [email, firstName, lastName]); if (w) return res.status(400).json({ error: w }); }
  let client;
  try {
    client = await db.getClient();
  } catch (e) {
    console.error('[register] database unavailable:', db.describeError(e));
    return res.status(503).json({ error: 'Service is starting up or the database is unavailable — please try again in a moment.' });
  }
  try {
    await client.query('BEGIN');
    // SECURITY: a borrower row may already exist for this email as a captured
    // website lead or a staff-originated file — carrying real PII (and possibly
    // linked applications/SSN). Self-registration must NEVER silently bind
    // credentials to that pre-existing record and hand back a live session (that
    // is account + PII takeover). Detect it BEFORE creating anything.
    const pre = await client.query(`SELECT id FROM borrowers WHERE lower(email)=lower($1)`, [email]);
    if (pre.rows[0]) {
      const id0 = pre.rows[0].id;
      const hasAuth = await client.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [id0]);
      await client.query('ROLLBACK');
      if (hasAuth.rows[0]) return res.status(409).json({ error: 'account exists — log in' });
      // Pre-existing record with no login yet: require proof of email ownership.
      // Issue a claim (invite) token and email it; create NO credentials here, so
      // an attacker can neither obtain a session nor squat a password on the record.
      try {
        const claim = C.randomToken(24);
        await db.query(
          `INSERT INTO invite_tokens (token_hash,kind,email,expires_at)
           VALUES ($1,'borrower',$2, now() + interval '7 days')`, [C.sha256(claim), email]);
        await mail.send('borrowerInvite', email, {
          firstName: firstName || '', acceptUrl: mail.link('/accept?token=' + claim) }).catch(() => {});
        // Record it (lib/portal-invite) — from the team's side this looks exactly
        // like an invitation that is out and unaccepted, and the file should say
        // so rather than read "never invited" while a live claim link exists. No
        // staff id: the PERSON asked for this by trying to register.
        await require('../lib/portal-invite').recordInviteSent(id0, { email, byStaffId: null });
      } catch (_) { /* email is best-effort; the security guarantee is the no-session return */ }
      return res.status(202).json({ verifyRequired: true,
        message: 'We found an existing record for this email. Check your email to activate your account.' });
    }
    const b = await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,middle_name)
       VALUES ($1,$2,$3,$4,NULLIF($5,''))
       ON CONFLICT (email) WHERE shares_email = false DO UPDATE SET
         -- Optional middle name (db/345) — fill-only, never over a stored one.
         middle_name=COALESCE(borrowers.middle_name,EXCLUDED.middle_name),
         -- The person typing their OWN name beats a placeholder row (e.g. a
         -- sync-created 'Unknown Unknown') — never a real stored name.
         first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                         THEN EXCLUDED.first_name ELSE borrowers.first_name END,
         last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                        THEN EXCLUDED.last_name ELSE borrowers.last_name END,
         cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
         updated_at=now() RETURNING id`,
      [firstName || 'Unknown', lastName || 'Unknown', email, cellPhone || null,
       String(middleName || '').trim()]);
    const id = b.rows[0].id;
    const exists = await client.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [id]);
    if (exists.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'account exists — log in' }); }
    await client.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)`,
      [id, await C.hashPassword(password)]);
    await client.query('COMMIT');

    // Welcome + email verification (outside the txn; never blocks the response).
    try {
      // #94: activation is a ONE-CLICK auto-verifying URL — no 6-digit code to
      // type, and a comfortable 7-day window (not the old tight 24h). The
      // /verify page auto-posts the token from the link, so clicking activates.
      const { token } = await issueEmailToken({
        borrowerId: id, email, kind: 'verify', ttlMin: 10080, withToken: true, withCode: false });
      await mail.send('welcome', email, {
        firstName: firstName || '',
        verifyUrl: mail.link('/verify?token=' + token) });
    } catch (mailErr) { console.error('[register] welcome email failed:', mailErr.message); }

    // S1-08: a self-registered account must PROVE it owns the email before it
    // gets a session — no immediate login. The welcome email (above) carries the
    // one-click verify link; /verify then activates AND logs them in. Response
    // mirrors the pre-existing-record branch so the app has ONE "check your email"
    // path for every registration outcome.
    res.status(202).json({ verifyRequired: true, borrowerId: id,
      message: 'Check your email to activate your account, then you’re in.' });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

/* Cross-surface sign-in routing (root-caused 2026-07-16 — the "I have to reset
   my password every time" loop, Chaim Lebowitz). One person, one email, TWO
   credential stores (staff_users vs borrower_auth) — and two login pages that
   each checked only their own store. A staffer landing on the site's "Client
   Login" (the borrower page) got 401 no matter how correct their password was;
   the shared forgot-password then routed the reset cross-kind to their STAFF
   account, /accept let them in once, and the next visit hit the same wall — an
   endless reset loop. Fix at the chokepoint: when the surface's own store
   cannot authenticate but the OTHER store fully can (active row, not locked,
   password VERIFIES), sign them into the account they actually have.
   Password-verify-FIRST means this reveals nothing an attacker couldn't
   already learn by trying the other endpoint directly. */
// A wrong password on the OTHER store must count against THAT account's
// lockout exactly like the direct endpoint would — otherwise the cross-surface
// fallback is an unthrottled brute-force channel (found in pre-merge audit).
async function tryStaffCredentials(email, password) {
  // is_external=false: an external TPO broker (db/467) authenticates ONLY at the
  // TPO door (/auth/tpo/login), never the staff console — not directly and not
  // through this cross-surface fallback.
  const r = await db.query(
    `SELECT id, role, password_hash, mfa_enabled, token_version, failed_attempts, locked_until
       FROM staff_users WHERE email=$1 AND is_active=true AND is_external=false`, [email]);
  const row = r.rows[0];
  // Compensating hash when there's no other-store account, so the fallback's
  // timing doesn't reveal whether a dual (staff+borrower) identity exists.
  if (!row || !row.password_hash) { await C.hashPassword(String(password || '')).catch(() => {}); return null; }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return null;
  if (!(await C.verifyPassword(password, row.password_hash))) {
    const fa = (row.failed_attempts || 0) + 1;
    await db.query(`UPDATE staff_users SET failed_attempts=$2, locked_until=$3 WHERE id=$1`,
      [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]).catch(() => {});
    return null;
  }
  await db.query(`UPDATE staff_users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [row.id]).catch(() => {});
  if (row.mfa_enabled)
    return { mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'staff', role: row.role, mfa: true }, 300), kind: 'staff' };
  return { token: staffToken(row.id, row.role, row.token_version), kind: 'staff' };
}
async function tryBorrowerCredentials(email, password) {
  const r = await db.query(
    `SELECT b.id, a.password_hash, a.mfa_enabled, a.token_version, a.failed_attempts, a.locked_until, a.email_verified
       FROM borrowers b JOIN borrower_auth a ON a.borrower_id=b.id WHERE b.email=$1`, [email]);
  const row = r.rows[0];
  // Compensating hash (see tryStaffCredentials) — uniform timing whether or not
  // a borrower account also exists for this email.
  if (!row || !row.password_hash) { await C.hashPassword(String(password || '')).catch(() => {}); return null; }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return null;
  if (!(await C.verifyPassword(password, row.password_hash))) {
    const fa = (row.failed_attempts || 0) + 1;
    await db.query(`UPDATE borrower_auth SET failed_attempts=$2, locked_until=$3 WHERE borrower_id=$1`,
      [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]).catch(() => {});
    return null;
  }
  // The S1-08 confirm-email gate still applies to the borrower account no
  // matter which page the sign-in came from.
  if (row.email_verified === false) return { verifyRequired: true, kind: 'borrower' };
  await db.query(`UPDATE borrower_auth SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE borrower_id=$1`, [row.id]).catch(() => {});
  if (row.mfa_enabled)
    return { mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'borrower', mfa: true }, 300), kind: 'borrower' };
  return { token: borrowerToken(row.id, row.token_version), kind: 'borrower' };
}

// On a DB failure, next(e) hands off to the JSON error middleware, which
// answers a friendly 503 instead of leaking "connect ECONNREFUSED ..." to the
// sign-in form.
router.post('/borrower/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    const r = await db.query(
      `SELECT b.id, a.password_hash, a.mfa_enabled, a.token_version, a.failed_attempts, a.locked_until, a.email_verified
       FROM borrowers b JOIN borrower_auth a ON a.borrower_id=b.id WHERE b.email=$1`, [email]);
    const row = r.rows[0];
    // No borrower account (or wrong borrower password): before failing, see if
    // these are actually STAFF credentials — a staffer on the "Client Login"
    // page signs into their staff console instead of looping on resets.
    if (!row) {
      const cross = await tryStaffCredentials(email, password);
      if (cross) return res.json(cross);
      // Run a real password hash even when the account doesn't exist, so the
      // response time doesn't reveal whether the email is registered (enumeration).
      await C.hashPassword(String(password || '')).catch(() => {});
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (row.locked_until && new Date(row.locked_until) > new Date())
      return res.status(423).json({ error: 'account locked — try later' });
    if (!(await C.verifyPassword(password, row.password_hash))) {
      const cross = await tryStaffCredentials(email, password);
      if (cross) return res.json(cross);   // dual-identity: the staff password works — don't punish the borrower row
      const fa = row.failed_attempts + 1;
      await db.query(`UPDATE borrower_auth SET failed_attempts=$2, locked_until=$3 WHERE borrower_id=$1`,
        [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await db.query(`UPDATE borrower_auth SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE borrower_id=$1`, [row.id]);
    // S1-08: a self-registered account must confirm its email before it gets a
    // session. The password is already correct here (so this reveals nothing to an
    // attacker) — if the email isn't verified, re-send the one-click link and ask
    // them to confirm rather than issuing a token. Existing active borrowers were
    // grandfathered to verified (db/119), so only never-confirmed accounts see this.
    if (row.email_verified === false) {
      try {
        // Throttle: a fresh unused link from the last 10 minutes is still in their
        // inbox — repeated sign-in attempts must not spam tokens/emails.
        const recent = await db.query(
          `SELECT 1 FROM email_tokens
            WHERE kind='verify' AND borrower_id=$1 AND used_at IS NULL
              AND created_at > now() - interval '10 minutes' LIMIT 1`, [row.id]);
        if (!recent.rows[0]) {
          const { token } = await issueEmailToken({ borrowerId: row.id, email, kind: 'verify', ttlMin: 10080, withToken: true, withCode: false });
          await mail.send('verifyEmail', email, { firstName: '', verifyUrl: mail.link('/verify?token=' + token) }).catch(() => {});
        }
      } catch (_) { /* email is best-effort; the gate itself is the guarantee */ }
      // 200 + a flag (like mfaRequired) — no session issued; the app shows the
      // "check your email" state and the borrower confirms via the fresh link.
      return res.json({ verifyRequired: true, message: 'Please confirm your email — we just sent you a fresh activation link.' });
    }
    if (row.mfa_enabled)
      return res.json({ mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'borrower', mfa: true }, 300) });
    res.json({ token: borrowerToken(row.id, row.token_version) });
  } catch (e) { next(e); }
});

// Completes an MFA challenge for whichever KIND the signed challenge carries.
// Cross-surface login routing can hand a STAFF challenge to the borrower page
// (and vice versa); the challenge JWT is signed, so its kind claim — not the
// URL it was submitted to — is what's authoritative.
async function completeMfa(req, res) {
  const { challenge, code } = req.body || {};
  const claims = C.verifyJwt(challenge);
  if (!claims || !claims.mfa || !['borrower', 'staff', 'tpo'].includes(claims.kind))
    return res.status(401).json({ error: 'bad challenge' });
  try {
    const v = await verifyMfaStep(claims.kind, claims.sub, code);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    // staff AND tpo both live in staff_users (db/467); only the minted token
    // kind differs, which is what routes the external user to the TPO door.
    if (claims.kind === 'staff' || claims.kind === 'tpo') {
      const r = await db.query(
        `SELECT u.role, u.token_version, u.is_active, f.status AS firm_status
           FROM staff_users u LEFT JOIN tpo_firms f ON f.id = u.tpo_firm_id
          WHERE u.id=$1`, [claims.sub]);
      if (!r.rows[0]) return res.status(401).json({ error: 'invalid code' });
      // The password path filters `is_active=true`, but this one didn't — so a
      // DEACTIVATED staffer with 2FA could finish signing in, get a valid-looking
      // token, and then be bounced by authenticate()'s is_active check on the very
      // first API call. That reads as "I sign in and I'm instantly signed out,
      // every time" (owner-reported 2026-07-26). Refuse at the door instead, with
      // a reason they can act on.
      if (r.rows[0].is_active === false)
        return res.status(403).json({ error: 'This account has been turned off. Ask an admin to re-enable it.', code: 'account_deactivated' });
      // A TPO (broker) session additionally requires an ACTIVE firm. The password
      // step already enforces this, but the MFA challenge was minted BEFORE the
      // second factor — this closes the narrow window where the firm is suspended
      // between issuing the challenge and verifying it. A non-external user can
      // never carry a tpo challenge (only /tpo/login mints one, is_external only),
      // and their firm_status is NULL, so this refuses that case too.
      if (claims.kind === 'tpo' && r.rows[0].firm_status !== 'active')
        return res.status(403).json({ error: 'Your firm’s access is not active. Contact YS Capital.', code: 'firm_inactive' });
      const mint = claims.kind === 'tpo' ? tpoToken : staffToken;
      return res.json({ token: mint(claims.sub, r.rows[0].role, r.rows[0].token_version), usedBackup: v.usedBackup || undefined, backupRemaining: v.backupRemaining });
    }
    const tv = await db.query(`SELECT token_version FROM borrower_auth WHERE borrower_id=$1`, [claims.sub]);
    if (!tv.rows[0]) return res.status(401).json({ error: 'invalid code' });
    res.json({ token: borrowerToken(claims.sub, tv.rows[0].token_version), usedBackup: v.usedBackup || undefined, backupRemaining: v.backupRemaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
router.post('/borrower/mfa/verify', completeMfa);

// ---------------- email verification / password reset (borrower) ----------------
// Confirm an email either by clicking the emailed link (token) or entering the code.
router.post('/borrower/verify', async (req, res) => {
  const { token, email, code } = req.body || {};
  try {
    let row = null;
    if (token) {
      const r = await db.query(
        `SELECT * FROM email_tokens
           WHERE kind='verify' AND used_at IS NULL AND expires_at > now()
             AND token_hash=$1 LIMIT 1`, [C.sha256(token)]);
      row = r.rows[0];
    } else if (email && code) {
      const r = await db.query(
        `SELECT * FROM email_tokens
           WHERE kind='verify' AND used_at IS NULL AND expires_at > now()
             AND email=$1 AND code_hash=$2 LIMIT 1`, [email, C.sha256(code)]);
      row = r.rows[0];
      if (!row) {
        // S1-09: cap wrong-code guesses. Bump attempts on the active token for
        // this email; once the cap (5) is hit, retire the token so the code can
        // no longer be brute-forced (a fresh code must be requested). Mirrors the
        // MFA lockout. Best-effort — a failure here never changes the response.
        await db.query(
          `UPDATE email_tokens
              SET code_attempts = code_attempts + 1,
                  used_at = CASE WHEN code_attempts + 1 >= 5 THEN now() ELSE used_at END
            WHERE kind='verify' AND used_at IS NULL AND expires_at > now() AND email=$1`,
          [email]).catch(() => {});
      }
    } else {
      return res.status(400).json({ error: 'token or email+code required' });
    }
    if (!row) return res.status(400).json({ error: 'invalid or expired verification' });
    if (row.borrower_id)
      await db.query(
        `UPDATE borrower_auth SET email_verified=true, email_verified_at=now() WHERE borrower_id=$1`,
        [row.borrower_id]);
    await db.query(`UPDATE email_tokens SET used_at=now() WHERE id=$1`, [row.id]);
    // S1-08: the one-click verify link IS the activation — issue a session so the
    // borrower lands straight in the portal (no separate sign-in after clicking).
    // NB: distinct name from the destructured `token` above — a `let token` here
    // would hoist into the try-block and put the `if (token)` lookup in the TDZ.
    let sessionToken = null;
    if (row.borrower_id) {
      const tv = await db.query(`SELECT token_version FROM borrower_auth WHERE borrower_id=$1`, [row.borrower_id]);
      sessionToken = borrowerToken(row.borrower_id, tv.rows[0] ? tv.rows[0].token_version : 0);
    }
    res.json({ ok: true, verified: true, token: sessionToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resend a verification email. Always 200 (no account enumeration).
router.post('/borrower/resend-verification', async (req, res) => {
  const { email } = req.body || {};
  try {
    if (email) {
      const r = await db.query(
        `SELECT b.id, b.first_name, ba.email_verified
           FROM borrowers b JOIN borrower_auth ba ON ba.borrower_id=b.id
          WHERE b.email=$1 LIMIT 1`, [email]);
      const b = r.rows[0];
      if (b && !b.email_verified) {
        const { token } = await issueEmailToken({    // #94: one-click URL, no code, 7-day
          borrowerId: b.id, email, kind: 'verify', ttlMin: 10080,
          withToken: true, withCode: false });
        await mail.send('verifyEmail', email, {
          firstName: b.first_name,
          verifyUrl: mail.link('/verify?token=' + token) });
      }
    }
  } catch (e) { /* swallow — never reveal state */ }
  res.json({ ok: true });
});

// Request a password reset. Always 200 (no account enumeration).
router.post('/borrower/forgot', async (req, res) => {
  const { email, scope } = req.body || {};
  try {
    if (email) {
      // The borrower login AND the staff console share this ONE "Forgot
      // password?" endpoint. An email can belong to BOTH a borrower portal
      // account and a staff account (a team member who also took a loan) — and
      // the old code fired both a borrower reset (/reset) AND a staff reset
      // (/accept) with no else between them, so that person received TWO
      // different reset emails. That is confusing and wrong: a reset request
      // must produce exactly ONE email.
      //
      // Resolve both possible identities, then pick a single target:
      //   • `scope` ('borrower' | 'staff') — the originating login page tells us
      //     which login the user clicked "Forgot password?" on, so a dual account
      //     is routed to the login they actually meant;
      //   • without a usable scope (older cached client, or scoped to an account
      //     type that doesn't exist) prefer the STAFF account when one exists — a
      //     dual account is always a staff member who also borrowed, and the
      //     console is their primary work login. A pure borrower (no staff
      //     account) still gets the borrower reset exactly as before.
      const br = await db.query(
        `SELECT b.id, b.first_name FROM borrowers b
           JOIN borrower_auth ba ON ba.borrower_id=b.id WHERE b.email=$1 LIMIT 1`, [email]);
      const b = br.rows[0];
      const s = await db.query(
        `SELECT id, email, full_name, role FROM staff_users
          WHERE lower(email)=lower($1) AND is_active=true LIMIT 1`, [email]);
      const su = s.rows[0];

      let target = null; // 'borrower' | 'staff' — send at most one
      if (scope === 'borrower' && b) target = 'borrower';
      else if (scope === 'staff' && su) target = 'staff';
      else if (su) target = 'staff';
      else if (b) target = 'borrower';

      if (target === 'borrower') {
        const { token } = await issueEmailToken({
          borrowerId: b.id, email, kind: 'reset', ttlMin: 60, withToken: true });
        await mail.send('passwordReset', email, {
          firstName: b.first_name,
          resetUrl: mail.link('/reset?token=' + token), minutes: 60 });
      } else if (target === 'staff') {
        // Mirrors admin.js /staff/:id/reset-email: an invite_tokens 'staff' row
        // + the staffPasswordReset email -> /accept.
        const stoken = C.randomToken(24);
        await db.query(
          `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
           VALUES ($1,'staff',$2,$3,$4, now() + interval '7 days')`,
          [C.sha256(stoken), su.email, su.role, su.id]);
        await mail.send('staffPasswordReset', su.email, {
          fullName: su.full_name, url: mail.link('/accept?token=' + stoken), days: 7 });
      }
    }
  } catch (e) {
    // Never reveal which accounts exist (enumeration-safe) — but DO log the
    // failure server-side so "reset email not received" is diagnosable (e.g. a
    // DB error, or an email provider that failed / is unconfigured). The client
    // still gets a uniform { ok: true }.
    console.error('[auth] forgot-password handler error (returning ok for enumeration-safety):', (e && e.message) || e);
  }
  res.json({ ok: true });
});

// Complete a password reset using the emailed token.
router.post('/borrower/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token + password required' });
  { const w = C.passwordProblem(password); if (w) return res.status(400).json({ error: w }); }
  try {
    const r = await db.query(
      `SELECT * FROM email_tokens
         WHERE kind='reset' AND used_at IS NULL AND expires_at > now()
           AND token_hash=$1 LIMIT 1`, [C.sha256(token)]);
    const row = r.rows[0];
    if (!row || !row.borrower_id) return res.status(400).json({ error: 'invalid or expired reset' });
    // Completing a reset proves ownership of the email the link was sent to —
    // the same proof /verify establishes — so it also clears the S1-08 gate.
    await db.query(
      `UPDATE borrower_auth
          SET password_hash=$2, token_version=token_version+1,
              failed_attempts=0, locked_until=NULL,
              email_verified=true, email_verified_at=COALESCE(email_verified_at, now())
        WHERE borrower_id=$1`,
      [row.borrower_id, await C.hashPassword(password)]);
    await db.query(`UPDATE email_tokens SET used_at=now() WHERE id=$1`, [row.id]);
    try {
      const b = await db.query(`SELECT first_name, email FROM borrowers WHERE id=$1`, [row.borrower_id]);
      if (b.rows[0]?.email) await mail.send('passwordChanged', b.rows[0].email, { firstName: b.rows[0].first_name });
    } catch (_) {}
    res.json({ ok: true, reset: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- MFA setup (borrower or staff) ----------------
router.post('/mfa/setup', requireAuth, async (req, res) => {
  const secret = C.newTotpSecret();
  // A tpo user is a staff_users row (db/467), so their 2FA enrolls in
  // staff_users — only a borrower uses borrower_auth. (mfaTbl/mfaIdCol are
  // defined below this route, so the branch is inlined to match them.)
  const tbl = req.actor.kind === 'borrower' ? 'borrower_auth' : 'staff_users';
  const idCol = req.actor.kind === 'borrower' ? 'borrower_id' : 'id';
  await db.query(`UPDATE ${tbl} SET mfa_secret=$2 WHERE ${idCol}=$1`, [req.actor.id, secret]);
  const label = req.actor.kind === 'borrower' ? 'borrower' : req.actor.kind;
  res.json({ secret, otpauthUrl: C.totpUri(secret, `${label}:${req.actor.id.slice(0, 8)}`) });
});
router.post('/mfa/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const tbl = req.actor.kind === 'borrower' ? 'borrower_auth' : 'staff_users';
  const idCol = req.actor.kind === 'borrower' ? 'borrower_id' : 'id';
  const r = await db.query(`SELECT mfa_secret FROM ${tbl} WHERE ${idCol}=$1`, [req.actor.id]);
  if (!r.rows[0]?.mfa_secret || !C.verifyTotp(r.rows[0].mfa_secret, code))
    return res.status(401).json({ error: 'invalid code' });
  // Issue one-time backup codes so a lost authenticator doesn't lock them out.
  // Store hashed; return the plaintext ONCE for the user to save.
  const backupCodes = C.newBackupCodes(10);
  await db.query(`UPDATE ${tbl} SET mfa_enabled=true, mfa_backup_codes=$2, mfa_failed_attempts=0, mfa_locked_until=NULL WHERE ${idCol}=$1`,
    [req.actor.id, backupCodes.map(C.hashBackupCode)]);
  res.json({ ok: true, mfaEnabled: true, backupCodes });
  // Confirmation email (best-effort, never blocks the response).
  try {
    let email = null, firstName = null;
    if (req.actor.kind !== 'borrower') {   // staff OR tpo — both in staff_users
      const s = await db.query(`SELECT email, full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
      email = s.rows[0]?.email; firstName = (s.rows[0]?.full_name || '').split(' ')[0] || null;
    } else {
      const b = await db.query(`SELECT email, first_name FROM borrowers WHERE id=$1`, [req.actor.id]);
      email = b.rows[0]?.email; firstName = b.rows[0]?.first_name;
    }
    if (email) await mail.send('mfaEnabled', email, { firstName });
  } catch (_) {}
});

// Helpers to address either login table from the actor kind.
// A tpo user is a staff_users row (db/467), so their 2FA lives in staff_users.
const mfaTbl = (kind) => (kind === 'borrower' ? 'borrower_auth' : 'staff_users');
const mfaIdCol = (kind) => (kind === 'borrower' ? 'borrower_id' : 'id');

/**
 * Verify one MFA step at login — accepts the current TOTP code OR a one-time
 * backup (recovery) code — with a lockout so codes can't be brute-forced (S1-09).
 * Shares the account's failed_attempts/locked_until counters. Returns {ok,...} or
 * {status,error}. A used backup code is consumed.
 */
async function verifyMfaStep(kind, userId, code) {
  const tbl = mfaTbl(kind), idCol = mfaIdCol(kind);
  // DEDICATED mfa counter (db/089) — NOT the shared password failed_attempts. A
  // password login resets the password counter, so sharing it let an attacker who
  // knows the password re-login to zero the count and guess codes forever. These
  // columns clear only on a successful 2FA step, so the lock actually holds.
  const r = await db.query(
    `SELECT mfa_secret, mfa_backup_codes, mfa_failed_attempts, mfa_locked_until FROM ${tbl} WHERE ${idCol}=$1`, [userId]);
  const row = r.rows[0];
  if (!row) return { status: 401, error: 'invalid code' };
  if (row.mfa_locked_until && new Date(row.mfa_locked_until) > new Date())
    return { status: 423, error: 'too many wrong codes — please try again later' };
  if (row.mfa_secret && C.verifyTotp(row.mfa_secret, code)) {
    await db.query(`UPDATE ${tbl} SET mfa_failed_attempts=0, mfa_locked_until=NULL WHERE ${idCol}=$1`, [userId]);
    return { ok: true };
  }
  const codes = Array.isArray(row.mfa_backup_codes) ? row.mfa_backup_codes : [];
  const h = C.hashBackupCode(code);
  if (code && codes.includes(h)) {
    const remaining = codes.filter((c) => c !== h);   // one-time: consume it
    await db.query(`UPDATE ${tbl} SET mfa_backup_codes=$2, mfa_failed_attempts=0, mfa_locked_until=NULL WHERE ${idCol}=$1`,
      [userId, remaining]);
    return { ok: true, usedBackup: true, backupRemaining: remaining.length };
  }
  const fa = (row.mfa_failed_attempts || 0) + 1;
  await db.query(`UPDATE ${tbl} SET mfa_failed_attempts=$2, mfa_locked_until=$3 WHERE ${idCol}=$1`,
    [userId, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]);
  return { status: 401, error: 'invalid code' };
}

// Current 2FA state for the signed-in user (drives the Security screen).
router.get('/mfa/status', requireAuth, async (req, res) => {
  const tbl = mfaTbl(req.actor.kind), idCol = mfaIdCol(req.actor.kind);
  const r = await db.query(
    `SELECT mfa_enabled, COALESCE(array_length(mfa_backup_codes, 1), 0) AS backup_remaining
       FROM ${tbl} WHERE ${idCol}=$1`, [req.actor.id]);
  res.json({ mfaEnabled: !!r.rows[0]?.mfa_enabled, backupRemaining: r.rows[0]?.backup_remaining || 0 });
});

// Turn 2FA OFF for the signed-in user. Requires a valid current code (TOTP or a
// backup code) so a hijacked session can't silently strip the second factor.
router.post('/mfa/disable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const tbl = mfaTbl(req.actor.kind), idCol = mfaIdCol(req.actor.kind);
  const r = await db.query(`SELECT mfa_enabled FROM ${tbl} WHERE ${idCol}=$1`, [req.actor.id]);
  if (!r.rows[0] || !r.rows[0].mfa_enabled) return res.json({ ok: true, mfaEnabled: false });   // already off
  // Require a valid current code, WITH the same lockout as login — so a stolen
  // session can't brute-force the code to strip 2FA.
  const v = await verifyMfaStep(req.actor.kind, req.actor.id, code);
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  await db.query(`UPDATE ${tbl} SET mfa_enabled=false, mfa_secret=NULL, mfa_backup_codes=NULL, mfa_failed_attempts=0, mfa_locked_until=NULL WHERE ${idCol}=$1`, [req.actor.id]);
  res.json({ ok: true, mfaEnabled: false });
});

// Regenerate the backup codes (invalidates the old set). Requires a valid current
// code, and only while 2FA is on. Returns the new plaintext set once.
router.post('/mfa/backup-codes', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const tbl = mfaTbl(req.actor.kind), idCol = mfaIdCol(req.actor.kind);
  const r = await db.query(`SELECT mfa_enabled FROM ${tbl} WHERE ${idCol}=$1`, [req.actor.id]);
  if (!r.rows[0] || !r.rows[0].mfa_enabled) return res.status(400).json({ error: 'two-factor is not enabled' });
  // Same code check + lockout as login (a valid TOTP/backup code required).
  const v = await verifyMfaStep(req.actor.kind, req.actor.id, code);
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  const backupCodes = C.newBackupCodes(10);
  await db.query(`UPDATE ${tbl} SET mfa_backup_codes=$2 WHERE ${idCol}=$1`, [req.actor.id, backupCodes.map(C.hashBackupCode)]);
  res.json({ ok: true, backupCodes });
});

// ---------------- staff login ----------------
router.post('/staff/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    const r = await db.query(
      `SELECT id, role, password_hash, mfa_enabled, token_version, failed_attempts, locked_until
         FROM staff_users WHERE email=$1 AND is_active=true AND is_external=false`, [email]);
    const row = r.rows[0];
    // No staff account (or wrong staff password): before failing, see if these
    // are actually BORROWER credentials — the mirror of the borrower page's
    // cross-surface routing, so a borrower typing into "Staff sign in" lands in
    // their portal instead of a dead 401.
    if (!row || !row.password_hash) {
      const cross = await tryBorrowerCredentials(email, password);
      if (cross) return res.json(cross);
      // Run a real password hash even when the account doesn't exist / is inactive,
      // so the response time doesn't reveal which staff emails are real (S1-06
      // enumeration) — same defense the borrower login already uses.
      await C.hashPassword(String(password || '')).catch(() => {});
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (row.locked_until && new Date(row.locked_until) > new Date())
      return res.status(423).json({ error: 'account locked — try later' });
    if (!(await C.verifyPassword(password, row.password_hash))) {
      const cross = await tryBorrowerCredentials(email, password);
      if (cross) return res.json(cross);   // dual-identity: the borrower password works — don't punish the staff row
      // Count the miss and lock after MAX_FAILED (S1-02) — staff had no lockout.
      const fa = row.failed_attempts + 1;
      await db.query(`UPDATE staff_users SET failed_attempts=$2, locked_until=$3 WHERE id=$1`,
        [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await db.query(`UPDATE staff_users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [row.id]);
    if (row.mfa_enabled)
      return res.json({ mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'staff', role: row.role, mfa: true }, 300) });
    res.json({ token: staffToken(row.id, row.role, row.token_version) });
  } catch (e) { next(e); }   // JSON error middleware answers a friendly 503/500
});
// Same cross-kind completion as /borrower/mfa/verify — the signed challenge's
// kind claim, not the URL, decides which account the code unlocks.
router.post('/staff/mfa/verify', completeMfa);

// ---------------- TPO (external brokerage) login ----------------
// The third front door (db/467). A TPO user is a staff_users row flagged
// `is_external=true`; this door authenticates ONLY those rows and mints a
// `kind='tpo'` token. There is deliberately NO cross-surface fallback — a
// broker is only ever a broker, so an internal staffer or a borrower typing
// here fails cleanly rather than being routed into an account they don't hold.
router.post('/tpo/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    // The firm must be ACTIVE — a suspended/closed firm's brokers cannot sign in
    // (and suspending a firm also revokes any live sessions via token_version).
    const r = await db.query(
      `SELECT u.id, u.role, u.password_hash, u.mfa_enabled, u.token_version, u.failed_attempts, u.locked_until
         FROM staff_users u JOIN tpo_firms f ON f.id = u.tpo_firm_id
        WHERE u.email=$1 AND u.is_active=true AND u.is_external=true AND f.status='active'`, [email]);
    const row = r.rows[0];
    if (!row || !row.password_hash) {
      // Enumeration defense: spend the same time whether or not the account
      // exists (mirrors the staff/borrower doors).
      await C.hashPassword(String(password || '')).catch(() => {});
      return res.status(401).json({ error: 'invalid credentials' });
    }
    if (row.locked_until && new Date(row.locked_until) > new Date())
      return res.status(423).json({ error: 'account locked — try later' });
    if (!(await C.verifyPassword(password, row.password_hash))) {
      const fa = (row.failed_attempts || 0) + 1;
      await db.query(`UPDATE staff_users SET failed_attempts=$2, locked_until=$3 WHERE id=$1`,
        [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await db.query(`UPDATE staff_users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [row.id]);
    if (row.mfa_enabled)
      return res.json({ mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'tpo', role: row.role, mfa: true }, 300) });
    res.json({ token: tpoToken(row.id, row.role, row.token_version) });
  } catch (e) { next(e); }
});
router.post('/tpo/mfa/verify', completeMfa);

// ---------------- admin: create staff + invites ----------------
// Roles this legacy endpoint may assign — every persona except super_admin
// (which requires the super_admin-guarded admin console). Sourced from the
// permissions module so new personas are accepted automatically.
const ASSIGNABLE_ROLES = perms.ROLE_KEYS.filter((r) => r !== 'super_admin');
router.post('/staff', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, fullName, role, password } = req.body || {};
  if (!ASSIGNABLE_ROLES.includes(role))
    return res.status(400).json({ error: 'bad role' });
  if (password) { const w = C.passwordProblem(password); if (w) return res.status(400).json({ error: w }); }
  // The ON CONFLICT upsert can overwrite an existing user's role — never let a
  // non-super-admin demote/alter a super_admin (or admin) by targeting their
  // email, and never let a non-super mint an admin (which carries every
  // platform-wide power). Mirrors the admin-console roleGuard (S1-05).
  if (req.actor.role !== 'super_admin') {
    if (role === 'admin')
      return res.status(403).json({ error: 'only a super admin can grant the admin role' });
    const ex = await db.query(`SELECT role FROM staff_users WHERE email=$1`, [email]);
    if (ex.rows[0] && (ex.rows[0].role === 'super_admin' || ex.rows[0].role === 'admin'))
      return res.status(403).json({ error: 'only a super admin can modify a super admin or admin account' });
  }
  try {
    const r = await db.query(
      `INSERT INTO staff_users (email,full_name,role,password_hash)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET full_name=EXCLUDED.full_name, role=EXCLUDED.role RETURNING id`,
      [email, fullName, role, password ? await C.hashPassword(password) : null]);
    res.status(201).json({ ok: true, staffId: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/invite', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, kind, role } = req.body || {};
  if (!['staff', 'borrower'].includes(kind)) return res.status(400).json({ error: 'bad kind' });
  // Validate the staff role so an invite can't mint a privilege the inviter
  // lacks — only a super_admin may grant super_admin (otherwise accept() would
  // create a super_admin from an unvalidated invite role).
  let inviteRole = null;
  if (kind === 'staff') {
    inviteRole = role || 'loan_officer';
    if (inviteRole === 'super_admin') {
      if (req.actor.role !== 'super_admin') return res.status(403).json({ error: 'only a super admin can grant super_admin' });
    } else if (inviteRole === 'admin') {
      // admin carries every platform-wide power, so granting it via invite is
      // super-admin-only too (S1-05 — mirrors the console roleGuard).
      if (req.actor.role !== 'super_admin') return res.status(403).json({ error: 'only a super admin can grant the admin role' });
    } else if (!ASSIGNABLE_ROLES.includes(inviteRole)) {
      return res.status(400).json({ error: 'bad role' });
    }
    // SECURITY: an invite to an existing super_admin's (or admin's) email would,
    // via accept()'s ON CONFLICT DO UPDATE, overwrite that account's password AND
    // return its unchanged privileged role — a takeover. Never let a
    // non-super-admin invite (and thereby seize) an existing super_admin or admin.
    // Mirrors the /auth/staff guard.
    if (email) {
      const ex = await db.query(`SELECT role FROM staff_users WHERE lower(email)=lower($1)`, [email]);
      if (ex.rows[0] && (ex.rows[0].role === 'super_admin' || ex.rows[0].role === 'admin') && req.actor.role !== 'super_admin') {
        return res.status(403).json({ error: 'only a super admin can invite or modify a super admin or admin account' });
      }
    }
  }
  const token = C.randomToken(24);
  await db.query(
    `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')`,
    [C.sha256(token), kind, email, inviteRole, req.actor.id]);
  let emailed = false;
  if (kind === 'staff' && email) {
    try {
      let inviter = 'YS Capital Group';
      const iv = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
      if (iv.rows[0]?.full_name) inviter = iv.rows[0].full_name;
      const r = await mail.send('staffInvite', email, {
        fullName: email, role: role || 'loan_officer',
        acceptUrl: mail.link('/accept?token=' + token), inviter, days: 7 });
      emailed = !!(r && r.ok);
    } catch (_) {}
  }
  res.status(201).json({ ok: true, token, emailed,
    note: emailed ? 'invite emailed; token also returned for reference'
                  : 'email this token to the invitee; they POST /auth/accept' });
});

router.post('/accept', async (req, res, next) => {
  const { token, password, firstName, lastName, fullName } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token + password required' });
  { const w = C.passwordProblem(password); if (w) return res.status(400).json({ error: w }); }
  const inv = await db.query(
    `SELECT * FROM invite_tokens WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now()`,
    [C.sha256(token)]);
  const row = inv.rows[0];
  if (!row) return res.status(400).json({ error: 'invalid or expired invite' });
  try {
    if (row.kind === 'staff') {
      // SECURITY (defense in depth): never let accept() silently seize a
      // pre-existing privileged account (overwriting its password + returning its
      // role) unless the invite role MATCHES that account's role — which, for
      // admin/super_admin, only a super_admin can create. Blocks the
      // invite→accept takeover even if a bad invite slipped through (post-fix
      // audit HIGH: a non-super minted a loan_officer invite for an existing
      // admin's email and accepted it to overwrite that admin's password).
      const existing = await db.query(`SELECT role FROM staff_users WHERE lower(email)=lower($1)`, [row.email]);
      if (existing.rows[0] && (existing.rows[0].role === 'super_admin' || existing.rows[0].role === 'admin')
          && row.role !== existing.rows[0].role) {
        return res.status(403).json({ error: 'cannot take over an existing admin account' });
      }
      // Bump token_version on the password overwrite (revokes any prior/stolen
      // sessions — mirrors the borrower accept + admin reset) and issue the
      // session with the ACTUAL resulting version.
      const s = await db.query(
        `INSERT INTO staff_users (email,full_name,role,password_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash,
           failed_attempts=0, locked_until=NULL, token_version=staff_users.token_version+1
         RETURNING id,role,token_version`,
        [row.email, fullName || row.email, row.role || 'loan_officer', await C.hashPassword(password)]);
      await db.query(`UPDATE invite_tokens SET accepted_at=now() WHERE id=$1`, [row.id]);
      return res.json({ token: staffToken(s.rows[0].id, s.rows[0].role, s.rows[0].token_version) });
    }
    if (row.kind === 'tpo') {
      // A TPO (external brokerage) invite (db/467/469). Creates an is_external
      // staff_users row tied to the firm named on the invite, and mints a
      // kind='tpo' session. NEVER flip an INTERNAL account into an external one:
      // the ON CONFLICT UPDATE is guarded on `is_external = true`, so a conflict
      // with an internal row updates nothing and returns no row → refuse.
      if (!row.tpo_firm_id) return res.status(400).json({ error: 'this invite is not linked to a firm' });
      const roleWanted = perms.TPO_ROLE_KEYS.includes(row.role) ? row.role : 'tpo_processor';
      const s = await db.query(
        `INSERT INTO staff_users (email, full_name, role, password_hash, is_external, tpo_firm_id, is_firm_admin, site_selectable)
           VALUES ($1,$2,$3,$4,true,$5,$6,false)
         ON CONFLICT (email) DO UPDATE SET
           password_hash=EXCLUDED.password_hash, full_name=EXCLUDED.full_name, role=EXCLUDED.role,
           is_external=true, tpo_firm_id=EXCLUDED.tpo_firm_id, is_firm_admin=EXCLUDED.is_firm_admin,
           failed_attempts=0, locked_until=NULL, token_version=staff_users.token_version+1
           WHERE staff_users.is_external = true
         RETURNING id, role, token_version`,
        [row.email, fullName || row.email, roleWanted, await C.hashPassword(password), row.tpo_firm_id, row.is_firm_admin]);
      if (!s.rows[0]) return res.status(403).json({ error: 'that email already belongs to an internal account' });
      await db.query(`UPDATE invite_tokens SET accepted_at=now() WHERE id=$1`, [row.id]);
      return res.json({ token: tpoToken(s.rows[0].id, s.rows[0].role, s.rows[0].token_version) });
    }
    const b = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3)
       ON CONFLICT (email) WHERE shares_email = false DO UPDATE SET
         first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                         THEN EXCLUDED.first_name ELSE borrowers.first_name END,
         last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                        THEN EXCLUDED.last_name ELSE borrowers.last_name END,
         updated_at=now() RETURNING id`,
      [firstName || 'Unknown', lastName || 'Unknown', row.email]);
    // Bump token_version on the password change (invalidates any prior sessions)
    // and issue the token with the ACTUAL resulting version. Hardcoding 0 handed
    // an existing borrower (token_version already > 0) a token that authenticate()
    // rejects immediately as "session expired".
    // S1-08: accepting an emailed invite PROVES email ownership (they clicked the
    // link), so the account is email-verified on accept — never gated at login.
    const ba = await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified,email_verified_at)
       VALUES ($1,$2,0,true,now())
       ON CONFLICT (borrower_id) DO UPDATE
         SET password_hash=EXCLUDED.password_hash, token_version=borrower_auth.token_version+1,
             email_verified=true, email_verified_at=COALESCE(borrower_auth.email_verified_at, now())
       RETURNING token_version`,
      [b.rows[0].id, await C.hashPassword(password)]);
    // LO branding (owner-directed 2026-07-20): a borrower who signs up through an
    // officer's invite link is bound to THAT officer as their loan officer of
    // record — belt-and-suspenders on top of the file-officer path, so even an
    // invite off a Lead-Capture file still keeps the inviter's branding. Only when
    // the inviter is officer-eligible, and only FILLS a blank owner (COALESCE via
    // the IS NULL guard) — it never steals an existing owning officer. Best-effort.
    if (row.created_by) {
      await db.query(
        `UPDATE borrowers b SET primary_officer_id=s.id, updated_at=now()
           FROM staff_users s
          WHERE b.id=$1 AND b.primary_officer_id IS NULL
            AND s.id=$2 AND s.is_active=true
            AND s.role IN ('loan_officer','admin','super_admin')`,
        [b.rows[0].id, row.created_by]).catch(() => {});
    }
    await db.query(`UPDATE invite_tokens SET accepted_at=now() WHERE id=$1`, [row.id]);
    res.json({ token: borrowerToken(b.rows[0].id, ba.rows[0].token_version) });
  } catch (e) { next(e); }
});

// ---------------- logout (revoke) + me ----------------
/**
 * Sign out. THIS DEVICE ONLY by default.
 *
 * It used to bump token_version, the global counter — so signing out on a phone
 * silently killed the desktop session too, and the desktop reported it as the
 * generic "your session expired". Now the current session's `sid` is revoked
 * (db/321) and every other device keeps working. `{everywhere:true}` still
 * gives the full hammer, and a legacy token minted before db/321 has no sid, so
 * it falls back to the global bump (it has nothing finer to revoke).
 */
router.post('/logout', requireAuth, async (req, res) => {
  // staff AND tpo both revoke against staff_users (a tpo user is a staff_users
  // row, db/467); only a borrower uses borrower_auth.
  const tbl = req.actor.kind === 'borrower' ? 'borrower_auth' : 'staff_users';
  const idCol = req.actor.kind === 'borrower' ? 'borrower_id' : 'id';
  const everywhere = (req.body && req.body.everywhere === true) || !req.actor.sid;
  if (everywhere) {
    await db.query(`UPDATE ${tbl} SET token_version = token_version + 1 WHERE ${idCol}=$1`, [req.actor.id]);
    return res.json({ ok: true, scope: 'all_devices' });
  }
  try {
    await db.query(
      `INSERT INTO revoked_sessions (sid, actor_kind, actor_id) VALUES ($1,$2,$3)
       ON CONFLICT (sid) DO NOTHING`,
      [req.actor.sid, req.actor.kind, req.actor.id]);
  } catch (e) {
    // Never leave someone unable to sign out. If the per-device table is
    // unavailable, fall back to the global revocation — signing out MUST work.
    console.error('[auth] per-device logout failed, revoking everywhere:', db.describeError(e));
    await db.query(`UPDATE ${tbl} SET token_version = token_version + 1 WHERE ${idCol}=$1`, [req.actor.id]);
    return res.json({ ok: true, scope: 'all_devices' });
  }
  res.json({ ok: true, scope: 'this_device' });
});

router.get('/me', requireAuth, async (req, res) => {
  if (req.actor.kind === 'tpo') {
    // A TPO (external brokerage) user: their identity + the firm they belong to,
    // so the third front door can greet them and gate the firm-admin actions.
    const r = await db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.mfa_enabled, u.is_firm_admin,
              u.tpo_firm_id, f.name AS firm_name, f.status AS firm_status
         FROM staff_users u LEFT JOIN tpo_firms f ON f.id = u.tpo_firm_id
        WHERE u.id=$1`, [req.actor.id]);
    const row = r.rows[0] || {};
    return res.json({
      kind: 'tpo', id: row.id, email: row.email, full_name: row.full_name,
      role: row.role, mfa_enabled: row.mfa_enabled, is_firm_admin: row.is_firm_admin,
      firm: row.tpo_firm_id ? { id: row.tpo_firm_id, name: row.firm_name, status: row.firm_status } : null,
    });
  }
  if (req.actor.kind === 'staff') {
    const r = await db.query(`SELECT id,email,full_name,role,mfa_enabled,permissions FROM staff_users WHERE id=$1`, [req.actor.id]);
    const row = r.rows[0] || {};
    // Resolve effective capabilities so the SPA can gate nav/screens the same
    // way the server gates routes.
    const permissions = [...perms.effectivePermissions(row.role, row.permissions)];
    return res.json({ kind: 'staff', id: row.id, email: row.email, full_name: row.full_name, role: row.role, mfa_enabled: row.mfa_enabled, permissions });
  }
  const r = await db.query(`SELECT id,email,first_name,last_name,tier FROM borrowers WHERE id=$1`, [req.actor.id]);
  // Inside a borrower view the identity IS the borrower (that is the whole
  // point) — but `me` also reports WHO is really looking, so the portal can show
  // the "you are viewing as …" bar and the way back to their own console.
  const impersonation = req.impersonation ? {
    staffId: req.impersonation.staffId,
    staffName: req.impersonation.name,
    staffRole: req.impersonation.role,
    sessionId: req.impersonation.sessionId,
    startedAt: req.impersonation.startedAt * 1000,
    expiresAt: (req.impersonation.startedAt + borrowerView.MAX_SESSION_SEC) * 1000,
  } : null;
  res.json({ kind: 'borrower', ...r.rows[0], ...(impersonation ? { impersonation } : {}) });
});

module.exports = { router, authenticate, requireAuth, requireRole, requirePermission, requireBorrower, requireStaff, requireTpo, issueEmailToken, mintBorrowerSession, mintStaffSession };
