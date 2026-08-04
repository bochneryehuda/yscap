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

module.exports = router;
