'use strict';

// HTTP for the Pricing Engine's saved INVESTOR GROUPS (db/634, owner-directed
// 2026-08-27). Mounted at /api/lt/dscr/investor-groups on the STAFF router only
// — deliberately NOT part of dscr-pricer's makeRouter, which is also mounted on
// the secret-gated diagnostics seam where there is no signed-in person: a group
// is somebody's own arrangement of their own screen, so every door here needs
// an actor, and the diagnostics surface stays exactly what it was.
//
// ⛔ A GROUP IS A DISPLAY OVERLAY, NEVER A SEARCH INPUT. Nothing here touches
// what is asked of Lender Price — these routes store and list named sets of
// canonical investor keys, and the screen hides board rows; the vendor is
// always asked for everything (pricer-groups.js carries the whole rule).

const express = require('express');
const router = express.Router();

const groups = require('../pricer-groups');

router.use(express.json({ limit: '64kb' }));

const staffId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);

// GET /api/lt/dscr/investor-groups — this person's own groups.
router.get('/', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in to use saved investor groups.' });
    res.json({ groups: await groups.listGroups(staffId(req)) });
  } catch (e) {
    console.error('[lt] list investor groups failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load your investor groups.' });
  }
});

// POST /api/lt/dscr/investor-groups — save one (same name = edit it).
// `dropped` NAMES any key that was refused, so a group can never quietly hold
// a different set from the one its maker picked.
router.post('/', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in to save an investor group.' });
    const body = req.body || {};
    const out = await groups.saveGroup({
      staffId: staffId(req),
      name: body.name,
      investors: body.investors,
    });
    if (!out.ok) return res.status(400).json({ error: out.reason });
    res.json({ ok: true, id: out.id, name: out.name, investors: out.investors, dropped: out.dropped || [] });
  } catch (e) {
    console.error('[lt] save investor group failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that group.' });
  }
});

// DELETE /api/lt/dscr/investor-groups/:id
router.delete('/:id', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in first.' });
    const out = await groups.deleteGroup(String(req.params.id), staffId(req));
    if (!out.ok) return res.status(404).json({ error: 'That group is not yours to remove.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt] delete investor group failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not remove that group.' });
  }
});

module.exports = router;
