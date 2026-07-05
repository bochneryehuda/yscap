/** Admin API — user management + Lead-Capture overview. */
const express = require('express');
const router = express.Router();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const provider = require('../lib/email');
const tpl = require('../lib/email/template');
const mail = require('../lib/email/catalog');
const roster = require('./roster');
const { requireAuth, requireRole } = require('../auth');

router.use(requireAuth, requireRole('admin'));

const ROLES = ['super_admin', 'admin', 'loan_officer', 'processor', 'underwriter'];
const DEPTS = ['sales', 'operations'];

/**
 * Send a branded test email so you can confirm the provider (Resend/Graph) and
 * FROM domain are wired correctly. POST { to?: "you@x.com" } — defaults to the
 * admin's own address. Returns the provider result, including any error verbatim
 * (e.g. Resend "domain not verified"), so misconfiguration is obvious.
 */
router.post('/test-email', async (req, res) => {
  let to = (req.body && req.body.to) || null;
  if (!to) {
    const r = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [req.actor.id]);
    to = r.rows[0]?.email;
  }
  if (!to) return res.status(400).json({ ok: false, error: 'no recipient (pass {to})' });
  if (cfg.emailProvider === 'none') {
    return res.status(400).json({
      ok: false, provider: 'none',
      error: 'EMAIL_PROVIDER is none — set RESEND_API_KEY (or the MS_* vars) and redeploy.',
    });
  }
  const built = tpl.render({
    audience: 'staff',
    title: 'YS Capital email test',
    preheader: 'This confirms transactional email is working.',
    intro: 'This is a test message from the YS Capital Group portal.',
    lines: [`Provider: ${cfg.emailProvider}. From: ${cfg.notifyFrom}. If you received this, email delivery is configured correctly.`],
    note: 'You can safely ignore this message.',
  });
  try {
    const r = await provider.sendMail({ to, subject: built.subject, text: built.text, html: built.html });
    return res.json({ ok: !!(r && r.ok), provider: cfg.emailProvider, from: cfg.notifyFrom, to, id: r && r.id });
  } catch (e) {
    return res.status(502).json({ ok: false, provider: cfg.emailProvider, from: cfg.notifyFrom, to, error: e.message });
  }
});

// ---------------- staff / team management ----------------
// super_admin is strictly above admin. Only a super_admin may create/assign the
// super_admin role or modify an existing super_admin account — otherwise a plain
// admin could reset the president's password, deactivate him, or self-escalate.
const isSuper = (req) => req.actor.role === 'super_admin';
async function targetRole(id) {
  const r = await db.query(`SELECT role FROM staff_users WHERE id=$1`, [id]);
  return r.rows[0] ? r.rows[0].role : null;
}
// Returns null if allowed, or an {code,error} to send. `newRole` is the role the
// request would assign (or undefined if unchanged).
function roleGuard(req, currentRole, newRole) {
  if (currentRole === 'super_admin' && !isSuper(req))
    return { code: 403, error: 'only a super admin can modify a super admin account' };
  if (newRole === 'super_admin' && !isSuper(req))
    return { code: 403, error: 'only a super admin can grant the super admin role' };
  return null;
}

// The full team, with the roster fields the admin console edits.
router.get('/staff', async (req, res) => {
  const r = await db.query(
    `SELECT id,email,full_name,role,title,department,phone,cell,ext,
            is_active,site_selectable,sort_order,mfa_enabled,
            (password_hash IS NOT NULL) AS has_login, last_login_at
       FROM staff_users ORDER BY department NULLS LAST, sort_order, full_name`);
  res.json(r.rows);
});

// Create a staff member. They appear on the roster (if sales + site_selectable),
// in portal assignment lists, and can log in as soon as a password is set —
// either directly here (password) or via an emailed invite (sendInvite:true).
router.post('/staff', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const fullName = String(b.fullName || '').trim();
  const role = String(b.role || 'loan_officer');
  if (!email || !fullName) return res.status(400).json({ error: 'email and fullName required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'bad role' });
  if (b.department && !DEPTS.includes(b.department)) return res.status(400).json({ error: 'bad department' });
  if (b.password && String(b.password).length < 8) return res.status(400).json({ error: 'password too short' });
  try {
    // Guard against granting super_admin, or silently touching an existing
    // super_admin (e.g. re-adding the president's email would otherwise
    // demote/overwrite him). On conflict we deliberately do NOT change role —
    // role changes go through the edit endpoint — so re-adding never demotes.
    const existing = await db.query(`SELECT role FROM staff_users WHERE email=$1`, [email]);
    const g = roleGuard(req, existing.rows[0] && existing.rows[0].role, role);
    if (g) return res.status(g.code).json({ error: g.error });

    const dept = b.department || (role === 'processor' || role === 'underwriter' ? 'operations' : 'sales');
    const r = await db.query(
      `INSERT INTO staff_users
         (email,full_name,role,title,department,phone,cell,ext,
          site_selectable,is_active,sort_order,password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)
       ON CONFLICT (email) DO UPDATE SET
         full_name=EXCLUDED.full_name, title=EXCLUDED.title,
         department=EXCLUDED.department, phone=EXCLUDED.phone, cell=EXCLUDED.cell,
         ext=EXCLUDED.ext, site_selectable=EXCLUDED.site_selectable, is_active=true,
         updated_at=now()
       RETURNING id, (xmax=0) AS created`,
      [email, fullName, role, b.title || null, dept, b.phone || null, b.cell || null, b.ext || null,
       b.siteSelectable !== false, Number(b.sortOrder) || 100, b.password ? C.hashPassword(b.password) : null]);
    const staffId = r.rows[0].id;
    roster.bust();

    let invited = false, inviteToken = null;
    if (!b.password && b.sendInvite) {
      inviteToken = C.randomToken(24);
      await db.query(
        `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
         VALUES ($1,'staff',$2,$3,$4, now() + interval '7 days')`,
        [C.sha256(inviteToken), email, role, req.actor.id]);
      try {
        let inviter = 'YS Capital Group';
        const iv = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
        if (iv.rows[0]?.full_name) inviter = iv.rows[0].full_name;
        const sent = await mail.send('staffInvite', email, {
          fullName, role, acceptUrl: mail.link('/accept?token=' + inviteToken), inviter, days: 7 });
        invited = !!(sent && sent.ok);
      } catch (_) {}
    }
    res.status(201).json({ ok: true, staffId, created: r.rows[0].created, invited, inviteToken });
  } catch (e) { res.status(500).json({ error: 'could not save staff member' }); }
});

// Edit any roster/profile field. Only provided fields change.
router.patch('/staff/:id', async (req, res) => {
  const b = req.body || {};
  if (b.role && !ROLES.includes(b.role)) return res.status(400).json({ error: 'bad role' });
  if (b.department && !DEPTS.includes(b.department)) return res.status(400).json({ error: 'bad department' });
  const g = roleGuard(req, await targetRole(req.params.id), b.role);
  if (g) return res.status(g.code).json({ error: g.error });
  const map = {
    full_name: b.fullName, role: b.role, title: b.title, department: b.department,
    phone: b.phone, cell: b.cell, ext: b.ext,
    is_active: b.isActive, site_selectable: b.siteSelectable, sort_order: b.sortOrder,
  };
  const sets = [], vals = []; let i = 1;
  for (const [k, v] of Object.entries(map)) if (v !== undefined) { sets.push(`${k}=$${i++}`); vals.push(v); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    await db.query(`UPDATE staff_users SET ${sets.join(',')} WHERE id=$${i}`, vals);
    roster.bust();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'could not update staff member' }); }
});

