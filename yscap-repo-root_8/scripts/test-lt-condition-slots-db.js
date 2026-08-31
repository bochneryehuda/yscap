#!/usr/bin/env node
/**
 * FILING A RETURNED DOCUMENT INTO ITS SLOT.
 *
 * Owner-directed 2026-08-31: *"Each document should be linked to a slot within
 * the condition … When the documents are coming back from the order, we can
 * assign each document to each and every slot after previewing it."*
 *
 * The order desk GUESSES on arrival from the filename (`orders/kinds.js
 * slotMap`), which is right for the common case and cannot be right for all of
 * them — a title company that names three attachments "scan001.pdf" defeats any
 * rule there will ever be. This door is the human's correction, and until it
 * existed `documents.slot_label` was written ONCE at upload and could never be
 * changed by anybody.
 *
 * REAL HTTP against a REAL database, because the two things that can go wrong
 * here are both invisible to a unit test: the door's SCOPE (whose documents can
 * it touch) and its VALIDATION against the condition's own slot list.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

(async () => {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-condition-slots');
  const crypto = require('crypto');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const auth = require('../src/auth');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, json };
  };

  const tag = `slot${Date.now()}`;
  try {
    const staff = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1,'Slot Tester','admin',true) RETURNING id`, [`${tag}@example.test`])).rows[0];
    const token = await auth.mintStaffSession(staff.id);

    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Slot','Probe',$1) RETURNING id`,
      [`${tag}.b@example.test`])).rows[0].id;
    const loan = crypto.randomUUID();
    await db.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`, [loan, borrower, `SLOT-${tag}`]);
    // A NEW JERSEY file, deliberately: New York drops two of the title slots, and
    // this suite is about filing documents rather than about that rule.
    await db.query(
      `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
       VALUES ($1::uuid,'2 Slot Way','Newark','NJ','07101',1,'SFR')`, [loan]);
    await engine.evaluateLoan(loan, { db });

    // The title DOCUMENTS condition — the one with the slots on it.
    const cond = (await db.query(
      `SELECT ci.id FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.lt_loan_id = $1::uuid AND t.code = 'lt_title_docs'`, [loan])).rows[0];
    check(!!cond, 'the title documents condition is on the file');
    if (!cond) throw new Error('no condition to file against');

    const mkDoc = async (filename, slot) => (await db.query(
      `INSERT INTO documents (checklist_item_id, lt_loan_id, filename, storage_ref, content_type,
                              uploaded_by_kind, uploaded_by_id, slot_label, visibility, is_current, review_status)
       VALUES ($1::uuid,$2::uuid,$3,'ref/x','application/pdf','staff',$4::uuid,$5,'staff_only',true,'pending')
       RETURNING id`, [cond.id, loan, filename, staff.id, slot])).rows[0].id;

    const doc = await mkDoc('scan001.pdf', null);

    console.log('\nA. THE HUMAN CORRECTS WHAT THE FILENAME COULD NOT SAY');
    const put = await call('PUT', `/api/lt/condition-center/documents/${doc}/slot`, token,
      { slot: 'Title commitment' });
    check(put.status === 200, `an unfiled document can be filed (${put.status} ${JSON.stringify(put.json)})`);
    const after = (await db.query('SELECT slot_label FROM documents WHERE id=$1::uuid', [doc])).rows[0];
    check(after.slot_label === 'Title commitment',
      `and the row really carries it (${after.slot_label})`);

    console.log('\nB. A SLOT THE CONDITION DOES NOT HAVE IS REFUSED');
    // A free-typed label would file the document where nothing renders it: the
    // condition then reads as missing a document that is sitting right there.
    const bad = await call('PUT', `/api/lt/condition-center/documents/${doc}/slot`, token,
      { slot: 'Some slot nobody has' });
    check(bad.status === 400, `refused (${bad.status})`);
    check(Array.isArray(bad.json && bad.json.slots) && bad.json.slots.length > 0,
      'and it says which slots there ARE — a refusal with no way forward is a dead end');
    const unmoved = (await db.query('SELECT slot_label FROM documents WHERE id=$1::uuid', [doc])).rows[0];
    check(unmoved.slot_label === 'Title commitment', 'nothing was written on the refusal');

    console.log('\nC. A DOCUMENT CAN BE TAKEN BACK OUT');
    // Forcing somebody to pick a different WRONG slot to undo a mistake is how
    // wrong data becomes permanent.
    const cleared = await call('PUT', `/api/lt/condition-center/documents/${doc}/slot`, token, { slot: null });
    check(cleared.status === 200 && cleared.json.slot === null, 'unfiling answers plainly');
    const back = (await db.query('SELECT slot_label FROM documents WHERE id=$1::uuid', [doc])).rows[0];
    check(back.slot_label === null, 'and the row is genuinely unfiled');

    console.log('\nD. IT IS SCOPED TO A LONG-TERM CONDITION');
    // A document on no condition has no slot to go in, and saying so is a
    // different instruction from "that is not a slot".
    const loose = (await db.query(
      `INSERT INTO documents (lt_loan_id, filename, storage_ref, content_type,
                              uploaded_by_kind, uploaded_by_id, visibility, is_current, review_status)
       VALUES ($1::uuid,'loose.pdf','ref/y','application/pdf','staff',$2::uuid,'staff_only',true,'pending')
       RETURNING id`, [loan, staff.id])).rows[0].id;
    const looseRes = await call('PUT', `/api/lt/condition-center/documents/${loose}/slot`, token,
      { slot: 'Title commitment' });
    check(looseRes.status === 404 || looseRes.status === 409,
      `a document on no condition is refused, with its own reason (${looseRes.status})`);

    const nobody = await call('PUT', `/api/lt/condition-center/documents/${doc}/slot`, null,
      { slot: 'Title commitment' });
    check(nobody.status === 401 || nobody.status === 403,
      `and the door needs a session (${nobody.status})`);

    console.log('\nE. THE SLOTS OFFERED ARE THE ONES THE FILE ACTUALLY HAS');
    const read = require('../src/longterm/conditions-center/read.js');
    const view = await read.forLoan(loan, { db, audience: 'internal' });
    const titleDocs = view.buckets.flatMap((b) => b.conditions).find((c) => c.code === 'lt_title_docs');
    const labels = titleDocs.slots.map((s) => s.label);
    check(labels.includes('Title commitment'), 'the slot we filed into is one the screen offers');
    check(bad.json.slots.every((l) => labels.includes(l)),
      'and the refusal lists exactly those — one slot list, not two');

    await db.query('DELETE FROM documents WHERE lt_loan_id = $1::uuid', [loan]);
    await db.query('DELETE FROM checklist_items WHERE lt_loan_id = $1::uuid', [loan]);
    await db.query('DELETE FROM lt_properties WHERE loan_id = $1::uuid', [loan]);
    await db.query('DELETE FROM lt_loans WHERE id = $1::uuid', [loan]);
    await db.query('DELETE FROM borrowers WHERE id = $1::uuid', [borrower]);
    await db.query('DELETE FROM staff_users WHERE id = $1::uuid', [staff.id]);
  } catch (e) {
    failures += 1;
    console.error('\nCRASH:', (e && e.stack) || e);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
    try { const l = require('../src/longterm/db.js'); if (l.pool && l.pool.end) await l.pool.end(); } catch (_) {}
  }

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nok — every check passed');
  process.exit(0);
})();
