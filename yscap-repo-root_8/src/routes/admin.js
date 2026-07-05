/** Admin API — user management + Lead-Capture overview. */
const express = require('express');
const router = express.Router();
const db = require('../db');
const cfg = require('../config');
const provider = require('../lib/email');
const tpl = require('../lib/email/template');
const { requireAuth, requireRole } = require('../auth');

router.use(requireAuth, requireRole('admin'));

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

router.get('/staff', async (req, res) => {
  const r = await db.query(
    `SELECT id,email,full_name,role,is_active,site_selectable,mfa_enabled,last_login_at FROM staff_users ORDER BY full_name`);
  res.json(r.rows);
});
router.patch('/staff/:id', async (req, res) => {
  const b = req.body || {};
  await db.query(
    `UPDATE staff_users SET is_active=COALESCE($2,is_active), site_selectable=COALESCE($3,site_selectable),
            role=COALESCE($4,role), updated_at=now() WHERE id=$1`,
    [req.params.id, b.isActive ?? null, b.siteSelectable ?? null, b.role || null]);
  res.json({ ok: true });
});
router.get('/borrowers', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,tier,created_at FROM borrowers ORDER BY created_at DESC LIMIT 200`);
  res.json(r.rows);
});

module.exports = router;
