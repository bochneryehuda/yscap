/**
 * Public team roster — the single source of truth for the marketing site's
 * "select your loan officer" dropdown and ?lo= branding. Serves ONLY active,
 * site-selectable staff, and never any secret/PII (no password, no ids beyond
 * what the site needs). Cached briefly to shield the DB from crawler traffic.
 *
 *   GET /api/roster            -> { groups:[{department,label,people:[…]}], people:[…], updatedAt }
 *   GET /api/roster?flat=1     -> { people:[…] }
 *
 * Each person: { code, name, title, role, email, phone, cell, ext, department }
 * `code` is the email local-part (lowercased) — the ?lo= branding key.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');

const DEPT_LABEL = { sales: 'Sales & Loan Coordinators', operations: 'Operations & Back Office' };
const DEPT_ORDER = { sales: 1, operations: 2 };

let _cache = { at: 0, payload: null };
const TTL_MS = 60 * 1000;

function shape(row) {
  return {
    code: (row.email || '').split('@')[0].toLowerCase(),
    name: row.full_name,
    title: row.title || null,
    role: row.role,
    email: row.email,
    phone: row.phone || null,
    cell: row.cell || null,
    ext: row.ext || null,
    department: row.department || null,
  };
}

async function load() {
  const r = await db.query(
    `SELECT email, full_name, role, title, department, phone, cell, ext
       FROM staff_users
      WHERE is_active = true AND site_selectable = true
      ORDER BY sort_order, full_name`);
  const people = r.rows.map(shape);
  const byDept = new Map();
  for (const p of people) {
    const key = p.department || 'sales';
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(p);
  }
  const groups = [...byDept.entries()]
    .sort((a, b) => (DEPT_ORDER[a[0]] || 9) - (DEPT_ORDER[b[0]] || 9))
    .map(([department, ppl]) => ({ department, label: DEPT_LABEL[department] || department, people: ppl }));
  return { groups, people, updatedAt: new Date().toISOString() };
}

router.get('/', async (req, res) => {
  try {
    if (!_cache.payload || Date.now() - _cache.at > TTL_MS) {
      _cache = { at: Date.now(), payload: await load() };
    }
    res.set('Cache-Control', 'public, max-age=60');
    if (req.query.flat) return res.json({ people: _cache.payload.people, updatedAt: _cache.payload.updatedAt });
    res.json(_cache.payload);
  } catch (e) {
    // Never 500 the public site over a roster hiccup — the site keeps its
    // static fallback list. Return an empty roster so the client uses it.
    res.set('Cache-Control', 'no-store');
    res.json({ groups: [], people: [], updatedAt: null, error: 'roster unavailable' });
  }
});

// Let an admin flush the cache immediately after editing the team.
function bust() { _cache = { at: 0, payload: null }; }
module.exports = router;
module.exports.bust = bust;
