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
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * AND IT IS A WHITELIST. Every key below is NAMED. Nothing is spread off the row,
 * and that — not a filter — is what makes rule 10 structural here: a column added
 * to `lt_loans` tomorrow, an investor field, a funding channel, a buy rate, cannot
 * reach a client through this door because nobody asked for it. This is the "build
 * a client payload FOR the client" half of the rule, and a whitelist is the strong
 * form of it: a blacklist has to be right about every key that will ever exist.
 *
 * WHICH IS WHY `audience.stripInternalOnly` AND `maySeeField` ARE UNUSED IN
 * PRODUCTION, and that is deliberate rather than an oversight. They are the
 * blacklist form of the same defence, kept for a surface built from Encompass
 * FIELD IDS if one is ever needed. Running one over this payload would add nothing
 * and would say the wrong thing — that keys may be spread here so long as they are
 * filtered afterwards, which is exactly the shape this avoids. Do not "harden"
 * this by adding one; harden it by keeping the list named.
 *
 * `scrubInvestorNames` is a DIFFERENT defence and IS wired: the whitelist governs
 * which FIELDS travel, and the scrub governs free text a human typed inside one of
 * them (a program name is the realistic case).
 *
 * `test-lt-investor-block.js` runs this function over a row carrying every
 * internal field there is and fails if a single one comes out the other side.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
function shape(row, stageCfg) {
  const verdict = productTerm.classifyProduct({
    programName: row.program_name, termMonths: row.term_months,
  });
  const scrub = (v) => (v == null ? null : audience.scrubInvestorNames(String(v), 'borrower'));

  const consumer = stages.consumerStatusOf({ consumer_status: row.consumer_status });
  const ourStage = (stageCfg.stages || []).find((s) => s.key === row.stage_key);

  return {
    id: row.id,
    file: row.loan_number || '(not numbered yet)',
    status: scrub(consumer || (ourStage && ourStage.label) || null),
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

    // A LEFT JOIN, deliberately: a milestone the tenant has not published consumer
    // wording for — or one added since we last read the list — must still return
    // the loan. An INNER join would make a client's own file disappear because of
    // a gap in OUR reference data, which is the worst possible failure here.
    const { rows } = await db.query(
      `SELECT l.id, l.loan_number, l.stage_key, l.milestone_name, l.loan_amount,
              l.term_months, l.program_name, l.encompass_synced_at,
              m.consumer_status
         FROM lt_loans l
         LEFT JOIN lt_encompass_milestones m ON m.milestone_name = l.milestone_name
        WHERE l.borrower_id = $1::uuid
        ORDER BY l.encompass_synced_at DESC NULLS LAST, l.loan_number NULLS LAST`,
      [borrowerId],
    );

    // The stage list is only the FALLBACK wording, so a settings read that fails
    // must not fail the request — the consumer status is what normally answers.
    const { settings: stageSettings } = await settingsStore.load().catch(() => ({ settings: {} }));
    const stageCfg = stages.configFrom(stageSettings || {});

    // ONLY THE LONG-TERM ONES. The long-term pipeline mirrors the WHOLE Encompass
    // book — no folder separates the two products at the source — so without this
    // the switch would show a borrower their short-term files a second time, under
    // a heading saying they are long-term. The rule is `product-term.js`, the same
    // one the staff census reads, so the two can never disagree about a file.
    const loans = rows.map((r) => shape(r, stageCfg)).filter((r) => r.product === productTerm.PRODUCT.LONG);

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

/**
 * `shape` is exported so the investor-block suite can RUN it over a row carrying
 * every internal field there is and check what comes out, rather than reading this
 * file and hoping. It is the client payload's whole defence — see the note on the
 * function — and a defence nothing exercises is a defence nobody has seen work.
 */
module.exports._internals = { shape };
