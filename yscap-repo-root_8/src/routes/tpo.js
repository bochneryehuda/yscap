/**
 * TPO PORTAL API — the third front door (owner-directed 2026-08-04; db/464 +
 * db/465; design docs/TPO-PORTAL-BLUEPRINT.md).
 *
 * Every endpoint requires a `kind='tpo'` session (an EXTERNAL brokerage user, a
 * staff_users row flagged is_external) and is FIRM-SCOPED: a TPO user only ever
 * sees their own firm's TPO files and borrowers, never a retail file and never
 * another firm's. Firm isolation lives in ONE place —
 * `permissions.tpoFirmScopeSql` — so every query here routes through it (the
 * same single-definition discipline as the staff `visibleOfficersSql`).
 *
 * This router is deliberately SEPARATE from /api/staff and /api/borrower rather
 * than poking is_external holes into them: an external party touching a lender's
 * system gets a small, curated surface, so a staff-only capability or an
 * internal integration can never be reached by accident. Feature endpoints
 * (pricing, conditions, orders, credit, documents …) are added here in later
 * phases, each reusing the underlying lib layer with the borrower-safe filters
 * already applied.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const mail = require('../lib/email/catalog');
const { requireAuth, requireTpo } = require('../auth');
const perms = require('../lib/permissions');

// Every TPO route is gated: a valid session AND the tpo kind.
router.use(requireAuth, requireTpo);

// Who am I + which firm do I belong to. (Mirrors /auth/me's tpo branch so the
// SPA can read it from the portal API without a second auth surface.)
router.get('/me', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.is_firm_admin,
              u.tpo_firm_id, f.name AS firm_name, f.status AS firm_status
         FROM staff_users u LEFT JOIN tpo_firms f ON f.id = u.tpo_firm_id
        WHERE u.id=$1`, [req.actor.id]);
    const row = r.rows[0] || {};
    res.json({
      id: row.id, email: row.email, full_name: row.full_name, role: row.role,
      is_firm_admin: row.is_firm_admin,
      firm: row.tpo_firm_id ? { id: row.tpo_firm_id, name: row.firm_name, status: row.firm_status } : null,
    });
  } catch (e) { next(e); }
});

// The firm's pipeline — every TPO file the broker's firm has brought us, and
// ONLY those. Scoped through the single firm-isolation definition.
router.get('/applications', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.status, a.property_address,
              a.borrower_portal_enabled, a.created_at,
              NULLIF(b.full_name,'') AS borrower_name
         FROM applications a
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE a.deleted_at IS NULL
          AND ${perms.tpoFirmScopeSql('a', '$1')}
        ORDER BY a.created_at DESC
        LIMIT 500`, [req.actor.id]);
    res.json({ applications: r.rows });
  } catch (e) { next(e); }
});

// ---------------- the firm's own team ----------------
// The broker's firm roster (every external user on their firm).
router.get('/team', async (req, res, next) => {
  try {
    const me = await db.query(`SELECT tpo_firm_id FROM staff_users WHERE id=$1`, [req.actor.id]);
    const firmId = me.rows[0] && me.rows[0].tpo_firm_id;
    if (!firmId) return res.json({ team: [] });
    const r = await db.query(
      `SELECT id, full_name, email, role, is_firm_admin, is_active,
              (password_hash IS NOT NULL) AS has_login
         FROM staff_users WHERE tpo_firm_id=$1 AND is_external=true
        ORDER BY is_firm_admin DESC, full_name`, [firmId]);
    res.json({ team: r.rows });
  } catch (e) { next(e); }
});

// A FIRM ADMIN invites a processor (or officer) to THEIR OWN firm. The firm is
// always the inviter's own firm — never client-supplied — and a firm admin can
// never mint another firm admin (that stays an internal-admin decision).
router.post('/team/invite', async (req, res, next) => {
  try {
    const me = (await db.query(`SELECT tpo_firm_id, is_firm_admin FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    if (!me.is_firm_admin) return res.status(403).json({ error: 'only a firm admin can invite team members' });
    const firmId = me.tpo_firm_id;
    const f = (await db.query(`SELECT status, name FROM tpo_firms WHERE id=$1`, [firmId])).rows[0];
    if (!f || f.status !== 'active') return res.status(400).json({ error: 'the firm is not active' });
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    const role = perms.TPO_ROLE_KEYS.includes(b.role) ? b.role : 'tpo_processor';
    // Refuse an email already attached to any account. An internal staffer is
    // never convertible; an existing broker (this firm's or another's) must not
    // be re-invited — a firm admin invites NEW people only. Re-inviting a
    // same-firm colleague would demote them (this path mints is_firm_admin=false,
    // and the accept branch would apply it); a different firm's broker is not
    // theirs to touch. Either case is handled from the internal admin surface.
    const ex = await db.query(`SELECT is_external FROM staff_users WHERE lower(email)=lower($1)`, [email]);
    if (ex.rows[0] && ex.rows[0].is_external === false)
      return res.status(409).json({ error: 'that email already belongs to an internal staff account' });
    if (ex.rows[0] && ex.rows[0].is_external === true)
      return res.status(409).json({ error: 'that person already has a broker account — ask YS Capital to move or update them' });
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash, kind, email, role, created_by, tpo_firm_id, is_firm_admin, expires_at)
       VALUES ($1,'tpo',$2,$3,$4,$5,false, now() + interval '7 days')`,
      [C.sha256(token), email, role, req.actor.id, firmId]);
    const acceptUrl = mail.link('/tpo/accept?token=' + token);
    let emailed = false;
    try {
      const r = await mail.send('tpoInvite', email, { fullName: b.fullName || '', firmName: f.name, role, acceptUrl, days: 7 });
      emailed = !!(r && r.ok);
    } catch (_) { /* best-effort */ }
    res.status(201).json({ ok: true, token, acceptUrl, emailed });
  } catch (e) { next(e); }
});

module.exports = router;
