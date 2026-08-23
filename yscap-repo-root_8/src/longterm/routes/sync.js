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
const milestoneCatalogSync = require('../sync/milestone-catalog');
const worker = require('../sync/worker');
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

    // HOW FRESH THE MILESTONE CATALOG IS, for the same reason as the conditions:
    // the stepper on every file screen is drawn from it, and a catalog nobody has
    // ever confirmed against Encompass is a different fact from one confirmed this
    // morning. `live` says how many rows a real read has touched — with none, the
    // whole catalog is still db/547's 2026-08-14 photograph, which is worth
    // knowing before somebody wonders why a new step is missing.
    const { rows: cat } = await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE COALESCE(is_archived, false) = false)::int AS live_steps,
              count(*) FILTER (WHERE catalog_source = 'live')::int AS live,
              max(catalog_synced_at) AS last_synced_at
         FROM lt_encompass_milestones`,
    ).catch(() => ({ rows: [{}] }));

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
      milestoneCatalog: cat[0] || {},
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

    // The tenant's own milestone catalog rides along too, and skips itself unless
    // a day has passed — so pressing the button costs its twenty reads at most
    // once a day. It is what stops a step a buyer added from blanking the
    // progress bar on every file sitting at it. Best-effort, like the conditions.
    let milestoneCatalog = null;
    try {
      milestoneCatalog = await milestoneCatalogSync.refreshOnce({});
    } catch (e) {
      milestoneCatalog = { ok: false, reason: (e && e.message) || String(e) };
    }

    res.json({ ...out, conditions, milestoneCatalog });
  } catch (e) {
    console.error('[lt] sync failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not run the sync.' });
  }
});

/**
 * POST /api/lt/sync/pull — PULL EVERYTHING FROM ENCOMPASS, NOW.
 *
 * Owner-directed 2026-08-23: *"Add, for the super admin, a syncing button. Like we
 * have 'pull from click up', you should have a button to pull from Encompass as well.
 * That should trigger it right away."*
 *
 * WHY THIS IS NOT THE BUTTON THAT ALREADY EXISTED. `POST /` runs ONE pass — 25 loans
 * — which is right for "refresh what moved" and is the wrong answer entirely for
 * somebody who has just been told the book is empty: they would press it, watch 25 of
 * 772 files arrive, and reasonably conclude it was broken. This runs the SAME drain
 * the background worker runs (`worker.tickOnce`), which keeps calling until the book
 * is caught up or its budget is spent, and brings the conditions and the milestone
 * catalog with it.
 *
 * IT ANSWERS IMMEDIATELY AND WORKS IN THE BACKGROUND, and that is a correctness
 * requirement rather than a nicety: a full drain is bounded at TEN MINUTES, and no
 * browser, proxy or load balancer between here and the user will hold a request open
 * that long. Waiting would give them a timeout on a pull that is in fact running
 * perfectly — the worst possible reading. So the answer is "started", and the Sync
 * screen's own state query is what shows the numbers climbing.
 *
 * IT CANNOT STACK. `tickOnce` refuses while a pass is already running (its own
 * `running` flag), so a second press — or a press that lands while the 20-minute
 * timer is mid-pass — is a no-op that says so rather than a second sweep of the
 * tenant's shared API budget.
 *
 * ENCOMPASS STAYS ONE-WAY: every call this schedules is a read.
 */
router.post('/pull', requireSyncAdmin, async (req, res) => {
  // Answer first, then work. Nothing after this line may reach the response.
  res.json({
    started: true,
    note: 'Pulling from Encompass now. This runs in the background and works through the whole book — '
      + 'refresh this screen in a minute or two to watch the count climb.',
  });
  setImmediate(() => {
    worker.tickOnce().catch((e) => {
      // The pass reports its own failures on the loans themselves and in the log;
      // this catch exists only so a rejection can never take the process down.
      console.error('[lt] manual Encompass pull failed:', (e && e.message) || e);
    });
  });
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
