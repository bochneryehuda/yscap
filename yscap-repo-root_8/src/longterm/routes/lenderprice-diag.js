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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN OPEN QUESTION FOR THE OWNER — WHOSE AUDIENCE IS THIS DOOR? (recorded
 * 2026-08-17, when the investor guard was wired onto the client route.)
 *
 * `audience.js` fails closed: anything that is not exactly our own staff is a
 * CLIENT, and a client may never be told an investor's name. This door has NO
 * signed-in actor at all — it authenticates a shared SECRET, not a person — and
 * the pricing it returns names the INVESTOR behind every program (`investor` on
 * each row of the trimmed program list and of the audit rung digest), because
 * that is the point of a rate-sheet diff against the Lender Price frontend.
 *
 * It is treated as INTERNAL and left exactly as it was, deliberately and NOT on a
 * guess about the guard: LP_DIAG_TOKEN is an ops secret of ours, the door 404s
 * unless somebody sets it, no borrower or broker session can reach it, and there
 * is no way for a client to obtain the header. Stripping the investor out here
 * would break the one job this door exists for while protecting nobody who can
 * actually knock on it.
 *
 * The question that was NOT decided here, because it is the owner's: should a
 * shared-secret ops door count as internal staff for the hard rule, or should the
 * diagnostics live behind a staff login like the identical `/api/lt/dscr/*`
 * mount? If the answer is the latter, this file is the one thing to delete — the
 * handlers it wraps are already staff-gated on the other mount.
 * ─────────────────────────────────────────────────────────────────────────────
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
