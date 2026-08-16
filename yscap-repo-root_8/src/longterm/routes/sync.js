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
    let canRun = false;
    try {
      const { settings } = await settingsStore.load();
      canRun = access.mayManagePeople(req.actor, settings);
    } catch (_) { /* the figures are still worth showing; the button simply stays off */ }
    res.json({ ...rows[0], failing, canRun });
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
    res.json(out);
  } catch (e) {
    console.error('[lt] sync failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not run the sync.' });
  }
});

module.exports = router;
