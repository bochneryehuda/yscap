'use strict';
/**
 * THE LOGIN-FREE CONDITION LINK, ON A LONG-TERM LOAN — proven end to end over
 * REAL HTTP, against a REAL Postgres, through the REAL doors.
 *
 * The owner asked for this on 2026-08-28: *"another way for borrowers to manage
 * their conditions if they're not so technical. A more simple condition center
 * for them, with an email directly with links to upload and enter the
 * information over there … without him being able to set up an account or
 * portal."* The short-term side has had it since it shipped; this is the same
 * link, the same module, the same email, pointed at the second product.
 *
 * NAMED `test-lt-…` DELIBERATELY: the separation gate reads a suite's FILENAME
 * as its product identity, and this one names `lt_loans` and
 * `condition_links.lt_loan_id`.
 *
 * ── WHY A DB SUITE AND NOT ONLY THE PURE ONE ────────────────────────────────
 *
 * `test-lt-guest-link-jail-pure.js` proves the RULE — which door a guest may
 * reach, and that a token naming one product is refused against the other. It
 * cannot prove any of the things that actually broke on the short-term side
 * when this was built there: that a link MINTS, that the token the email
 * carries EXCHANGES, that the session it produces really is refused by Express
 * at a door the rule says no to, and that revoking the row kills the session on
 * the very next request. Those are facts about the wiring, and only running it
 * can see them.
 *
 * ── WHAT IT PINS ────────────────────────────────────────────────────────────
 *
 *  A. THE ROUND TRIP a borrower actually does: the desk sends, the email
 *     carries a token, the token opens a session, the session lists their
 *     conditions and files a document against one.
 *
 *  B. THE JAIL, WHICH IS THE WHOLE REASON THIS IS SAFE. The loan LIST is
 *     refused — a forwarded link must not disclose what else this person has
 *     borrowed. Another loan of their own is refused. Every short-term door is
 *     refused. Each refusal is asserted on the WRITE as well as the read: a
 *     door that answers 403 and files the document anyway has refused nothing.
 *
 *  C. THE REFUSALS THE DESK SEES BEFORE IT SENDS, and again at the send: an
 *     unlinked borrower, an archived loan, and a loan with nothing outstanding.
 *
 *  D. REVOCATION IS IMMEDIATE, and scoped to the loan in the URL.
 *
 *  E. THE SHORT-TERM SIDE IS BYTE-FOR-BYTE UNCHANGED — the control that makes
 *     every assertion above mean something. If the short-term link stopped
 *     working, "the long-term one works" would be worthless.
 *
 * PROBES THE DATABASE FIRST — `ensureSchema` gives up on an unreachable
 * database WITHOUT throwing, so a suite that does not probe prints a confident
 * ok against nothing at all.
 *
 * Run: DATABASE_URL=... node scripts/test-lt-guest-link-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-guest-link-db (no DATABASE_URL)'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.APP_URL = process.env.APP_URL || 'https://pilot.test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

process.env.STORAGE_DIR = process.env.STORAGE_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'lt-guest-'));

const db = require('../src/db');
const C = require('../src/lib/crypto');
const settingsStore = require('../src/longterm/settings/store');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

const uniq = `ltgl-${process.pid}-${Date.now()}`;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/* THE MAILER IS STUBBED AND INSPECTED, not merely allowed to no-op.
   With EMAIL_PROVIDER=none a send "succeeds" having addressed nobody, so a
   suite that only asserts `ok:true` proves nothing about who was written to or
   what the body carried — and the TOKEN only ever exists in that body (the row
   stores its hash). Capturing the wire payload is the only way to get it, and
   is the same discipline `test-draw-email-db.js` records. */
const mailer = require('../src/lib/email');
const outbox = [];
mailer.sendMail = async (msg) => { outbox.push(msg); return { ok: true, id: `stub-${outbox.length}` }; };

