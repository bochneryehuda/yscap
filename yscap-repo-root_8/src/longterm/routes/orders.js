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
      blockers: blocks, blockerText: blocks.map((b) => data.blockerText(b, kind, d)), canOrder: blocks.length === 0,
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

/**
 * IS THIS PROPERTY IN A FLOOD ZONE? — the one applicability fact a person can set.
 *
 * Owner-directed 2026-08-31: *"The Flood Insurance Order should be grayed out
 * unless you switch this switch so that this property is in a flood zone. If you
 * flip that switch, it should also populate the condition for the flood
 * insurance."*
 *
 * TWO THINGS HAPPEN AND THE SECOND IS THE POINT. Writing the column alone would
 * ungrey the order and leave the file with no flood-insurance CONDITION, so the
 * work would exist on one screen and not the other. `evaluateLoan` is the ONE
 * thing that decides which conditions a file carries, so it is re-run rather
 * than a condition being inserted here — an insert here would be a second
 * writer of the same fact, and the one that drifts is the one that leaks.
 *
 * The re-evaluation is BEST-EFFORT: the switch itself is saved either way. A
 * person who flipped it and got an error would flip it again, and the second
 * flip would write the same value while the conditions still had not run.
 *
 * The state OTHER than New York is deliberately NOT settable from here. It is
 * read from Encompass and correcting it in PILOT would put the two at odds on a
 * fact the investor's own file is the authority on.
 */
