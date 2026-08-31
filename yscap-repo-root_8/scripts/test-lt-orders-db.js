'use strict';
/**
 * THE LONG-TERM ORDERS DESK, END TO END — proven against a REAL Postgres, with
 * the mailer stubbed and INSPECTED, and a vendor's reply driven through the real
 * inbound handler.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The orders sharing is built and correct: `src/lib/order-email.js` was
 * extracted out of `src/lib/orders.js` and is re-exported BY it, so there is ONE
 * definition of an order letter and a fix reaches both products. What was
 * missing was the other half of "prove it, don't assert it" — every long-term
 * orders suite was PURE. A pure test reads the letter's wording and the routing
 * decisions; it cannot see whether an order actually lands, whether a second
 * press sends a second letter to a title company, whether a failed send leaves a
 * file claiming an order that never went, or whether the documents a vendor
 * sends back reach the condition that asked for them.
 *
 * Those are the four things worth being sure of on a desk that emails outside
 * companies, so they are what this pins.
 *
 * NAMED `test-lt-…` DELIBERATELY: the separation gate reads a suite's FILENAME as
 * its product identity, and this one names `lt_loans`, `lt_file_orders`,
 * `lt_loan_vendors` and `lt_order_events`.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. THE ORDER GOES OUT — the row, the letter, the vendor as the recipient, and
 *     the condition moving to "asked for" rather than to satisfied.
 *  B. EXACTLY ONCE. A second press is refused; a DELIBERATE re-send is not. The
 *     refusal is asserted on the MAILER, because a door that answers 409 and
 *     emails the title company anyway has refused nothing.
 *  C. A FAILED SEND LEAVES NO ORDER. `place` claims the row, sends, then settles
 *     inside one transaction and rolls back when the send fails — so a file never
 *     shows an order that never went. This is the assertion a pure test cannot
 *     make at all.
 *  D. BLOCKERS REFUSE BEFORE THE WIRE. No vendor card means nothing is sent and
 *     nothing is recorded, with a reason a person can act on.
 *  E. THE REPLY COMES BACK TO THE RIGHT ORDER, with its document filed onto the
 *     condition that asked for it — driven through the real `handleOne`.
 *  F. SCOPE. One loan's reply address can never file onto another loan's order.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-orders-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-orders-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
/* THE PER-ORDER REPLY ADDRESS ONLY EXISTS WHEN A REPLY DOMAIN IS CONFIGURED —
   `ltOrderReplyTo` answers null without one, which is correct and which made an
   earlier cut of this suite a TAUTOLOGY: it compared the order's stored address
   to the builder's answer and both were null, so it proved nothing and the whole
   reply half could not run. Set here so every assertion below is about a real
   address. */
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-orders-'));

