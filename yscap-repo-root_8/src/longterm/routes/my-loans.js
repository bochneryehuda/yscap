'use strict';

// THE BORROWER'S OWN LONG-TERM FILES — the client-facing half of the owner's
// switch. Mounted at /api/lt/my by src/server.js, BORROWER-authenticated at that
// mount (the /api/lt router beside it is staff-only, which is why this needs its
// own seam rather than a route inside it).
//
// It is still Long-Term's own code, under /api/lt/*, in src/longterm/** — the
// charter's namespace rules hold; only the authentication differs.
//
// BUILT READY, SWITCHED OFF (owner-directed 2026-08-16, "build it ready"). With
// `borrower.longTermVisible` off — the default, and the state it ships in — this
// answers `{enabled:false, loans:[]}` and the portal renders no switch at all. It
// deliberately answers 200 rather than 404: the front end has to be able to tell
// "this is off" from "this is broken", and the owner turning it on must be one
// setting rather than a deploy.
//
// A BORROWER SEES ONLY WHAT A HUMAN CONFIRMED IS THEIRS. The list is keyed on
// `lt_loans.borrower_id`, which is written only by an admin confirming a link
// (`borrower-links.js`). An unmatched loan belongs to nobody and appears to
// nobody — the safe direction, and the reason the mapping is confirm-and-not-guess
// in the first place.
//
// THE INVESTOR NAME NEVER REACHES A CLIENT — the hard rule (charter §10). Nothing
// investor-related is selected here at all, and every free-text field that could
// carry a spelling of one goes through the shared scrub on the way out. Building
// the payload FOR the client rather than filtering one built for staff is the
// first of the two defences that rule names.

const express = require('express');
const router = express.Router();

const db = require('../db');
const audience = require('../audience');
const productTerm = require('../product-term');
const settingsStore = require('../settings/store');

/** Is the borrower-facing long-term side switched on? Fails CLOSED. */
async function longTermVisible() {
  try {
    const { settings } = await settingsStore.load();
    return settings['borrower.longTermVisible'] === true;
  } catch (e) {
    // A settings read that fails is not permission to show a client an unfinished
    // product. Off is the safe answer and the one it ships in.
    console.error('[lt] borrower long-term visibility check failed:', (e && e.message) || e);
    return false;
  }
}

/** Everything the client is allowed to know about one of their long-term files. */
function shape(row) {
  const verdict = productTerm.classifyProduct({
    programName: row.program_name, termMonths: row.term_months,
  });
  const scrub = (v) => (v == null ? null : audience.scrubInvestorNames(String(v), 'borrower'));
  return {
    id: row.id,
    file: row.loan_number || '(not numbered yet)',
    // Encompass's own words for where the file is. They name a stage of OUR
    // process, not a buyer, and they are what the borrower is asking about when
    // they ask "where is my loan up to".
    status: scrub(row.stage_key),
    milestone: scrub(row.milestone_name),
    loanAmount: row.loan_amount == null ? null : Number(row.loan_amount),
    termMonths: verdict.termMonths,
    // The program is shown SCRUBBED. A long-term program name is ordinarily
    // descriptive ("Investor DSCR 30 YEAR FRM"), but it is free text a human typed
    // and the one place an investor's name could ride along.
    programName: scrub(verdict.programName),
    product: verdict.product,
    updatedAt: row.encompass_synced_at || null,
  };
}

// GET /api/lt/my/loans — the signed-in borrower's own long-term files.
router.get('/loans', async (req, res) => {
  try {
    const enabled = await longTermVisible();
    if (!enabled) {
      // Off is a state, not a failure. Saying so plainly is what lets the portal
      // hide the switch instead of showing an error to a client.
      return res.json({ enabled: false, loans: [], counts: { longTerm: 0, total: 0 } });
    }

    const borrowerId = req.actor && req.actor.id;
    if (!borrowerId) return res.status(401).json({ error: 'Please sign in again.' });

    const { rows } = await db.query(
      `SELECT id, loan_number, stage_key, milestone_name, loan_amount,
              term_months, program_name, encompass_synced_at
         FROM lt_loans
        WHERE borrower_id = $1::uuid
        ORDER BY encompass_synced_at DESC NULLS LAST, loan_number NULLS LAST`,
      [borrowerId],
    );

    // ONLY THE LONG-TERM ONES. The long-term pipeline mirrors the WHOLE Encompass
    // book — no folder separates the two products at the source — so without this
    // the switch would show a borrower their short-term files a second time, under
    // a heading saying they are long-term. The rule is `product-term.js`, the same
    // one the staff census reads, so the two can never disagree about a file.
    const loans = rows.map(shape).filter((r) => r.product === productTerm.PRODUCT.LONG);

    res.json({
      enabled: true,
      loans,
      counts: { longTerm: loans.length, total: rows.length },
    });
  } catch (e) {
    console.error('[lt] borrower long-term loans failed:', (e && e.message) || e);
    res.status(500).json({ error: 'We could not load your long-term files just now.' });
  }
});

module.exports = router;
