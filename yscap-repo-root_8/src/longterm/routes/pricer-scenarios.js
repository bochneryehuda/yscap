'use strict';

// HTTP for the Pricing Engine's SAVED SCENARIOS (db/658, owner-directed
// 2026-08-31). Mounted at /api/lt/dscr/scenarios on the STAFF router only —
// deliberately NOT part of dscr-pricer's makeRouter, which is also mounted on
// the secret-gated diagnostics seam where there is no signed-in person. A
// scenario belongs to ONE person (SAVED-SCENARIOS-RESEARCH.md D2), so every
// door here needs an actor and the diagnostics surface stays what it was.
//
// ⛔ A SCENARIO IS INPUTS, NEVER A PRICE. Nothing here asks Lender Price
// anything and nothing here holds a pricing rule: the screen re-runs a saved
// scenario through the SAME /api/lt/dscr/price door the pricing engine uses.
// The one stored figure is `savedBoard`, a DATED headline used only to say what
// has MOVED since (D4) — `pricer-scenarios.js` carries the whole rule.

const express = require('express');
const router = express.Router();

const scenarios = require('../pricer-scenarios');

router.use(express.json({ limit: '64kb' }));

const staffId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);

// GET /api/lt/dscr/scenarios — this person's own scenarios, newest first.
router.get('/', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in to use saved scenarios.' });
    res.json({ scenarios: await scenarios.listScenarios(staffId(req)) });
  } catch (e) {
    console.error('[lt] list scenarios failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not load your scenarios.' });
  }
});

// GET /api/lt/dscr/scenarios/:id — one scenario, to re-open or re-run it.
// A scenario that is not this person's is a 404, never a 403: whether somebody
// else's scenario exists is not this person's business.
router.get('/:id', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in to use saved scenarios.' });
    const row = await scenarios.getScenario(String(req.params.id), staffId(req));
    if (!row) return res.status(404).json({ error: 'That scenario is not yours.' });
    res.json({ scenario: row });
  } catch (e) {
    console.error('[lt] read scenario failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not open that scenario.' });
  }
});

// POST /api/lt/dscr/scenarios — save a NEW one.
//
// ⛔ ALWAYS A NEW ROW, never an upsert on the name (unlike an investor group):
// two searches on one property at different leverage are two scenarios somebody
// wants BOTH of, and quietly overwriting the first would lose work nobody asked
// to lose. Renaming and re-saving an existing one is the PATCH below.
router.post('/', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in to save a scenario.' });
    const body = req.body || {};
    const out = await scenarios.saveScenario({
      staffId: staffId(req),
      name: body.name,
      borrowerName: body.borrowerName,
      entityName: body.entityName,
      propertyAddress: body.propertyAddress,
      form: body.form,
      scenario: body.scenario,
      calc: body.calc,
      savedBoard: body.savedBoard,
    });
    if (!out.ok) return res.status(400).json({ error: out.reason });
    res.json({ ok: true, scenario: out.scenario });
  } catch (e) {
    console.error('[lt] save scenario failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that scenario.' });
  }
});

// PATCH /api/lt/dscr/scenarios/:id — rename it, or re-save what it holds.
//
// ⛔ ONLY THE FIELDS THAT WERE SENT MOVE. A rename must not blank the deal and a
// re-save must not blank the name, so the keys are forwarded by PRESENCE
// (hasOwnProperty), never by truthiness — an explicitly cleared borrower name is
// a person clearing it, and an absent one is a person not mentioning it.
router.patch('/:id', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in first.' });
    const body = req.body || {};
    const patch = {};
    for (const k of ['name', 'borrowerName', 'entityName', 'propertyAddress',
      'form', 'scenario', 'calc', 'savedBoard']) {
      if (Object.prototype.hasOwnProperty.call(body, k)) patch[k] = body[k];
    }
    const out = await scenarios.updateScenario(String(req.params.id), staffId(req), patch);
    if (!out.ok) {
      // "Not yours" is the only reason that is about the ROW rather than about
      // what was asked for, and it answers 404 for the same reason the read does.
      const notMine = /not yours/i.test(String(out.reason || ''));
      return res.status(notMine ? 404 : 400).json({ error: out.reason });
    }
    res.json({ ok: true, scenario: out.scenario });
  } catch (e) {
    console.error('[lt] update scenario failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that change.' });
  }
});

// DELETE /api/lt/dscr/scenarios/:id — a person removing their own scenario.
// SOFT (the row keeps its `deleted_at`), and this press is the ONLY thing in the
// system that sets it: the owner asked that a list never age out on a timer (D5).
router.delete('/:id', async (req, res) => {
  try {
    if (!staffId(req)) return res.status(401).json({ error: 'Sign in first.' });
    const out = await scenarios.deleteScenario(String(req.params.id), staffId(req));
    if (!out.ok) return res.status(404).json({ error: 'That scenario is not yours to remove.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt] delete scenario failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not remove that scenario.' });
  }
});

module.exports = router;
