'use strict';
/**
 * THE GENERAL PRICING ENGINE'S INVESTOR SOURCES — the side-by-side list's own door.
 *
 * ── THE OWNER'S ASK (2026-09-03) ───────────────────────────────────────────
 * *"I want the side-by-side list… in the settings of the regular pricing engine…
 * three options should be like a nice modern design: price it from Lender Price,
 * price it from LoanNEX, or turn off this investor."* And: *"Don't add any new
 * sections"* to the pricing page — this is ONE new section in the SETTINGS, and
 * the pricing screen itself is untouched.
 *
 * ── IT IS A MOUNT, NOT AN ENGINE ───────────────────────────────────────────
 * Every door here comes from `investor-settings-routes.js`, the ONE definition
 * the Combined Pricing Engine mounts too. This file adds exactly two things: the
 * gate, and the path. There is no route body in it at all — deliberately, so a
 * validation rule can never be right on one engine's settings screen and wrong on
 * the other's.
 *
 * ⛔ NOT BEHIND `LT_COMBINED_PRICING`. That switch hides the engine the owner is
 * auditing privately; the general engine's own settings must not disappear with
 * it. Mounting the combined router a second time would have done exactly that,
 * which is why the doors were lifted out instead.
 *
 * ⛔ SUPER ADMIN ONLY, AND IT ANSWERS 404. These four settings decide which rate
 * sheet every price on the board comes from and carry a margin — the same
 * authority the combined engine's copy has always required. A 404 rather than a
 * 403 for the same reason the engine beside it gives one: a control the rest of
 * the team may not use should not announce itself to them.
 */

const express = require('express');
const settingsRoutes = require('./investor-settings-routes');

/** The REAL staff role, never a long-term override — an override may not hand this out. */
function isSuperAdmin(req) {
  const a = req.actor;
  return !!(a && a.kind === 'staff' && String(a.role || '') === 'super_admin');
}

function makeRouter(opts = {}) {
  const router = express.Router();
  const superAdminOnly = opts.superAdminOnly !== false;
  router.use((req, res, next) => (!superAdminOnly || isSuperAdmin(req) ? next() : res.status(404).json({ error: 'not_found' })));
  settingsRoutes.attach(router);
  return router;
}

module.exports = { makeRouter, _internals: { isSuperAdmin } };
