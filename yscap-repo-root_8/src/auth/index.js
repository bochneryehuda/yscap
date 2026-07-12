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
const C = require('../lib/crypto');
const mail = require('../lib/email/catalog');
const perms = require('../lib/permissions');
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
async function authenticate(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const claims = C.verifyJwt(raw);
  if (!claims) return res.status(401).json({ error: 'unauthenticated' });
  // A pending-MFA challenge is NOT an access token — it only authorizes the
  // /mfa/verify step. Reject it here or the second factor is bypassable.
  if (claims.mfa) return res.status(401).json({ error: 'mfa not completed' });
  // token_version check (revocation). This runs on EVERY authenticated request,
  // so a DB blip here must answer 503 fast — never reject and hang the request.
  const tbl = claims.kind === 'staff' ? 'staff_users' : 'borrower_auth';
  const idCol = claims.kind === 'staff' ? 'id' : 'borrower_id';
  let r;
  try {
    // For staff, also read the CURRENT role + permission overrides so a role or
    // grant change takes effect immediately (not only after re-login) and so
    // capability gates can run synchronously off req.actor.perms.
    r = claims.kind === 'staff'
      ? await db.query(`SELECT token_version, role, permissions, is_active FROM staff_users WHERE id=$1`, [claims.sub])
      : await db.query(`SELECT token_version FROM ${tbl} WHERE ${idCol}=$1`, [claims.sub]);
  } catch (e) {
    console.error('[auth] token check failed (db):', db.describeError(e));
    return res.status(503).json({ error: 'The service is briefly unavailable — please try again in a moment.' });
  }
  const tv = r.rows[0] ? r.rows[0].token_version : null;
  if (tv === null || tv !== (claims.tv || 0))
    return res.status(401).json({ error: 'session expired' });
  // SECURITY: a deactivated staffer must lose access immediately. Deactivation
  // (admin toggle) doesn't bump token_version, so without this check an existing
  // session would keep renewing (sliding token) and retain access to loan files,
  // borrower PII and decrypted SSNs until a separate password reset.
  if (claims.kind === 'staff' && r.rows[0].is_active === false)
    return res.status(401).json({ error: 'account deactivated' });
  req.actor = { id: claims.sub, kind: claims.kind, role: claims.role };
  if (claims.kind === 'staff') {
    // Trust the DB role over the JWT claim (role can change mid-session).
    req.actor.role = r.rows[0].role || claims.role;
    req.actor.perms = perms.effectivePermissions(req.actor.role, r.rows[0].permissions);
  }
  // Sliding session: past the token's half-life, hand back a fresh token so an
  // active user never gets logged out mid-work. The SPA stores it from this
  // header on every response; revocation still wins because tv is re-checked.
  const nowSec = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.iat && (claims.exp - nowSec) < (claims.exp - claims.iat) / 2) {
    const fresh = claims.kind === 'staff'
      ? staffToken(claims.sub, claims.role, tv)
      : borrowerToken(claims.sub, tv);
    res.set('X-Refresh-Token', fresh);
  }
  // Presence heartbeat (best-effort, non-blocking, throttled to ~1 write/min per
  // user) so chat can show who is currently online.
  const ptbl = claims.kind === 'staff' ? 'staff_users' : 'borrowers';
  db.query(`UPDATE ${ptbl} SET last_seen_at=now() WHERE id=$1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')`, [claims.sub]).catch(() => {});
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
function requirePermission(cap) {
  return (req, res, next) => {
    if (!req.actor || req.actor.kind !== 'staff') return res.status(403).json({ error: 'forbidden' });
    if (perms.can(req.actor, cap)) return next();
    return res.status(403).json({ error: 'forbidden' });
  };
}
const requireAuth = authenticate;
const requireBorrower = (req, res, next) =>
  req.actor?.kind === 'borrower' ? next() : res.status(403).json({ error: 'borrower only' });

