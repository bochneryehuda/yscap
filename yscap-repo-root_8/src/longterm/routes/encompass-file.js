'use strict';
/**
 * THE ENCOMPASS SYNCING SECTION OF ONE LONG-TERM FILE (owner-directed 2026-08-25):
 * *"We need to add one more section, which would be the Encompass syncing, the same
 * way we have a ClickUp syncing. We can click it to try to read that file from
 * Encompass and see what it read and what it didn't read. You see all the details on
 * every file about the Encompass integration: the pull, the refresh, the last pull,
 * last refresh, last webhooks, and stuff like that."*
 *
 * READ-ONLY TOWARDS ENCOMPASS, ALWAYS. Nothing here writes to Encompass — the read
 * button calls `loans.readLoan`, which is a GET of the loan and its milestone
 * ladder. The Encompass read-only gate (`scripts/check-encompass-readonly.js`) is
 * what keeps that true for every module in this repo, and this one is not on the
 * write pad.
 *
 * TWO DOORS:
 *   GET  /loans/:loanId       — the whole section, from the row PILOT already holds.
 *                               Costs nothing and reaches no vendor.
 *   POST /loans/:loanId/read  — open this loan in Encompass NOW and re-read it.
 *
 * WHO MAY PRESS READ. Anybody who can open the file. It is a READ of a loan they are
 * already looking at, and gating it on administrator would put the one control that
 * un-sticks a stale file out of reach of the person staring at it. What it is
 * protected by instead is a THROTTLE (below), because the cost of a mis-click is
 * Encompass API calls rather than a wrong write.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const { loadScopedLoan } = require('./scoped-loan');
const readState = require('../read-state');
const view = require('../encompass/file-sync-view');
const killSwitch = require('../encompass/enabled');
const encClient = require('../encompass/client');
const loans = require('../sync/loans');

/** How recently a loan may have been read before the button says "it is already
 *  fresh" instead of spending another Encompass call. Short enough that a person
 *  who genuinely wants a second look gets one; long enough that a double-click,
 *  or two people on the same file, cannot hammer the vendor. */
const READ_THROTTLE_SEC = (() => {
  const n = parseInt(process.env.LT_ENCOMPASS_FILE_READ_THROTTLE_SEC || '30', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/**
 * WHY A READ CANNOT RUN, in the words that say what to change — or null when it can.
 * Asked BEFORE the work in both doors, so the screen can grey the button with the
 * reason rather than letting somebody press it and watch nothing happen.
 */
function blockedReason(loan) {
  if (!killSwitch.encompassEnabled()) return killSwitch.OFF_REASON;
  if (!encClient.configured()) {
    return 'Encompass is not connected yet — add the long-term Encompass credentials first.';
  }
  if (!loan.encompass_loan_guid) {
    return 'PILOT does not hold this loan’s Encompass id, so there is nothing to open. '
      + 'Discovery records the id when it finds the loan in the pipeline search; '
      + 'if this file was created another way it will pick one up on the next discovery pass.';
  }
  return null;
}

const switchesOf = (loan) => ({
  enabled: killSwitch.encompassEnabled(),
  configured: encClient.configured(),
  blocked: blockedReason(loan),
  throttleSec: READ_THROTTLE_SEC,
});

/** GET /api/lt/encompass-file/loans/:loanId — the section. */
router.get('/loans/:loanId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-encompass-file');
  if (!scoped) return;
  try {
    const { loan } = scoped;
    res.json(view.fileSyncView(loan, {
      readState: readState.readStateOf(loan),
      switches: switchesOf(loan),
    }));
  } catch (e) {
    console.error('[lt-encompass-file] section failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read this file’s Encompass details.' });
  }
});

/**
 * POST /api/lt/encompass-file/loans/:loanId/read — open the loan in Encompass now.
 *
 * ANSWERS WHAT IT ACTUALLY DID, never "started". This runs one loan, which takes a
 * second or two, so there is no reason to answer optimistically and leave somebody
 * refreshing a screen — that is exactly the "the button does nothing" complaint the
 * whole-book pull earned by having to work in the background.
 *
 * A REFUSAL IS A 200 CARRYING ITS REASON. Encompass switched off, not connected, no
 * id on the row: every one of those is a state of the configuration rather than a
 * fault, and a 5xx would send the screen down its "something is broken" path.
 */
