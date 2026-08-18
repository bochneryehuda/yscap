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
// THE INVESTOR NAME NEVER REACHES A CLIENT — the hard rule (charter §10), and
// BOTH of the defences that rule names are wired here:
//
//   (a) DON'T SEND IT. The payload is built FOR the client by `client-view.js`,
//       which asks `audience.maySeeField` / `audience.internalOnlyColumns` about
//       every field before it assembles one and runs `audience.stripInternalOnly`
//       over the finished object. The SELECT below is checked at load time by
//       `clientView.assertNoInternalColumns`, so a join that reaches
//       `lt_loan_investors` cannot start the server.
//   (b) SCRUB FREE TEXT. Every free-text field a human may have typed goes
//       through `audience.scrubInvestorNames` on the way out — the SECOND
//       defence, not a replacement for the first.
//
// The audience is DERIVED from the signed-in actor (`audience.audienceOfActor`),
// never hard-coded: this route is mounted borrower-only today, and a broker
// surface added tomorrow is a client by the same rule with nothing to remember.
// Anything that is not exactly our own staff is a client — it fails closed.

const express = require('express');
const router = express.Router();

const db = require('../db');
const audience = require('../audience');
const clientView = require('../client-view');
const productTerm = require('../product-term');
const settingsStore = require('../settings/store');
const stages = require('../stages');

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

/**
 * Everything the client is allowed to know about one of their long-term files.
 *
 * THE WHOLE LIST lives in `client-view.js` — this adds only the row's own id,
 * which names nothing and is what the screen keys on. Building it there rather
 * than here is what lets a second client surface (a broker portal) answer with
 * exactly the same payload instead of a hand-copied one that drifts.
 *
 * THE STATUS IS THE ONE WRITTEN FOR A BORROWER, never the stored key. There are
 * three layers of wording on this side — Encompass's 19 milestones, our 9 stages,
 * and the tenant's own consumer wording per milestone (`consumer_status`, db/547) —
 * and only the third was written to be read by a client: it turns "Started" into
 * "Collecting Information" and every milestone from Doc Signing onward into
 * "Funded". `stages.consumerStatusOf` is the ONE definition of that layer, so this
 * screen and anything else client-facing can never word one milestone two ways.
 *
 * It falls back to our stage's LABEL and never to `stage_key`: printing
 * `clear_to_close` at a borrower is showing them a database value. With neither, it
 * says NOTHING — a status invented for a client is worse than a blank one.
 */
function shape(row, stageCfg, aud) {
  return { id: row.id, ...clientView.buildLoanView(row, { stageCfg }, aud) };
}

// The one query behind this route. Held as a constant so the load-time guard below
// can read it: the FIRST defence is "don't select the column", and a constant is
// what makes that a property of the code rather than a habit.
//
// A LEFT JOIN, deliberately: a milestone the tenant has not published consumer
// wording for — or one added since we last read the list — must still return the
// loan. An INNER join would make a client's own file disappear because of a gap in
// OUR reference data, which is the worst possible failure here.
const LOANS_SQL = `SELECT l.id, l.loan_number, l.stage_key, l.milestone_name, l.loan_amount,
              l.term_months, l.program_name, l.encompass_synced_at,
              m.consumer_status
         FROM lt_loans l
         LEFT JOIN lt_encompass_milestones m ON m.milestone_name = l.milestone_name
        WHERE l.borrower_id = $1::uuid
        ORDER BY l.encompass_synced_at DESC NULLS LAST, l.loan_number NULLS LAST`;

// Refused at load time, loudly, so a client query can never reach a running server
// carrying an investor column. Deterministic: the SQL is a constant, so this either
// always throws or never does.
clientView.assertNoInternalColumns(LOANS_SQL, 'GET /api/lt/my/loans');

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

    // WHO IS ASKING. Derived, never assumed: a borrower and a broker are both
    // CLIENTS and anything unrecognised is a client too, because `audience.js`
    // fails closed. Our own staff — who may see an investor — cannot reach this
    // route at all (the mount is borrower-only), so on this surface this only ever
    // resolves to a client today; it is written this way so the answer stays
    // correct the day a second client door is opened.
    const aud = audience.audienceOfActor(req.actor);

    const { rows } = await db.query(LOANS_SQL, [borrowerId]);

    // The stage list is only the FALLBACK wording, so a settings read that fails
    // must not fail the request — the consumer status is what normally answers.
    const { settings: stageSettings } = await settingsStore.load().catch(() => ({ settings: {} }));
    const stageCfg = stages.configFrom(stageSettings || {});

    // ONLY THE LONG-TERM ONES. The long-term pipeline mirrors the WHOLE Encompass
    // book — no folder separates the two products at the source — so without this
    // the switch would show a borrower their short-term files a second time, under
    // a heading saying they are long-term. The rule is `product-term.js`, the same
    // one the staff census reads, so the two can never disagree about a file.
    //
    // It is asked of the ROW, not of the client's view of it: which product a file
    // belongs to is a fact about the loan, and reading it off a payload the guard
    // may have narrowed would make the filter depend on what the client is allowed
    // to see — two unrelated rules, tangled.
    const loans = rows
      .filter((r) => productTerm.isLongTerm({ programName: r.program_name, termMonths: r.term_months }))
      .map((r) => shape(r, stageCfg, aud));

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