// ---------------- token helpers ----------------
const borrowerToken = (id, tv) => C.signJwt({ sub: id, kind: 'borrower', role: 'borrower', tv });
const staffToken    = (id, role, tv) => C.signJwt({ sub: id, kind: 'staff', role, tv });

// ---------------- borrower register / login ----------------
router.post('/borrower/register', async (req, res) => {
  const { email, password, firstName, lastName, cellPhone } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'password too short' });
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
      } catch (_) { /* email is best-effort; the security guarantee is the no-session return */ }
      return res.status(202).json({ verifyRequired: true,
        message: 'We found an existing record for this email. Check your email to activate your account.' });
    }
    const b = await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
      [firstName || 'Unknown', lastName || 'Unknown', email, cellPhone || null]);
    const id = b.rows[0].id;
    const exists = await client.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [id]);
    if (exists.rows[0]) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'account exists — log in' }); }
    await client.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)`,
      [id, await C.hashPassword(password)]);
    await client.query('COMMIT');

    // Welcome + email verification (outside the txn; never blocks the response).
    try {
      const { token, code } = await issueEmailToken({
        borrowerId: id, email, kind: 'verify', ttlMin: 1440, withToken: true, withCode: true });
      await mail.send('welcome', email, {
        firstName: firstName || '',
        verifyUrl: mail.link('/verify?token=' + token),
        code });
    } catch (mailErr) { console.error('[register] welcome email failed:', mailErr.message); }

    res.status(201).json({ token: borrowerToken(id, 0), borrowerId: id });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// On a DB failure, next(e) hands off to the JSON error middleware, which
// answers a friendly 503 instead of leaking "connect ECONNREFUSED ..." to the
// sign-in form.
router.post('/borrower/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    const r = await db.query(
      `SELECT b.id, a.password_hash, a.mfa_enabled, a.token_version, a.failed_attempts, a.locked_until
       FROM borrowers b JOIN borrower_auth a ON a.borrower_id=b.id WHERE b.email=$1`, [email]);
    const row = r.rows[0];
    // Run a real password hash even when the account doesn't exist, so the
    // response time doesn't reveal whether the email is registered (enumeration).
    if (!row) { await C.hashPassword(String(password || '')).catch(() => {}); return res.status(401).json({ error: 'invalid credentials' }); }
    if (row.locked_until && new Date(row.locked_until) > new Date())
      return res.status(423).json({ error: 'account locked — try later' });
    if (!(await C.verifyPassword(password, row.password_hash))) {
      const fa = row.failed_attempts + 1;
      await db.query(`UPDATE borrower_auth SET failed_attempts=$2, locked_until=$3 WHERE borrower_id=$1`,
        [row.id, fa, fa >= MAX_FAILED ? new Date(Date.now() + 15 * 60000) : null]);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await db.query(`UPDATE borrower_auth SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE borrower_id=$1`, [row.id]);
    if (row.mfa_enabled)
      return res.json({ mfaRequired: true, challenge: C.signJwt({ sub: row.id, kind: 'borrower', mfa: true }, 300) });
    res.json({ token: borrowerToken(row.id, row.token_version) });
  } catch (e) { next(e); }
});

router.post('/borrower/mfa/verify', async (req, res) => {
  const { challenge, code } = req.body || {};
  const claims = C.verifyJwt(challenge);
  if (!claims || !claims.mfa || claims.kind !== 'borrower') return res.status(401).json({ error: 'bad challenge' });
  try {
    const r = await db.query(`SELECT mfa_secret, token_version FROM borrower_auth WHERE borrower_id=$1`, [claims.sub]);
    if (!r.rows[0] || !C.verifyTotp(r.rows[0].mfa_secret, code)) return res.status(401).json({ error: 'invalid code' });
    res.json({ token: borrowerToken(claims.sub, r.rows[0].token_version) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    } else {
      return res.status(400).json({ error: 'token or email+code required' });
    }
    if (!row) return res.status(400).json({ error: 'invalid or expired verification' });
    if (row.borrower_id)
      await db.query(
        `UPDATE borrower_auth SET email_verified=true, email_verified_at=now() WHERE borrower_id=$1`,
        [row.borrower_id]);
    await db.query(`UPDATE email_tokens SET used_at=now() WHERE id=$1`, [row.id]);
    res.json({ ok: true, verified: true });
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
        const { token, code } = await issueEmailToken({
          borrowerId: b.id, email, kind: 'verify', ttlMin: 1440,
          withToken: true, withCode: true });
        await mail.send('verifyEmail', email, {
          firstName: b.first_name,
          verifyUrl: mail.link('/verify?token=' + token), code });
      }
    }
  } catch (e) { /* swallow — never reveal state */ }
  res.json({ ok: true });
});

// Request a password reset. Always 200 (no account enumeration).
router.post('/borrower/forgot', async (req, res) => {
  const { email } = req.body || {};
  try {
    if (email) {
      // Borrower self-service reset (needs an existing portal account).
      const r = await db.query(
        `SELECT b.id, b.first_name FROM borrowers b
           JOIN borrower_auth ba ON ba.borrower_id=b.id WHERE b.email=$1 LIMIT 1`, [email]);
      const b = r.rows[0];
      if (b) {
        const { token } = await issueEmailToken({
          borrowerId: b.id, email, kind: 'reset', ttlMin: 60, withToken: true });
        await mail.send('passwordReset', email, {
          firstName: b.first_name,
          resetUrl: mail.link('/reset?token=' + token), minutes: 60 });
      }
      // STAFF self-service reset. The staff console login AND the borrower login
      // share this one "Forgot password?" endpoint, but it previously checked
      // borrowers ONLY — so a staffer who entered their own email got NOTHING
      // (no email was ever sent; delivery was fine, the send never happened).
      // Now, when the email belongs to an active staff user, issue a console-
      // reset link too. Mirrors admin.js /staff/:id/reset-email exactly: an
      // invite_tokens 'staff' row + the staffPasswordReset email -> /accept.
      const s = await db.query(
        `SELECT id, email, full_name, role FROM staff_users
          WHERE lower(email)=lower($1) AND is_active=true LIMIT 1`, [email]);
      const su = s.rows[0];
      if (su) {
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
  if (String(password).length < 8) return res.status(400).json({ error: 'password too short' });
  try {
    const r = await db.query(
      `SELECT * FROM email_tokens
         WHERE kind='reset' AND used_at IS NULL AND expires_at > now()
           AND token_hash=$1 LIMIT 1`, [C.sha256(token)]);
    const row = r.rows[0];
    if (!row || !row.borrower_id) return res.status(400).json({ error: 'invalid or expired reset' });
    await db.query(
      `UPDATE borrower_auth
          SET password_hash=$2, token_version=token_version+1,
              failed_attempts=0, locked_until=NULL
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
  const tbl = req.actor.kind === 'staff' ? 'staff_users' : 'borrower_auth';
  const idCol = req.actor.kind === 'staff' ? 'id' : 'borrower_id';
  await db.query(`UPDATE ${tbl} SET mfa_secret=$2 WHERE ${idCol}=$1`, [req.actor.id, secret]);
  const label = req.actor.kind === 'staff' ? 'staff' : 'borrower';
  res.json({ secret, otpauthUrl: C.totpUri(secret, `${label}:${req.actor.id.slice(0, 8)}`) });
});
router.post('/mfa/enable', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  const tbl = req.actor.kind === 'staff' ? 'staff_users' : 'borrower_auth';
  const idCol = req.actor.kind === 'staff' ? 'id' : 'borrower_id';
  const r = await db.query(`SELECT mfa_secret FROM ${tbl} WHERE ${idCol}=$1`, [req.actor.id]);
  if (!r.rows[0]?.mfa_secret || !C.verifyTotp(r.rows[0].mfa_secret, code))
    return res.status(401).json({ error: 'invalid code' });
  await db.query(`UPDATE ${tbl} SET mfa_enabled=true WHERE ${idCol}=$1`, [req.actor.id]);
  res.json({ ok: true, mfaEnabled: true });
  // Confirmation email (best-effort, never blocks the response).
  try {
    let email = null, firstName = null;
    if (req.actor.kind === 'staff') {
      const s = await db.query(`SELECT email, full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
      email = s.rows[0]?.email; firstName = (s.rows[0]?.full_name || '').split(' ')[0] || null;
    } else {
      const b = await db.query(`SELECT email, first_name FROM borrowers WHERE id=$1`, [req.actor.id]);
      email = b.rows[0]?.email; firstName = b.rows[0]?.first_name;
    }
    if (email) await mail.send('mfaEnabled', email, { firstName });
  } catch (_) {}
});

// ---------------- staff login ----------------
router.post('/staff/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  try {
    const r = await db.query(
      `SELECT id, role, password_hash, mfa_enabled, token_version, failed_attempts, locked_until
         FROM staff_users WHERE email=$1 AND is_active=true`, [email]);
    const row = r.rows[0];
    // Run a real password hash even when the account doesn't exist / is inactive,
    // so the response time doesn't reveal which staff emails are real (S1-06
    // enumeration) — same defense the borrower login already uses.
    if (!row || !row.password_hash) { await C.hashPassword(String(password || '')).catch(() => {}); return res.status(401).json({ error: 'invalid credentials' }); }
    if (row.locked_until && new Date(row.locked_until) > new Date())
      return res.status(423).json({ error: 'account locked — try later' });
    if (!(await C.verifyPassword(password, row.password_hash))) {
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
router.post('/staff/mfa/verify', async (req, res) => {
  const { challenge, code } = req.body || {};
  const claims = C.verifyJwt(challenge);
  if (!claims || !claims.mfa || claims.kind !== 'staff') return res.status(401).json({ error: 'bad challenge' });
  const r = await db.query(`SELECT mfa_secret, role, token_version FROM staff_users WHERE id=$1`, [claims.sub]);
  if (!r.rows[0] || !C.verifyTotp(r.rows[0].mfa_secret, code)) return res.status(401).json({ error: 'invalid code' });
  res.json({ token: staffToken(claims.sub, r.rows[0].role, r.rows[0].token_version) });
});

// ---------------- admin: create staff + invites ----------------
// Roles this legacy endpoint may assign — every persona except super_admin
// (which requires the super_admin-guarded admin console). Sourced from the
// permissions module so new personas are accepted automatically.
const ASSIGNABLE_ROLES = perms.ROLE_KEYS.filter((r) => r !== 'super_admin');
router.post('/staff', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, fullName, role, password } = req.body || {};
  if (!ASSIGNABLE_ROLES.includes(role))
    return res.status(400).json({ error: 'bad role' });
  // The ON CONFLICT upsert can overwrite an existing user's role — never let a
  // non-super-admin demote/alter a super_admin by targeting their email.
  if (req.actor.role !== 'super_admin') {
    const ex = await db.query(`SELECT role FROM staff_users WHERE email=$1`, [email]);
    if (ex.rows[0] && ex.rows[0].role === 'super_admin')
      return res.status(403).json({ error: 'only a super admin can modify a super admin' });
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
    } else if (!ASSIGNABLE_ROLES.includes(inviteRole)) {
      return res.status(400).json({ error: 'bad role' });
    }
    // SECURITY: an invite to an existing super_admin's email would, via accept()'s
    // ON CONFLICT DO UPDATE, overwrite that account's password AND return its
    // unchanged super_admin role — a takeover. Never let a non-super-admin invite
    // (and thereby seize) an existing super_admin. Mirrors the /auth/staff guard.
    if (email) {
      const ex = await db.query(`SELECT role FROM staff_users WHERE lower(email)=lower($1)`, [email]);
      if (ex.rows[0] && ex.rows[0].role === 'super_admin' && req.actor.role !== 'super_admin') {
        return res.status(403).json({ error: 'only a super admin can invite or modify a super admin account' });
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
  const inv = await db.query(
    `SELECT * FROM invite_tokens WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at > now()`,
    [C.sha256(token)]);
  const row = inv.rows[0];
  if (!row) return res.status(400).json({ error: 'invalid or expired invite' });
  try {
    if (row.kind === 'staff') {
      // SECURITY (defense in depth): never let accept() silently seize a
      // pre-existing super_admin account (overwriting its password + returning its
      // role) unless the invite itself was for super_admin — which only a
      // super_admin can create. Blocks the invite→accept takeover even if a bad
      // invite slipped through.
      const existing = await db.query(`SELECT role FROM staff_users WHERE lower(email)=lower($1)`, [row.email]);
      if (existing.rows[0] && existing.rows[0].role === 'super_admin' && row.role !== 'super_admin') {
        return res.status(403).json({ error: 'cannot take over an existing super admin account' });
      }
      const s = await db.query(
        `INSERT INTO staff_users (email,full_name,role,password_hash) VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id,role,token_version`,
        [row.email, fullName || row.email, row.role || 'loan_officer', await C.hashPassword(password)]);
      await db.query(`UPDATE invite_tokens SET accepted_at=now() WHERE id=$1`, [row.id]);
      return res.json({ token: staffToken(s.rows[0].id, s.rows[0].role, s.rows[0].token_version) });
    }
    const b = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3)
       ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
      [firstName || 'Unknown', lastName || 'Unknown', row.email]);
    // Bump token_version on the password change (invalidates any prior sessions)
    // and issue the token with the ACTUAL resulting version. Hardcoding 0 handed
    // an existing borrower (token_version already > 0) a token that authenticate()
    // rejects immediately as "session expired".
    const ba = await db.query(
      `INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)
       ON CONFLICT (borrower_id) DO UPDATE
         SET password_hash=EXCLUDED.password_hash, token_version=borrower_auth.token_version+1
       RETURNING token_version`,
      [b.rows[0].id, await C.hashPassword(password)]);
    await db.query(`UPDATE invite_tokens SET accepted_at=now() WHERE id=$1`, [row.id]);
    res.json({ token: borrowerToken(b.rows[0].id, ba.rows[0].token_version) });
  } catch (e) { next(e); }
});

// ---------------- logout (revoke) + me ----------------
router.post('/logout', requireAuth, async (req, res) => {
  const tbl = req.actor.kind === 'staff' ? 'staff_users' : 'borrower_auth';
  const idCol = req.actor.kind === 'staff' ? 'id' : 'borrower_id';
  await db.query(`UPDATE ${tbl} SET token_version = token_version + 1 WHERE ${idCol}=$1`, [req.actor.id]);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  if (req.actor.kind === 'staff') {
    const r = await db.query(`SELECT id,email,full_name,role,mfa_enabled,permissions FROM staff_users WHERE id=$1`, [req.actor.id]);
    const row = r.rows[0] || {};
    // Resolve effective capabilities so the SPA can gate nav/screens the same
    // way the server gates routes.
    const permissions = [...perms.effectivePermissions(row.role, row.permissions)];
    return res.json({ kind: 'staff', id: row.id, email: row.email, full_name: row.full_name, role: row.role, mfa_enabled: row.mfa_enabled, permissions });
  }
  const r = await db.query(`SELECT id,email,first_name,last_name,tier FROM borrowers WHERE id=$1`, [req.actor.id]);
  res.json({ kind: 'borrower', ...r.rows[0] });
});

module.exports = { router, authenticate, requireAuth, requireRole, requirePermission, requireBorrower, issueEmailToken };
