/** Admin API — user management + Lead-Capture overview. */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireRole } = require('../auth');

router.use(requireAuth, requireRole('admin'));

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
