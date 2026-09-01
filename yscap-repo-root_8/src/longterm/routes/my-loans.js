'use strict';

// THE BORROWER'S OWN LONG-TERM FILES — the client-facing half of the owner's
// switch. Mounted at /api/lt/my by src/server.js, BORROWER-authenticated at that
// mount (the /api/lt router beside it is staff-only, which is why this needs its
// own seam rather than a route inside it).
//
// It is still Long-Term's own code, under /api/lt/*, in src/longterm/** — the
// charter's namespace rules hold; only the authentication differs.
//
// BUILT READY (owner-directed 2026-08-16, "build it ready") AND NOW SWITCHED ON
// (owner-directed 2026-08-17, "turn switch on"). `borrower.longTermVisible`
// DEFAULTS TO TRUE, so on an untouched deployment a borrower does see their
// confirmed long-term files.
//
// This comment said the opposite until 2026-08-18 — three times, in the words it
// shipped with on the 16th. The behaviour followed the owner's instruction
// correctly; only the prose was left behind. That is not a harmless staleness on
// a CLIENT-FACING door: anybody reasoning about what a borrower can see would
// have read this file, concluded the surface was dark, and been wrong. The
// registry's own `evidence` line is the record, and
// `test-lt-borrower-switch-db.js` asserts the declared default so it cannot move
// again without somebody saying so.
//
// Turned OFF it answers `{enabled:false, loans:[]}` and the portal renders no
// switch at all — 200 rather than 404, deliberately: the front end has to tell
// "this is off" from "this is broken", and moving it either way must be one
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
const myScope = require('../my-scope');

/* THE BORROWER'S CONDITIONS RIDE THIS SAME MOUNT — /api/lt/my, already behind
   `requireAuth` + `requireBorrower` in server.js. Mounting them here rather than
   adding a second entry there means there is ONE borrower-authenticated
   long-term seam, and a door added to it cannot be reachable without the
   authentication this one already has. */
router.use(require('./my-conditions'));
const stages = require('../stages');

/**
 * Is the borrower-facing long-term side switched on?
 *
 * DELEGATES to `my-scope`, which is now the ONE definition — this door is no
 * longer the only borrower-facing one, and a switch that gated the LIST while
 * leaving the conditions and their documents reachable would be a switch that
 * does not mean what it says. The reasoning that lived here (fail closed, `===
 * true` so an empty settings object and the string "true" both read as OFF) is
 * unchanged and now lives beside the scope it belongs to.
 */
