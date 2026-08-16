'use strict';

// HTTP for the long-term people map — who each Encompass login is in PILOT.
// Mounted at /api/lt/people by src/longterm/index.js. Staff authentication is
// applied at the mount seam in src/server.js (like the /api/admin routers), so this
// router imports no RTL auth code.
//
// READING the map is open to any staff member: it is a company directory, and an
// officer wondering why their pipeline is empty must be able to see that nobody has
// linked their account yet. CHANGING it is admin-only (`access.mayManagePeople`,
// settings-driven) — a confirmed link decides whose files are whose.
//
// ENCOMPASS STAYS ONE-WAY. The only outbound call any of this makes is the roster
// READ inside roster.syncRoster; nothing here writes to Encompass.

const express = require('express');
const router = express.Router();

const roster = require('../people/roster');
const links = require('../people/links');
const access = require('../access');
const settingsStore = require('../settings/store');

/** Admin gate. Answers in plain words rather than a bare 403 — the reader may be the
 *  officer this screen exists to explain things to. */
async function requirePeopleAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({
        error: 'Only an administrator can change who an Encompass user is in PILOT.',
      });
    }
    return next();
  } catch (e) {
    // The gate itself failing is not permission to pass it.
    console.error('[lt] people admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

/** One place that turns a thrown refusal into its own status + wording. */
function fail(res, e, fallback) {
  if (e && e.status && e.plain) return res.status(e.status).json({ error: e.plain });
  console.error(`[lt] ${fallback}:`, (e && e.message) || e);
  return res.status(500).json({ error: fallback });
}

// GET /api/lt/people — every Encompass user, its link, and why an unlinked one is
// unlinked. Any staff member may read it.
router.get('/', async (req, res) => {
  try {
    const out = await roster.listPeople();
    let canManage = false;
    try {
      const { settings } = await settingsStore.load();
      canManage = access.mayManagePeople(req.actor, settings);
    } catch (_) { /* the list is still worth showing; the buttons simply stay off */ }
    res.json({ ...out, canManage });
  } catch (e) {
    fail(res, e, 'Could not load the people map.');
  }
});

// POST /api/lt/people/sync — read the Encompass roster and refresh the proposals.
// READ-ONLY against Encompass.
router.post('/sync', requirePeopleAdmin, async (req, res) => {
  try {
    const out = await roster.syncRoster();
    if (!out.ok) return res.status(502).json({ error: out.reason });
    res.json(out);
  } catch (e) {
    fail(res, e, 'Could not sync the Encompass roster.');
  }
});

// POST /api/lt/people/:loginId/confirm — "yes, this is that person".
router.post('/:loginId/confirm', requirePeopleAdmin, async (req, res) => {
  try {
    const link = await links.confirmLink(req.params.loginId, (req.body || {}).staffId, req.actor && req.actor.id);
    res.json({ ok: true, link });
  } catch (e) {
    fail(res, e, 'Could not confirm that link.');
  }
});

// POST /api/lt/people/:loginId/reject — "no, that is not them". Never re-proposed.
router.post('/:loginId/reject', requirePeopleAdmin, async (req, res) => {
  try {
    const link = await links.rejectLink(req.params.loginId, req.actor && req.actor.id);
    res.json({ ok: true, link });
  } catch (e) {
    fail(res, e, 'Could not record that.');
  }
});

// DELETE /api/lt/people/:loginId/link — undo a decision entirely; the login becomes
// unlinked and proposable again. The way out of a wrong confirm.
router.delete('/:loginId/link', requirePeopleAdmin, async (req, res) => {
  try {
    const out = await links.unlink(req.params.loginId);
    res.json({ ok: true, ...out });
  } catch (e) {
    fail(res, e, 'Could not undo that link.');
  }
});

module.exports = router;
