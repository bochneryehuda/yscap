'use strict';

// HTTP for the long-term BORROWER map — which PILOT borrower profile each
// long-term loan belongs to. Mounted at /api/lt/borrowers by
// src/longterm/index.js; staff authentication is applied at the mount seam in
// src/server.js, so this router imports no RTL auth code.
//
// READING IS SCOPED TO THE VIEWER'S OWN FILES (owner-directed 2026-08-23: *"every
// officer should only be able to see their [borrowers] over there, and they should
// not be able to see [borrowers] from different officers"*). It was open to any
// staff member, on the reasoning that an officer looking at a long-term file has to
// see whether its borrower has been matched yet — true, but it handed every officer
// the name and email of every borrower in the book, which is what the owner was
// shown. The narrower rule still satisfies the original need: a viewer sees the
// borrower of every file they are on. A super-admin (`seesAll`) still sees all.
// CHANGING it is
// admin-only, and it is the most consequential button on the long-term side: a
// confirmed link is what puts a loan on a client's own login, so a wrong one shows
// one borrower another borrower's file. It reuses the SAME `mayManagePeople` gate
// the staff map uses — deciding who somebody is, is one permission.
//
// ENCOMPASS IS NOT TOUCHED. Nothing here calls Encompass at all; it reads what the
// sync has already mirrored.

const express = require('express');
const router = express.Router();

const borrowerMatch = require('../borrower-match');
const borrowerLinks = require('../borrower-links');
const access = require('../access');
const db = require('../db');
const trash = require('../trash');
const settingsStore = require('../settings/store');

async function requireBorrowerAdmin(req, res, next) {
  try {
    const { settings } = await settingsStore.load();
    if (!access.mayManagePeople(req.actor, settings)) {
      return res.status(403).json({
        error: 'Only an administrator can decide which borrower profile a long-term loan belongs to.',
      });
    }
    return next();
  } catch (e) {
    // The gate itself failing is not permission to pass it.
    console.error('[lt] borrower admin gate failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not check your permissions just now. Try again in a moment.' });
  }
}

/** One place that turns a thrown refusal into its own status + wording. */
function fail(res, e, fallback) {
  if (e && e.status && e.plain) return res.status(e.status).json({ error: e.plain });
  console.error(`[lt] ${fallback}:`, (e && e.message) || e);
  return res.status(500).json({ error: fallback });
}

/**
 * GET /api/lt/borrowers — every borrower address on the long-term book, what we
 * propose it is, and why an unproposed one is unproposed.
 *
 * The candidate profiles are narrowed to the addresses the book actually carries,
 * rather than reading the whole `borrowers` table: the match key is the email, so
 * a profile whose address appears on no long-term loan can never be a candidate,
 * and pulling tens of thousands of person records to discard nearly all of them is
 * the kind of query that is fine on a test database and not on a real one.
 */
router.get('/', async (req, res) => {
  try {
    const { settings } = await settingsStore.load().catch(() => ({ settings: {} }));

    // WHOSE BORROWERS THIS PERSON MAY SEE. This list used to have no scope at all:
    // every caller got every borrower in the book, with their name and email,
    // regardless of whose loan it was. Owner-reported, and it is the same question
    // the pipeline already answers — so it is answered by the SAME predicate rather
    // than a second one written here. `access.js` says exactly why in its own words:
    // three copies of "is this person on this file" would drift, and the copy that
    // goes wrong is the one nobody thinks of as a copy. This was the fourth place
    // that needed it and the only one that had gone without.
    //
    // A viewer with `seesAll` (super-admin) gets an empty clause and the whole book,
    // which is the behaviour that was already intended for them.
    const viewer = access.accessFor(req.actor, settings);
    const scope = access.pipelineScopeSql(viewer, req.actor && req.actor.id, 1);
    const { rows: loans } = await db.query(
      `SELECT l.id, l.loan_number, l.borrower_email, l.borrower_name, l.borrower_id,
              l.loan_folder, l.stage_key
         FROM lt_loans l
        -- Deleted loans (Encompass's trash) never reach the match screen: their
        -- test borrowers ("testing, tesing") are not people to link
        -- (owner-directed 2026-08-23).
        WHERE ${trash.notTrashSql('l')}${scope.where ? ` AND ${scope.where}` : ''}
        ORDER BY l.borrower_email NULLS LAST, l.loan_number NULLS LAST`,
      scope.params,
    );

    const emails = [...new Set(loans.map((l) => l.borrower_email).filter(Boolean))];
    const { rows: profiles } = emails.length
      ? await db.query(
        `SELECT id, email, NULLIF(full_name, '') AS full_name
           FROM borrowers
          WHERE lower(email) = ANY($1::text[])`,
        [emails],
      )
      : { rows: [] };

    const existing = await borrowerLinks.loadLinks();
    const out = borrowerMatch.matchBorrowers(loans, profiles, { existing, settings });

    res.json({
      ...out,
      links: existing,
      // Whether THIS person may decide, so the screen shows the buttons to
      // somebody who can press them. It is the SAME gate the write routes apply
      // (`mayManagePeople`) — this is a hint for the screen and never the
      // authorization, which stays on the doors that change something.
      canManage: access.mayManagePeople(req.actor, settings),
      rule: {
        matchedOn: 'email',
        // Said out loud on the payload because the screen must not imply PILOT
        // decided anything: every row here is waiting on a person.
        note: 'PILOT proposes a match by email address and never adopts a borrower profile on its own.',
      },
    });
  } catch (e) {
    fail(res, e, 'Could not read the long-term borrower map just now.');
  }
});

// POST /api/lt/borrowers/confirm — this address IS this person. Stamps every
// long-term loan on the address, so the borrower can see them on their login.
router.post('/confirm', requireBorrowerAdmin, async (req, res) => {
  try {
    const { settings } = await settingsStore.load().catch(() => ({ settings: {} }));
    const out = await borrowerLinks.confirmLink(
      req.body && req.body.email,
      req.body && req.body.borrowerId,
      req.actor && req.actor.id,
      { settings, force: (req.body && req.body.force) === true },
    );
    res.json(out);
  } catch (e) {
    fail(res, e, 'Could not link that borrower just now.');
  }
});

// POST /api/lt/borrowers/reject — this address is NOT that person. Durable: the
// match is never proposed again.
router.post('/reject', requireBorrowerAdmin, async (req, res) => {
  try {
    const out = await borrowerLinks.rejectLink(req.body && req.body.email, req.actor && req.actor.id);
    res.json(out);
  } catch (e) {
    fail(res, e, 'Could not record that decision just now.');
  }
});

// POST /api/lt/borrowers/unlink — undo a link entirely: forget the decision AND
// detach the loans it attached, so the file leaves the borrower's login again.
router.post('/unlink', requireBorrowerAdmin, async (req, res) => {
  try {
    const out = await borrowerLinks.unlink(req.body && req.body.email);
    res.json(out);
  } catch (e) {
    fail(res, e, 'Could not undo that link just now.');
  }
});

module.exports = router;
