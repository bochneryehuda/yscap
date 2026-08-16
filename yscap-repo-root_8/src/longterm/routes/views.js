'use strict';

// HTTP for saved pipeline views. Mounted at /api/lt/views; staff authentication is
// applied at the mount seam in src/server.js, so this router imports no RTL code.
//
// A VIEW CANNOT WIDEN WHAT SOMEBODY SEES. Its filters are appended to the viewer's
// own scope inside the pipeline query, every time — never substituted for it — so a
// SHARED view built by an administrator who sees the whole book shows an officer
// exactly their own files. That is why a shared view is safe to offer, and it is a
// property of where the scope is applied rather than of anything checked here.
//
// A PERSONAL view is anybody's to make: it is their own arrangement of their own
// screen. A SHARED one is an administrator's, because it appears on every colleague's
// screen and a name on somebody else's list is a small piece of authority.

const express = require('express');
const router = express.Router();

const views = require('../views');
const access = require('../access');
const settingsStore = require('../settings/store');

const staffId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);

async function canShare(req) {
  try {
    const { settings } = await settingsStore.load();
    return access.mayManagePeople(req.actor, settings);
  } catch (_) {
    // The gate failing is not permission to pass it.
    return false;
  }
}

// GET /api/lt/views — the views this person may use: their own, plus the shared ones.
router.get('/', async (req, res) => {
  try {
    const list = await views.listViews(staffId(req));
    res.json({ views: list, canShare: await canShare(req) });
  } catch (e) {
    console.error('[lt] list views failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load your saved views.' });
  }
});

// POST /api/lt/views — save one. `shared` is refused rather than downgraded: somebody
// who meant to give the whole team a view must be told they did not.
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const shared = body.shared === true;
    if (shared && !(await canShare(req))) {
      return res.status(403).json({ error: 'Only an administrator can save a view for everybody. Save it for yourself instead.' });
    }
    const out = await views.saveView({
      staffId: staffId(req),
      name: body.name,
      filters: body.filters,
      shared,
      isDefault: body.isDefault === true,
      id: body.id ? String(body.id) : null,
    });
    if (!out.ok) return res.status(400).json({ error: out.reason });
    // `dropped` NAMES any filter that was not stored, so a view can never quietly
    // show a different book from the one its name promises.
    res.json({ ok: true, id: out.id, filters: out.filters, dropped: out.dropped || [] });
  } catch (e) {
    console.error('[lt] save view failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that view.' });
  }
});

// DELETE /api/lt/views/:id
router.delete('/:id', async (req, res) => {
  try {
    const out = await views.deleteView(String(req.params.id), staffId(req), { allowShared: await canShare(req) });
    if (!out.ok) return res.status(404).json({ error: 'That view is not yours to remove.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt] delete view failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not remove that view.' });
  }
});

module.exports = router;
