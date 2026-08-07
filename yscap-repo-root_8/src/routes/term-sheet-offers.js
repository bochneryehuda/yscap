'use strict';

/**
 * THE BORROWER'S SIDE OF AN EMAILED TERM SHEET (owner-directed 2026-08-07).
 *
 * The owner's three steps, in order: *"1. Go right away and create a password for his
 * account. 2. Go ahead and collect the initial information. 3. Start it like a regular
 * file that is registered already, like it's borrower registered already with all the
 * terms."*
 *
 * ── THIS ROUTER DOES NOT CREATE CREDENTIALS ─────────────────────────────────────
 * Step 1 is `POST /auth/accept`, which already exists and is already audited: it
 * handles the pre-existing-borrower case, bumps `token_version` on a password
 * overwrite, marks the email verified (clicking an emailed link IS proof of
 * ownership), and binds the borrower to the inviting officer. `createOffer` wrote the
 * SAME token to `invite_tokens` for exactly that reason, so there is no second
 * credential path here and no new account-takeover surface. Step 3 then runs
 * AUTHENTICATED as the borrower who just signed in.
 *
 * ── WHAT IS PUBLIC AND WHAT IS NOT ──────────────────────────────────────────────
 * `GET /:token` is public (nobody has an account yet when they click the link) and
 * answers with the BORROWER-SAFE terms only. It never returns the officer's markup,
 * the internal quote, the draft's raw overrides, or anything about other files. The
 * token is the authorization: it is 24 random bytes, stored only as a sha256, and it
 * names exactly one offer.
 *
 * `POST /:token/start` requires a borrower session, and the offer's email must match
 * that borrower's own — the token alone must never be able to attach somebody else's
 * terms to whichever account happens to be signed in.
 */

const express = require('express');
const db = require('../db');
const offers = require('../lib/term-sheet-offer');
const { requireAuth } = require('../auth');

const router = express.Router();

/** Everything a borrower may see about their own offer. Never the internals. */
function publicView(offer, officer) {
  const dead = !!offer.revoked_at || new Date(offer.expires_at) <= new Date();
  return {
    property: offers.propertyLine(offer.draft),
    terms: offers.borrowerTerms(offer.quote_snapshot, offer.draft, offer.term_options),
    officer: officer ? { name: officer.full_name || null, email: officer.email || null,
      phone: officer.phone || null, nmls: officer.nmls || null, title: officer.title || null } : null,
    borrowerName: offer.borrower_name || null,
    borrowerEmail: offer.borrower_email,
    hasTermSheet: !!offer.pdf_ref,
    expiresAt: offer.expires_at,
    // The state the screen has to branch on, named rather than inferred from nulls.
    state: dead ? 'expired' : (offer.accepted_at ? 'accepted' : 'open'),
    applicationId: offer.accepted_at ? (offer.application_id || null) : null,
  };
}

/* ── PUBLIC: read the offer behind the emailed link ─────────────────────────────
   Answers 404 for an unknown token and never says WHY beyond that — a probe must
   not be able to tell a wrong token from a revoked one. An EXPIRED or already
   ACCEPTED offer is answered normally, because the person holding the link is the
   borrower and needs to be told which of the two happened. */
router.get('/:token', async (req, res) => {
  try {
    const offer = await offers.offerByToken(req.params.token);
    if (!offer) return res.status(404).json({ error: 'This link is not valid. Ask your loan officer to send it again.' });
    let officer = null;
    if (offer.officer_id) {
      const r = await db.query(
        `SELECT full_name, email, phone, nmls, title FROM staff_users WHERE id=$1 AND is_active=true`,
        [offer.officer_id]);
      officer = r.rows[0] || null;
    }
    // A read receipt for the officer — best-effort, and never a reason to fail.
    offers.markOpened(offer.id);
    // Does this person already have a portal login? The screen asks for a password
    // when they do not, and offers sign-in when they do — asking someone to "create"
    // a password they already have is the confusing half of every invite flow.
    let hasAccount = false;
    try {
      const a = await db.query(
        `SELECT 1 FROM borrowers b JOIN borrower_auth a ON a.borrower_id=b.id
          WHERE lower(b.email)=lower($1) LIMIT 1`, [offer.borrower_email]);
      hasAccount = !!a.rows[0];
    } catch (_) { hasAccount = false; }
    res.json({ ...publicView(offer, officer), hasAccount });
  } catch (e) {
    res.status(500).json({ error: db.describeError ? db.describeError(e) : e.message });
  }
});

/* ── STEP 3: the file, born with the terms ──────────────────────────────────────
   Requires the borrower session that step 1 (`/auth/accept`) just handed out. */
router.post('/:token/start', requireAuth, async (req, res) => {
  const actor = req.actor || {};
  if (actor.kind !== 'borrower') {
    return res.status(403).json({ error: 'Sign in as the borrower this term sheet was sent to.' });
  }
  // A BORROWER-VIEW SESSION MAY NOT ACCEPT TERMS. Staff step into a borrower's portal
  // to walk them through a screen; agreeing to loan terms in their legal identity is
  // not that, and the guard list is deliberately tiny, so this one is checked here.
  if (req.impersonation) {
    return res.status(403).json({ error: 'Accepting terms has to be done by the borrower themselves.' });
  }
  try {
    const offer = await offers.offerByToken(req.params.token);
    if (!offer) return res.status(404).json({ error: 'This link is not valid.' });
    // THE OFFER'S EMAIL MUST BE THIS BORROWER'S. Without this, a token forwarded to
    // anyone with a portal account would attach another person's terms to their file.
    const me = await db.query(`SELECT id, email FROM borrowers WHERE id=$1`, [actor.id]);
    const mine = me.rows[0];
    if (!mine || String(mine.email || '').toLowerCase() !== String(offer.borrower_email || '').toLowerCase()) {
      return res.status(403).json({ error: 'These terms were sent to a different email address.' });
    }
    const out = await offers.acceptOffer({
      token: req.params.token,
      borrowerId: actor.id,
      initial: req.body && req.body.initial,
    });
    if (!out.ok) return res.status(400).json({ error: out.problem || 'Could not start the application.' });
    res.json({ ok: true, applicationId: out.applicationId, registered: !!out.registered,
      already: !!out.already, reason: out.reason || null });
  } catch (e) {
    res.status(500).json({ error: db.describeError ? db.describeError(e) : e.message });
  }
});

module.exports = router;
