'use strict';
/**
 * THE CARD AND THE PHOTO ID LIVE ON THE PERSON — proven over REAL HTTP, against a
 * REAL Postgres, through the REAL doors.
 *
 * The owner's share-the-code directive, item 7: *"Profile-linked conditions —
 * photo ID from the shared profile; the credit-card-for-appraisal card
 * BIDIRECTIONAL with the shared profile."* Both long-term conditions already
 * DECLARED it (`readsFromBorrowerProfile` / `savesToBorrowerProfile`) and told
 * the borrower in as many words that an ID or a card given before is already on
 * file. No long-term module referenced `saved_card_*` or `photo_id_document_id`
 * at all — the same promise-with-nothing-behind-it as the vesting entity.
 *
 * NAMED `test-lt-…` DELIBERATELY: the separation gate reads a suite's FILENAME as
 * its product identity, and this one names `lt_loans`.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. NOTHING ON FILE reads as nothing on file — and an unlinked loan is refused
 *     rather than silently saving a card against nobody.
 *  B. THE CARD GOES ONTO THE PERSON, not onto any file: asserted on
 *     `borrowers.saved_card_*` AND on `application_payment_cards` staying empty,
 *     because a long-term twin of that per-file table is the one outcome this
 *     whole design exists to avoid.
 *  C. THE NUMBER NEVER COMES BACK. Not from the save, not from the read. The
 *     assertion is on the RESPONSE BODY, because a module that returns a PAN
 *     puts it in a log the first time a screen renders it.
 *  D. THE VALIDATOR IS THE SHARED ONE — a bad number, a bad code and an expired
 *     card are refused in the short-term side's own words, so a card one product
 *     accepts is never one the other rejects.
 *  E. BIDIRECTIONAL, WHICH IS THE POINT: a card saved from a long-term loan is
 *     there for the NEXT loan, and for the short-term side's own reader.
 *  F. THE PHOTO ID READ — an ID already on the profile answers the long-term
 *     condition, which is what its hint promises.
 *  G. SCOPE — another borrower's card is not this loan's.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable database
 * WITHOUT throwing, so a suite that does not probe prints a confident ok against
 * nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-profile-links-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-profile-links-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-prof-links-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltpl-${process.pid}-${Date.now()}`;
// A well-known Visa test number: Luhn-valid, and not anybody's card.
const TEST_PAN = '4111111111111111';
const nextYear = new Date().getUTCFullYear() + 3;

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const app = require('../src/server');
  let server = null;

  try {
    const { rows: sr } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'LT Profile Links Admin','super_admin',true) RETURNING id, token_version`,
      [`${uniq}@example.test`]);
    const token = C.signJwt({
      sub: String(sr[0].id), kind: 'staff', role: 'super_admin', tv: sr[0].token_version, sid: uniq });

    const mkBorrower = async (tag) => String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,$2,$3) RETURNING id`,
      [uniq, tag, `${uniq}-${tag}@example.test`])).rows[0].id);
    const borrower = await mkBorrower('owner');
    const stranger = await mkBorrower('stranger');

    const mkLoan = async (n, borrowerId) => String((await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder)
       VALUES ($1::uuid,$2,'Bo Rrower',$3,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline')
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`, borrowerId === null ? null : borrowerId])).rows[0].id);

    const loan = await mkLoan('main', borrower);
    const loan2 = await mkLoan('second', borrower);
    const orphan = await mkLoan('orphan', null);
    const strangerLoan = await mkLoan('stranger', stranger);

    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    const call = (method, p, body) => new Promise((resolve) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, method, path: p,
        headers: Object.assign({ Authorization: `Bearer ${token}` },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      }, (res) => {
        let raw = '';
        res.on('data', (d) => { raw += d; });
        res.on('end', () => {
          let json = null; try { json = JSON.parse(raw); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, json, raw });
        });
      });
      req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
      if (payload) req.write(payload);
      req.end();
    });

    const links = (l) => `/api/lt/condition-center/loans/${l}/profile-links`;
    const cardDoor = (l) => `/api/lt/condition-center/loans/${l}/appraisal-card`;

    /* ═════════════════ A. NOTHING ON FILE, AND NOBODY TO SAVE TO ═════════════ */

    const a1 = await call('GET', links(loan));
    assert(a1.status === 200 && a1.json && a1.json.card && a1.json.card.available === false,
      `A1 with nothing on file the card reads as not available (got ${a1.status})`);
    assert(a1.json.photoId && a1.json.photoId.available === false,
      'A2 …and so does the photo ID — "nothing on file" is an answer, not an error');
    assert(a1.json.unreadable === false,
      'A3 …and it is NOT reported unreadable — "we looked and there is nothing" is a different fact from "we could not look"');

    const a4 = await call('POST', cardDoor(orphan), {
      number: TEST_PAN, cvc: '123', expMonth: 4, expYear: nextYear, zip: '11219' });
    assert(a4.status === 409,
      `A4 a loan with no borrower profile is refused — there is nowhere to keep a card (got ${a4.status})`);

    /* ═════════════════ B. THE CARD GOES ONTO THE PERSON ══════════════════════ */

    const b1 = await call('POST', cardDoor(loan), {
      number: TEST_PAN, cvc: '123', expMonth: 4, expYear: nextYear, zip: '11219' });
    assert(b1.status === 201, `B1 the card is saved (got ${b1.status} ${b1.raw.slice(0, 140)})`);

    const prof = (await db.query(
      `SELECT save_card_for_reuse, saved_card_last4, saved_card_brand, saved_card_exp,
              saved_card_billing_zip,
              (saved_card_number_encrypted IS NOT NULL) AS has_number
         FROM borrowers WHERE id=$1::uuid`, [borrower])).rows[0];
    assert(prof && prof.save_card_for_reuse === true && prof.has_number === true,
      'B2 …onto the BORROWER’S OWN RECORD — the shared identity zone, which is where the reusable card has always lived');
    assert(prof && String(prof.saved_card_last4) === '1111' && prof.saved_card_brand === 'Visa',
      'B3 …with the display fields a screen needs, and the brand read by the shared module');

    /* THE SCOPED COUNT BELOW NEEDS SOMETHING IT COULD FIND, or it proves
       nothing. `application_payment_cards.application_id` is NOT NULL, so with
       no short-term file for this borrower the join can never match and the
       assertion passes whatever the code does — a tautology, which is the trap
       the first scoped cut fell into. So the person gets a real short-term file
       too. That is also the honest shape of this feature: the whole point of a
       shared profile is that ONE PERSON can hold a short-term file and a
       long-term loan at once, and the card must still live in exactly one
       place. With this row present, wiring the long-term save to the RTL
       per-file writer — `saveApplicationCard`, which the crossing ledger marks
       OFF LIMITS — would put a row here and B4 would catch it. */
    const rtlFile = (await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1::uuid,'underwriting') RETURNING id`,
      [borrower])).rows[0].id;

    /* SCOPED TO THIS BORROWER, NEVER A GLOBAL COUNT — and that is the whole
       lesson of this assertion's first cut. It asked
       `SELECT count(*) FROM application_payment_cards` with no WHERE at all,
       so it was really asking "has ANY suite in this database ever stored a
       per-file card?" — and in the full chain the answer is yes, because RTL's
       own suites legitimately store them. It passed alone and failed in the
       chain: a flaky assertion of my own making, and precisely the
       "assert on the row, never on the aggregate count" trap this repo already
       records elsewhere. The claim worth proving is about THIS card save, so
       it is scoped to the borrower the save was made against — a borrower this
       fixture created seconds ago, so any row here could only have come from
       the code under test. */
    const perFile = Number((await db.query(
      `SELECT count(*)::int AS n
         FROM application_payment_cards pc
         JOIN applications a ON a.id = pc.application_id
        WHERE a.borrower_id = $1::uuid`, [borrower])).rows[0].n);
    assert(perFile === 0,
      `B4 …and NO per-file card row was created for this borrower, who also holds short-term file ${rtlFile} — a long-term twin of application_payment_cards would be a second store of a card number, which is the one outcome this design exists to avoid`);

    /* AND THE STRUCTURAL HALF, which no accumulated state can touch: there is
       no Long-Term card table at all. B4 can only speak about the RTL table
       (and could not be written against an LT twin that does not exist yet);
       this asks the database's own catalogue whether one has appeared. A
       long-term twin would be an `lt_*` table carrying a card number, and the
       one and only place a card number may live is `borrowers`. */
    const twins = (await db.query(
      `SELECT c.table_name || '.' || c.column_name AS what
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name LIKE 'lt\\_%'
          AND (c.column_name LIKE '%card_number%' OR c.column_name LIKE '%card_last4%')
        ORDER BY 1`)).rows.map((x) => x.what);
    assert(twins.length === 0,
      `B4b …and the long-term side has no card table of its own at all — the card lives on the person, once (found: ${twins.join(', ') || 'none'})`);

    /* ═════════════════ C. THE NUMBER NEVER COMES BACK ════════════════════════ */

    assert(!b1.raw.includes(TEST_PAN),
      'C1 the SAVE response does not contain the card number');
    const c2 = await call('GET', links(loan));
    assert(!c2.raw.includes(TEST_PAN),
      'C2 …and neither does the READ — nothing on this path ever decrypts the number');
    assert(c2.json.card.available === true && c2.json.card.last4 === '1111',
      'C3 …while still saying enough for a screen to offer "use the card on file"');
    assert(c2.json.card.expired === false,
      'C4 …and reporting an in-date card as in date, through the shared module’s own expiry rule');

    /* ═════════════════ D. THE VALIDATOR IS THE SHARED ONE ════════════════════ */

    const bad = await call('POST', cardDoor(loan), {
      number: '4111111111111112', cvc: '123', expMonth: 4, expYear: nextYear, zip: '11219' });
    assert(bad.status === 400 && /card number/i.test((bad.json && bad.json.error) || ''),
      `D1 a number that fails the checksum is refused in the shared module’s own words (got ${bad.status})`);

    const badCvc = await call('POST', cardDoor(loan), {
      number: TEST_PAN, cvc: '1', expMonth: 4, expYear: nextYear, zip: '11219' });
    assert(badCvc.status === 400 && /security code/i.test((badCvc.json && badCvc.json.error) || ''),
      'D2 …and so is a security code that is not 3 or 4 digits');

    const expired = await call('POST', cardDoor(loan), {
      number: TEST_PAN, cvc: '123', expMonth: 1, expYear: 2020, zip: '11219' });
    assert(expired.status === 400 && /expired/i.test((expired.json && expired.json.error) || ''),
      'D3 …and an already-expired card, before anything is stored');
    const stillOurs = (await db.query(
      `SELECT saved_card_exp FROM borrowers WHERE id=$1::uuid`, [borrower])).rows[0];
    assert(stillOurs && String(stillOurs.saved_card_exp).endsWith(String(nextYear)),
      'D4 …and NONE of those three refusals overwrote the good card already on file');

    /* ═════════════════ E. BIDIRECTIONAL ══════════════════════════════════════ */

    const e1 = await call('GET', links(loan2));
    assert(e1.status === 200 && e1.json.card.available === true && e1.json.card.last4 === '1111',
      'E1 the NEXT long-term loan for the same borrower already has the card — which is the whole promise the condition’s hint makes');

    const shared = await require('../src/lib/appraisal-card').getSavedCard(borrower);
    assert(shared && shared.available === true && shared.last4 === '1111',
      'E2 …and the SHORT-TERM side’s own reader sees the very same card — one card, one place, both products');

    /* ═════════════════ F. THE PHOTO ID READ ══════════════════════════════════ */

    const { ref, provider } = await require('../src/lib/storage')
      .save(Buffer.from('%PDF-1.4 a driving licence'), { filename: 'licence.pdf' });
    const docId = String((await db.query(
      `INSERT INTO documents (borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind)
       VALUES ($1::uuid,'licence.pdf','application/pdf',25,$2,$3,'borrower',$1::uuid,'photo_id')
       RETURNING id`, [borrower, provider, ref])).rows[0].id);
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2::uuid WHERE id=$1::uuid`, [borrower, docId]);

    const f1 = await call('GET', links(loan));
    assert(f1.json.photoId && f1.json.photoId.available === true
      && String(f1.json.photoId.documentId) === docId,
      'F1 an ID already on the profile answers the long-term condition — "an ID given on any previous loan is already here"');

    /* ═════════════════ G. SCOPE ══════════════════════════════════════════════ */

    const g1 = await call('GET', links(strangerLoan));
    assert(g1.status === 200 && g1.json.card.available === false && g1.json.photoId.available === false,
      'G1 another borrower’s loan sees neither the card nor the ID — the profile is read through the LOAN’S OWN borrower, never a shared cache');

    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  } finally {
    if (server) server.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
