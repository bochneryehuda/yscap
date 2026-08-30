'use strict';
/**
 * LONG-TERM — THE ORDERS DESK (HTTP).
 *
 * Mounted at /api/lt/orders; staff authentication is applied at the seam in
 * src/server.js, so this router imports no RTL route code.
 *
 * FOUR RULES, the same four the condition centre's router states, because a desk
 * that reaches a file the file screen would refuse is the failure that matters most:
 *
 * 1. EVERY PER-FILE ROUTE GOES THROUGH `loadScopedLoan` — one access rule, one
 *    "no such loan" answer, one 503-not-404 rule for an outage.
 * 2. EVERY ORDER IS SCOPED TO ITS LOAN IN THE STATEMENT, never checked afterwards,
 *    so an id from another file matches no row as a property of the query.
 * 3. PLACING AN ORDER IS ANY STAFF MEMBER'S; changing what a vendor is ASKED for —
 *    the letter's own wording — is an administrator's, because that text goes to an
 *    outside company on every file in the book.
 * 4. A REFUSAL SAYS WHAT TO DO. The desk's blockers each carry their own sentence
 *    (`orders/data.BLOCKER_TEXT`), and the route relays it verbatim rather than
 *    inventing a second wording for the same state.
 */

const express = require('express');

const router = express.Router();

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const desk = require('../orders/desk');
const data = require('../orders/data');
const letter = require('../orders/letter');
const kinds = require('../orders/kinds');
const vendorDirectory = require('../../lib/vendor-directory');
const { loadScopedLoan, UUID_RE } = require('./scoped-loan');

/** Administrator, resolved the same way every other long-term admin gate resolves
    it. FAILS CLOSED: an unreadable settings row is not permission. */
async function isAdmin(req) {
  try {
    const { settings } = await settingsStore.load();
    return access.mayManagePeople(req.actor, settings);
  } catch (_) { return false; }
}

const actorId = (req) => (req.actor && req.actor.id) || null;
const actorName = (req) => (req.actor && (req.actor.fullName || req.actor.full_name || req.actor.name)) || null;
/* THE PERSON THE ORDER COMES FROM. Their own name and their own address, so the
   vendor answers a real person — `lib/send-as.js` decides whether we may put that
   address in the From line or must send for them instead. */
const actorSender = (req) => ({ name: actorName(req), email: (req.actor && req.actor.email) || null });

/* ── THE DESK ─────────────────────────────────────────────────────────────── */

/** Every order kind on one loan, its state, and what still blocks it. */
router.get('/loans/:loanId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  try {
    const view = await desk.desk(scoped.loan.id, db);
    if (!view) return res.status(404).json({ error: 'No such long-term loan.' });
    res.json({ ...view, canEditLetters: await isAdmin(req) });
  } catch (e) {
    console.error('[lt-orders] desk read failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not read the orders on this loan just now. Try again in a moment.' });
  }
});

/** One order's whole thread — the Gmail-style box. */
router.get('/loans/:loanId/:kind/thread', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  if (!kinds.orderKind(req.params.kind)) return res.status(404).json({ error: 'There is no such order.' });
  try {
    res.json(await desk.thread(scoped.loan.id, req.params.kind, db));
  } catch (e) {
    console.error('[lt-orders] thread read failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not read this order’s messages just now.' });
  }
});

/**
 * PREVIEW — exactly the letter the send would put on the wire.
 *
 * The SAME builder, over the SAME data, so what a person reads here is what the
 * vendor receives. A preview drawn any other way is a preview of something else.
 */
router.get('/loans/:loanId/:kind/preview', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const kind = req.params.kind;
  if (!kinds.orderKind(kind)) return res.status(404).json({ error: 'There is no such order.' });
  try {
    const d = await data.getOrderData(scoped.loan.id, db);
    if (!d) return res.status(404).json({ error: 'No such long-term loan.' });
    const followup = String(req.query.followup || '') === '1';
    const built = letter.buildLetter(kind, d, { followup, note: String(req.query.note || '') });
    const recips = require('../../lib/order-email').recipientsFor(kind, d, {
      replyTo: require('../../lib/file-address').ltOrderReplyTo(scoped.loan.id, kind),
    });
    const blocks = data.blockers(kind, d);
    res.json({
      subject: built.subject, html: built.html, text: built.text,
      to: recips.to, cc: recips.cc, replyTo: recips.replyTo,
      blockers: blocks, blockerText: blocks.map(data.blockerText), canOrder: blocks.length === 0,
    });
  } catch (e) {
    console.error('[lt-orders] preview failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not build the letter just now.' });
  }
});

