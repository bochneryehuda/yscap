'use strict';
/**
 * LONG-TERM DSCR PRICER — HTTP routes (Lender Price backend).
 *
 * Two mounts share these handlers:
 *   • the staff-gated LT router (src/longterm/index.js → /api/lt/dscr/*), and
 *   • a secret-gated diagnostics router (src/longterm/routes/lenderprice-diag.js →
 *     /api/lt/_diag/lenderprice/*) that is OFF unless LP_DIAG_TOKEN is set.
 *
 * Read-only: prices via Lender Price and never books/locks/registers. All Lender Price
 * calls happen server-side (the trusted company origin); the client lives in
 * src/longterm/lenderprice/client.js. LT-only — imports no RTL code.
 */
const express = require('express');
const lp = require('../lenderprice/client');

// A small, fixed verification battery spanning states / property types / FICO / DSCR / prepay.
const BATTERY = [
  { name: 'SFR purchase 75% 760 DSCR1.25 NJ 5yr', purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039', prepayMonths: 60 },
  { name: 'SFR cash-out 70% 720 DSCR1.10 FL 3yr', purpose: 'CashOut', value: 600000, loan: 420000, fico: 720, dscr: 1.10, propertyType: 'SingleFamily', zip: '33101', state: 'FL', county: 'Miami-Dade', countyFps: '12086', prepayMonths: 36 },
  { name: '2-4 unit purchase 75% 740 DSCR1.30 NY 5yr', purpose: 'Purchase', value: 900000, loan: 675000, fico: 740, dscr: 1.30, propertyType: 'Unit2_4', zip: '11211', state: 'NY', county: 'Kings', countyFps: '36047', prepayMonths: 60 },
  { name: 'Warr condo r/t refi 65% 780 DSCR1.40 TX none', purpose: 'RateTerm', value: 450000, loan: 292500, fico: 780, dscr: 1.40, propertyType: 'CondoWarr', zip: '75201', state: 'TX', county: 'Dallas', countyFps: '48113', prepayMonths: 0 },
  { name: 'SFR purchase I/O 80% 700 DSCR1.05 GA 2yr', purpose: 'Purchase', value: 350000, loan: 280000, fico: 700, dscr: 1.05, propertyType: 'SingleFamily', zip: '30301', state: 'GA', county: 'Fulton', countyFps: '13121', prepayMonths: 24, io: true },
];

function trimPrograms(parsed, limit = 60) {
  return {
    meta: { programCount: parsed.programCount, lenderCount: parsed.lenderCount, rungCount: parsed.rungCount, disqualifiedCount: parsed.disqualifiedCount },
    programs: parsed.programs.slice(0, limit).map((p) => ({
      lender: p.lender, program: p.program, minRate: p.minRate, maxPrice: p.maxPrice, rungCount: p.rungCount,
    })),
  };
}

// GET /health — is the module up and are Lender Price credentials configured (no login attempted).
async function health(req, res) {
  res.json({ ok: true, product: 'long-term', feature: 'dscr-pricer', configured: lp.configured() });
}

// GET /login-check — actually attempt a login and report ok/failure (no pricing). Confirms the
// origin-gated login works from the server.
async function loginCheck(req, res) {
  const s = await lp.getSession({ force: true });
  if (!s.ok) return res.status(502).json({ ok: false, error: s.error, http: s.http || null, message: s.message });
  res.json({ ok: true, companyId: s.companyId, userId: s.userId, expiresAt: new Date(s.expiresAt).toISOString(), profile: s.profile });
}

// POST /price — body is a scenario (or { scenario }). Returns the parsed program summary.
async function price(req, res) {
  const sc = (req.body && req.body.scenario) ? req.body.scenario : (req.body || {});
  const r = await lp.price(sc);
  if (!r.ok) {
    const code = (r.http && r.http >= 500) ? 502 : 400;
    return res.status(code).json({ ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null });
  }
  const parsed = lp.parse(r.raw);
  res.json({ ok: true, ...trimPrograms(parsed), request: r.request });
}

// POST /selftest — run the fixed battery; returns one row per scenario. Paced, gentle on the login.
async function selftest(req, res) {
  const results = [];
  for (const sc of BATTERY) {
    const r = await lp.price(sc);
    if (!r.ok) { results.push({ name: sc.name, ok: false, error: r.error, http: r.http || null, message: r.message, upstream: r.upstream || r.body || null }); continue; }
    const p = lp.parse(r.raw);
    const best = p.programs.reduce((m, x) => (x.minRate != null && (m == null || x.minRate < m) ? x.minRate : m), null);
    results.push({ name: sc.name, ok: true, programCount: p.programCount, lenderCount: p.lenderCount, rungCount: p.rungCount, bestRate: best });
    await new Promise((rs) => setTimeout(rs, 800));
  }
  res.json({ ok: results.every((x) => x.ok), count: results.length, results });
}

// A router with the endpoints wired. Auth is applied by the mount (staff at /api/lt, or the
// secret gate at /api/lt/_diag/lenderprice).
function makeRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.get('/health', (req, res) => health(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_health_error' })));
  router.get('/login-check', (req, res) => loginCheck(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_login_error' })));
  router.post('/price', (req, res) => price(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_price_error' })));
  router.post('/selftest', (req, res) => selftest(req, res).catch((e) => res.status(500).json({ ok: false, error: 'lt_dscr_selftest_error' })));
  return router;
}

module.exports = { makeRouter, handlers: { health, loginCheck, price, selftest }, BATTERY };