const longTermVisible = myScope.longTermVisible;

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

    // ═══════════════════════════════════════════════════════════════════════
    // THE BORROWER'S WORDING IS KEYED ON THE STEP BEING WAITED ON, NOT THE ONE
    // JUST FINISHED (audit round 3, D1).
    //
    // db/547's `consumer_status` was authored against the ORIGINAL first-not-done
    // reading of `milestone_name` — it is "what the borrower is told WHILE the
    // file sits at this step". Its own rows prove it: Cond. Approval carries
    // "Submitted for Approval" (true while awaiting that approval) and Processing
    // carries "Conditionally Approved" (true once Cond. Approval is behind you).
    //
    // #44 redefined `milestone_name` as the LAST COMPLETED step — right for every
    // STAFF surface, and it would silently shift this borrower-facing column one
    // step BACKWARD: a loan clear to close would tell its borrower "Final
    // Approval". So this door keeps asking the question db/547 answers, by
    // reading the first NOT-done step off the ladder mirror.
    //
    // Re-wording db/547 for completion semantics is a business decision (and
    // would also settle the pre-existing oddity that its Funding row says
    // "Funded" while Funding is still being worked) — it is on the owner's
    // question list, not something to infer here.
    //
    // A LEFT JOIN LATERAL, deliberately: a loan with no ladder mirror yet must
    // still be returned, falling back to whatever `milestone_name` it holds.
    const { rows } = await db.query(
      `SELECT l.id, l.loan_number, l.stage_key, l.milestone_name, l.loan_amount,
              l.term_months, l.program_name, l.encompass_synced_at,
              w.milestone_name AS awaiting_milestone
         FROM lt_loans l
         LEFT JOIN LATERAL (
           -- THE FIRST NOT-DONE STEP **AFTER THE ONE THE LOAN STANDS AT**
           -- (audit round 4, C2). A plain "first not-done anywhere" is wrong on
           -- this data: a not-done row may sit BEHIND a done one — an optional
           -- step left unticked, or a step reopened for rework while later ones
           -- stay done — which is exactly why sittingOf scans for the LAST done
           -- row rather than assuming the ladder is contiguous. On such a ladder
           -- the naive read walked the borrower's wording five steps back.
           -- Complementing sittingOf exactly is what stops the two readings of
           -- one ladder disagreeing.
           --
           -- KEEP THIS COMMENT CLAUSE-FREE. It lives inside a SQL template
           -- literal, so the product-separation gate parses it AS SQL, and an
           -- ordinary English sentence can read as a table reference: the word
           -- "f-r-o-m" followed by any word is taken to name an RTL table and
           -- fails the build. It has now happened twice here — once on this
           -- comment's own closing phrase, and once on the sentence that was
           -- added to warn about it. A backtick would be worse still: it ends
           -- the literal outright and breaks the file. So keep the prose clear
           -- of the SQL keywords, and never put a backtick in this string.
           SELECT m.milestone_name
             FROM lt_loan_milestones m
            WHERE m.loan_id = l.id AND m.done = false
              AND btrim(m.milestone_name) <> ''
              AND m.position > COALESCE(
                    (SELECT max(d.position) FROM lt_loan_milestones d
                      WHERE d.loan_id = l.id AND d.done
                        AND btrim(d.milestone_name) <> ''), -1)
            ORDER BY m.position ASC, m.milestone_name ASC
            LIMIT 1
         ) w ON true
        -- THE ONE OWN-LOAN SCOPE (my-scope.js): the confirmed borrower link plus
        -- the trash exclusion. A loan deleted in Encompass is not one of their
        -- files, and a loan nobody confirmed is theirs belongs to nobody. Read
        -- from the shared fragment so this list and the borrower's conditions
        -- doors can never disagree about which loans are theirs.
        WHERE ${myScope.ownLoanSql('l', '$1')}
        ORDER BY l.encompass_synced_at DESC NULLS LAST, l.loan_number NULLS LAST`,
      [borrowerId],
    );

    // The milestone → borrower-wording table, mapped in JS rather than joined in
    // SQL so the key has ONE definition (`stages.milestoneKey`) instead of a
    // PL/pgSQL twin that would drift from it — the trap this repo has been bitten
    // by twice. The catalog is 19 rows. A failed read leaves every wording null
    // and the stage LABEL answers instead, which is the documented fallback.
    const consumerByKey = new Map();
    try {
      // ARCHIVED ROWS EXCLUDED, ORDERED (audit round 4). The catalog sync
      // ARCHIVES rather than deletes, so an archived "Cond Approval" and a live
      // "Cond. Approval" collapse to the same punctuation-blind key and the
      // winner would be whichever row the planner happened to return last.
      const { rows: cat } = await db.query(
        `SELECT milestone_name, consumer_status
           FROM lt_encompass_milestones
          WHERE COALESCE(is_archived, false) = false
          ORDER BY sequence`);
      for (const c of cat) {
        if (c.milestone_name) consumerByKey.set(stages.milestoneKey(c.milestone_name), c.consumer_status);
      }
    } catch (_) { /* wording unavailable — the stage label answers */ }
    for (const r of rows) {
      const key = stages.milestoneKey(r.awaiting_milestone || r.milestone_name);
      r.consumer_status = key ? (consumerByKey.get(key) || null) : null;
    }

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