/** Place the order. */
router.post('/loans/:loanId/:kind/place', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const b = req.body || {};
  const out = await desk.place(scoped.loan.id, req.params.kind, {
    staffId: actorId(req), from: actorSender(req),
    note: b.note, ccBorrower: b.ccBorrower, ccHelper: b.ccHelper,
    extraCc: Array.isArray(b.extraCc) ? b.extraCc : [],
    conditionId: UUID_RE.test(String(b.conditionId || '')) ? b.conditionId : null,
    force: !!b.force,
  });
  if (!out.ok) return res.status(out.status || 400).json(out);
  res.json(out);
});

/** Chase it, on the same thread. */
router.post('/loans/:loanId/:kind/follow-up', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const b = req.body || {};
  const out = await desk.followUp(scoped.loan.id, req.params.kind, {
    staffId: actorId(req), from: actorSender(req), note: b.note,
    extraCc: Array.isArray(b.extraCc) ? b.extraCc : [],
    msgType: b.note ? 'reply' : 'followup',
  });
  if (!out.ok) return res.status(out.status || 400).json(out);
  res.json(out);
});

/** Stand it down, with a reason. */
router.post('/loans/:loanId/:kind/cancel', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const out = await desk.cancel(scoped.loan.id, req.params.kind, {
    staffId: actorId(req), reason: (req.body || {}).reason,
  });
  if (!out.ok) return res.status(out.status || 400).json(out);
  res.json(out);
});

/* ── THE VENDOR CARDS ─────────────────────────────────────────────────────── */

/**
 * WHO IS ON THIS FILE, and who could be.
 *
 * The directory is the SHARED `service_contacts` — one title company, one card,
 * corrected in one place — and this reads it on the LONG-TERM pool, which is why it
 * is a query here rather than a call into the short-term suggester (that reaches the
 * short-term pool; the ledger entry says so).
 *
 * The FOLDING is the shared one, though: db/224 put an `emails text[]` beside the
 * legacy scalar and backfilled only the rows that existed then, so reading either
 * alone drops addresses. `allEmails` is that one definition.
 */
router.get('/loans/:loanId/vendors', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  try {
    const { rows } = await db.query(
      `SELECT v.id, v.kind, v.is_primary, v.service_contact_id,
              sc.id AS contact_id, sc.company_name, sc.contact_name, sc.email, sc.emails,
              sc.phone, sc.phones, sc.address
         FROM lt_loan_vendors v
         LEFT JOIN service_contacts sc ON sc.id = v.service_contact_id
        WHERE v.loan_id = $1::uuid
        ORDER BY v.kind, v.is_primary DESC`,
      [scoped.loan.id]);
    res.json({
      kinds: kinds.VENDOR_KINDS,
      vendors: rows.map((r) => ({
        id: r.id, kind: r.kind, isPrimary: r.is_primary,
        serviceContactId: r.service_contact_id,
        // A card removed from the shared directory reads as GONE, with its own
        // wording — a different instruction from "nobody is on the file".
        missing: !r.contact_id,
        companyName: r.company_name, contactName: r.contact_name,
        emails: vendorDirectory.allEmails(r), phones: vendorDirectory.allPhones(r),
        address: r.address,
      })),
    });
  } catch (e) {
    console.error('[lt-orders] vendor read failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not read this loan’s contacts just now.' });
  }
});

/**
 * SEARCH THE SHARED DIRECTORY.
 *
 * Deliberately narrow: it answers only for a borrower we can already see on a loan
 * this person may open, and it returns business contact details only. The directory
 * is company-wide, so an unscoped search here would be a way to enumerate every
 * vendor every borrower has ever used from a long-term file.
 */
