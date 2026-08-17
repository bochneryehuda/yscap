'use strict';

// HTTP for the long-term loan sync. Mounted at /api/lt/sync by
// src/longterm/index.js. Staff authentication is applied at the mount seam in
// src/server.js, so this router imports no RTL auth code.
//
// Running a sync is ADMIN-ONLY — it is a bounded but real burst of Encompass reads,
// and the freshness of the whole long-term book depends on it. Reading the sync's
// STATE is open to any staff member: "why does this file look old?" is a question an
// officer must be able to answer without asking somebody.
//
// ENCOMPASS STAYS ONE-WAY. Every call this triggers is a read.

const express = require('express');
const router = express.Router();

const loanSync = require('../sync/loans');
const conditionSync = require('../conditions/sync');
const access = require('../access');
const settingsStore = require('../settings/store');
const db = require('../db');

async function requireSyncAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({ error: 'Only an administrator can run the long-term sync.' });
    }
    return next();
  } catch (e) {
    console.error('[lt] sync admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

// GET /api/lt/sync — how fresh the book is, and what is failing.
router.get('/', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS loans,
              count(*) FILTER (WHERE encompass_synced_at IS NOT NULL)::int AS read_at_least_once,
              count(*) FILTER (WHERE encompass_sync_error IS NOT NULL)::int AS failing,
              max(encompass_synced_at) AS last_synced_at,
              min(encompass_synced_at) FILTER (WHERE encompass_synced_at IS NOT NULL) AS oldest_synced_at
         FROM lt_loans`,
    );
    // Name what is failing rather than only counting it — a count sends somebody
    // hunting, and the reason is already stored on the loan.
    const { rows: failing } = await db.query(
      `SELECT loan_number, encompass_loan_guid, encompass_sync_error, updated_at
         FROM lt_loans
        WHERE encompass_sync_error IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 20`,
    );
    // How fresh the CONDITION CENTRE is, on the same screen and for the same
    // reason: a condition list is only as trustworthy as its last read, and
    // "why does this centre look empty?" has to be answerable without asking
    // somebody. Reported even while the feature is off — an all-zero row plus
    // the switch state is the honest answer, and hiding it would leave the
    // owner unable to tell "nothing to read" from "nothing ever read it".
    const { rows: cond } = await db.query(
      `SELECT count(*) FILTER (WHERE conditions_synced_at IS NOT NULL)::int AS loans_read,
              count(*) FILTER (WHERE conditions_sync_error IS NOT NULL
                                  OR documents_sync_error IS NOT NULL)::int AS failing,
              max(GREATEST(conditions_synced_at, documents_synced_at)) AS last_synced_at
         FROM lt_loans`,
    );
    const { rows: mirrored } = await db.query(
      `SELECT (SELECT count(*) FROM lt_conditions WHERE is_removed = false)::int AS conditions,
              (SELECT count(*) FROM lt_documents  WHERE is_removed = false)::int AS documents`,
    );

    let canRun = false;
    let conditionsEnabled = false;
    try {
      const { settings } = await settingsStore.load();
      canRun = access.mayManagePeople(req.actor, settings);
      conditionsEnabled = settings['conditions.enabled'] === true;
    } catch (_) { /* the figures are still worth showing; the button simply stays off */ }
    res.json({
      ...rows[0],
      failing,
      canRun,
      conditions: { enabled: conditionsEnabled, ...cond[0], ...mirrored[0] },
    });
  } catch (e) {
    console.error('[lt] sync state failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the sync state.' });
  }
});

// POST /api/lt/sync — one pass: discover everything, then fully read what moved.
router.post('/', requireSyncAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const budget = Number(body.readBudget);
    const out = await loanSync.syncOnce({
      // A caller may ask for a smaller pass; it may not ask for an unbounded one.
      readBudget: Number.isFinite(budget) && budget > 0
        ? Math.min(Math.floor(budget), 200)
        : loanSync.DEFAULT_READ_BUDGET,
      loanFolder: body.loanFolder ? String(body.loanFolder) : null,
    });
    if (!out.ok) return res.status(502).json({ error: out.reason });

    // THE CONDITION CENTRE RIDES THE SAME PASS. Refreshing the book and
    // refreshing what each loan is waiting on are one job to the person pressing
    // the button, and a mirror nothing ever calls is a mirror that stays empty —
    // which is exactly how the read side shipped able to answer only "nothing".
    //
    // BEST-EFFORT, ALWAYS: it is bounded by its OWN budget, it refuses politely
    // while `conditions.enabled` is off (so this call is safe on every
    // deployment as it stands), and its failure is REPORTED beside the loan
    // pass rather than replacing it. Reading conditions is a READ of Encompass;
    // nothing here writes to Encompass.
    let conditions = null;
    try {
      conditions = await conditionSync.syncOnce({});
    } catch (e) {
      conditions = { ok: false, reason: (e && e.message) || String(e) };
    }

    res.json({ ...out, conditions });
  } catch (e) {
    console.error('[lt] sync failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not run the sync.' });
  }
});

/**
 * POST /api/lt/sync/conditions — the Condition Centre's own pass, on its own.
 *
 * The whole-book sync above already runs it, so this is for reading the centre
 * again WITHOUT re-reading every loan: the switch was just turned on, a loan's
 * last read failed, or somebody wants the newest conditions on a busy file.
 *
 * A refusal (the feature is off, Encompass is not connected) is a 200 carrying
 * its own reason — it is a state of the configuration, not a fault, and a 502
 * would send the screen down its "something is broken" path for a deliberate
 * setting.
 */
router.post('/conditions', requireSyncAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const budget = Number(body.readBudget);
    const out = await conditionSync.syncOnce({
      // A caller may ask for a smaller pass; it may not ask for an unbounded one.
      readBudget: Number.isFinite(budget) && budget > 0
        ? Math.min(Math.floor(budget), 200)
        : conditionSync.DEFAULT_READ_BUDGET,
      // Handed through RAW. `refreshHoursFor` is the one definition of what an
      // age means — 0 is "re-read everything now", which is the point of asking
      // for this pass by hand, and junk falls back to the ordinary refresh age.
      // Deciding it a second time here is how the button and the sweep drift.
      refreshHours: body.refreshHours,
    });
    res.json(out);
  } catch (e) {
    console.error('[lt] condition sync failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the conditions.' });
  }
});

module.exports = router;
