'use strict';
/**
 * VENDORS AS COMPANIES + THE SAME-EMAIL AUTO-MERGE + THE EMAIL-CHAIN HARVEST
 * (owner-directed 2026-08-28) — real Postgres, real HTTP. Skips with no
 * DATABASE_URL.
 *
 * Pins:
 *   1. THE COMPANY IS THE DOMAIN, with the free-mail guard: gmail is a person,
 *      not a company. `companyContacts` lists the pool's people at a domain.
 *   2. AUTO-MERGE: two vendors sharing an email fold automatically when nothing
 *      conflicts — gaps fill from the other side, the extra phone number just
 *      adds, file links re-point, the loser is soft-marked. A pair with two
 *      DIFFERENT names on one inbox is a CONFLICT — reported, never merged.
 *   3. THE HARVEST: a same-domain address the vendor CC'd on the order's own
 *      email chain surfaces as a person to add; saving it creates a real
 *      linked contact; a foreign-domain address is refused by the one-click
 *      door.
 *   4. THE AUTO-LOOP: a SECOND same-type contact linked to the file rides the
 *      order's Cc automatically; a panel-picked extraCc rides the place body.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-vendor-company-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const vco = require('../src/lib/vendor-company');
const orders = require('../src/lib/orders');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `vcd-${process.pid}-${Date.now()}`;
const DOM = `${uniq}-title.example`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Vee Admin','admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ven','Dor',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, property_address, loan_type, usps_imported_at)
     VALUES ($1,'underwriting',$2,'{"oneLine":"1 Vendor Vw"}','Purchase',now()) RETURNING id`,
    [borrower, `YS${String(Date.now()).slice(-8)}11`])).rows[0].id;
  const mkVendor = async (fields) => (await db.query(
    `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, phone, phones)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [borrower, fields.type || 'title_company', fields.company || null, fields.name || null,
      fields.email || null, fields.phone || null, fields.phones || null])).rows[0].id;
  const link = (contactId, type = 'title_company') => db.query(
    `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [appId, contactId, type]);

  const jwt = signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0, sid: 'test' });
  const call = async (method, p, body) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };

  // ── 1. domains ─────────────────────────────────────────────────────────────
  ok(vco.emailDomain(`sue@${DOM}`) === DOM, 'a corporate address names its domain');
  ok(vco.emailDomain('someone@gmail.com') === null, 'gmail is a person, not a company');
  ok(vco.emailDomain('not-an-email') === null, 'junk is not a company');

  // ── 2. auto-merge ──────────────────────────────────────────────────────────
  {
    // A clean duplicate: the same inbox, one side has the company name, the
    // other has the phone — no conflicts, everything fills.
    const a = await mkVendor({ company: 'Title Co LLC', email: `dup@${uniq}.example` });
    const b = await mkVendor({ email: `dup@${uniq}.example`, phone: '5165551234', name: 'Tara Title' });
    await link(b);
    // A CONFLICTED pair: same inbox, two different company names.
    const c1 = await mkVendor({ company: 'Alpha Abstract', email: `clash@${uniq}.example` });
    const c2 = await mkVendor({ company: 'Beta Abstract', email: `clash@${uniq}.example` });

    const dry = await call('POST', '/api/staff/vendors/auto-merge', { dryRun: true });
    ok(dry.status === 200 && dry.body.dryRun === true, 'the dry run answers');
    ok(dry.body.merged.some((m) => [a, b].includes(m.survivorId) && [a, b].includes(m.mergedId)),
      'the clean duplicate is found');
    ok(dry.body.conflicts.some((c) => [c1, c2].includes(c.aId) && [c1, c2].includes(c.bId) && c.fields.includes('company_name')),
      'the conflicted pair is reported, naming the conflicting field');
    const before = (await db.query(`SELECT count(*)::int c FROM service_contacts WHERE merged_into_id IS NOT NULL AND id IN ($1,$2,$3,$4)`, [a, b, c1, c2])).rows[0].c;
    ok(before === 0, 'a dry run writes NOTHING');

    const real = await call('POST', '/api/staff/vendors/auto-merge', {});
    ok(real.status === 200 && real.body.merged.length >= 1, 'the real run merges the clean duplicate');
    const rows = (await db.query(`SELECT * FROM service_contacts WHERE id IN ($1,$2) ORDER BY (merged_into_id IS NULL) DESC`, [a, b])).rows;
    const survivor = rows.find((r) => !r.merged_into_id);
    const loser = rows.find((r) => r.merged_into_id);
    ok(!!survivor && !!loser && String(loser.merged_into_id) === String(survivor.id), 'one survives; the other is soft-marked into it');
    ok(survivor.company_name === 'Title Co LLC' && survivor.contact_name === 'Tara Title',
      'gaps filled FROM BOTH SIDES — the company name and the contact name both survive');
    ok((survivor.phones || [survivor.phone]).some((x) => String(x || '').includes('5551234')),
      'the extra phone number just added');
    const links = (await db.query(
      `SELECT service_contact_id FROM application_service_contacts WHERE application_id=$1 AND contact_type='title_company'`, [appId])).rows;
    ok(links.some((l) => String(l.service_contact_id) === String(survivor.id)), 'the file link re-pointed to the survivor');
    const clash = (await db.query(`SELECT merged_into_id FROM service_contacts WHERE id IN ($1,$2)`, [c1, c2])).rows;
    ok(clash.every((r) => r.merged_into_id === null), 'the CONFLICTED pair was NOT merged — a human decides');
  }

  // ── 3 + 4. the company block, the harvest, and the auto-loop ───────────────
  {
    // The order's vendor at a corporate domain + a second same-type contact.
    const primary = await mkVendor({ company: 'Corporate Title', name: 'Cora Primary', email: `cora@${DOM}` });
    const second = await mkVendor({ company: 'Corporate Title', name: 'Sid Second', email: `sid@${DOM}` });
    const poolOnly = await mkVendor({ company: 'Corporate Title', name: 'Paula Pool', email: `paula@${DOM}` });
    await link(second);
    await link(primary);   // linked LAST = most recent = the order's vendor
    await db.query(`UPDATE service_contacts SET last_used_at=now() WHERE id=$1`, [primary]);

    // An inbound reply on the title chain CCing a same-domain colleague + a stranger.
    await db.query(
      `INSERT INTO email_messages (application_id, direction, msg_type, category, from_email, from_name, to_emails, cc_emails, subject, occurred_at)
       VALUES ($1,'inbound','title_message','messages',$2,'Cora Primary',$3::jsonb,$4::jsonb,'Re: Title Order', now())`,
      [appId, `cora@${DOM}`,
        JSON.stringify([{ email: 'title+abc@reply.yscapgroup.com' }]),
        JSON.stringify([{ email: `newperson@${DOM}`, name: 'Nina New' }, { email: 'stranger@other.example' }])]);

    const cc = await call('GET', `/api/staff/applications/${appId}/orders/title/company-contacts`);
    ok(cc.status === 200 && cc.body.domain === DOM, 'the company block names the vendor’s domain');
    ok(cc.body.onFile.some((x) => x.emails.includes(`sid@${DOM}`)), 'the second linked contact shows as on-file');
    ok(cc.body.company.some((x) => x.id === poolOnly), 'the pool’s other person at the company is offered');
    ok(cc.body.harvested.some((h) => h.email === `newperson@${DOM}` && h.name === 'Nina New'),
      'the same-domain address the vendor CC’d is harvested, with their name');
    ok(!cc.body.harvested.some((h) => h.email === 'stranger@other.example'), 'a foreign-domain address is never harvested');

    // One-click save of the harvested person → a real linked contact.
    const add = await call('POST', `/api/staff/applications/${appId}/orders/title/company-contacts/add`,
      { email: `newperson@${DOM}`, name: 'Nina New' });
    ok(add.status === 201 && add.body.contactId, 'saving the harvested person creates a real contact on the file');
    const refuse = await call('POST', `/api/staff/applications/${appId}/orders/title/company-contacts/add`,
      { email: 'stranger@other.example' });
    ok(refuse.status === 400, 'the one-click door refuses an address outside the vendor’s company');

    // Adopt the pool person.
    const adopt = await call('POST', `/api/staff/applications/${appId}/contacts/${poolOnly}/adopt`, {});
    ok(adopt.status === 200, '"add people from this company" links a pool contact to the file');

    // THE AUTO-LOOP: every other same-type FILE contact rides the Cc.
    const data = await orders.getOrderData(appId);
    const r = orders.recipientsFor('title', data, {});
    ok(r.to.includes(`cora@${DOM}`), 'the order goes TO the primary vendor');
    for (const e of [`sid@${DOM}`, `newperson@${DOM}`, `paula@${DOM}`]) {
      ok(r.cc.includes(e), `${e} — a same-type file contact — is looped on the Cc automatically`);
    }
    // A one-off extraCc rides too, deduped.
    const r2 = orders.recipientsFor('title', data, { extraCc: ['oneoff@somewhere.example', `sid@${DOM}`] });
    ok(r2.cc.includes('oneoff@somewhere.example'), 'a panel-picked one-off loop-in rides the Cc');
    ok(r2.cc.filter((e) => e === `sid@${DOM}`).length === 1, '…without duplicating an address already looped');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll vendor-company checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
