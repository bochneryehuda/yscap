'use strict';
/**
 * LOANNEX / MERGED-PRICING DIAGNOSTICS — secret-gated, read-only.
 *
 * The same handlers as `merged-pricer`, reachable without a staff browser
 * session so the two-vendor pipeline can be verified end-to-end on the server it
 * actually runs from. Mounted in src/server.js at /api/lt/_diag/loannex.
 *
 * TWO GATES, BOTH MUST BE OPEN. The owner's not-live flag (LT_MERGED_PRICING)
 * is enforced inside makeRouter, and this seam adds the shared secret on top:
 *   - OFF by default: with NEX_DIAG_TOKEN unset every path 404s.
 *   - Constant-time compare of the x-nex-diag-token header. No token → 401.
 * A diagnostics seam that could bypass the owner's flag would defeat the flag,
 * so the order is deliberate: secret first, then the same gate everyone else hits.
 *
 * LT-only; imports no RTL code.
 */
const express = require('express');
const crypto = require('crypto');
const { makeRouter } = require('./merged-pricer');

const router = express.Router();

router.use((req, res, next) => {
  const token = process.env.NEX_DIAG_TOKEN || '';
  if (!token) return res.status(404).json({ error: 'not_found' });
  const got = String(req.get('x-nex-diag-token') || '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

router.use(makeRouter());

module.exports = router;
