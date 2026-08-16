'use strict';
/**
 * LENDER PRICE DIAGNOSTICS — secret-gated, read-only.
 *
 * Mounted in src/server.js at /api/lt/_diag/lenderprice, BEFORE the staff-gated /api/lt
 * mount, so it is reachable without a staff login BUT only with the shared secret
 * LP_DIAG_TOKEN. This exists so the pricing backend can be verified end-to-end from
 * outside a browser session (login → price → parse) once deployed.
 *
 * SAFETY:
 *   - OFF by default: with LP_DIAG_TOKEN unset the router 404s every path (feature hidden).
 *   - Constant-time token compare (x-lp-diag-token header). No token → 401.
 *   - Read-only pricing only (the shared DSCR handlers). No write/book/lock path exists.
 *   - LT-only; imports no RTL code.
 */
const express = require('express');
const crypto = require('crypto');
const { makeRouter } = require('./dscr-pricer');

const router = express.Router();

// Secret gate. Off unless LP_DIAG_TOKEN is set; then require a matching header.
router.use((req, res, next) => {
  const token = process.env.LP_DIAG_TOKEN || '';
  if (!token) return res.status(404).json({ error: 'not_found' });
  const got = String(req.get('x-lp-diag-token') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

router.use(makeRouter());

module.exports = router;
