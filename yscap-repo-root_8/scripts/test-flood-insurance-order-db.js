'use strict';
/**
 * THE FLOOD INSURANCE ORDER (owner-directed 2026-08-28) — real Postgres, real
 * HTTP. Skips with no DATABASE_URL.
 *
 * What this pins:
 *   1. THE ZONE IS THE GATE: with nothing establishing a flood zone, the order
 *      refuses with the reason. The manual "this property is in a flood zone"
 *      flip establishes it — AND attaches the flood-insurance condition through
 *      the engine's existing rule in the same call.
 *   2. THE DEFAULT AGENT IS NEVER SILENT: with no flood contact on file, the
 *      order answers a contact prompt NAMING the file's insurance agent; only
 *      an explicit {useInsuranceAgent:true} copies the agent into a
 *      flood_insurance contact (a copy — the homeowner's-policy contact row is
 *      never rewritten) and sends.
 *   3. THE EMAIL IS THE INSURANCE ORDER'S FLOOD TWIN: the same mortgagee clause
 *      + loan number (RCN's servicer clause included through the one clause
 *      rule), the binder-or-paid-invoice ask, the flood coverage language.
 *   4. The send writes a real 'flood_insurance' file_orders row on the
 *      exactly-once core (a second click without force refuses).
 *   5. Un-flipping the MANUAL flag falls back to the derived answer; an
 *      appraisal-proven zone needs no flip at all.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-flood-insurance-order-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const fio = require('../src/lib/flood-insurance-order');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `fio-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://${'127.0.0.1'}:${server.address().port}`;

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Flo Odd','processor',true) RETURNING id`,
    [`${uniq}-staff@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone) VALUES ('Fay','Flood',$1,'5165551111') RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const mkApp = async ({ lender = null } = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, lender, property_address, loan_type, loan_amount, usps_imported_at)
     VALUES ($1,'underwriting',$2,$3,$4,'Purchase',300000,now()) RETURNING id`,
    [borrower, `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`, lender,
      JSON.stringify({ oneLine: '9 Wet Way, Freeport, NY 11520', street: '9 Wet Way', city: 'Freeport', state: 'NY', zip: '11520' })])).rows[0].id;
  const addAgent = async (appId) => {
    const c = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,'insurance_agent','Homeowner Ins Co','Ida Agent',$2) RETURNING id`,
      [borrower, `${uniq}-agent@x.test`])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
                    VALUES ($1,$2,'insurance_agent')`, [appId, c]);
  };

  const jwt = signJwt({ sub: staff, kind: 'staff', role: 'processor', tv: 0, sid: 'test' });
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };
  const email = require('../src/lib/email');
  const withStub = async (fn) => {
    const real = email.sendMail; const outbox = [];
    email.sendMail = async (opts) => { outbox.push(opts); return { ok: true, id: `m${outbox.length}` }; };
    try { return { out: await fn(), outbox }; } finally { email.sendMail = real; }
  };

  // ── 1. the zone gate + the manual flip ─────────────────────────────────────
  const appId = await mkApp({ lender: 'RCN Capital, LLC' });
  await addAgent(appId);
  {
    const z = await fio.floodZoneEstablished(appId);
    ok(z.inZone === false, 'a fresh file has no established flood zone');
    const refused = await call('POST', `/api/staff/applications/${appId}/orders/flood-insurance/place`, {});
    ok(refused.status === 422 && refused.body.code === 'no_flood_zone' && /flood zone/.test(refused.body.error),
      'ordering without an established zone refuses, with the reason');

    const flip = await call('POST', `/api/staff/applications/${appId}/flood-zone`, { inFloodZone: true });
    ok(flip.status === 200 && flip.body.inFloodZone === true && flip.body.source === 'manual',
      'the manual flip establishes the zone');
    const cond = (await db.query(
      `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_cond_flood_insurance'`, [appId])).rows;
    ok(cond.length === 1, '…and attaches the flood-insurance CONDITION through the engine rule, in the same call');
  }

  // ── 2 + 3 + 4. the default-agent prompt, the send, the email ───────────────
  {
    const prompt = await call('POST', `/api/staff/applications/${appId}/orders/flood-insurance/place`, {});
    ok(prompt.status === 400 && prompt.body.code === 'contact', 'with no flood contact, the order does not send silently');
    ok(prompt.body.insuranceAgent && prompt.body.insuranceAgent.name === 'Homeowner Ins Co',
      '…it NAMES the file’s insurance agent as the default to confirm');

    const { out, outbox } = await withStub(() =>
      call('POST', `/api/staff/applications/${appId}/orders/flood-insurance/place`, { useInsuranceAgent: true }));
    ok(out.status === 200 && out.body.ok, 'confirming "use the same agent" sends the order');
    ok(outbox.length === 1 && outbox[0].to.includes(`${uniq}-agent@x.test`), 'to the agent’s address');
    const text = outbox[0].text;
    ok(/flood insurance quote/i.test(text) && /FEMA flood zone/i.test(text), 'the email says what it is — a flood quote, because of the zone');
    ok(/BINDER or the PAID INVOICE/i.test(text), 'it asks for the binder or paid invoice');
    // RCN file → the servicer mortgagee clause, exactly as the regular insurance order.
    ok(/Elite Commercial Servicing/.test(text) && /Loan #: YS/.test(text),
      'the SAME mortgagee clause rule as the regular insurance order (RCN → the servicer address), with the loan number');
    ok(/Fay Flood/.test(text) && /9 Wet Way/.test(text), 'the deal/borrower detail block rides');

    // The copy: a flood_insurance contact now exists, the agent row untouched.
    const flood = (await db.query(
      `SELECT sc.* FROM application_service_contacts l JOIN service_contacts sc ON sc.id=l.service_contact_id
        WHERE l.application_id=$1 AND sc.contact_type='flood_insurance'`, [appId])).rows;
    ok(flood.length === 1 && flood[0].email === `${uniq}-agent@x.test`,
      'the agent was COPIED into a flood_insurance contact (the original row untouched)');
    const row = (await db.query(
      `SELECT status FROM file_orders WHERE application_id=$1 AND order_type='flood_insurance'`, [appId])).rows[0];
    ok(row && row.status === 'ordered', 'a real flood_insurance order row is recorded');
    const dup = await call('POST', `/api/staff/applications/${appId}/orders/flood-insurance/place`, {});
    ok(dup.status === 409, 'a second order without force refuses (the exactly-once core)');
  }

  // ── 5. un-flip falls back to derived; an appraisal-proven zone needs no flip ─
  {
    const fresh = await mkApp({});
    await call('POST', `/api/staff/applications/${fresh}/flood-zone`, { inFloodZone: true });
    ok((await fio.floodZoneEstablished(fresh)).inZone === true, 'flip on');
    await call('POST', `/api/staff/applications/${fresh}/flood-zone`, { inFloodZone: null });
    ok((await fio.floodZoneEstablished(fresh)).inZone === false, 'un-flip falls back to the derived answer (nothing else proves a zone)');

    const proven = await mkApp({});
    await db.query(
      `INSERT INTO appraisals (application_id, fema_flood_sfha, superseded) VALUES ($1,true,false)`, [proven]);
    const z = await fio.floodZoneEstablished(proven);
    ok(z.inZone === true && z.source === 'appraisal', 'an appraisal-proven SFHA needs no manual flip at all');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll flood-insurance order checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