// Set / reset a staff password (admin-driven provisioning or lockout recovery).
router.post('/staff/:id/password', async (req, res) => {
  const pw = (req.body || {}).password || '';
  if (String(pw).length < 8) return res.status(400).json({ error: 'password too short (min 8)' });
  const g = roleGuard(req, await targetRole(req.params.id));
  if (g) return res.status(g.code).json({ error: g.error });
  const r = await db.query(
    `UPDATE staff_users SET password_hash=$2, token_version=token_version+1, updated_at=now()
      WHERE id=$1 RETURNING email`, [req.params.id, C.hashPassword(pw)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  res.json({ ok: true, email: r.rows[0].email });
});

// Send a "your console is ready" welcome. Staff WITH a login get a sign-in
// email; staff without get an invite link to set their password.
async function sendWelcome(row) {
  let url, hasLogin = !!row.has_login;
  if (hasLogin) url = mail.link('/staff/login');
  else {
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,role,expires_at)
       VALUES ($1,'staff',$2,$3, now() + interval '14 days')`, [C.sha256(token), row.email, row.role]);
    url = mail.link('/accept?token=' + token);
  }
  const r = await mail.send('staffWelcome', row.email, { fullName: row.full_name, role: row.role, url, hasLogin });
  return !!(r && r.ok);
}
router.post('/staff/:id/welcome', async (req, res) => {
  const r = await db.query(
    `SELECT email, full_name, role, (password_hash IS NOT NULL) AS has_login
       FROM staff_users WHERE id=$1 AND is_active=true`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  try {
    const sent = await sendWelcome(r.rows[0]);
    res.json({ ok: true, sent, email: r.rows[0].email });
  } catch (e) { res.status(502).json({ error: 'could not send welcome email' }); }
});
// Email a staff member a "set a new password" link. Works whether or not they
// already have a login — accepting the token resets their password (the /accept
// staff path does ON CONFLICT DO UPDATE password_hash). super_admin-protected.
router.post('/staff/:id/reset-email', async (req, res) => {
  const g = roleGuard(req, await targetRole(req.params.id));
  if (g) return res.status(g.code).json({ error: g.error });
  const r = await db.query(`SELECT email, full_name, role FROM staff_users WHERE id=$1 AND is_active=true`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  try {
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
       VALUES ($1,'staff',$2,$3,$4, now() + interval '7 days')`,
      [C.sha256(token), r.rows[0].email, r.rows[0].role, req.actor.id]);
    const sent = await mail.send('staffPasswordReset', r.rows[0].email, {
      fullName: r.rows[0].full_name, url: mail.link('/accept?token=' + token), days: 7 });
    res.json({ ok: true, sent: !!(sent && sent.ok), email: r.rows[0].email });
  } catch (e) { res.status(502).json({ error: 'could not send reset email' }); }
});

router.post('/staff/welcome-all', async (req, res) => {
  const onlyNoLogin = (req.body || {}).onlyWithoutLogin !== false;   // default: those who can't log in yet
  const r = await db.query(
    `SELECT email, full_name, role, (password_hash IS NOT NULL) AS has_login
       FROM staff_users WHERE is_active=true ${onlyNoLogin ? 'AND password_hash IS NULL' : ''}
      ORDER BY full_name`);
  let sent = 0, failed = 0;
  for (const row of r.rows) {
    try { (await sendWelcome(row)) ? sent++ : failed++; }
    catch (_) { failed++; }
  }
  res.json({ ok: true, total: r.rows.length, sent, failed });
});

router.get('/borrowers', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,tier,created_at FROM borrowers ORDER BY created_at DESC LIMIT 200`);
  res.json(r.rows);
});

// Which third-party integrations are configured (keys present) vs pending.
router.get('/integrations', (req, res) => {
  res.json(require('../lib/integrations').status());
});

module.exports = router;