router.post('/loans/:loanId/read', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-encompass-file');
  if (!scoped) return;
  const { loan, settings } = scoped;

  const blocked = blockedReason(loan);
  if (blocked) return res.json({ ok: false, read: false, reason: blocked });

  // THE THROTTLE. Deliberately reported as a success with a reason rather than a
  // refusal: nothing is wrong, the file simply already holds what a read would
  // fetch, and calling that an error would teach people to ignore real ones.
  if (READ_THROTTLE_SEC > 0 && loan.encompass_synced_at) {
    const age = Date.now() - Date.parse(loan.encompass_synced_at);
    if (Number.isFinite(age) && age >= 0 && age < READ_THROTTLE_SEC * 1000) {
      return res.json({
        ok: true,
        read: false,
        reason: `This file was read from Encompass a few seconds ago, so it is already current. `
          + `Give it ${READ_THROTTLE_SEC} seconds if you want to read it again.`,
      });
    }
  }

  let out;
  try {
    out = await loans.readLoan(loan.id, loan.encompass_loan_guid, settings);
  } catch (e) {
    // `readLoan` records its own refusals on the row and answers `{ok:false}`; this
    // catch is for the failure it cannot answer for, and it must not 500 a screen
    // whose whole job is to explain why a file is not updating.
    const why = String((e && e.message) || e).slice(0, 300);
    console.error('[lt-encompass-file] read failed:', why);
    return res.json({ ok: false, read: false, reason: `The read did not finish: ${why}` });
  }

  // RECORD THAT SOMEBODY ASKED (db/629). The read itself already stamped
  // `encompass_synced_at`; this is the separate fact — who/what prompted the look —
  // and recording a person's press beside the webhook's pings is what lets the
  // section say "last nudged: somebody pressed the button" rather than implying
  // Encompass called us. Best-effort: it may never turn a successful read into a
  // failure.
  try {
    await db.query(
      `UPDATE lt_loans
          SET encompass_nudged_at   = now(),
              encompass_nudged_via  = 'manual',
              encompass_nudge_count = COALESCE(encompass_nudge_count, 0) + 1,
              updated_at            = now()
        WHERE id = $1::uuid`, [loan.id]);
  } catch (e) {
    console.warn('[lt-encompass-file] could not record the manual read:', (e && e.message) || e);
  }

  // Re-read the row so the answer carries the file AS IT NOW STANDS — the screen
  // renders straight from this, and handing back the pre-read row would show the
  // very staleness the button just fixed.
  let fresh = loan;
  try {
    const { rows } = await db.query('SELECT * FROM lt_loans WHERE id = $1::uuid', [loan.id]);
    if (rows.length) fresh = rows[0];
  } catch (e) {
    console.warn('[lt-encompass-file] could not re-read the loan after the read:', (e && e.message) || e);
  }

  const section = view.fileSyncView(fresh, {
    readState: readState.readStateOf(fresh),
    switches: switchesOf(fresh),
  });

  if (out && out.ok === false) {
    return res.json({
      ok: false,
      read: false,
      reason: `Encompass refused the read: ${out.reason || 'no reason was given.'}`,
      section,
    });
  }

  const filled = section.fields.fullRead.filled;
  const total = section.fields.fullRead.total;
  return res.json({
    ok: true,
    read: true,
    // WHAT IT READ AND WHAT IT DID NOT, in one sentence, from the same counts the
    // table below it shows — so the note and the list can never disagree.
    reason: `Read from Encompass. ${filled} of ${total} details came back`
      + (filled < total ? ' — the rest are blank on the loan in Encompass itself.' : '.'),
    section,
  });
});

module.exports = router;
module.exports._internals = { blockedReason, switchesOf, READ_THROTTLE_SEC };
