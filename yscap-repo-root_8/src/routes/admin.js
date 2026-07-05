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
    const dept = b.department || (role === 'processor' || role === 'underwriter' ? 'operations' : 'sales');
    const r = await db.query(
      `INSERT INTO staff_users
         (email,full_name,role,title,department,phone,cell,ext,
          site_selectable,is_active,sort_order,password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)
       ON CONFLICT (email) DO UPDATE SET
         full_name=EXCLUDED.full_name, role=EXCLUDED.role, title=EXCLUDED.title,
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
  const r = await db.query(
    `UPDATE staff_users SET password_hash=$2, token_version=token_version+1, updated_at=now()
      WHERE id=$1 RETURNING email`, [req.params.id, C.hashPassword(pw)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  res.json({ ok: true, email: r.rows[0].email });
});

router.get('/borrowers', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,tier,created_at FROM borrowers ORDER BY created_at DESC LIMIT 200`);
  res.json(r.rows);
});

module.exports = router;
