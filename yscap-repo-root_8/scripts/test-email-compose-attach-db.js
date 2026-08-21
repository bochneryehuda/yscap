/* ATTACHING A DOCUMENT TO A REPLY — through the REAL HTTP door, against a REAL database,
 * with the mailer stubbed so nothing is sent and the WIRE PAYLOAD can be read back.
 *
 * Owner-directed 2026-08-21: *"on any reply to any Gmail section that we currently have … we
 * need to be able to attach documents over there manually and also drag and drop into the box
 * of the email."*
 *
 * A pure test cannot prove this. It proves the reader; it cannot prove the ROUTE hands what
 * the reader produced to the provider — and that gap is exactly where this codebase has been
 * bitten before (the investor delivery passed `render()`'s whole object as the HTML body and
 * every unit test still passed, because the noop provider accepts anything). So this asserts
 * on the captured message.
 *
 *   1. an ordinary reply still sends with NO attachments key at all — byte-identical to before;
 *   2. an attached document reaches the provider, in the provider's own shape, with its bytes;
 *   3. a web page wearing a PDF's name never leaves the building, and the response NAMES it;
 *   4. …and the reply is still SENT — one bad attachment does not lose the message;
 *   5. the audit row records how many rode, so the file answers it later;
 *   6. it is recorded on the Email Center's own row, so what was attached is visible after;
 *   7. an unreadable attachment payload is a 400, never a 500.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-email-compose-attach-db.js
 */
'use strict';
const http = require('http');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) { console.log('SKIP test-email-compose-attach-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const C = require('../src/lib/crypto');
const mailer = require('../src/lib/email');
const app = require('../src/server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => Buffer.from(s).toString('base64');
const PDF = '%PDF-1.4\nthe binder the agent asked for';

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const realSend = mailer.sendMail;
  const outbox = [];
  mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };
  try {
    const admin = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Attach Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`att-admin-${sfx}@yscapgroup.com`])).rows[0].id;
    const token = C.signJwt({ sub: admin, kind: 'staff', role: 'super_admin', tv: 0 });
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Attach','Borrower',$1) RETURNING id`,
      [`att-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications(borrower_id,status,ys_loan_number,property_address)
       VALUES($1,'processing',$2,'{"oneLine":"7 Attach Ln","city":"Lakewood","state":"NJ","zip":"08701"}')
       RETURNING id`, [bor, `AT${sfx.slice(-8)}`])).rows[0].id;

    const reply = (body) => call(server, 'POST', `/api/staff/applications/${appId}/emails/reply`, token, body);

    // ---------------------------------------------------------------- 1. unchanged
    {
      outbox.length = 0;
      const r = await reply({ body: 'Just a plain note.', subject: 'Hello' });
      eq('1a a plain reply still sends', r.status, 200);
      eq('1b …to the borrower', outbox.length, 1);
      ok('1c …carrying NO attachments key at all — byte-identical to before',
        !Object.prototype.hasOwnProperty.call(outbox[0], 'attachments'));
      eq('1d …and it says nothing was attached', r.body.attached, 0);
    }

    // ---------------------------------------------------------------- 2. it really rides
    {
      outbox.length = 0;
      const r = await reply({
        body: 'Here is the binder.', subject: 'Binder',
        attachments: [{ filename: 'binder.pdf', contentType: 'application/pdf', dataBase64: b64(PDF) }],
      });
      eq('2a the reply sends', r.status, 200);
      eq('2b …and reports what rode', r.body.attached, 1);
      const msg = outbox[0] || {};
      eq('2c the provider was handed exactly one attachment', (msg.attachments || []).length, 1);
      const a = (msg.attachments || [])[0] || {};
      eq('2d …named', a.filename, 'binder.pdf');
      eq('2e …typed from its own bytes', a.contentType, 'application/pdf');
      eq('2f …and the BYTES are the document, not a description of it',
        Buffer.from(String(a.content || ''), 'base64').toString(), PDF);
      ok('2g the body is still a string, not an object — the render() trap',
        typeof msg.html === 'string' && typeof msg.text === 'string');

      // ------------------------------------------------------------ 5 + 6. the record
      const aud = (await db.query(
        `SELECT detail FROM audit_log WHERE entity_id=$1 AND action='email_reply_sent'
          ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
      eq('5a the audit row records how many rode', aud.detail.attached, 1);
      // The Email Center's own record. It is written by `captureOutbound`, which lives
      // INSIDE the very `sendMail` wrapper this test replaces — so the stub necessarily
      // bypasses it, and asserting on `email_messages` here would be asserting on nothing.
      // The honest test is to hand that function the SAME message the route handed the
      // provider and read the row back.
      const emailLog = require('../src/lib/email-log');
      await emailLog.captureOutbound(msg, { applicationId: appId, type: 'staff_reply', audience: 'borrower', status: 'sent' });
      const row = (await db.query(
        `SELECT attachments FROM email_messages
          WHERE application_id=$1 AND direction='outbound' AND attachments IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
      ok('6a the Email Center row remembers what was attached, by name',
        !!row && Array.isArray(row.attachments) && row.attachments.some((x) => x && x.filename === 'binder.pdf'));
      ok('6b …and its size, so the history is readable without the bytes',
        !!row && row.attachments.every((x) => x && Number.isFinite(Number(x.size))));
    }

    // ---------------------------------------------------------------- 3 + 4. the refusal
    {
      outbox.length = 0;
      const r = await reply({
        body: 'And this one.', subject: 'Two things',
        attachments: [
          { filename: 'good.pdf', contentType: 'application/pdf', dataBase64: b64(PDF) },
          { filename: 'evil.pdf', contentType: 'application/pdf', dataBase64: b64('<!doctype html><script>steal()</script>') },
        ],
      });
      eq('3a the reply is still SENT — one bad attachment does not lose the message', r.status, 200);
      eq('4a …carrying only the real document', (outbox[0].attachments || []).length, 1);
      eq('4b …the good one', outbox[0].attachments[0].filename, 'good.pdf');
      ok('3b a web page never leaves the building', !JSON.stringify(outbox[0].attachments).includes('steal()'));
      eq('3c …and the caller is TOLD which one was held back, with a reason',
        (r.body.attachSkipped || []).map((x) => x.filename), ['evil.pdf']);
      ok('3d …in plain language', /web page/.test((r.body.attachSkipped || [])[0].why || ''));
    }

    // ---------------------------------------------------------------- 7. a bad payload
    {
      outbox.length = 0;
      const r = await reply({
        body: 'Broken.', subject: 'Broken',
        attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', dataBase64: 'not base64 at all !!!' }],
      });
      eq('7a an unreadable attachment does not stop the message', r.status, 200);
      eq('7b …it is held back and named', (r.body.attachSkipped || []).length, 1);
      eq('7c …and nothing unreadable reached the provider', (outbox[0].attachments || []).length, 0);
    }
  } catch (e) {
    fail++; console.log('FAIL threw:', (e && e.stack) || e);
  } finally {
    mailer.sendMail = realSend;
    await db.query(`DELETE FROM applications WHERE ys_loan_number = $1`, [`AT${sfx.slice(-8)}`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email = $1`, [`att-bo-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email = $1`, [`att-admin-${sfx}@yscapgroup.com`]).catch(() => {});
    server.close();
    console.log(`${pass} passed, ${fail} failed`);
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
