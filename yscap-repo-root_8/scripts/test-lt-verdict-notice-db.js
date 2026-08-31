'use strict';
/**
 * THE BORROWER IS TOLD WHEN A LONG-TERM DOCUMENT COMES BACK — proven over REAL
 * HTTP, against a REAL Postgres, with the MAILER STUBBED AND INSPECTED.
 *
 * ── WHY THIS SUITE EXISTS SEPARATELY FROM THE PARITY ENGINE ─────────────────
 *
 * The parity engine (`scripts/test-rtl-lt-parity-pure.js`) found this gap: on a
 * short-term file, sending a document back emails the borrower; on a long-term
 * file the review landed, the condition reopened, and nobody was told. But that
 * engine measures whether a product's CODE reaches a capability — it cannot see
 * whether the capability is WIRED. Unhooking the notice from the review route
 * leaves the shared claim still called from `guest/send.js` and the engine still
 * reads "long-term has it", which is exactly the back-end-nobody-calls class
 * this repo keeps warning about. So the wiring is proven here, by pressing the
 * button.
 *
 * ── AND IT IS ASSERTED ON THE WIRE ──────────────────────────────────────────
 *
 * A passing send against the `none` email provider proves nothing about who was
 * addressed or what was in it — the standing lesson from the investor-delivery
 * work. The mailer is replaced in the require cache and the captured payload is
 * read: who it went to, that it names the condition, that it carries the
 * reviewer's own words, and that it carries a way in.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. A REJECT tells the borrower, and says what is needed.
 *  B. A plain ACCEPT tells them NOTHING — accepting is an internal step
 *     (owner-directed 2026-07-20), and this must not quietly change that.
 *  C. ACCEPT-AND-ASK-FOR-MORE tells them, in different words.
 *  D. AN INTERNAL condition tells them nothing — they cannot see it, so a link
 *     to a list that does not contain it would read as a broken email.
 *  E. ONE EMAIL PER CONDITION, through the SHARED throttle — a tool that saves
 *     three formats of one answer and has all three sent back sends one email.
 *  F. A MAIL FAILURE NEVER FAILS THE REVIEW.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-verdict-notice-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-verdict-notice-db (no DATABASE_URL)'); process.exit(0); }
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
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-verdict-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');

/* THE MAILER, STUBBED BEFORE ANYTHING REQUIRES IT. `sendMail` is reached through
   `require('../../lib/email')` inside the notice, so replacing the module's
   export here is what the whole suite reads. `fromWithName` is kept because the
   notice calls it. */
