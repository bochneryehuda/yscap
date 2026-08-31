'use strict';
/**
 * LONG-TERM — THE VERIFICATION OF RENT (HTTP).
 *
 * Mounted at /api/lt/vor; staff authentication is applied at the seam in
 * src/server.js, so this router imports no RTL route code.
 *
 * The same four rules the orders router states, because a desk that reaches a file
 * the file screen would refuse is the failure that matters most:
 *
 * 1. EVERY ROUTE GOES THROUGH `loadScopedLoan` — one access rule, one "no such
 *    loan" answer, one 503-not-404 rule for an outage.
 * 2. THE FORM IS SCOPED TO ITS LOAN IN THE STATEMENT, never checked afterwards.
 * 3. A REFUSAL SAYS WHAT TO DO, in the desk's own wording rather than a second one
 *    invented here.
 * 4. THE PDF IS RENDERED, NEVER UPLOADED. There is deliberately no route that takes
 *    PDF bytes from a browser: a hand-edited document cannot be re-anchored, so its
 *    required questions would silently stop being asked. What is editable is the
 *    DATA, and the preview is rendered from it.
 */

const express = require('express');

const router = express.Router();

const db = require('../db');
const desk = require('../vor/desk');
const { loadScopedLoan } = require('./scoped-loan');

const actorId = (req) => (req.actor && req.actor.id) || null;
const actorName = (req) => (req.actor && (req.actor.fullName || req.actor.full_name || req.actor.name)) || null;
/* THE PERSON THE FORM COMES FROM — their own name and address, so a landlord
   answers a real person. `lib/send-as.js` decides whether we may put that address
   in the From line or must send for them instead. */
const actorSender = (req) => ({ name: actorName(req), email: (req.actor && req.actor.email) || null });

/** The whole desk for one loan: the form, its envelopes, what came back, what blocks. */
router.get('/loans/:loanId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vor');
  if (!scoped) return;
  try {
    const view = await desk.state(scoped.loan.id, db, { actor: req.actor });
    if (!view) return res.status(404).json({ error: 'That loan is not here.' });
    res.json(view);
  } catch (e) {
    res.status(500).json({ error: 'The verification-of-rent desk could not be read.' });
  }
});

/** Save the edits to OUR half of the form. */
router.post('/loans/:loanId/form', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vor');
  if (!scoped) return;
  try {
    const out = await desk.saveForm(scoped.loan.id, (req.body && req.body.data) || {}, actorId(req), db);
    const view = await desk.state(scoped.loan.id, db, { actor: req.actor });
    res.json({ ...out, state: view });
  } catch (e) {
    res.status(500).json({ error: 'That could not be saved.' });
  }
});

/**
 * The preview — the actual PDF, rendered from the data as it stands.
 *
 * Served INLINE so it opens in the viewer rather than downloading, and with
 * `no-store`: it is regenerated from the data every time, so a cached copy is a
 * copy of an older form, which is the one thing a preview may never be.
 */
router.get('/loans/:loanId/preview.pdf', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vor');
  if (!scoped) return;
  try {
    const out = await desk.preview(scoped.loan.id, db, { actor: req.actor });
    if (!out) return res.status(404).json({ error: 'That loan is not here.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${desk.FILENAME}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out.pdf);
  } catch (e) {
    res.status(500).json({ error: 'The form could not be drawn.' });
  }
});

/** Send it — DocuSign, an email attachment, or both. */
router.post('/loans/:loanId/send', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vor');
  if (!scoped) return;
  const method = String((req.body && req.body.method) || '').trim();
  try {
    const out = await desk.send(scoped.loan.id, {
      method,
      staffId: actorId(req),
      from: actorSender(req),
      force: req.body && req.body.force === true,
      db,
    });
    if (!out.ok) return res.status(422).json(out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'The form could not be sent.' });
  }
});

/**
 * Record a form that came back another way — and VOID whatever is still in flight.
 *
 * The reason is required (the desk refuses a short one): once an envelope is voided
 * this note is the only record of why an in-flight signature request was stopped.
 */
router.post('/loans/:loanId/manual-return', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vor');
  if (!scoped) return;
  try {
    const out = await desk.recordManualReturn(scoped.loan.id, {
      note: (req.body && req.body.note) || '',
      answers: (req.body && req.body.answers) || {},
      filename: (req.body && req.body.filename) || null,
      storageRef: (req.body && req.body.storageRef) || null,
      staffId: actorId(req),
    }, db);
    if (!out.ok) return res.status(422).json(out);
    const view = await desk.state(scoped.loan.id, db, { actor: req.actor });
    res.json({ ...out, state: view });
  } catch (e) {
    res.status(500).json({ error: 'That could not be recorded.' });
  }
});

module.exports = router;
