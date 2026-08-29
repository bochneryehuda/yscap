/**
 * CC THE BORROWER'S HELPER ON A TITLE / INSURANCE ORDER — real Postgres, real HTTP,
 * real `borrower_assistants` rows. Skips with no DATABASE_URL.
 *
 * Owner-directed 2026-08-28: "when you order title and insurance and you have the
 * option to CC the borrower, you should also be able to have an option to CC the
 * helper as well if there is a borrower helper on file."
 *
 * The pure test (test-orders-cc-helper-pure.js) pins the RULE. This pins the parts a
 * pure test structurally cannot, and each of them is a way the feature could look
 * finished and not be:
 *
 *   1. THE HELPER IS ACTUALLY FOUND. `getOrderData` reads `borrower_assistants` for
 *      the borrower AND the co-borrower. A feature whose rule is perfect over a
 *      helper list that is always empty does nothing at all.
 *   2. A DISABLED HELPER IS NOT FOUND. Disabling is how a borrower REVOKES a helper;
 *      copying a revoked party on the whole deal is the worst failure available here.
 *   3. THE ADDRESS REACHES THE REAL SEND. The order is placed through the real route
 *      with the provider stubbed, and the Cc the route reports is asserted — not the
 *      Cc a preview computed.
 *   4. THE CHOICE IS PERSISTED AND RE-READ. `file_orders.meta.ccHelper` is written by
 *      the place, and the panel then answers with that footing — which is what makes
 *      a follow-up stay on the same footing as its order.
 *   5. THE OFFICER'S OWN DEFAULT WORKS, through the real lo_settings row.
 *   6. THE PANEL OFFERS IT BY NAME, and offers nothing on a file with no helper.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-orders-cc-helper-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const orders = require('../src/lib/orders');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `cch-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ophelia Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const mkBorrower = async (tag) => (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo',$1,$2) RETURNING id`,
    [tag, `${uniq}-${tag}@example.test`])).rows[0].id;
  const borrower = await mkBorrower('primary');
  const coBorrower = await mkBorrower('co');

  const mkApp = async ({ withCo = false } = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, ys_loan_number, property_address,
                               status, loan_type, usps_imported_at)
     VALUES ($1,$2,$3,$4,$5,'underwriting','Purchase', now()) RETURNING id`,
    [borrower, withCo ? coBorrower : null, officer,
     `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
     JSON.stringify({ oneLine: '3 Clock Ct, Brooklyn, NY 11211', street: '3 Clock Ct', city: 'Brooklyn', state: 'NY', zip: '11211' }),
    ])).rows[0].id;

  const addVendor = async (appId, type, email) => {
    const c = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,$2,$3,'A Person',$4) RETURNING id`, [borrower, type, `${type} co`, email])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [appId, c, type]);
  };
  const addHelper = async (borrowerId, email, name, { disabled = false } = {}) => (await db.query(
    `INSERT INTO borrower_assistants (borrower_id, email, name, invited_by_self, disabled_at)
     VALUES ($1,$2,$3,true,$4) RETURNING id`,
    [borrowerId, email, name, disabled ? new Date() : null])).rows[0].id;

  const jwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };
  const placeOrder = async (appId, kind, body = {}) => {
    const email = require('../src/lib/email');
    const real = email.sendMail;
    email.sendMail = async () => ({ ok: true, id: 'test' });
    try { return await call('POST', `/api/staff/applications/${appId}/orders/${kind}/place`, body); }
    finally { email.sendMail = real; }
  };
  const lower = (xs) => (xs || []).map((x) => String(x).toLowerCase());

  // ─────────────────────────────────────────────────────────────────────────
  // 1 + 2. THE HELPER IS FOUND — and a DISABLED one is not.
  // ─────────────────────────────────────────────────────────────────────────
  const HELPER = `${uniq}-helper@example.test`;
  const REVOKED = `${uniq}-revoked@example.test`;
  const CO_HELPER = `${uniq}-cohelper@example.test`;
  const appId = await mkApp({ withCo: true });
  await addVendor(appId, 'title_company', `${uniq}-title@example.test`);
  await addVendor(appId, 'insurance_agent', `${uniq}-ins@example.test`);
  await addHelper(borrower, HELPER, 'Rivky Helper');
  await addHelper(borrower, REVOKED, 'Revoked Helper', { disabled: true });
  await addHelper(coBorrower, CO_HELPER, 'Co Helper');

  {
    const data = await orders.getOrderData(appId);
    const emails = orders.helperEmails(data);
    assert(emails.includes(HELPER), 'the borrower’s active helper is read off the file');
    assert(emails.includes(CO_HELPER), 'the CO-borrower’s helper counts as a helper on this file too');
    assert(!emails.includes(REVOKED), 'a DISABLED (revoked) helper is never read — a revoked party is not copied');
    assert((data.helpers || []).some((h) => h.email === HELPER && h.name === 'Rivky Helper'),
      'the helper comes back with a NAME, so a screen can offer the choice by name');
    assert((data.helpers || []).some((h) => h.email === CO_HELPER && h.forCoBorrower === true),
      'a co-borrower’s helper is marked as such');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. THE PANEL OFFERS IT — by name, and off by default.
  // ─────────────────────────────────────────────────────────────────────────
  {
    const r = await call('GET', `/api/staff/applications/${appId}/orders`);
    assert(r.status === 200, 'the orders panel loads');
    const names = lower((r.body.file.helpers || []).map((h) => h.email));
    assert(names.includes(HELPER) && names.includes(CO_HELPER), 'the panel names this file’s helpers');
    assert(!names.includes(REVOKED), 'the panel does not name a revoked helper');
    assert(r.body.orders.title.ccHelper === false, 'title: the helper is OFF by default');
    assert(r.body.orders.insurance.ccHelper === false, 'insurance: the helper is OFF by default');
    assert(!lower(r.body.orders.title.recipients.cc).includes(HELPER),
      'the preview Cc does not carry the helper while the choice is off');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3 + 4. THE REAL SEND carries the helper, and the choice is PERSISTED.
  // ─────────────────────────────────────────────────────────────────────────
  {
    const r = await placeOrder(appId, 'title', { ccHelper: true });
    assert(r.status === 200 && r.body.ok, 'the title order sends with the helper copied');
    assert(lower(r.body.cc).includes(HELPER) && lower(r.body.cc).includes(CO_HELPER),
      'both helpers are on the Cc the SEND actually used');
    assert(!lower(r.body.cc).includes(REVOKED), 'the revoked helper is not on the send');
    // The borrower's own footing is untouched by the helper's — they are two choices.
    assert(r.body.ccBorrower === false, 'copying the helper did NOT copy the borrower');
    assert(!lower(r.body.cc).includes(`${uniq}-primary@example.test`), 'the borrower is genuinely absent from the Cc');

    const meta = (await db.query(
      `SELECT meta FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0].meta;
    assert(meta && meta.ccHelper === true, 'the helper footing is stamped on the order row');
    assert(meta && meta.ccBorrower === false, 'the borrower footing is stamped alongside it, independently');

    const panel = await call('GET', `/api/staff/applications/${appId}/orders`);
    assert(panel.body.orders.title.ccHelper === true, 'the panel re-reads the stored footing (a follow-up stays on it)');
    assert(panel.body.orders.insurance.ccHelper === false, 'the other order kind is unaffected');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. THE OFFICER'S OWN DEFAULT — through a real lo_settings row.
  // ─────────────────────────────────────────────────────────────────────────
  {
    await require('../src/lib/lo-settings').setSettings(officer, { ccHelperOnInsuranceOrder: true });
    const fresh = await mkApp();
    await addVendor(fresh, 'insurance_agent', `${uniq}-ins2@example.test`);
    await addVendor(fresh, 'title_company', `${uniq}-title2@example.test`);
    const panel = await call('GET', `/api/staff/applications/${fresh}/orders`);
    assert(panel.body.orders.insurance.ccHelper === true, 'the officer’s insurance default turns the helper on');
    assert(panel.body.orders.title.ccHelper === false, '…and does NOT turn it on for title — the keys are per kind');
    assert(panel.body.orders.insurance.ccBorrower === false, '…and does not turn the BORROWER on either');
    // The address is really added on the real send.
    const r = await placeOrder(fresh, 'insurance', {});
    assert(r.status === 200 && lower(r.body.cc).includes(HELPER),
      'an order placed with no explicit choice copies the helper because the officer said so');
    // An explicit NO on the order beats the officer's default. On its OWN file:
    // a forced re-send inside the 10-second window is refused by the exactly-once
    // claim (by design), and a test that quietly passed on that 409 would be
    // proving nothing about the choice it claims to prove.
    const fresh2 = await mkApp();
    await addVendor(fresh2, 'insurance_agent', `${uniq}-ins3@example.test`);
    const r2 = await placeOrder(fresh2, 'insurance', { ccHelper: false });
    assert(r2.status === 200, 'the second file’s order sends');
    assert(!lower(r2.body.cc).includes(HELPER),
      'an explicit "do not copy the helper" beats the officer’s own default');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // A FILE WITH NO HELPER — the panel offers nothing, and asking anyway is inert.
  // ─────────────────────────────────────────────────────────────────────────
  {
    const lonelyBorrower = await mkBorrower('nohelper');
    const lonely = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase',now()) RETURNING id`,
      [lonelyBorrower, officer, `YS${String(Date.now()).slice(-8)}77`,
       JSON.stringify({ oneLine: '9 Empty Rd, Brooklyn, NY 11211' })])).rows[0].id;
    const c = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'title_company','T Co','A Person',$2) RETURNING id`,
      [lonelyBorrower, `${uniq}-t3@example.test`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'title_company') ON CONFLICT DO NOTHING`, [lonely, c]);
    const panel = await call('GET', `/api/staff/applications/${lonely}/orders`);
    assert((panel.body.file.helpers || []).length === 0, 'a file with no helper names none');
    const r = await placeOrder(lonely, 'title', { ccHelper: true });
    assert(r.status === 200, 'asking to copy a helper that does not exist still sends the order');
    assert((r.body.cc || []).every((e) => e && String(e).includes('@')), '…and adds no blank recipient');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll order CC-helper database checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