const db = require('../src/db');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltord-${process.pid}-${Date.now()}`;

/* THE MAILER IS STUBBED AND INSPECTED, not switched off. `EMAIL_PROVIDER=none`
   accepts anything and reports success, so a suite that only checked for "no
   error" would pass against a send that addressed nobody. Every assertion below
   about who was written to reads THIS list. */
const email = require('../src/lib/email');
/* THE ATTACHMENT RETRIEVAL IS STUBBED FOR THE SAME REASON THE MAILER IS.
   `handleOne` deliberately does NOT trust the bytes on the webhook — it re-fetches
   them from the provider, which is right in production and unreachable here. The
   stub hands back the attachments the fixture describes, so what runs is the real
   FILING path (`fileAttachment`, the dedupe, the condition lookup) and only the
   provider round trip is stood in for. Without it the suite reports a skip and a
   reader would think the filing was broken. */
const inboundMail = require('../src/lib/inbound-mail');
let inlineAttachments = [];
inboundMail.retrieveAttachmentsSafe = async () => {
  const out = inlineAttachments.slice();
  out.droppedByCap = 0; out.droppedByError = 0;
  return out;
};
const sent = [];
let failNextSend = false;
email.sendMail = async (payload) => {
  if (failNextSend) { failNextSend = false; const e = new Error('the provider refused this message'); throw e; }
  sent.push(payload);
  return { id: `stub-${sent.length}`, ok: true };
};

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const desk = require('../src/longterm/orders/desk');
  const inbox = require('../src/longterm/orders/inbox');
  const { ltOrderReplyTo } = require('../src/lib/file-address');

  /* ───────────────────────────────── seed ────────────────────────────────── */
  const { rows: sr } = await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'LT Orders Officer','loan_officer',true) RETURNING id`,
    [`${uniq}@example.test`]);
  const staffId = String(sr[0].id);

  const borrowerId = String((await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,'Orders',$2) RETURNING id`,
    [uniq, `${uniq}-b@example.test`])).rows[0].id);

  /* THE FIXTURE STAGES WHAT THE CODE ACTUALLY READS, not what a loan "obviously"
     has. `getOrderData` takes the property from `lt_properties` (its own row, so
     the one-line address and its parts can never disagree) and the officer from
     the SHARED staff roster via `lt_loans.loan_officer_id` — there is no
     property_address or officer name on `lt_loans` at all. A fixture that
     invented those columns would be testing a different loan than the one the
     desk reads, which is how a suite passes while the feature is broken. */
  const mkLoan = async (n) => {
    const id = String((await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder, loan_officer_id)
       VALUES ($1::uuid,$2,'Bo Rrower',$3::uuid,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline',$4::uuid)
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`, borrowerId, staffId])).rows[0].id);
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip)
       VALUES ($1::uuid,'12 Test Street','Lakewood','NJ','08701')`, [id]);
    return id;
  };

  const loan = await mkLoan('main');
  const other = await mkLoan('other');

  const vendorEmail = `${uniq}-title@vendor.test`;
  const contactId = String((await db.query(
    `INSERT INTO service_contacts (company_name, contact_name, email, contact_type)
     VALUES ($1,'A Closer','${'' + ''}' || $2, 'title') RETURNING id`,
    [`${uniq} Title Co`, vendorEmail])).rows[0].id);

  const linkVendor = async (loanId, kind) => db.query(
    `INSERT INTO lt_loan_vendors (loan_id, kind, service_contact_id, is_primary)
     VALUES ($1::uuid,$2,$3::uuid,true)`, [loanId, kind, contactId]);

  const orderRows = async (loanId) => (await db.query(
    `SELECT id, kind, status, reply_to FROM lt_file_orders WHERE loan_id=$1::uuid`, [loanId])).rows;

  /* THE CONDITIONS ARE STAGED IN THE SHARED TABLE, because that is where db/653
     put them. Staging them in `lt_file_conditions` would have made this suite
     agree with the stale code it is meant to catch — the returned document would
     have filed, and the live defect (nothing writes that table any more) would
     have stayed invisible. */
  const mkCondition = async (loanId, code) => {
    const tpl = String((await db.query(
      `INSERT INTO checklist_templates (code, scope, label, audience, item_kind, is_active, sort_order, slots)
       VALUES ($1,'lt_loan',$2,'staff','document',true,100,'[]'::jsonb)
       ON CONFLICT (code) DO UPDATE SET is_active = true
       RETURNING id`, [code, code])).rows[0].id);
    return String((await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, template_id, category, label, audience, status, item_kind, is_required)
       VALUES ('lt_loan',$1::uuid,$2::uuid,'prior_to_approval',$3,'staff','outstanding','document',true)
       RETURNING id`, [loanId, tpl, code])).rows[0].id);
  };

  /* TWO DIFFERENT CONDITIONS, and conflating them is easy: `kinds.js` gives each
     order kind a `condition` (the one that moves to "asked for" when the order
     goes out — `lt_order_title`) AND a `docCondition` (the one a RETURNED
     document is filed onto — `lt_title_docs`). Staging only one would have made
     half of this suite assert against a condition the code never touches. */
  const orderCond = await mkCondition(loan, 'lt_order_title');
  const titleCond = await mkCondition(loan, 'lt_title_docs');

  /* ═════════════════ D. BLOCKERS REFUSE BEFORE THE WIRE ════════════════════
     Asserted FIRST, while this loan genuinely has no vendor card — running it
     after the happy path would be asserting against a loan that already has
     one, which proves nothing. */
  {
    const before = sent.length;
    const r = await desk.place(loan, 'title', { staffId });
    assert(r.ok === false && r.status === 422,
      `D1 with no vendor card the order is refused (got ${r.status})`);
    assert(typeof r.error === 'string' && r.error.length > 10,
      'D2 …with a reason in words, not a code');
    assert(sent.length === before,
      'D3 …and NOTHING was emailed — the refusal is asserted on the mailer, not on the status');
    assert((await orderRows(loan)).length === 0,
      'D4 …and no order row was created either');
  }

  await linkVendor(loan, 'title');
  await linkVendor(other, 'title');

  /* ═════════════════ C. A FAILED SEND LEAVES NO ORDER ══════════════════════
     Also before the happy path, so the rollback is proven on a file with no
     order at all — afterwards an "order absent" assertion could not tell a
     rollback from a row that was simply never touched. */
  {
    failNextSend = true;
    const r = await desk.place(loan, 'title', { staffId });
    assert(r.ok === false,
      `C1 when the provider refuses the message the order is not reported as placed (got ok=${r.ok})`);
    assert((await orderRows(loan)).length === 0,
      'C2 …and NO order row survives — the claim, the send and the settle are one transaction, so a file never shows an order that never went');
    /* SCOPED TO THIS LOAN, NEVER THE WHOLE TABLE. The claim is "THIS failed
       send left no thread event", and an unscoped count asks something else
       entirely — "has any suite in this database ever written one?" — which is
       true today only by luck and becomes false the moment another orders
       suite runs first in the chain. The identical mistake in the profile-links
       suite failed the full run on 2026-08-31; this is its twin, found by
       sweeping for it. Section A above places a REAL order on this same loan
       and asserts an event DOES appear through this very predicate, so the
       scope is one the query can genuinely match — not so narrow it could
       never find anything, which is the other half of the same trap.

       HONESTLY: C3 IS REDUNDANT TODAY, and that is recorded rather than left
       to imply more than it does. `lt_order_events.order_id` is NOT NULL with
       a foreign key to `lt_file_orders`, so an event cannot exist without an
       order at all — C2 above ("no order row survives") structurally implies
       this. It was proven by trying to mutate it: a hand-written event for
       this loan with no order is REFUSED by the database, so no faithful
       mutation of C3 exists while the schema stands. It is kept because it
       states the intent, and because it becomes load-bearing the day an event
       may be written before its order exists — a shape any "log the attempt
       first" change would introduce. */
    const ev = Number((await db.query(
      `SELECT count(*)::int AS n FROM lt_order_events WHERE loan_id=$1::uuid`, [loan])).rows[0].n);
    assert(ev === 0, 'C3 …and no thread event was left behind either');
  }

  /* ═════════════════ A. THE ORDER GOES OUT ═════════════════════════════════ */
  let placed = null;
  {
    const before = sent.length;
    const r = await desk.place(loan, 'title', { staffId });
    assert(r.ok === true, `A1 the title order is placed (got ${JSON.stringify(r).slice(0, 160)})`);
    assert(sent.length === before + 1, 'A2 …and exactly ONE letter went out');
    // NULL-SAFE: a crashing suite stops where it stands and reports a pass rate
    // that means nothing, so a missing send is a FAILED assertion, never a throw.
    const msg = sent[sent.length - 1] || {};
    const to = [].concat(msg.to || []).join(' ').toLowerCase();
    assert(to.includes(vendorEmail.toLowerCase()),
      'A3 …addressed to the title company on the file, not to a default');
    assert(typeof msg.subject === 'string' && msg.subject.length > 5,
      'A4 …with a real subject line');

    /* THE CONTROL FOR C3. A scoped count only proves something if the scope
       could match — the same trap the profile-links suite fell into, where the
       join could never find a row and the assertion passed whatever the code
       did. This is the positive half: a send that SUCCEEDS does leave a thread
       event on this loan, read through the very predicate C3 used to find
       none. Without it, C3 would be satisfied by a broken loan_id just as well
       as by a correct rollback. */
    const evAfter = Number((await db.query(
      `SELECT count(*)::int AS n FROM lt_order_events WHERE loan_id=$1::uuid`, [loan])).rows[0].n);
    assert(evAfter >= 1,
      `A4a …and the thread event IS written for this loan — which is what makes C3's "none after a failed send" mean something (got ${evAfter})`);

    const condAfter = (await db.query(
      `SELECT status FROM checklist_items WHERE id=$1::uuid`, [orderCond])).rows[0];
    assert(condAfter && condAfter.status === 'received',
      'A4b …and the condition it answers moves to "asked for" — not to satisfied, because asking is not receiving');

    const rows = await orderRows(loan);
    placed = rows[0];
    assert(rows.length === 1 && placed.status === 'ordered',
      'A5 …and the order is recorded on the loan');
    /* AND THE ADDRESS IS REAL, asserted on its own before it is compared to
       anything. Two nulls are equal, so without this line A6 passes on a
       deployment with no reply domain and the comparison means nothing. */
    assert(typeof placed.reply_to === 'string' && placed.reply_to.includes('@'),
      `A6a the order really has a reply address (got ${JSON.stringify(placed.reply_to)})`);
    assert(placed.reply_to === ltOrderReplyTo(loan, 'title'),
      'A6 …carrying its own reply address — which is what files the documents the vendor sends back onto the right order');
    const replyTo = String(msg.replyTo || msg.reply_to || msg.headers?.['Reply-To'] || '');
    assert(replyTo.includes(placed.reply_to),
      `A7 …and the letter itself tells the vendor to reply THERE, or nothing they send comes back (payload keys: ${Object.keys(msg).join(',')})`);
  }

  /* ═════════════════ B. EXACTLY ONCE ═══════════════════════════════════════ */
  {
    const before = sent.length;
    const again = await desk.place(loan, 'title', { staffId });
    assert(again.ok === false && again.status === 409,
      `B1 a second press is refused (got ${again.status})`);
    assert(sent.length === before,
      'B2 …and NO second letter reached the title company — asserted on the mailer, because a 409 that emails anyway has refused nothing');

    const forced = await desk.place(loan, 'title', { staffId, force: true });
    assert(forced.ok === true && sent.length === before + 1,
      'B3 …while a DELIBERATE re-send does go, because sending again is sometimes the right thing and the desk must not make it impossible');
    assert((await orderRows(loan)).length === 1,
      'B4 …onto the SAME order rather than a second one');
  }

  /* ═════════════════ E. THE REPLY COMES BACK ═══════════════════════════════
     Driven through the real inbound handler with a synthetic retrieved email, so
     the filing rules run exactly as they do in production; only the provider
     retrieval is stood in for. */
  {
    /* THE REF IS DERIVED FROM THE REAL REPLY ADDRESS, never hand-built. That is
       the half of this feature worth proving: the per-order address is what makes
       a vendor's reply reach the order that asked, and a hand-made ref would
       skip exactly that step (and hide, say, a key named `kind` where the code
       reads `orderKind`). */
    const refs = inbox.ordersFromEvent({ to: [placed.reply_to] });
    assert(refs.length === 1 && String(refs[0].loanId) === String(loan) && refs[0].orderKind === 'title',
      `E0 the reply address resolves to THIS loan's title order (got ${JSON.stringify(refs)})`);
    const ref = refs[0];
    const full = {
      id: `${uniq}-reply`,
      from: vendorEmail,
      to: [placed.reply_to],
      subject: 'Re: title order',
      text: 'Here is the commitment.',
      html: '<p>Here is the commitment.</p>',
      attachments: [{
        filename: 'title-commitment.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('%PDF-1.4 title commitment').toString('base64'),
      }],
    };
    inlineAttachments = full.attachments;
    let res = null;
    try { res = await inbox.handleOne(ref, { data: { email_id: full.id } }, full); }
    catch (e) { res = { status: `threw: ${(e && e.message) || e}` }; }
    /* ASSERTED ON WHAT IT FILED, not on the absence of a throw. An earlier cut
       checked only that nothing threw, and passed happily on `filed:0,skipped:1`
       — a reply whose document went nowhere reads as success. */
    assert(res && Number(res.filed || 0) >= 1,
      `E1 the vendor's reply is handled and the document is FILED (got ${JSON.stringify(res).slice(0, 200)})`);

    const evs = (await db.query(
      `SELECT direction, subject FROM lt_order_events WHERE order_id=$1::uuid AND direction='inbound'`,
      [placed.id])).rows;
    assert(evs.length >= 1,
      'E2 …and lands on THAT order’s thread, so the desk shows the conversation rather than a silent inbox');

    const docs = (await db.query(
      `SELECT id, filename, lt_loan_id, checklist_item_id FROM documents
        WHERE lt_loan_id=$1::uuid AND filename ILIKE '%title-commitment%'`, [loan])).rows;
    assert(docs.length >= 1,
      'E3 …with the document they sent filed onto the loan — the whole point of the per-order reply address');
    assert(docs.length >= 1 && String(docs[0].checklist_item_id) === String(titleCond),
      'E4 …and onto the CONDITION that asked for it, in the shared Condition Center — filing it on the loan alone would leave the condition still waiting');
  }

  /* ═════════════════ F. SCOPE ══════════════════════════════════════════════ */
  {
    // The OTHER loan has its own vendor and no order. A reply naming this loan's
    // order must not file against it.
    const before = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE lt_loan_id=$1::uuid`, [other])).rows[0].n);
    /* THE OTHER LOAN'S OWN ADDRESS — well-formed, resolving to a real loan and a
       real kind, with NO order behind it. Reusing the first loan's address here
       would refuse for the wrong reason (it names another loan), and the point
       is that an address alone can never CREATE the order it claims to answer. */
    const strayTo = ltOrderReplyTo(other, 'title');
    const refs2 = inbox.ordersFromEvent({ to: [strayTo] });
    assert(refs2.length === 1 && String(refs2[0].loanId) === String(other),
      'F0 (fixture) that address really does resolve to the other loan — so F1 refuses for the right reason');
    const ref = refs2[0];
    const full = {
      id: `${uniq}-stray`,
      from: vendorEmail,
      to: [strayTo],
      subject: 'Re: title order',
      text: 'Stray.',
      attachments: [{
        filename: 'stray.pdf', contentType: 'application/pdf',
        content: Buffer.from('%PDF-1.4 stray').toString('base64'),
      }],
    };
    inlineAttachments = full.attachments;
    try { await inbox.handleOne(ref, { data: { email_id: full.id } }, full); } catch (_) { /* refusing by throwing is still refusing */ }
    const after = Number((await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE lt_loan_id=$1::uuid`, [other])).rows[0].n);
    assert(after === before,
      'F1 a loan with no order of its own files nothing — a reply cannot create the order it claims to answer');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