router.get('/loans/:loanId/vendors/search', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const kind = String(req.query.kind || '').trim();
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  try {
    // ESCAPED, then bound. A typed % or _ is a LIKE wildcard: unescaped, a person
    // typing "100%" matches every card in the directory and the search silently
    // becomes a match-all.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await db.query(
      `SELECT sc.id, sc.company_name, sc.contact_name, sc.email, sc.emails, sc.phone,
              sc.phones, sc.address, sc.contact_type
         FROM service_contacts sc
        WHERE sc.merged_into_id IS NULL
          AND (sc.company_name ILIKE $1 OR sc.contact_name ILIKE $1 OR sc.email ILIKE $1)
        ORDER BY sc.last_used_at DESC NULLS LAST, sc.company_name
        LIMIT 25`,
      [like]);
    res.json({
      kind: kind || null,
      results: rows.map((r) => ({
        id: r.id, companyName: r.company_name, contactName: r.contact_name,
        emails: vendorDirectory.allEmails(r), phones: vendorDirectory.allPhones(r),
        address: r.address, contactType: r.contact_type,
      })),
    });
  } catch (e) {
    console.error('[lt-orders] vendor search failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not search the directory just now.' });
  }
});

/** Put a card on this loan for a job. */
router.post('/loans/:loanId/vendors', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const b = req.body || {};
  const kind = String(b.kind || '').trim();
  const contactId = String(b.serviceContactId || '').trim();
  if (!Object.prototype.hasOwnProperty.call(kinds.VENDOR_KINDS, kind)) {
    return res.status(400).json({ error: 'That is not a kind of contact a loan can carry.' });
  }
  if (!UUID_RE.test(contactId)) return res.status(400).json({ error: 'Pick a contact from the directory.' });
  try {
    // The card must EXIST in the shared directory. Storing an id we cannot see
    // would create exactly the dangling link the missing-card wording exists for,
    // on purpose rather than by accident.
    const { rows: found } = await db.query('SELECT id FROM service_contacts WHERE id = $1::uuid', [contactId]);
    if (!found.length) return res.status(404).json({ error: 'That contact is not in the directory.' });

    const primary = b.isPrimary !== false;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Exactly one card is the one an order is addressed to; a new primary demotes
      // the old one in the same breath, or the partial unique index refuses.
      if (primary) {
        await client.query(
          'UPDATE lt_loan_vendors SET is_primary = false, updated_at = now() WHERE loan_id = $1::uuid AND kind = $2 AND is_primary',
          [scoped.loan.id, kind]);
      }
      await client.query(
        `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary, added_by)
         VALUES ($1::uuid,$2,$3::uuid,$4,$5::uuid)
         ON CONFLICT (loan_id, kind, service_contact_id)
         DO UPDATE SET is_primary = EXCLUDED.is_primary, updated_at = now()`,
        [scoped.loan.id, kind, contactId, primary, actorId(req)]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* going back either way */ }
      throw e;
    } finally { client.release(); }
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt-orders] vendor link failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not put that contact on the loan.' });
  }
});

/** Take a card off this loan. The card itself is never touched — it belongs to the
    shared directory and other files use it. */
router.delete('/loans/:loanId/vendors/:linkId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  if (!UUID_RE.test(String(req.params.linkId || ''))) return res.status(404).json({ error: 'No such contact on this loan.' });
  try {
    const { rows } = await db.query(
      'DELETE FROM lt_loan_vendors WHERE id = $1::uuid AND loan_id = $2::uuid RETURNING id',
      [req.params.linkId, scoped.loan.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such contact on this loan.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[lt-orders] vendor unlink failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not take that contact off the loan.' });
  }
});

/* ── THE LETTERS ──────────────────────────────────────────────────────────── */

/** The wording every order goes out with, and whether this person may change it. */
router.get('/letters', async (req, res) => {
  res.json({
    letters: letter.DEFAULT_LETTERS,
    kinds: kinds.ORDER_KINDS,
    tokens: Object.keys(letter.tokenValues({})),
    canEdit: await isAdmin(req),
    note: 'Every letter here is what the system is prefilled with. Editing one changes '
      + 'what an outside company is asked for on every long-term file, which is why it is an administrator’s.',
  });
});

module.exports = router;
