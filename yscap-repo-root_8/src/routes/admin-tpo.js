/**
 * TPO firm onboarding — INTERNAL admin surface (owner-directed 2026-08-04;
 * db/472/469; design docs/TPO-PORTAL-BLUEPRINT.md). An internal admin creates a
 * brokerage firm and invites its lead broker; the lead broker then invites their
 * own processors from inside the TPO portal (src/routes/tpo.js).
 *
 * Gated `manage_team` (add staff / set roles) — onboarding an external partner
 * is team management. Mounted at /api/admin/tpo.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const perms = require('../lib/permissions');
const mail = require('../lib/email/catalog');
const firmCredentials = require('../lib/credit/firm-credentials');   // TPO own-Xactus (Phase 5b)
const creditProvider = require('../lib/credit/provider');
const { requireAuth, requireStaff, requirePermission } = require('../auth');

router.use(requireAuth, requireStaff, requirePermission('manage_team'));

// A firm's OWN credit-vendor login is platform-config-level sensitive, so setting
// it needs the stronger platform_setup permission (viewing presence-only status
// stays on the router's manage_team gate). Audited best-effort.
async function auditTpo(req, action, firmId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff', $1, $2, 'tpo_firm', $3, $4)`,
      [req.actor.id, action, firmId, detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* never block the action on an audit-write failure */ }
}
async function firmOr404(req, res) {
  const f = await db.query(`SELECT id, name FROM tpo_firms WHERE id=$1`, [req.params.id]);
  if (!f.rows[0]) { res.status(404).json({ error: 'firm not found' }); return null; }
  return f.rows[0];
}

// List every firm + its live user / file counts.
router.get('/firms', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT f.id, f.name, f.status, f.nmls, f.created_at,
              (SELECT count(*) FROM staff_users u WHERE u.tpo_firm_id=f.id AND u.is_active=true) AS user_count,
              (SELECT count(*) FROM applications a WHERE a.tpo_firm_id=f.id AND a.deleted_at IS NULL) AS file_count
         FROM tpo_firms f ORDER BY f.created_at DESC`);
    res.json({ firms: r.rows });
  } catch (e) { next(e); }
});

// Create a firm.
router.post('/firms', async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'firm name required' });
    const r = await db.query(
      `INSERT INTO tpo_firms (name, nmls, notes, created_by)
       VALUES ($1, NULLIF($2,''), NULLIF($3,''), $4) RETURNING id, name, status, nmls, created_at`,
      [name, String(b.nmls || '').trim(), String(b.notes || '').trim(), req.actor.id]);
    res.status(201).json({ firm: r.rows[0] });
  } catch (e) { next(e); }
});

// Firm detail: the firm, its users, and any pending invites.
router.get('/firms/:id', async (req, res, next) => {
  try {
    const f = await db.query(`SELECT id, name, status, nmls, notes, created_at FROM tpo_firms WHERE id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'firm not found' });
    const users = await db.query(
      `SELECT id, full_name, email, role, is_firm_admin, is_active, last_login_at,
              (password_hash IS NOT NULL) AS has_login
         FROM staff_users WHERE tpo_firm_id=$1 AND is_external=true
        ORDER BY is_firm_admin DESC, full_name`, [req.params.id]);
    const invites = await db.query(
      `SELECT email, role, is_firm_admin, created_at, expires_at
         FROM invite_tokens WHERE tpo_firm_id=$1 AND accepted_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`, [req.params.id]);
    res.json({ firm: f.rows[0], users: users.rows, pendingInvites: invites.rows });
  } catch (e) { next(e); }
});

