/**
 * TPO broker ordering + intake conditions + note-buyer stamp — real Postgres + HTTP.
 * Owner-directed 2026-08-11.
 *
 * AREA 4 — a broker's brand-new file gets its conditions RIGHT AWAY and the note buyer's
 *   stamp on it: a TPO file is created at `file_intake`, which the conditions engine now
 *   admits, so the rule-driven conditions (flood cert, ...) attach at creation; and the
 *   note buyer is stamped from the program at creation (canonical spelling), never leaked.
 *   The boot backfill re-attaches conditions on an existing intake file.
 *
 * AREA 1/2/3 — a broker orders TITLE & INSURANCE (never flood), EXCEPT when the note
 *   buyer is RCN (staff-only); the order email shows OUR mortgage clause and signs as the
 *   broker (the file's loan officer); the borrower-safe read never leaks the note buyer;
 *   firm isolation on every door.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO orders DB (no DATABASE_URL)'); process.exit(0); }
  process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const orders = require(R + '/src/lib/orders');
  const email = require(R + '/src/lib/email');
  const engine = require(R + '/src/lib/conditions/engine');
  const registry = require(R + '/src/lib/conditions/field-registry');
  const nbForProgram = require(R + '/src/lib/note-buyer-for-program').noteBuyerForProgram;
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const addrOf = (n) => ({ line1: `${n} Main St`, city: 'Lakewood', state: 'NJ', zip: '08701' });
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  const norm = (s) => registry.normNoteBuyer(s);
  const enter = (tok, body) => call(server, 'POST', '/api/tpo/applications', tok, body);
  // EMAIL_PROVIDER=none makes the provider answer {skipped:true}, so an order would never
  // "send" and thus never record. Stub the wire (like the Orders desk hardening test) so a
  // placed order is actually exercised. Restored in finally.
  const realSendMail = email.sendMail;
  email.sendMail = async () => ({ ok: true, id: 'test' });
  const codesOn = async (appId) => (await db.query(
    `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.application_id=$1`,
    [appId])).rows.map((r) => r.code);

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // ── AREA 4: create a broker file with a GOLD program ──────────────────────────
    const e1 = await enter(tokA, {
      borrower: { firstName: 'Ollie', lastName: 'Order', email: mail('ollie') },
      propertyAddress: addrOf(1), loanType: 'Purchase', program: 'gold',
      purchasePrice: 300000, asIsValue: 300000, arv: 400000, rehabBudget: 50000 });
    ok(e1.status === 201 && e1.body.id, 'broker A enters a Gold loan (201)');
    const appA = e1.body.id;

    // note buyer stamped AT CREATION (canonical spelling), from the program
    const lenderNow = (await db.query(`SELECT lender FROM applications WHERE id=$1`, [appA])).rows[0].lender;
    ok(norm(lenderNow) === norm(nbForProgram('gold')),
      `the note buyer is stamped at creation from the program (lender="${lenderNow}")`);

    // conditions attach RIGHT AWAY on the intake file — the flood cert (an "always"
    // condition on every file) is present without our team activating the file first.
    const codesA = await codesOn(appA);
    ok(codesA.includes('rtl_cond_flood'), 'the rule-driven flood certificate attaches at creation on a broker intake file');
    ok(codesA.includes('rtl_cond_credit'), 'the base credit condition is present too (sanity)');

    // and the note buyer is NEVER exposed to the broker (the `lender` field is omitted;
    // `payoff_lender` — the borrower's own existing loan — is a different, borrower-safe field)
    const av = await call(server, 'GET', `/api/tpo/applications/${appA}`, tokA);
    ok(av.status === 200 && av.body.lender === undefined && !/blue\s*lake|note\s*buyer/i.test(JSON.stringify(av.body)),
      'the note buyer is never exposed to the broker in the file view');

    // A broker file's loan number is assigned later (via sync); ordering needs it (it
    // prints in the mortgage clause), so give this file one to exercise the order path.
    await db.query(`UPDATE applications SET ys_loan_number=$2 WHERE id=$1`, [appA, `YTORD${sfx.replace(/[^0-9]/g, '').slice(0, 8)}`]);

    // the boot backfill re-attaches on an intake file whose rule conditions were removed
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='rtl_cond_flood')`, [appA]);
    ok(!(await codesOn(appA)).includes('rtl_cond_flood'), 'flood removed for the backfill test');
    await engine.backfillTpoIntakeConditionsOnce();
    ok((await codesOn(appA)).includes('rtl_cond_flood'), 'the boot backfill re-attaches rule conditions to an existing intake file');

    // ── AREA 1/2/3: borrower-safe order read (no vendor yet) ──────────────────────
    const o1 = await call(server, 'GET', `/api/tpo/applications/${appA}/orders`, tokA);
    ok(o1.status === 200 && Array.isArray(o1.body.orders), 'GET orders returns the order state');
    ok(!/blue\s*lake|lender|note\s*buyer|fidelis|rcn/i.test(JSON.stringify(o1.body)),
      'the borrower-safe order read NEVER leaks the note buyer');
    const title0 = o1.body.orders.find((x) => x.kind === 'title');
    ok(title0 && title0.canOrder === false && title0.blockers.some((b) => b.code === 'contact'),
      'title is not orderable yet — needs the title company');

    // add the title vendor, then it becomes orderable
    const av1 = await call(server, 'POST', `/api/tpo/applications/${appA}/orders/title/vendor`, tokA,
      { companyName: 'Acme Title', email: 'closing@acme.test' });
    ok(av1.status === 201, 'broker adds the title company (201)');
    const o2 = await call(server, 'GET', `/api/tpo/applications/${appA}/orders`, tokA);
    const title1 = o2.body.orders.find((x) => x.kind === 'title');
    ok(title1 && title1.canOrder === true && title1.vendor && title1.vendor.company_name === 'Acme Title',
      'with the vendor added, title is orderable and the broker sees their own vendor');

    // AREA 2: the order email shows OUR mortgage clause + signs as the broker (LO)
    const data = await orders.getOrderData(appA);
    const built = orders.buildOrderEmail('title', data, {});
    const emailStr = JSON.stringify(built);
    ok(/YS Capital Group/.test(emailStr), 'the order email carries OUR YS Capital mortgage clause');
    ok(!/blue\s*lake/i.test(emailStr), 'the order email NEVER shows the investor / note buyer');
    ok(data.officer && data.officer.name === 'Broker A' && /Broker A/.test(emailStr),
      'the order signs as the file loan officer — the broker ("for the TPO as the loan officer")');

    // place the title order
    const p1 = await call(server, 'POST', `/api/tpo/applications/${appA}/orders/title/place`, tokA, {});
    ok(p1.status === 200 && p1.body.ok, 'broker places the title order (200)');
    const fo = (await db.query(`SELECT status FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appA])).rows[0];
    ok(fo && fo.status === 'ordered', 'the title order is recorded as ordered');
    // a second place without force is refused (exactly-once)
    const p2 = await call(server, 'POST', `/api/tpo/applications/${appA}/orders/title/place`, tokA, {});
    ok(p2.status === 409, 'a second place without force is refused (409)');

    // ── AREA 3: flood is NEVER a broker order ─────────────────────────────────────
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/orders/flood/place`, tokA, {})).status === 400,
      'a broker cannot place a FLOOD order (400 — not an order kind)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/orders/flood/vendor`, tokA, { companyName: 'X' })).status === 400,
      'a broker cannot add a flood vendor (400 — not an order kind)');

    // ── AREA 1: RCN → staff-only, never revealed ──────────────────────────────────
    const e2 = await enter(tokA, {
      borrower: { firstName: 'Rita', lastName: 'Ridge', email: mail('rita') },
      propertyAddress: addrOf(2), loanType: 'Purchase', purchasePrice: 250000, asIsValue: 250000, arv: 350000, rehabBudget: 40000 });
    const appRcn = e2.body.id;
    await db.query(`UPDATE applications SET lender='RCN Capital' WHERE id=$1`, [appRcn]);
    await call(server, 'POST', `/api/tpo/applications/${appRcn}/orders/title/vendor`, tokA, { companyName: 'Any Title', email: 'a@t.test' });
    const or = await call(server, 'GET', `/api/tpo/applications/${appRcn}/orders`, tokA);
    const titleR = or.body.orders.find((x) => x.kind === 'title');
    ok(titleR && titleR.staffHandled === true && titleR.canOrder === false,
      'an RCN file: the broker option is staff-handled, never orderable');
    ok(!/rcn/i.test(JSON.stringify(or.body)), 'the RCN note buyer is NEVER revealed to the broker');
    const pr = await call(server, 'POST', `/api/tpo/applications/${appRcn}/orders/title/place`, tokA, {});
    ok(pr.status === 403 && pr.body.code === 'staff_handled', 'placing an RCN order is refused for the broker (403)');
    ok(!/rcn/i.test(JSON.stringify(pr.body)), 'the RCN refusal never names the note buyer');

    // ── borrower-login toggle: a portal-disabled TPO file does NOT email the borrower ──
    const notify = require(R + '/src/lib/notify');
    const enabledOut = await notify.notifyAppBorrowers(appA, { type: 'condition_added', title: 'test', body: 'test' });
    ok(Array.isArray(enabledOut) && enabledOut.filter(Boolean).length > 0, 'a portal-ENABLED TPO file still notifies the borrower');
    await db.query(`UPDATE applications SET borrower_portal_enabled=false WHERE id=$1`, [appA]);
    const disabledOut = await notify.notifyAppBorrowers(appA, { type: 'condition_added', title: 'test', body: 'test' });
    ok(Array.isArray(disabledOut) && disabledOut.length === 0, 'a portal-DISABLED TPO file does NOT notify/email the borrower');
    // a RETAIL file is never gated by the TPO toggle (is_tpo guard short-circuits)
    const retail = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, program, loan_type, status, source, borrower_portal_enabled, is_tpo)
       VALUES ((SELECT borrower_id FROM applications WHERE id=$1), $2, 'gold', 'Purchase', 'new', 'staff', false, false) RETURNING id`,
      [appA, JSON.stringify(addrOf(9))])).rows[0].id;
    const retailOut = await notify.notifyAppBorrowers(retail, { type: 'condition_added', title: 'test', body: 'test' });
    ok(Array.isArray(retailOut) && retailOut.filter(Boolean).length > 0, 'a retail file with portal off is UNAFFECTED (the TPO toggle never gates it)');

    // ── firm isolation: broker B (another firm) cannot touch firm A's file ─────────
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}/orders`, tokB)).status === 404, 'another firm cannot read the orders (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/orders/title/vendor`, tokB, { companyName: 'Z' })).status === 404, 'another firm cannot add a vendor (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/orders/title/place`, tokB, {})).status === 404, 'another firm cannot place an order (404)');

  } catch (e) { console.error(e); fail++; }
  finally {
    email.sendMail = realSendMail;
    console.log(`\ntest-tpo-orders-db: ${pass} passed, ${fail} failed`);
    await new Promise((r) => server.close(r));
    try { await db.pool.end(); } catch (_) {}
    process.exit(fail ? 1 : 0);
  }
})();
