#!/usr/bin/env node
'use strict';
/**
 * THE FILE'S VENDOR CONTACTS — one writer, no duplicates, replace means replace.
 * Real Postgres; nothing sent.
 *
 * Owner-reported 2026-09-01:
 *   • "he ordered insurance from one agent, and then the client changed agents …
 *     it's ordering now from both agents" — a replacement must retire the first.
 *   • "changed back to the same insurance agent … Now it populates twice" — the
 *     directory must be FOUND before it is written.
 *   • "based on the document that you accept, the system shall keep the … agent
 *     who sent these documents."
 */
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP file contacts DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const FC = require(R + '/src/lib/file-contacts');
  const orders = require(R + '/src/lib/orders');
  const sfx = `fc-${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fc','Test',$1) RETURNING id`, [`${sfx}@fc.test`])).rows[0].id;
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Fc Officer','loan_officer',true) RETURNING id`,
    [`${sfx}-lo@fc.test`])).rows[0].id;
  const mkApp = async () => (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, ys_loan_number, property_address)
     VALUES ($1,$2,'underwriting','Purchase',$3,'{"line1":"1 Fc St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`,
    [borrowerId, staffId, `YS-${sfx}-${Math.random().toString(36).slice(2, 7)}`])).rows[0].id;
  const linked = (appId, type) => db.query(
    `SELECT sc.id, sc.email, sc.phone, sc.company_name FROM application_service_contacts l JOIN service_contacts sc ON sc.id=l.service_contact_id
      WHERE l.application_id=$1 AND l.contact_type=$2 ORDER BY sc.last_used_at DESC`, [appId, type]).then((r) => r.rows);
  const retired = (appId, orderType) => db.query(
    `SELECT meta FROM file_orders WHERE application_id=$1 AND order_type=$2`, [appId, orderType])
    .then((r) => FC.retiredVendorEmails(r.rows[0] && r.rows[0].meta));
  const A = { companyName: `Aron Ins ${sfx}`, contactName: 'Aron', email: `aron-${sfx}@sibins.test`, phone: '(718) 288-3093' };
  const B = { companyName: `Bella Ins ${sfx}`, contactName: 'Bella', email: `bella-${sfx}@bellains.test` };

  try {
    // ── 1. NO DUPLICATE: the same agent typed twice (once without the phone) is ONE row ──
    const app1 = await mkApp();
    const a1 = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...A, addedByStaffId: staffId });
    await FC.linkContact(db, { applicationId: app1, contactId: a1.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    ok(a1.created === true, 'the first time, the agent is created');
    const a2 = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', companyName: A.companyName, email: A.email.toUpperCase(), addedByStaffId: staffId });
    await FC.linkContact(db, { applicationId: app1, contactId: a2.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    ok(a2.id === a1.id && a2.reused === true, 'typed again (different case, no phone) → the SAME directory row, not a second one');
    const rows1 = await linked(app1, 'insurance_agent');
    ok(rows1.length === 1, `the file lists the agent once (found ${rows1.length})`);
    ok(rows1[0].phone === A.phone, 'the phone the first entry carried is kept — a blank never erases a value');
    // A DIFFERENT company with no email in common is a different row.
    const b1 = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...B, addedByStaffId: staffId });
    ok(b1.id !== a1.id && b1.created === true, 'a genuinely different agent is its own row');
    // Same email, different TYPE (an agent who also writes flood) is its own row too — the type is part of the identity.
    const aFlood = await FC.upsertContact(db, { borrowerId, type: 'flood_insurance', ...A, addedByStaffId: staffId });
    ok(aFlood.id !== a1.id, 'the same person under a different contact type is a separate directory row');

    // ── 2. REPLACE: "use a different one" retires the first agent from the order ──
    const app2 = await mkApp();
    await db.query(`INSERT INTO file_orders (application_id, order_type, status) VALUES ($1,'insurance','ordered')`, [app2]);
    const rA = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...A, addedByStaffId: staffId });
    await FC.linkContact(db, { applicationId: app2, contactId: rA.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    const rB = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...B, addedByStaffId: staffId });
    await FC.linkContact(db, { applicationId: app2, contactId: rB.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    ok((await linked(app2, 'insurance_agent')).length === 2, 'before the replace both agents are on the file (the reported state)');
    const rep = await FC.replaceSameType(db, { applicationId: app2, keepContactId: rB.id, type: 'insurance_agent' });
    const after = await linked(app2, 'insurance_agent');
    ok(after.length === 1 && after[0].id === rB.id, 'after the replace ONLY the new agent is on the file');
    ok(rep.removed.length === 1 && rep.removed[0].contactId === rA.id, 'the old agent is the one removed');
    const ret = await retired(app2, 'insurance');
    ok(ret.includes(A.email.toLowerCase()) && !ret.includes(B.email.toLowerCase()),
      `the old agent's address is retired from the order thread, the new one's is not (${ret.join(', ')})`);
    // The order's recipients now name B alone.
    const data = await orders.getOrderData(app2);
    const emails = orders.vendorEmails('insurance', data).map((e) => e.toLowerCase());
    ok(emails.includes(B.email.toLowerCase()) && !emails.includes(A.email.toLowerCase()), 'the order now goes to the new agent only');
    ok(!((data.vendorsExtra || {}).insurance || []).length, 'nobody rides the Cc as an "extra" of the same type');
    const fo = (await db.query(`SELECT vendor_contact_id FROM file_orders WHERE application_id=$1 AND order_type='insurance'`, [app2])).rows[0];
    ok(fo && String(fo.vendor_contact_id) === String(rB.id), 'the order row itself points at the new agent');

    // ── 3. CHANGE BACK: re-adding the first agent un-retires them and still does not duplicate ──
    const back = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', companyName: A.companyName, email: A.email, addedByStaffId: staffId });
    ok(back.id === rA.id && back.reused === true, 'changing back finds the original agent row (no third copy)');
    await FC.linkContact(db, { applicationId: app2, contactId: back.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    await FC.replaceSameType(db, { applicationId: app2, keepContactId: back.id, type: 'insurance_agent' });
    const ret2 = await retired(app2, 'insurance');
    ok(!ret2.includes(A.email.toLowerCase()) && ret2.includes(B.email.toLowerCase()),
      'the returning agent is no longer retired; the one they replaced now is');
    ok((await linked(app2, 'insurance_agent')).length === 1, 'still exactly one insurance agent on the file');

    // ── 4. THE ACCEPTED DOCUMENT DECIDES ──────────────────────────────────────
    const app3 = await mkApp();
    await db.query(`INSERT INTO file_orders (application_id, order_type, status) VALUES ($1,'insurance','ordered')`, [app3]);
    const qA = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...A, addedByStaffId: staffId });
    const qB = await FC.upsertContact(db, { borrowerId, type: 'insurance_agent', ...B, addedByStaffId: staffId });
    await FC.linkContact(db, { applicationId: app3, contactId: qA.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    await FC.linkContact(db, { applicationId: app3, contactId: qB.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    const mkDoc = async (appId, kind, from) => (await db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                              uploaded_by_kind, doc_kind, review_status, source_type, visibility, from_email)
       VALUES ($1,$2,'quote.pdf','application/pdf',10,'local',$3,'staff',$4,'pending','system','staff_only',$5) RETURNING id`,
      [appId, borrowerId, `ref-${sfx}-${Math.random()}`, kind, from])).rows[0].id;
    // Two quotes came in; the one from B is accepted.
    const docB = await mkDoc(app3, 'insurance_order_return', B.email.toUpperCase());
    const adopt = await FC.adoptVendorFromAcceptedDocument(db, docB);
    ok(adopt.adopted === qB.id && adopt.reason === 'adopted', `accepting B's quote makes B the file's agent (got ${JSON.stringify(adopt)})`);
    const l3 = await linked(app3, 'insurance_agent');
    ok(l3.length === 1 && l3[0].id === qB.id, 'A is off the file, B stays');
    ok((await retired(app3, 'insurance')).includes(A.email.toLowerCase()), "A's address is retired from the thread");
    // Nothing to decide with one agent; an unknown sender changes nothing; a non-order document changes nothing.
    const docB2 = await mkDoc(app3, 'insurance_order_return', B.email);
    ok((await FC.adoptVendorFromAcceptedDocument(db, docB2)).reason === 'nothing_to_decide', 'one agent on the file → nothing to decide');
    const app4 = await mkApp();
    await FC.linkContact(db, { applicationId: app4, contactId: qA.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    await FC.linkContact(db, { applicationId: app4, contactId: qB.id, type: 'insurance_agent', addedByKind: 'staff', addedById: staffId });
    const stranger = await mkDoc(app4, 'insurance_order_return', `stranger-${sfx}@nowhere.test`);
    ok((await FC.adoptVendorFromAcceptedDocument(db, stranger)).reason === 'sender_not_a_file_contact'
      && (await linked(app4, 'insurance_agent')).length === 2, 'a sender who is not a file contact decides nothing');
    const noSender = await mkDoc(app4, 'insurance_order_return', null);
    ok((await FC.adoptVendorFromAcceptedDocument(db, noSender)).reason === 'no_sender', 'a document with no recorded sender decides nothing');
    const plain = await mkDoc(app4, 'bank_statement', B.email);
    ok((await FC.adoptVendorFromAcceptedDocument(db, plain)).reason === 'not_an_order_return', 'an ordinary document never moves a vendor');
    ok((await FC.adoptVendorFromAcceptedDocument(db, '00000000-0000-0000-0000-000000000000')).adopted === null, 'an unknown document → nothing, no throw');

    // ── 5. THE DOORS USE THIS WRITER (source guards) ──────────────────────────
    const fs = require('fs');
    const staff = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
    const borrower = fs.readFileSync(R + '/src/routes/borrower.js', 'utf8');
    ok(!/INSERT INTO service_contacts/.test(staff.slice(staff.indexOf("router.post('/applications/:id/file-contacts'"), staff.indexOf("router.patch('/file-contacts/:linkId'"))),
      'the staff add-contact door no longer inserts the directory row itself');
    ok(/FC\.upsertContact\(/.test(staff) && /FC\.replaceSameType\(/.test(staff), 'the staff door upserts and can replace');
    ok(/FC\.upsertContact\(/.test(borrower), 'the borrower door upserts through the same writer');
    ok((staff.match(/retiredVendorEmails\(row && row\.meta\)/g) || []).length === 3,
      'the reply, the preview and the follow-up all keep a retired vendor off the thread');
    ok(/adoptVendorFromAcceptedDocument\(db, doc\.id\)/.test(staff), 'accepting a document runs the adoption');
    ok(/from_email\)/.test(fs.readFileSync(R + '/src/lib/order-inbox.js', 'utf8')), 'the inbox records who sent each returned document');
    const op = fs.readFileSync(R + '/app-v2/src/components/OrdersPanel.jsx', 'utf8');
    ok(/replace: replace \|\| undefined/.test(op) && /replace=\{adding && !!vendor\}/.test(op), '"Use a different one" sends replace:true');
    ok(/<VendorAutocomplete/.test(op) && /<VendorAutocomplete/.test(fs.readFileSync(R + '/app-v2/src/components/FileContacts.jsx', 'utf8')),
      'both contact forms offer the vendor directory type-ahead');
    const vendorsRoute = staff.slice(staff.indexOf("router.get('/vendors'"), staff.indexOf("router.get('/vendors'") + 600);
    ok(!/if \(!can\(req\.actor, 'manage_vendors'\)\)/.test(vendorsRoute), 'reading the directory needs no manage_vendors');
    ok(/router\.post\('\/vendors'[\s\S]{0,300}manage_vendors/.test(staff), 'writing the directory still does');
  } catch (e) {
    fail++; console.log('  FAIL: harness threw:', e && e.stack ? e.stack : e);
  }
  await db.pool.end().catch(() => {});
  console.log(`file contacts: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