router.post('/loans/:loanId/flood-zone', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const b = req.body || {};
  // EXACTLY true or false. A missing or unparseable answer must not read as
  // "not in a flood zone" — that is the state that greys the order, and getting
  // there by accident is how a flood file quietly stops asking for insurance.
  if (b.inFloodZone !== true && b.inFloodZone !== false) {
    return res.status(400).json({ error: 'Say whether the property is in a flood zone.' });
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE lt_properties SET in_flood_zone = $2, updated_at = now() WHERE loan_id = $1::uuid`,
      [scoped.loan.id, b.inFloodZone]);
    if (!rowCount) {
      return res.status(404).json({ error: 'This loan has no property record to mark.' });
    }
  } catch (e) {
    console.error('[lt-orders] flood-zone write failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not save that just now.' });
  }

  let conditions = null;
  try {
    conditions = await require('../conditions-center/engine').evaluateLoan(scoped.loan.id, { db });
  } catch (e) {
    console.error('[lt-orders] flood-zone condition re-run failed:', (e && e.message) || e);
  }
  res.json({
    ok: true,
    inFloodZone: b.inFloodZone,
    // What CHANGED on the conditions list, so the screen can say so rather than
    // leaving somebody to go and look.
    conditionsAdded: (conditions && conditions.added) || [],
    conditionsRemoved: (conditions && conditions.removed) || [],
    conditionsUnreadable: !conditions,
  });
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

/**
 * A CONTACT NOBODY HAS ENTERED YET — write the card, then put it on the loan.
 *
 * Owner-directed 2026-08-30: *"FileContacts, Vendor Contact, General Vendor
 * Contact, Vendor FileContacts — they should all be built from our Vendor Contact
 * and connected always … No parallel contact store may ever exist on the LT
 * side."* Until this door existed, the only way a card could reach a long-term
 * loan was for somebody to have created it on a SHORT-TERM file first, which is
 * exactly the parallel-store pressure the directive forbids: a desk that can only
 * link and never create is a desk whose users start keeping the title company's
 * details somewhere else.
 *
 * It is the SHORT-TERM write (`routes/staff.js` POST file-contacts) minus the
 * parts that are facts about that product and not about a vendor:
 *
 *   · NO `checklist_items` COMPLETION and no ClickUp push. The short-term route
 *     flips the borrower's title/insurance CONDITION as a side effect. That table
 *     is RTL's and those codes are RTL's; the long-term conditions are their own
 *     rows with their own codes, and reaching them from here would be the
 *     cross-product write the charter exists to prevent. The condition side-effect
 *     stays where it already is — server-side, per product.
 *   · NO RTL AUDIT ROW. That trail is entity 'application'; a long-term loan is
 *     not one.
 *   · The link is `lt_loan_vendors`, never `application_service_contacts`.
 *
 * What is deliberately IDENTICAL is the card itself: the same columns, the same
 * `contact_type` vocabulary (through `kinds.directoryTypeFor`), and the same
 * EMAIL PAIR RULE — db/224 put an `emails text[]` beside the legacy scalar, every
 * reader still reads the scalar, and the scalar is always the array's first entry
 * so the two can never describe different vendors.
 */
router.post('/loans/:loanId/vendors/new', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  const b = req.body || {};
  // Validated against the registry EXACTLY as the link door does, not
  // case-insensitively: `kind` is written straight into a column whose CHECK
  // lists these twelve words, so anything the registry does not spell is a 400
  // here rather than a Postgres error at the moment somebody presses Save.
  const kind = String(b.kind || '').trim();
  if (!Object.prototype.hasOwnProperty.call(kinds.VENDOR_KINDS, kind)) {
    return res.status(400).json({ error: 'That is not a kind of contact a loan can carry.' });
  }
  const dir = kinds.directoryTypeFor(kind);

  // The same one-detail floor the short-term form has. A card with a type and
  // nothing else is not a contact; it is a row that will be typed again.
  const emails = vendorDirectory.dedupBy(
    Array.isArray(b.emails) ? b.emails : (b.email ? [b.email] : []),
    vendorDirectory._internals.normEmail);
  const phone = String(b.phone || '').trim() || null;
  const companyName = String(b.companyName || '').trim() || null;
  const contactName = String(b.contactName || '').trim() || null;
  if (!companyName && !contactName && !emails.length && !phone) {
    return res.status(400).json({ error: 'Enter at least one detail — a company, a name, an email or a phone number.' });
  }
  // The person's own words for a job the directory has no name for; the kind's own
  // label wins where it has one (an HOA is an HOA however it was typed).
  const custom = dir.contactType === 'other'
    ? (dir.customType || String(b.customType || '').trim().slice(0, 60) || null)
    : null;

  try {
    const primary = b.isPrimary !== false;
    const client = await db.getClient();
    let contactId = null;
    let linkId = null;
    try {
      await client.query('BEGIN');
      /* WHOSE CARD IT IS. `service_contacts.borrower_id` has been nullable since
         db/032 — the vendors screen writes company-wide cards with none — so a
         loan whose borrower link has not been made yet still gets a usable card
         rather than a refusal. Where the borrower IS known the card hangs off
         them, which is what puts it on their profile and makes it "mine" in the
         type-ahead on their next file, long-term or short-term. */
      const card = await client.query(
        `INSERT INTO service_contacts
           (borrower_id, contact_type, custom_type, company_name, contact_name,
            email, emails, phone, address, notes, added_by_staff_id, last_used_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,now())
         RETURNING id`,
        [scoped.loan.borrower_id || null, dir.contactType, custom, companyName, contactName,
          emails[0] || null, emails.length ? emails : null,
          phone, String(b.address || '').trim() || null, String(b.notes || '').trim() || null,
          actorId(req)]);
      contactId = String(card.rows[0].id);

      // Exactly one card is the one an order is addressed to — the same demotion
      // the link door does, for the same partial unique index.
      if (primary) {
        await client.query(
          'UPDATE lt_loan_vendors SET is_primary = false, updated_at = now() WHERE loan_id = $1::uuid AND kind = $2 AND is_primary',
          [scoped.loan.id, kind]);
      }
      const link = await client.query(
        `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary, added_by)
         VALUES ($1::uuid,$2,$3::uuid,$4,$5::uuid)
         ON CONFLICT (loan_id, kind, service_contact_id)
         DO UPDATE SET is_primary = EXCLUDED.is_primary, updated_at = now()
         RETURNING id`,
        [scoped.loan.id, kind, contactId, primary, actorId(req)]);
      linkId = String(link.rows[0].id);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* going back either way */ }
      throw e;
    } finally { client.release(); }
    res.status(201).json({ ok: true, linkId, contactId });
  } catch (e) {
    console.error('[lt-orders] vendor create failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that contact.' });
  }
});

/**
 * CORRECT A CARD — and it is corrected EVERYWHERE, on purpose.
 *
 * The owner's whole point: *"one company, one card, corrected in one place."* So
 * this updates the SHARED `service_contacts` row, exactly as the short-term Edit
 * button does, and a title company's new closing@ address typed on a long-term
 * loan is the address the short-term orders go to from that moment. That is the
 * intent, not a leak — but it is the reason this door touches only the card's own
 * business details and never the merge bookkeeping (`merged_into_id`) or anybody
 * else's link rows.
 *
 * The link's KIND is part of the same save when it is sent: moving a card from
 * "buyer's attorney" to "our attorney" is a change to what it is FOR on this loan,
 * and the card's directory type follows it, because the type lives on the card.
 */
router.patch('/loans/:loanId/vendors/:linkId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-orders');
  if (!scoped) return;
  if (!UUID_RE.test(String(req.params.linkId || ''))) return res.status(404).json({ error: 'No such contact on this loan.' });
  const b = req.body || {};
  // An empty `kind` means "leave it where it is"; a kind we do not carry is a
  // refusal, never a silent no-op that reads as a successful save.
  const kind = String(b.kind || '').trim();
  if (kind && !Object.prototype.hasOwnProperty.call(kinds.VENDOR_KINDS, kind)) {
    return res.status(400).json({ error: 'That is not a kind of contact a loan can carry.' });
  }
  const dir = kind ? kinds.directoryTypeFor(kind) : null;

  const emails = vendorDirectory.dedupBy(
    Array.isArray(b.emails) ? b.emails : (b.email ? [b.email] : []),
    vendorDirectory._internals.normEmail);
  const phone = String(b.phone || '').trim() || null;
  const companyName = String(b.companyName || '').trim() || null;
  const contactName = String(b.contactName || '').trim() || null;
  if (!companyName && !contactName && !emails.length && !phone) {
    return res.status(400).json({ error: 'Enter at least one detail — a company, a name, an email or a phone number.' });
  }
  const custom = dir && dir.contactType === 'other'
    ? (dir.customType || String(b.customType || '').trim().slice(0, 60) || null)
    : null;

  try {
    // SCOPED IN THE STATEMENT, like every other per-file read on this desk: a link
    // id from another loan matches no row as a property of the query.
    const { rows: found } = await db.query(
      'SELECT service_contact_id FROM lt_loan_vendors WHERE id = $1::uuid AND loan_id = $2::uuid',
      [req.params.linkId, scoped.loan.id]);
    if (!found.length) return res.status(404).json({ error: 'No such contact on this loan.' });
    const contactId = String(found[0].service_contact_id);

    const client = await db.getClient();
    // The link survives a card deleted from the directory on purpose (db/644's
    // header says why there is no foreign key). Editing one is still nothing, and
    // it is a 404 rather than a silent ok — reported AFTER the client is back in
    // the pool, so the door can never return without releasing it.
    let cardGone = false;
    try {
      await client.query('BEGIN');
      /* The two email columns move TOGETHER — the scalar is always the first of
         the array. The type is COALESCEd so a save that does not mention the kind
         keeps the card filed where it is, and `custom_type` is only reset when the
         type is actually being changed (the short-term PATCH makes the same two
         decisions, for the same reason). */
      const upd = await client.query(
        `UPDATE service_contacts
            SET contact_type = COALESCE($2, contact_type),
                custom_type  = CASE WHEN $2::text IS NULL THEN custom_type ELSE $3 END,
                company_name = $4, contact_name = $5,
                email = $6, emails = $7, phone = $8, address = $9, notes = $10,
                updated_at = now()
          WHERE id = $1::uuid
          RETURNING id`,
        [contactId, dir ? dir.contactType : null, custom, companyName, contactName,
          emails[0] || null, emails.length ? emails : null,
          phone, String(b.address || '').trim() || null, String(b.notes || '').trim() || null]);
      if (!upd.rows.length) {
        cardGone = true;
        await client.query('ROLLBACK');
      } else {
        if (dir) {
          await client.query(
            'UPDATE lt_loan_vendors SET kind = $2, updated_at = now() WHERE id = $1::uuid',
            [req.params.linkId, kind]);
        }
        await client.query('COMMIT');
      }
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* going back either way */ }
      throw e;
    } finally { client.release(); }
    if (cardGone) return res.status(404).json({ error: 'That contact is no longer in the directory.' });
    res.json({ ok: true, contactId });
  } catch (e) {
    console.error('[lt-orders] vendor edit failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that contact.' });
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