/** The clear token out of a sent email — the ONE place it is ever legible. */
function tokenFrom(msg) {
  const hay = `${(msg && msg.text) || ''}\n${(msg && msg.html) || ''}`;
  // The email emits the tracking-proof bounce: /link/r?to=<encoded route>.
  const m = hay.match(/[?&]to=([^"'\s&]+)/);
  if (!m) return null;
  const route = decodeURIComponent(m[1]);
  const t = route.match(/[?&]t=([A-Za-z0-9_-]{16,64})/);
  return t ? t[1] : null;
}

(async () => {
  const probe = await db.query('SELECT 1 AS one');
  if (!probe.rows[0] || Number(probe.rows[0].one) !== 1) throw new Error('database probe failed');
  console.log('PASS 0 the database answered a probe before anything else ran');

  const { ensureSchema } = require('../src/migrate-boot');
  await ensureSchema();

  const app = require('../src/server');
  let server = null;
  try {
    /* ───────────────────────────────── seed ────────────────────────────────── */
    const { rows: sr } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, title, nmls)
       VALUES ($1,'Guest Link Officer','super_admin',true,'Loan Officer','123456') RETURNING id, token_version`,
      [`${uniq}-officer@example.test`]);
    const staff = { id: String(sr[0].id),
      token: C.signJwt({ sub: String(sr[0].id), kind: 'staff', role: 'super_admin', tv: sr[0].token_version, sid: uniq }) };

    const mkBorrower = async (tag) => (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1,$2,$3) RETURNING id`,
      ['Bo', tag, `${uniq}-${tag}@example.test`])).rows[0].id;
    const borrower = String(await mkBorrower('mine'));

    const mkLoan = async (n, borrowerId, extra = '') => (await db.query(
      `INSERT INTO lt_loans (id, loan_number, borrower_name, borrower_id, term_months,
                             program_name, loan_amount, loan_folder${extra ? `, ${extra}` : ''})
       VALUES ($1::uuid,$2,'Bo Rrower',$3,360,'Investor DSCR 30 YEAR FRM',500000,'Pipeline'${extra ? ', true' : ''})
       RETURNING id`,
      [crypto.randomUUID(), `${uniq}-${n}`, borrowerId])).rows[0].id;

    const loan = String(await mkLoan('main', borrower));
    const otherLoan = String(await mkLoan('other', borrower));      // SAME borrower, different loan
    const archived = String(await mkLoan('arch', borrower, 'encompass_archived'));
    const unlinked = String(await mkLoan('unlinked', null));

    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip)
       VALUES ($1::uuid,'11 Guest Way','Lakewood','NJ','08701')
       ON CONFLICT (loan_id) DO UPDATE SET street = EXCLUDED.street`, [loan]);

    const mkItem = async (loanId, label, audience = 'both') => String((await db.query(
      `INSERT INTO checklist_items
         (scope, lt_loan_id, category, label, borrower_label, hint, borrower_hint,
          audience, status, item_kind, is_required, notes)
       VALUES ('lt_loan',$1::uuid,'prior_to_approval',$2,$3,'internal hint','what you need to send',
               $4,'outstanding','document',true,'INTERNAL note')
       RETURNING id`,
      [loanId, `INTERNAL ${label}`, `Please send ${label}`, audience])).rows[0].id);

    const cond = await mkItem(loan, 'your last two bank statements');
    const condStaff = await mkItem(loan, 'the flood certificate', 'staff');
    const condOther = await mkItem(otherLoan, 'their insurance binder');
    /* THE ARCHIVED LOAN GETS A REAL OUTSTANDING CONDITION ON PURPOSE. Without
       one it would be refused for having nothing to send, and C3 would pass
       whether or not the archive rule exists at all — the assertion would be
       true for the wrong reason. With it, the archive check is the only thing
       standing between that loan and an email. */
    await mkItem(archived, 'something still outstanding');

    await db.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company','borrower.longTermVisible','true'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    settingsStore.bust();

    // The SHORT-TERM control file — section E's whole point.
    const rtlApp = String((await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1::uuid,'underwriting') RETURNING id`,
      [borrower])).rows[0].id);
    const rtlCond = String((await db.query(
      `INSERT INTO checklist_items (scope, application_id, category, label, borrower_label, hint,
                                    borrower_hint, audience, status, item_kind, is_required)
       VALUES ('application',$1::uuid,'p1','INTERNAL rtl','Please send the RTL one','h','send it',
               'both','outstanding','document',true) RETURNING id`, [rtlApp])).rows[0].id);

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const CC = '/api/lt/condition-center';

    const call = async (method, p, token, body) => {
      const res = await fetch(base + p, {
        method,
        headers: Object.assign(token ? { authorization: `Bearer ${token}` } : {},
          body ? { 'content-type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const raw = await res.text();
      let parsed = null; try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
      return { status: res.status, body: parsed, raw };
    };

    /* ═════════════════ A. THE ROUND TRIP A BORROWER ACTUALLY DOES ═══════════ */

    const pre = await call('GET', `${CC}/loans/${loan}/outreach`, staff.token);
    assert(pre.status === 200, `A1 the desk can preview the outreach (${pre.status})`);
    assert(Array.isArray(pre.body && pre.body.blockers) && pre.body.blockers.length === 0,
      `A2 …with nothing blocking it (${JSON.stringify(pre.body && pre.body.blockers)})`);
    assert(((pre.body || {}).items || []).length === 1,
      `A3 …and the ONE borrower-facing condition, never the staff-only one (${((pre.body || {}).items || []).length})`);
    assert(((pre.body || {}).recipients || []).some((r) => r.email === `${uniq}-mine@example.test`),
      'A4 …addressed to the borrower off their own profile record');
    assert(String((pre.body || {}).propertyLine || '').includes('11 Guest Way'),
      `A5 …naming the property the loan is secured by (${(pre.body || {}).propertyLine})`);

    outbox.length = 0;
    const sent = await call('POST', `${CC}/loans/${loan}/outreach`, staff.token,
      { emails: [`${uniq}-mine@example.test`] });
    assert(sent.status === 200 && sent.body && sent.body.ok === true,
      `A6 the send answers ok (${sent.status} ${JSON.stringify(sent.body && sent.body.error)})`);
    assert(outbox.length === 1, `A7 …and exactly ONE email left the building (${outbox.length})`);
    assert(String(outbox[0].to) === `${uniq}-mine@example.test`,
      `A8 …to the borrower, on the wire, not merely reported (${outbox[0].to})`);

    const token = tokenFrom(outbox[0]);
    assert(!!token, 'A9 the email carries a usable link token');

    const ex = await call('POST', '/auth/condition-link', null, { token });
    assert(ex.status === 200 && ex.body && ex.body.ok === true,
      `A10 the token exchanges for a session (${ex.status})`);
    assert((ex.body || {}).product === 'long_term',
      `A11 …and the screen is told WHICH product it landed on (${(ex.body || {}).product})`);
    assert(String((ex.body || {}).ltLoanId) === loan && (ex.body || {}).applicationId == null,
      'A12 …carrying the long-term loan and no short-term file');
    const guest = (ex.body || {}).accessToken;
    assert(!!guest, 'A13 …and a real access token');

    const list = await call('GET', `/api/lt/my/loans/${loan}/conditions`, guest);
    assert(list.status === 200, `A14 the guest can read the loan's conditions (${list.status})`);
    const seen = [].concat(...(((list.body || {}).buckets || []).map((b) => b.conditions || [])));
    assert(seen.length === 1 && String(seen[0].id) === cond,
      `A15 …seeing the one addressed to them (${seen.length})`);
    assert(seen[0] && seen[0].label === 'Please send your last two bank statements',
      `A16 …in the borrower's own wording, never the internal label (${seen[0] && seen[0].label})`);

    const up = await call('POST', `/api/lt/my/loans/${loan}/conditions/${cond}/documents`, guest,
      { filename: 'statement.pdf', contentType: 'application/pdf', dataBase64: b64('%PDF-1.4 guest') });
    assert(up.status === 200 || up.status === 201,
      `A17 …and file a document against it (${up.status} ${up.raw.slice(0, 160)})`);
    const filed = (await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE checklist_item_id = $1::uuid`, [cond])).rows[0].n;
    assert(Number(filed) === 1, `A18 …which really landed on that condition (${filed})`);

    /* ══════════════ B. THE JAIL — every door this link may NOT reach ════════ */

    const listAll = await call('GET', '/api/lt/my/loans', guest);
    assert(listAll.status === 403,
      `B1 the loan LIST is refused — a forwarded link never discloses the rest of the book (${listAll.status})`);

    const otherRead = await call('GET', `/api/lt/my/loans/${otherLoan}/conditions`, guest);
    assert(otherRead.status === 403,
      `B2 …and their OWN other loan is refused too — the link opens one file (${otherRead.status})`);

    const otherWrite = await call('POST', `/api/lt/my/loans/${otherLoan}/conditions/${condOther}/documents`, guest,
      { filename: 'x.pdf', contentType: 'application/pdf', dataBase64: b64('%PDF-1.4 x') });
    assert(otherWrite.status === 403, `B3 …on the WRITE as well as the read (${otherWrite.status})`);
    const strayCount = (await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE checklist_item_id = $1::uuid`, [condOther])).rows[0].n;
    assert(Number(strayCount) === 0,
      `B4 …and nothing was filed anyway — a 403 that writes has refused nothing (${strayCount})`);

    for (const [m, p] of [
      ['GET', '/api/borrower/applications'],
      ['GET', `/api/borrower/applications/${rtlApp}`],
      ['GET', `/api/borrower/applications/${rtlApp}/checklist`],
      ['GET', '/api/lt/condition-center/loans/' + loan],
      ['POST', `/api/lt/my/loans/${loan}/conditions/${cond}/documents/../../../../foo`],
    ]) {
      const r = await call(m, p, guest, m === 'POST' ? { x: 1 } : undefined);
      assert(r.status === 403 || r.status === 404,
        `B5 ${m} ${p} is refused to a long-term guest (${r.status})`);
    }

    /* ══════════ C. THE DESK'S REFUSALS, BEFORE AND AT THE SEND ══════════════ */

    const unl = await call('GET', `${CC}/loans/${unlinked}/outreach`, staff.token);
    assert(unl.status === 200 && ((unl.body || {}).blockers || []).some((b) => /borrower profile/i.test(b)),
      `C1 a loan with no confirmed borrower says so, in words (${JSON.stringify((unl.body || {}).blockers)})`);
    const unlSend = await call('POST', `${CC}/loans/${unlinked}/outreach`, staff.token,
      { emails: ['someone@example.test'] });
    assert(unlSend.status === 409, `C2 …and the send refuses it too, not only the screen (${unlSend.status})`);

    const arch = await call('POST', `${CC}/loans/${archived}/outreach`, staff.token,
      { emails: [`${uniq}-mine@example.test`] });
    assert(arch.status === 409 && /archiv/i.test(String((arch.body || {}).error || '')),
      `C3 an archived loan does not email its borrower (${arch.status} ${(arch.body || {}).error})`);

    // Nothing outstanding: settle the only borrower-facing condition on a loan.
    await db.query(`UPDATE checklist_items SET status='satisfied' WHERE id=$1::uuid`, [condOther]);
    const none = await call('POST', `${CC}/loans/${otherLoan}/outreach`, staff.token,
      { emails: [`${uniq}-mine@example.test`] });
    assert(none.status === 409 && /nothing is outstanding/i.test(String((none.body || {}).error || '')),
      `C4 a loan with nothing outstanding sends nothing (${none.status} ${(none.body || {}).error})`);

    const bad = await call('POST', `${CC}/loans/${loan}/outreach`, staff.token, { emails: ['not-an-email'] });
    assert(bad.status === 400, `C5 a malformed address is refused before anything is minted (${bad.status})`);
    const tooMany = await call('POST', `${CC}/loans/${loan}/outreach`, staff.token,
      { emails: Array.from({ length: 9 }, (_, i) => `a${i}@example.test`) });
    assert(tooMany.status === 400, `C6 …and so is a blast (${tooMany.status})`);

    /* ═════════════════ D. REVOCATION IS IMMEDIATE AND SCOPED ════════════════ */

    const stillOk = await call('GET', `/api/lt/my/loans/${loan}/conditions`, guest);
    assert(stillOk.status === 200, 'D1 the session still works right up to the revoke — the control');

    const linkRow = (await db.query(
      `SELECT id FROM condition_links WHERE lt_loan_id=$1::uuid ORDER BY created_at DESC LIMIT 1`,
      [loan])).rows[0];
    assert(!!linkRow, 'D2 the link was recorded against the LONG-TERM loan, not an application');

    const wrongLoan = await call('POST', `${CC}/loans/${otherLoan}/outreach/${linkRow.id}/revoke`, staff.token);
    assert(wrongLoan.status === 404,
      `D3 …and it cannot be revoked from a different loan's route (${wrongLoan.status})`);

    const rev = await call('POST', `${CC}/loans/${loan}/outreach/${linkRow.id}/revoke`, staff.token);
    assert(rev.status === 200, `D4 the desk can revoke it (${rev.status})`);
    const dead = await call('GET', `/api/lt/my/loans/${loan}/conditions`, guest);
    assert(dead.status === 401 || dead.status === 403,
      `D5 …and the session dies on the very next request (${dead.status})`);

    /* ═════ E. THE SHORT-TERM SIDE IS UNCHANGED — the control that matters ═══ */

    const conditionLink = require('../src/lib/condition-link');
    const { token: rtlToken } = await conditionLink.mintLink({
      applicationId: rtlApp, borrowerId: borrower, email: `${uniq}-mine@example.test`, createdBy: staff.id,
    });
    const rtlEx = await call('POST', '/auth/condition-link', null, { token: rtlToken });
    assert(rtlEx.status === 200 && (rtlEx.body || {}).product === 'short_term',
      `E1 a short-term link still exchanges and reports its own product (${(rtlEx.body || {}).product})`);
    assert(String((rtlEx.body || {}).applicationId) === rtlApp && (rtlEx.body || {}).ltLoanId == null,
      'E2 …carrying the application and no long-term loan');
    const rtlGuest = (rtlEx.body || {}).accessToken;
    const rtlRead = await call('GET', `/api/borrower/applications/${rtlApp}/checklist`, rtlGuest);
    assert(rtlRead.status === 200, `E3 …and reaches the short-term condition list exactly as before (${rtlRead.status})`);

    // AND IT CANNOT CROSS. The short-term guest is refused every long-term door.
    const cross = await call('GET', `/api/lt/my/loans/${loan}/conditions`, rtlGuest);
    assert(cross.status === 403,
      `E4 a short-term guest is refused the long-term doors (${cross.status})`);

    console.log(failures
      ? `\ntest-lt-guest-link-db: ${failures} FAILED`
      : '\ntest-lt-guest-link-db: all checks passed');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await db.pool.end().catch(() => {});
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
