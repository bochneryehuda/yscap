'use strict';

// HTTP for the signed-in person's own long-term preferences. Mounted at /api/lt/me
// by src/longterm/index.js; staff authentication is applied at the mount seam.
//
// TODAY THERE IS ONE PREFERENCE: which product side the person opens on — the
// owner's "everybody should have a switch on his login to switch to the long-term
// side", remembered per user.
//
// IT IS STORED AS A SETTING UNDER A PER-USER SCOPE, not as a column on
// `staff_users`: adding a column to an RTL table to make Long-Term work is exactly
// what the separation rules forbid. `lt_settings.scope` was built to be more than
// 'company', so a person's own value lives under `user:<staff id>` and goes through
// the SAME declaration and the SAME validation as every other setting — an
// undeclared key is still refused.
//
// The ONE place a per-user scope behaves differently from the company one is
// `keepDefault`: on the company scope a value equal to the default is deleted, so
// the table holds only genuine deviations. Here it is KEPT, because "this person
// chose RTL" and "this person has never chosen" are different facts — and on a
// lender whose company default is the long-term side, collapsing them would put
// the one person who deliberately chose RTL back on the other side.

const express = require('express');
const router = express.Router();

const settingsStore = require('../settings/store');
const access = require('../access');

const PRODUCTS = ['rtl', 'long_term'];

/** The scope a person's own preferences live under. */
const scopeFor = (staffId) => `user:${String(staffId)}`;

/**
 * The company default, read from the company scope — so a lender that wants its
 * people to open on the long-term side changes ONE setting rather than every user.
 */
async function resolveProduct(staffId) {
  const [me, company] = await Promise.all([
    settingsStore.load(scopeFor(staffId)),
    settingsStore.load(),
  ]);
  // The per-user store starts from the DECLARED defaults, so it always holds a
  // value — which would mask the company's. Only a genuine per-user choice counts.
  //
  // THE QUESTION IS "DID THEY CHOOSE", NOT "IS IT DIFFERENT FROM OURS". This read
  // `describe(...).isOverridden`, which answers the second — and the two part
  // company on exactly the case the PUT below passes `keepDefault: true` to
  // protect. Somebody deliberately picking the side that HAPPENS to be the
  // company default stored a row, that row read as "not overridden" because its
  // value matched ours, their choice was discarded in favour of the company
  // value, and the day an admin moved that default they were moved with it —
  // having explicitly asked not to be. Proven end to end before it was changed:
  // the row was there the whole time and nothing read it.
  // ONE test, deliberately. `load` always returns `stored`, so a second lookup
  // beside this could never be reached, and a guard no mutation can reach is
  // decoration — the rule `conditions/read.js doneStatusesFrom` records for the
  // same reason.
  const chosenByUser = me.stored.has('ui.defaultProduct');
  const chosen = chosenByUser ? me.settings['ui.defaultProduct'] : company.settings['ui.defaultProduct'];
  return {
    product: PRODUCTS.includes(chosen) ? chosen : 'rtl',
    chosenByUser: !!chosenByUser,
    degraded: me.degraded || company.degraded,
  };
}

// GET /api/lt/me — which side this person opens on, and what they may do here.
router.get('/', async (req, res) => {
  try {
    const staffId = req.actor && req.actor.id;
    const [{ product, chosenByUser, degraded }, { settings }] = await Promise.all([
      resolveProduct(staffId),
      settingsStore.load(),
    ]);
    const viewer = access.accessFor(req.actor, settings);
    res.json({
      product,
      chosenByUser,
      degraded,
      products: PRODUCTS,
      ltRole: viewer.ltRole,
      scope: viewer.scope,
      canManagePeople: access.mayManagePeople(req.actor, settings),
      // The Condition Center is set aside (owner-directed 2026-08-14). The shell
      // reads this rather than hard-coding the deferral, so lifting it is a
      // settings change and not a deploy.
      conditionsEnabled: settings['conditions.enabled'] === true,
    });
  } catch (e) {
    console.error('[lt] read own preferences failed:', (e && e.message) || e);
    // Never leave the shell without an answer: falling back to RTL is the safe
    // side, because Long-Term is a side build that is not live.
    res.json({ product: 'rtl', chosenByUser: false, degraded: true, products: PRODUCTS, conditionsEnabled: false });
  }
});

// PUT /api/lt/me/product — flip the switch, for this person only.
router.put('/product', async (req, res) => {
  try {
    const product = String((req.body || {}).product || '');
    if (!PRODUCTS.includes(product)) {
      return res.status(400).json({ error: `Which side? Expected one of: ${PRODUCTS.join(', ')}.` });
    }
    const staffId = req.actor && req.actor.id;
    if (!staffId) return res.status(400).json({ error: 'No signed-in person to save this for.' });

    // keepDefault: a person choosing the side that HAPPENS to be the declared
    // default is still a choice, and the store would otherwise delete the row —
    // which on a lender whose company default is the other side would silently
    // put them back on it.
    await settingsStore.save(
      { 'ui.defaultProduct': product },
      { scope: scopeFor(staffId), staffId, keepDefault: true },
    );
    const out = await resolveProduct(staffId);
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message });
    console.error('[lt] save product preference failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save which side you open on.' });
  }
});

module.exports = router;
module.exports.PRODUCTS = PRODUCTS;
module.exports.scopeFor = scopeFor;
