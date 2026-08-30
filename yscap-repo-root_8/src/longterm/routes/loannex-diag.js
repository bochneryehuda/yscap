'use strict';
/**
 * LOANNEX / COMBINED-PRICING-ENGINE DIAGNOSTICS — secret-gated, read-only.
 *
 * The same handlers as `combined-pricer`, reachable without a staff browser
 * session so the two-vendor pipeline can be verified end-to-end on the server it
 * actually runs from. Mounted in src/server.js at /api/lt/_diag/loannex.
 *
 * THE SECRET REPLACES THE ROLE, AND NOTHING ELSE.
 *   - OFF by default: with NEX_DIAG_TOKEN unset every path 404s.
 *   - Constant-time compare of the x-nex-diag-token header. No token → 401.
 *
 * `superAdminOnly: false` is passed EXPLICITLY, and it is the only place in the
 * codebase that does. This seam has no signed-in person at all — there is no
 * `req.actor` to hold a role — so the super-admin gate could only ever refuse
 * it. The shared secret is what stands in its place, and it is strictly
 * narrower: a token nobody has set means the whole seam is 404. The KILL SWITCH
 * (`LT_COMBINED_PRICING`) is NOT opted out of and still applies here.
 *
 * LT-only; imports no RTL code.
 */
const express = require('express');
const crypto = require('crypto');
const { makeRouter } = require('./combined-pricer');

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

router.use(makeRouter({ superAdminOnly: false }));

module.exports = router;