const email = require('../src/lib/email');
const outbox = [];
const realSend = email.sendMail;
email.sendMail = async (msg) => { outbox.push(msg); return { ok: true, id: `stub-${outbox.length}` }; };

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltvn-${process.pid}-${Date.now()}`;

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  await require('../src/migrate-boot').ensureSchema();
  const app = require('../src/server');
  let server = null;

  try {
    const { rows: sr } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'LT Verdict Admin','super_admin',true) RETURNING id, token_version`,
      [`${uniq}@example.test`]);
    const staffId = String(sr[0].id);
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: sr[0].token_version, sid: uniq });

    const borrowerEmail = `${uniq}-borrower@example.test`;
    const borrower = String((await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,'Borrower',$2) RETURNING id`,
      [uniq, borrowerEmail])).rows[0].id);

    const loan = String((await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder)
       VALUES ($1::uuid,$2,'Bo Rrower',$3::uuid,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline')
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-1`, borrower])).rows[0].id);
    /* THE PROPERTY IS ITS OWN ROW — the email names the address, so a loan with
       no property would test a message the borrower would never receive. */
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip)
       VALUES ($1::uuid,'12 Test Street','Lakewood','NJ','08701')`, [loan]);

    /* THE CONDITIONS ARE THE ENGINE'S OWN, not hand-inserted: the notice sends
       the outstanding list, and a list built by hand would prove the email
       renders rather than that a real file produces one. */
    const ev = await require('../src/longterm/conditions-center/engine').evaluateLoan(loan);
    assert(ev.ok, `seed the engine attached this loan's conditions (${ev.degraded || 'ok'})`);

    const conds = (await db.query(
      `SELECT ci.id, ci.audience, t.code
         FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid`, [loan])).rows;
    const borrowerCond = conds.find((c) => c.audience !== 'staff');
    const staffCond = conds.find((c) => c.audience === 'staff');
    assert(!!borrowerCond, 'seed the loan carries a condition the borrower can see');
    if (!borrowerCond) throw new Error('no borrower-facing condition — the rest of the suite turns on it');

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

    const upload = (condId, name) => call('POST',
      `/api/lt/condition-center/loans/${loan}/conditions/${condId}/documents`,
      { filename: name, contentType: 'application/pdf',
        dataBase64: Buffer.from(`%PDF-1.4 ${name}`).toString('base64') });
    const review = (docId, body) => call('POST',
      `/api/lt/condition-center/documents/${docId}/review`, body);
    /* THE SHARED THROTTLE IS KEYED ON THE CONDITION AND LASTS FIVE MINUTES, so
       every case after the first would otherwise be suppressed by the one before
       it. Releasing the claim is what lets each case be tested on its own —
       which is also the proof, in E, that the claim is what suppresses. */
    const releaseClaims = () => db.query(
      `DELETE FROM audit_log WHERE entity_id = ANY($1::uuid[]) AND action LIKE 'lt_doc_%_emailed'`,
      [conds.map((c) => c.id)]);

    /* ═════════════════ A. A REJECT TELLS THE BORROWER ════════════════════════ */
    outbox.length = 0;
    const u1 = await upload(borrowerCond.id, 'first-try.pdf');
    assert(u1.status === 201, `A0 a document files onto the condition (got ${u1.status} ${u1.raw.slice(0, 120)})`);
    const r1 = await review(u1.json.documentId, { action: 'reject', reason: 'The second page is missing.' });
    assert(r1.status === 200, `A1 the reject is recorded (got ${r1.status} ${r1.raw.slice(0, 160)})`);
    assert(r1.json && r1.json.borrowerTold === true,
      `A2 …and the route SAYS the borrower was told, so the desk need not guess (${r1.json && r1.json.borrowerWhy})`);
    assert(outbox.length === 1, `A3 …and exactly one email really left the building (${outbox.length})`);
    const m1 = outbox[0] || {};
    assert(m1.to === borrowerEmail, `A4 …to the borrower (${m1.to})`);
    assert(typeof m1.html === 'string' && m1.html.length > 0 && typeof m1.text === 'string',
      'A5 …with a real body — a rendered object handed over as HTML is the failure a stubbed provider hides');
    assert(String(m1.text).includes('first-try.pdf'),
      'A6 …naming the document that came back');
    assert(String(m1.text).includes('The second page is missing.'),
      'A7 …and carrying the reviewer’s OWN words, which is the only part that tells them what to do');
    /* THE WAY IN IS THE SHARED LOGIN-FREE LINK. Asserted on its real shape
       (`/link/r?to=…%2Fguest%2Fconditions…`, which is what `condition-link`
       builds), not on a guess — a loose pattern here would pass on an email
       carrying no link at all, which is the one thing that would make the whole
       notice useless. */
    assert(String(m1.text).includes('/link/r?to=') && /guest%2Fconditions/.test(String(m1.text)),
      'A8 …and a login-free way in, so nothing about it needs a password');

    /* ═════════════════ B. A PLAIN ACCEPT SAYS NOTHING ════════════════════════ */
    await releaseClaims();
    outbox.length = 0;
    const u2 = await upload(borrowerCond.id, 'second-try.pdf');
    const r2 = await review(u2.json.documentId, { action: 'accept' });
    assert(r2.status === 200, `B1 a plain accept is recorded (got ${r2.status})`);
    assert(outbox.length === 0,
      `B2 …and the borrower is told NOTHING — accepting is an internal step (${outbox.length} email(s))`);

    /* ═════════════════ C. ACCEPT AND ASK FOR MORE ════════════════════════════ */
    await releaseClaims();
    outbox.length = 0;
    const u3 = await upload(borrowerCond.id, 'third-try.pdf');
    const r3 = await review(u3.json.documentId, { action: 'accept', requestMore: true, note: 'We also need last month.' });
    assert(r3.status === 200, `C1 accept-and-ask-for-more is recorded (got ${r3.status} ${r3.raw.slice(0, 140)})`);
    assert(outbox.length === 1, `C2 …and the borrower IS told (${outbox.length})`);
    assert(String((outbox[0] || {}).text || '').includes('We also need last month.'),
      'C3 …with what is still needed, in the reviewer’s own words');
    assert(!String((outbox[0] || {}).text || '').includes('sent it back'),
      'C4 …and NOT worded as a rejection — the document was kept, this is an "and also"');

    /* ═════════════════ D. AN INTERNAL CONDITION SAYS NOTHING ═════════════════ */
    if (staffCond) {
      await releaseClaims();
      outbox.length = 0;
      const u4 = await upload(staffCond.id, 'internal.pdf');
      const r4 = await review(u4.json.documentId, { action: 'reject', reason: 'wrong form' });
      assert(r4.status === 200, `D1 an internal condition’s document can still be sent back (got ${r4.status})`);
      assert(outbox.length === 0,
        `D2 …and the borrower is told nothing — they cannot see that condition (${outbox.length})`);
    } else {
      assert(false, 'D0 (fixture) the loan carries no internal condition, so D proves nothing');
    }

    /* ═════════════════ E. ONE EMAIL PER CONDITION ════════════════════════════
       A tool that saves three formats of one answer files three documents; all
       three sent back must produce ONE email, not three. */
    await releaseClaims();
    outbox.length = 0;
    const many = [];
    for (const n of ['export.html', 'export.xml', 'export.pdf']) {
      const u = await upload(borrowerCond.id, n);
      many.push(u.json.documentId);
    }
    for (const id of many) await review(id, { action: 'reject', reason: 'Please redo this.' });
    assert(outbox.length === 1,
      `E1 three documents on ONE condition sent back produce ONE email (${outbox.length})`);

    /* ═════════════════ F. A MAIL FAILURE NEVER FAILS THE REVIEW ══════════════ */
    await releaseClaims();
    outbox.length = 0;
    email.sendMail = async () => { throw new Error('the provider is down'); };
    const u5 = await upload(borrowerCond.id, 'fourth-try.pdf');
    const r5 = await review(u5.json.documentId, { action: 'reject', reason: 'still wrong' });
    email.sendMail = async (msg) => { outbox.push(msg); return { ok: true }; };
    assert(r5.status === 200,
      `F1 the review still succeeds when the email cannot be sent (got ${r5.status})`);
    assert(r5.json && r5.json.borrowerTold === false && !!r5.json.borrowerWhy,
      'F2 …and says so honestly rather than claiming the borrower was told');
    const stillRejected = (await db.query(
      `SELECT review_status FROM documents WHERE id=$1::uuid`, [u5.json.documentId])).rows[0];
    assert(stillRejected && stillRejected.review_status === 'rejected',
      'F3 …with the verdict itself recorded, which is what must never be lost');

    console.log(failures ? `\nFAILED ${failures} assertion(s)` : '\nOK test-lt-verdict-notice-db (all assertions passed)');
  } finally {
    email.sendMail = realSend;
    if (server) await new Promise((r) => server.close(r));
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
