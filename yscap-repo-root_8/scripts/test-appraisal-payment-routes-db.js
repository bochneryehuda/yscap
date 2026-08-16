/**
 * CHOOSING HOW AN APPRAISAL GETS PAID FOR — the real endpoints.
 *
 * Owner-directed 2026-08-16: *"We're gonna keep it manual. We're gonna have all
 * the options over there … send the payment link … use the card on file … use the
 * card manually. We should keep all the options open."*
 *
 * `test-appraisal-payment-intent-db.js` pins the storage and
 * `test-appraisal-payment-options-pure.js` the vocabulary. This boots the REAL
 * Express app and drives the REAL routes, because the interesting rules live in
 * the handler and a module test cannot see them:
 *
 *   • all three options are offered, for every appraisal company;
 *   • a Richer Values method is REFUSED here — it can genuinely be charged, and
 *     recording "somebody will do this by hand" about an order the vendor already
 *     charged is the one wrong answer this feature can give;
 *   • "use the card on file" with no card on the file refuses, and says which of
 *     the other two to use instead — never a dead end;
 *   • "enter a card now" really saves the card, so the appraisal-payment condition
 *     fills exactly as it would from the condition itself;
 *   • marking it paid, and putting it back;
 *   • only somebody who may touch the file may do any of it, and it is audited.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-payment-routes-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch (_) { return {}; } };

const CARD = { number: '4111111111111111', expMonth: 12, expYear: new Date().getFullYear() + 3, cvc: '123', zip: '11219' };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let adminId, otherId, borrowerId; const apps = [];
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Pay Admin','super_admin',true,false,'x',0) RETURNING id`, [`pay-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    otherId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Other LO','loan_officer',true,false,'x',0) RETURNING id`, [`pay-lo-${sfx}@test.local`])).rows[0].id;
    const otherToken = C.signJwt({ sub: otherId, kind: 'staff', role: 'loan_officer', tv: 0 });

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pay','Routes',$1) RETURNING id`,
      [`pay-bo-${sfx}@test.local`])).rows[0].id;
    const mkApp = async () => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`,
        [borrowerId, adminId])).rows[0].id;
      apps.push(id); return id;
    };

    // ---- 1. the options, for every appraisal company ------------------------
    const appA = await mkApp();
    const optRes = await call(server, 'GET', `/api/staff/applications/${appA}/appraisal-payment`, token);
    const opts = json(optRes);
    assert(optRes.status === 200, '1: the desk can read what the options are');
    assert(!!opts.vendors && ['nan', 'class', 'rv'].every((v) => opts.vendors[v]),
      '1: all three appraisal companies are described');
    for (const v of ['nan', 'class', 'rv']) {
      // ASSERTS THE ASK, NOT A COUNT (changed 2026-08-16). This used to pin
      // `length === 3`, which broke the moment #1198 gave Richer Values a real
      // fourth way (COMPANY_CARD — the card YS Capital keeps on their account).
      // A count cannot tell "a company gained a way it genuinely has" from "a way
      // went missing", and only the second is a bug. So: every company must offer
      // each of the owner's three BY NAME, and may offer more.
      const methods = (opts.vendors[v].options || []).map((o) => o.method);
      for (const m of ['PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD']) {
        assert(methods.includes(m),
          `1: ${opts.vendors[v].name} offers ${m} — the whole point of the ask`);
      }
      // The company card is Richer Values' alone; the other two must not advertise
      // a button that could never work there.
      assert(methods.includes('COMPANY_CARD') === (v === 'rv'),
        `1: ${opts.vendors[v].name} offers the company card only if it really has one`);
    }
    assert(opts.card && opts.card.present === false,
      '1: it reports there is no card on the file yet');
    // The card is DESCRIBED, never revealed — this endpoint decides what buttons to
    // show and has no business decrypting a number to do it.
    assert(!/4111111111111111/.test(optRes.body) && opts.card.number === undefined,
      '1: and it never returns a card number');

    // ---- 2. "use the card on file" with no card refuses, and says what to do --
    const noCard = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-payment`, token,
      { vendor: 'nan', orderId: 11, method: 'CARD_ON_FILE' });
    assert(noCard.status === 409 && /Enter a card now|payment link/i.test(json(noCard).detail || ''),
      '2: no card on file refuses AND names both ways out — never a dead end');

    // ---- 3. Richer Values is refused here — its own route charges it ---------
    const rvHere = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-payment`, token,
      { vendor: 'rv', orderId: 12, method: 'PAYMENT_LINK' });
    assert(rvHere.status === 400 && json(rvHere).error === 'vendor_performs',
      '3: Richer Values cannot be RECORDED as done-by-hand — it really takes the payment');
    assert(/Pay button/i.test(json(rvHere).detail || ''),
      '3: and the refusal points at where it is actually done');

    // ---- 4. a way to pay we do not offer is refused --------------------------
    const ach = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-payment`, token,
      { vendor: 'nan', orderId: 13, method: 'ACH' });
    assert(ach.status === 400 && json(ach).error === 'unknown_method',
      '4: ACH is still not one of the three');
    const acme = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-payment`, token,
      { vendor: 'acme', orderId: 13, method: 'PAYMENT_LINK' });
    assert(acme.status === 400 && json(acme).error === 'unknown_vendor', '4: so is an unknown company');

    // ---- 5. the payment link: recorded, nothing charged ----------------------
    const link = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-payment`, token,
      { vendor: 'nan', orderId: 21, method: 'PAYMENT_LINK', note: 'borrower asked to pay it himself' });
    const linkOut = json(link);
    assert(link.status === 201 && linkOut.intent && linkOut.intent.method === 'PAYMENT_LINK',
      '5: the choice is recorded');
    assert(linkOut.intent.performed_by === 'back_office' && !linkOut.intent.settled_at,
      '5: as something a person still has to do, and NOT as paid');
    assert(linkOut.intent.note === 'borrower asked to pay it himself',
      '5: with what the back office should know');
    const aud5 = await db.query(
      `SELECT 1 FROM audit_log WHERE action='appraisal_payment_choice' AND entity_id=$1 LIMIT 1`, [appA]);
    assert(aud5.rows.length === 1, '5: and choosing how money moves is audited');

    // ---- 6. "enter a card now" really fills the condition --------------------
    const appB = await mkApp();
    const tpl = (await db.query(
      `SELECT id, label, item_kind, tool_key, is_required FROM checklist_templates WHERE code='rtl_p1_apprcard'`)).rows[0];
    const itemB = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,$5,$6) RETURNING id`,
      [tpl.id, appB, tpl.label, tpl.item_kind, tpl.tool_key, tpl.is_required])).rows[0].id;

    const newCard = await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-payment`, token,
      { vendor: 'class', orderId: 31, method: 'NEW_CARD', card: CARD });
    assert(newCard.status === 201 && json(newCard).cardSaved && json(newCard).cardSaved.last4 === '1111',
      '6: the card is saved onto the file');
    const cond = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [itemB])).rows[0];
    assert(cond.status === 'received',
      '6: …so paying from HERE fills the appraisal-payment condition, exactly as entering it there would');
    assert(json(newCard).intent.method === 'NEW_CARD', '6: and the instruction says which card to charge');
    // A junk card is refused BEFORE anything is recorded — half-done is worse.
    const junk = await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-payment`, token,
      { vendor: 'class', orderId: 32, method: 'NEW_CARD', card: { number: '1234', expMonth: 1, expYear: 2020, cvc: '1' } });
    assert(junk.status === 400, '6: a card that is not a card is refused');
    const none = await db.query(
      `SELECT 1 FROM appraisal_payment_intents WHERE vendor='class' AND vendor_order_id=32`);
    assert(none.rows.length === 0, '6: …and nothing is recorded when it is');

    // ---- 7. now the card IS on file, so that option opens up -----------------
    const opts2 = json(await call(server, 'GET', `/api/staff/applications/${appB}/appraisal-payment`, token));
    const onFile = opts2.vendors.nan.options.find((o) => o.method === 'CARD_ON_FILE');
    assert(opts2.card.present === true && onFile.available === true,
      '7: with a card on the file, "use the card on file" becomes pressable');

    // ---- 8. marking it paid, and putting it back ----------------------------
    const settled = await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-payment/settle`, token,
      { vendor: 'class', orderId: 31 });
    assert(settled.status === 200 && !!json(settled).intent.settled_at, '8: it can be marked paid');
    assert(json(settled).intent.settled_by === adminId, '8: recording who said so');
    const back = await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-payment/settle`, token,
      { vendor: 'class', orderId: 31, undo: true });
    assert(back.status === 200 && !json(back).intent.settled_at, '8: and put back if it was the wrong order');
    const orphan = await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-payment/settle`, token,
      { vendor: 'class', orderId: 999 });
    assert(orphan.status === 409 && /how this one is being paid/i.test(json(orphan).detail || ''),
      '8: an order nobody chose a way for cannot be marked paid');

    // ---- 9. only somebody on the file --------------------------------------
    for (const [m, p, b] of [
      ['GET', `/api/staff/applications/${appB}/appraisal-payment`, null],
      ['POST', `/api/staff/applications/${appB}/appraisal-payment`, { vendor: 'nan', orderId: 41, method: 'PAYMENT_LINK' }],
      ['POST', `/api/staff/applications/${appB}/appraisal-payment/settle`, { vendor: 'class', orderId: 31 }],
    ]) {
      assert((await call(server, m, p, otherToken, b)).status === 403,
        `9: a loan officer on no file is refused (${m} ${p.split('/').pop()})`);
    }
  } catch (e) {
    console.error('FATAL', e); failures++;
  } finally {
    for (const a of apps) {
      await db.query(`DELETE FROM appraisal_payment_intents WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM application_payment_cards WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [a]).catch(() => {});
    }
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    for (const s of [adminId, otherId]) if (s) await db.query(`DELETE FROM staff_users WHERE id=$1`, [s]).catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nOK  appraisal-payment-routes-db: all checks passed');
  process.exit(failures ? 1 : 0);
})();
