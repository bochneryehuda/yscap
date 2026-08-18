'use strict';
/**
 * LONG-TERM — the Condition Center's read routes.
 *
 * READ-ONLY IN BOTH DIRECTIONS. Nothing here writes to Encompass (the eFolder
 * upload is a WRITE and stays blocked on docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md),
 * and nothing here writes to our own tables either — the mirror is filled by the
 * sync. There is deliberately no POST, no PATCH and no DELETE in this file.
 *
 * TWO GATES, IN THIS ORDER, and the order matters:
 *
 *   1. THE FEATURE SWITCH. `conditions.enabled` is off by default, so on every
 *      deployment as it stands these routes answer "coming soon" rather than
 *      data — which is what makes the screen's placeholder honest instead of a
 *      lie told by a screen while the data flows anyway.
 *   2. THE FILE SCOPE. `access.mayOpenLoan` — the SAME predicate the pipeline and
 *      the workspace use, so a viewer can never reach a loan's conditions by a
 *      route that forgot the rule. A loan the viewer may not open answers 404,
 *      NOT 403: telling somebody a file exists but is not theirs is itself a
 *      disclosure about the book.
 *
 * THE INVESTOR NAME NEVER REACHES A CLIENT: the audience is resolved from the
 * SESSION, never from the request, and passed to the reader, which runs every
 * client-bound string through the one shared scrub.
 */

const express = require('express');
const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const read = require('../conditions/read');

const router = express.Router();

/**
 * Resolve the loan, the viewer's right to open it, AND THE SETTINGS IT WAS
 * DECIDED ON.
 *
 * Returns null after answering, so every handler reads as
 * `const opened = await openable(req,res); if (!opened) return;`
 *
 * THE SETTINGS COME BACK WITH THE LOAN, and that is the whole point of the shape.
 * This used to return the loan alone, and two of the three handlers below went on
 * to pass a bare `settings` to their reader — a free variable that existed only
 * inside THIS function. Every request for the centre and for the eFolder needs
 * list threw a ReferenceError into its own catch and answered 500. It was never
 * seen because the Condition Center ships switched OFF, so the two dead doors were
 * only reachable by the one tenant setting nobody had turned on yet.
 *
 * Handing them back means a handler cannot ask for the settings without having
 * them, which is a different kind of safety from remembering to load them twice.
 */
async function openable(req, res) {
  const { settings } = await settingsStore.load();

  if (settings['conditions.enabled'] !== true) {
    // 200 with a plain state, not an error: this is a switched-off feature, and a
    // 404 here would send the screen down its "something is broken" path for a
    // deliberate configuration.
    res.json({ enabled: false, why: 'The Condition Center is coming soon.' });
    return null;
  }

  const { rows } = await db.query(
    'SELECT id, loan_number FROM lt_loans WHERE id = $1::uuid',
    [String(req.params.loanId)],
  );
  if (!rows.length) { res.status(404).json({ error: 'No such long-term loan.' }); return null; }

  const { rows: team } = await db.query(
    'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid', [rows[0].id],
  );
  const viewer = access.accessFor(req.actor, settings);
  if (!access.mayOpenLoan(viewer, req.actor && req.actor.id, team)) {
    res.status(404).json({ error: 'No such long-term loan.' });
    return null;
  }
  return { loan: rows[0], settings };
}

/** The whole centre for one loan: conditions, the eFolder needs list, freshness. */
router.get('/:loanId', async (req, res) => {
  try {
    const opened = await openable(req, res);
    if (!opened) return;
    const { loan, settings } = opened;
    const center = await read.centerForLoan(loan.id, { audience: 'internal', settings });
    res.json({ enabled: true, loanId: loan.id, loanNumber: loan.loan_number, ...center });
  } catch (e) {
    console.error('[lt-conditions] read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'server error' });
  }
});

/** The conditions alone — the same data, for a screen that only wants that half. */
router.get('/:loanId/conditions', async (req, res) => {
  try {
    const opened = await openable(req, res);
    if (!opened) return;
    const { loan } = opened;
    const out = await read.conditionsForLoan(loan.id, { audience: 'internal' });
    res.json({ enabled: true, items: out.items, open: out.open, total: out.total });
  } catch (e) {
    console.error('[lt-conditions] conditions read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'server error' });
  }
});

/** The eFolder needs list alone. */
router.get('/:loanId/documents', async (req, res) => {
  try {
    const opened = await openable(req, res);
    if (!opened) return;
    const { loan, settings } = opened;
    const out = await read.documentsForLoan(loan.id, { audience: 'internal', settings });
    res.json({ enabled: true, items: out.items, outstanding: out.outstanding, total: out.total });
  } catch (e) {
    console.error('[lt-conditions] documents read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
