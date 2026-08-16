'use strict';

// HTTP for the long-term SETTINGS — the owner's hard structural rule made usable:
// "everything that I'm telling you to build, which is customizable to us, should be
// in the settings pre-filled customizable for us, but everything should be able to
// be changed so we can sell the system eventually."
//
// Mounted at /api/lt/settings; staff authentication is applied at the mount seam.
//
// TWO SCREENS, as the owner asked — an ADMIN one and a REGULAR one — and they are
// the same endpoint with different scopes rather than two implementations:
//
//   · COMPANY scope is the lender's own configuration. Admin only, because a stage
//     map or a role→scope map decides what every person in the company sees.
//   · USER scope is a person's own preferences. Anyone may change their own, and
//     NOBODY may change somebody else's — the scope is derived from the session,
//     never taken from the request, so there is no id to tamper with.
//
// THE SCREEN IS DRAWN FROM THE SERVER'S OWN DESCRIPTION (`store.describe`), so
// adding a setting server-side makes it appear with no front-end change. That is
// what stops the two drifting — a front end with its own copy of the setting list
// is a second source of truth for "what can be configured".

const express = require('express');
const router = express.Router();

const settingsStore = require('../settings/store');
const access = require('../access');

const COMPANY = 'company';
const userScope = (staffId) => `user:${String(staffId)}`;

/**
 * Which settings belong on the personal screen.
 *
 * Deliberately a small allowlist rather than "everything not admin-only": a new
 * setting must be DECIDED onto the personal screen, because the failure mode of
 * getting it wrong is a person quietly overriding company policy for themselves.
 */
const PERSONAL_KEYS = new Set(['ui.defaultProduct']);

async function requireSettingsAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({ error: 'Only an administrator can change the company settings.' });
    }
    return next();
  } catch (e) {
    // The gate failing is not permission to pass it.
    console.error('[lt] settings admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

// GET /api/lt/settings — the COMPANY settings, grouped, each with its default, its
// effective value, and whether it has been changed from ours. Readable by any staff
// member (knowing how the system is configured is not a privilege); the screen
// hides the save controls unless `canManage`.
router.get('/', async (req, res) => {
  try {
    const described = await settingsStore.describe(COMPANY);
    let canManage = false;
    try {
      const { settings } = await settingsStore.load();
      canManage = access.mayManagePeople(req.actor, settings);
    } catch (_) { /* the values are still worth showing; the controls stay off */ }
    res.json({ ...described, canManage });
  } catch (e) {
    console.error('[lt] read settings failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load the settings.' });
  }
});

// PATCH /api/lt/settings — change the company's configuration.
router.patch('/', requireSettingsAdmin, async (req, res) => {
  try {
    const patch = (req.body && req.body.settings) || {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return res.status(400).json({ error: 'Send the changes as an object of setting keys.' });
    }
    // A key nobody declared is REFUSED, and the answer NAMES it — a flat "invalid"
    // leaves somebody guessing which of twenty fields was wrong.
    const out = await settingsStore.save(patch, { scope: COMPANY, staffId: req.actor && req.actor.id });
    const described = await settingsStore.describe(COMPANY);
    res.json({ ok: true, ...out, ...described });
  } catch (e) {
    if (e && e.status === 400) {
      return res.status(400).json({ error: e.message, rejected: e.rejected || [] });
    }
    console.error('[lt] save settings failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save the settings.' });
  }
});

// GET /api/lt/settings/mine — a person's OWN preferences, with the company value
// shown beside each so they can see what they are departing from.
router.get('/mine', async (req, res) => {
  try {
    const staffId = req.actor && req.actor.id;
    if (!staffId) return res.status(400).json({ error: 'No signed-in person.' });

    const [mine, company] = await Promise.all([
      settingsStore.describe(userScope(staffId)),
      settingsStore.load(),
    ]);
    const settings = mine.groups
      .flatMap((g) => g.settings)
      .filter((s) => PERSONAL_KEYS.has(s.key))
      .map((s) => ({
        ...s,
        // `default` on a personal setting means the COMPANY's value, not the
        // declared one — that is what "back to the default" means to a person.
        default: company.settings[s.key],
        followsCompany: !s.isOverridden,
      }));
    res.json({ scope: userScope(staffId), settings });
  } catch (e) {
    console.error('[lt] read own settings failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load your settings.' });
  }
});

// PATCH /api/lt/settings/mine — change your own. The scope comes from the SESSION,
// so there is no id in the request that could point at somebody else.
router.patch('/mine', async (req, res) => {
  try {
    const staffId = req.actor && req.actor.id;
    if (!staffId) return res.status(400).json({ error: 'No signed-in person.' });

    const patch = (req.body && req.body.settings) || {};
    const keys = Object.keys(patch);
    const notPersonal = keys.filter((k) => !PERSONAL_KEYS.has(k));
    if (notPersonal.length) {
      // Refused rather than silently ignored: somebody who thinks they changed a
      // company setting from their own screen must be told they did not.
      return res.status(403).json({
        error: `These are company settings, not personal ones: ${notPersonal.join(', ')}. An administrator changes them.`,
        rejected: notPersonal,
      });
    }

    // keepDefault — a person choosing the value that HAPPENS to equal the declared
    // default is still a choice, and the store would otherwise delete the row and
    // silently put them back on the company's value.
    const out = await settingsStore.save(patch, { scope: userScope(staffId), staffId, keepDefault: true });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.status === 400) return res.status(400).json({ error: e.message, rejected: e.rejected || [] });
    console.error('[lt] save own settings failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save your settings.' });
  }
});

// POST /api/lt/settings/reset — put a setting back to OUR pre-filled value.
// Deliberately its own door: "set it to what it was" is a different intention from
// "set it to this value", and a person should not have to know our default to undo.
router.post('/reset', requireSettingsAdmin, async (req, res) => {
  try {
    const keys = Array.isArray((req.body || {}).keys) ? req.body.keys.map(String) : [];
    if (!keys.length) return res.status(400).json({ error: 'Which setting should go back to the default?' });

    const defaults = settingsStore.defaults();
    const unknown = keys.filter((k) => !settingsStore.isKnown(k));
    if (unknown.length) return res.status(400).json({ error: `No such setting: ${unknown.join(', ')}.` });

    // Saving the declared default DELETES the row on the company scope, which is
    // exactly what "back to ours" means — the table then holds only real deviations.
    const patch = {};
    for (const k of keys) patch[k] = defaults[k];
    const out = await settingsStore.save(patch, { scope: COMPANY, staffId: req.actor && req.actor.id });
    const described = await settingsStore.describe(COMPANY);
    res.json({ ok: true, ...out, ...described });
  } catch (e) {
    console.error('[lt] reset settings failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not reset the settings.' });
  }
});

module.exports = router;
module.exports.PERSONAL_KEYS = PERSONAL_KEYS;