// Invite a user to the firm (the lead broker, or another officer/processor).
router.post('/firms/:id/invite', async (req, res, next) => {
  try {
    const f = await db.query(`SELECT id, name, status FROM tpo_firms WHERE id=$1`, [req.params.id]);
    if (!f.rows[0]) return res.status(404).json({ error: 'firm not found' });
    if (f.rows[0].status !== 'active') return res.status(400).json({ error: 'the firm is not active' });
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    const role = perms.TPO_ROLE_KEYS.includes(b.role) ? b.role : 'tpo_officer';
    const isFirmAdmin = b.isFirmAdmin === true;
    // Never invite an email that already belongs to an INTERNAL staffer (the
    // accept flow would refuse it anyway; refuse earlier so the admin sees why).
    // Also refuse an email that already belongs to a broker at ANOTHER firm — a
    // re-invite would silently move them (the accept branch reassigns tpo_firm_id
    // on conflict). Moving a broker between firms should be a deliberate action,
    // not a side effect of an invite. Re-inviting into the SAME firm is fine
    // (resend / promote), so only a DIFFERENT firm is refused.
    const ex = await db.query(`SELECT is_external, tpo_firm_id FROM staff_users WHERE lower(email)=lower($1)`, [email]);
    if (ex.rows[0] && ex.rows[0].is_external === false)
      return res.status(409).json({ error: 'that email already belongs to an internal staff account' });
    if (ex.rows[0] && ex.rows[0].is_external === true && String(ex.rows[0].tpo_firm_id) !== String(req.params.id))
      return res.status(409).json({ error: 'that email already belongs to a broker at another firm' });
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash, kind, email, role, created_by, tpo_firm_id, is_firm_admin, expires_at)
       VALUES ($1,'tpo',$2,$3,$4,$5,$6, now() + interval '7 days')`,
      [C.sha256(token), email, role, req.actor.id, req.params.id, isFirmAdmin]);
    const acceptUrl = mail.link('/tpo/accept?token=' + token);
    let emailed = false;
    try {
      const r = await mail.send('tpoInvite', email, { fullName: b.fullName || '', firmName: f.rows[0].name, role, acceptUrl, days: 7 });
      emailed = !!(r && r.ok);
    } catch (_) { /* email is best-effort; the token is returned either way */ }
    res.status(201).json({ ok: true, token, acceptUrl, emailed });
  } catch (e) { next(e); }
});

// Suspend / reactivate / close a firm. Suspending or closing REVOKES every one
// of its brokers' live sessions (the token_version hammer) so access stops
// immediately, not only at the next login. The status change and the session
// revocation run in ONE transaction: if the revocation fails, the status change
// rolls back too, so we never report a firm as suspended while its brokers'
// live sessions are still valid (a silent .catch() previously hid exactly that).
router.patch('/firms/:id', async (req, res, next) => {
  const status = (req.body || {}).status;
  if (!['active', 'suspended', 'closed'].includes(status)) return res.status(400).json({ error: 'bad status' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE tpo_firms SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, name, status`, [req.params.id, status]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'firm not found' }); }
    if (status !== 'active') {
      await client.query(
        `UPDATE staff_users SET token_version = token_version + 1 WHERE tpo_firm_id=$1 AND is_external=true`,
        [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ firm: r.rows[0] });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) { /* already broken */ } next(e); }
  finally { client.release(); }
});

// ── TPO own-Xactus: a firm's OWN credit account (Phase 5b) ──────────────────
// When a firm has an ACTIVE credentials row, credit pulls on that firm's files
// run on the firm's Xactus login; otherwise every pull uses our shared company
// account, unchanged. Flood is always on our account. The password is stored
// encrypted and is NEVER returned — status reports presence only.

// View a firm's credit-account status (no secrets). manage_team (router default).
router.get('/firms/:id/credit-credentials', async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    res.json({ credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// Set (create/replace) a firm's Xactus credit login. platform_setup (sensitive).
router.put('/firms/:id/credit-credentials', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const b = req.body || {};
    await firmCredentials.setForFirm(req.params.id, {
      endpoint: b.endpoint, username: b.username, password: b.password,
      account: b.account, clientId: b.clientId, version: b.version,
      requestingParty: b.requestingParty, authMode: b.authMode,
    }, req.actor.id);
    await auditTpo(req, 'tpo_firm_credit_credentials_set', req.params.id, { authMode: b.authMode || 'basic' });
    res.json({ ok: true, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.userMessage || e.message });
    next(e);
  }
});

// Turn a firm's own-account on/off without re-entering the password. platform_setup.
router.post('/firms/:id/credit-credentials/active', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const active = (req.body || {}).active !== false;
    const ok = await firmCredentials.setActiveForFirm(req.params.id, active);
    if (!ok) return res.status(404).json({ error: 'no credit account is configured for this firm' });
    await auditTpo(req, 'tpo_firm_credit_credentials_active', req.params.id, { active });
    res.json({ ok: true, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// Remove a firm's own-account entirely (they revert to our shared account). platform_setup.
router.delete('/firms/:id/credit-credentials', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const ok = await firmCredentials.clearForFirm(req.params.id);
    await auditTpo(req, 'tpo_firm_credit_credentials_cleared', req.params.id, {});
    res.json({ ok, credit: await firmCredentials.statusForFirm(req.params.id) });
  } catch (e) { next(e); }
});

// A SAFE reachability check against the firm's own login (no credit request, not a
// billable pull) — the same "Test now" the API Health page runs for our account.
router.post('/firms/:id/credit-credentials/test', requirePermission('platform_setup'), async (req, res, next) => {
  try {
    if (!(await firmOr404(req, res))) return;
    const creds = await firmCredentials.resolveForFirm(req.params.id);
    if (!creds) return res.json({ configured: false, live: false, detail: 'No active credit account is configured for this firm yet.' });
    res.json(await creditProvider.testConnection(creds));
  } catch (e) { next(e); }
});

module.exports = router;
