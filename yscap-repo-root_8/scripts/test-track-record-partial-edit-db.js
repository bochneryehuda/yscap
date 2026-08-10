'use strict';
/**
 * AN EDIT ONLY TOUCHES WHAT THE REQUEST ACTUALLY SAID (2026-08-09 A-to-Z audit).
 *
 * The two track-record PUT doors built their UPDATE from trackRecordCols(b) —
 * the FULL column shape — so a partial body nulled every absent figure (sale
 * price, dates, entity name), silently reset an absent dealType to 'flip',
 * and, because those columns are material to db/485, UN-VERIFIED the line over
 * columns the caller never mentioned. Validation only requires the address, so
 * partial bodies are legal traffic. `trackRecordSentOnly` (routes/borrower.js,
 * shared by both doors) drops any column whose body key was not sent.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const tag = `trpartial_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();

  console.log('\n0. The shared guard itself (pure half)');
  {
    const { trackRecordSentOnly, trackRecordErrors } = require('../src/routes/borrower');
    const full = { property_address: {}, deal_type: 'flip', sale_price: null, entity_name: null, owned_personally: false, address_key: 'k', entered_by_kind: 'staff' };
    const out = trackRecordSentOnly(full, { propertyAddress: { oneLine: 'x' } });
    ok(!('sale_price' in out) && !('deal_type' in out) && !('entity_name' in out) && !('owned_personally' in out),
      'absent body keys drop their columns (salePrice/dealType/entityName/ownedPersonally)');
    ok('property_address' in out && 'address_key' in out, 'the sent address (and its dedupe key) stays');
    ok('entered_by_kind' in out, 'the who-typed-this stamp always rides');
    const p = trackRecordSentOnly({ entity_name: null, owned_personally: true }, { ownedPersonally: true });
    ok('entity_name' in p, '"owned personally" still clears the entity even without entityName restated');
    // #29: a blank OR absent address on an edit drops property_address + its key,
    // so the stored address is kept rather than overwritten with a blank.
    const noAddr = trackRecordSentOnly(full, { salePrice: 1 });
    ok(!('property_address' in noAddr) && !('address_key' in noAddr), 'an absent address drops the column and its key (keep the stored one)');
    const blankAddr = trackRecordSentOnly(full, { propertyAddress: {} });
    ok(!('property_address' in blankAddr) && !('address_key' in blankAddr), 'a BLANK address object drops them too — never clears the identity');
    // #29: the save gate requires an address to CREATE but not to EDIT.
    ok(trackRecordErrors({}) === 'property address is required', 'CREATE with no address is refused by the gate');
    ok(trackRecordErrors({}, { isEdit: true }) === null, 'EDIT with no address passes the gate (keep-existing)');
    ok(trackRecordErrors({ propertyAddress: {} }, { isEdit: true }) === null, 'EDIT with a blank address object passes the gate');
    ok(trackRecordErrors({ propertyAddress: { oneLine: 'x' } }) === null, 'a real address always passes');
  }

  const app = require('../src/server');
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Partial Tester','super_admin') RETURNING id, token_version`,
    [`partial+${tag}@x.test`])).rows[0];
  const token = C.signJwt({ sub: staff.id, kind: 'staff', role: 'super_admin', tv: staff.token_version || 0 });
  const call = (method, path, body) => fetch(`${base}/api/staff${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Partial','Case',$1) RETURNING id`,
    [`partialcase+${tag}@x.test`])).rows[0].id;
  const addr = { oneLine: `9 Partial Way, Lakewood, NJ 08701` };

  console.log('\n1. A VERIFIED line survives a partial staff edit untouched');
  const create = await call('POST', `/borrowers/${borrowerId}/track-records`, {
    propertyAddress: addr, dealType: 'hold', purchasePrice: 200000, rentAmount: 2500,
    rentDate: '2025-06-01', salePrice: 390000, entityName: 'Partial Holdings LLC',
  });
  const trId = (await create.json()).trackRecordId;
  await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified' WHERE id=$1`, [trId]);
  {
    const r = await call('PUT', `/track-records/${trId}`, { propertyAddress: addr, loNotes: 'internal note only' });
    ok(r.status === 200, `the partial edit saves (got HTTP ${r.status})`);
    const row = (await db.query(`SELECT * FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(row.deal_type === 'hold', `dealType was not reset to 'flip' (got ${row.deal_type})`);
    ok(Number(row.sale_price) === 390000 && Number(row.rent_amount) === 2500 && row.rent_date != null,
      'the figures the request never mentioned are intact');
    ok(row.entity_name === 'Partial Holdings LLC', 'the entity name is intact');
    ok(row.is_verified === true, 'the VERIFICATION is intact — no un-verify over unsent columns');
    ok(row.lo_notes === 'internal note only', '…and the one thing the request said was written');
  }

  console.log('\n2. A REAL change still resets the review (db/485 untouched)');
  {
    await call('PUT', `/track-records/${trId}`, { propertyAddress: addr, dealType: 'hold', salePrice: 400000 });
    const row = (await db.query(`SELECT is_verified, sale_price FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(Number(row.sale_price) === 400000, 'the changed figure landed');
    ok(row.is_verified === false, 'a real material change still un-verifies for re-review');
  }

  console.log('\n3. A blank/absent address on an EDIT keeps the stored address (#29)');
  {
    const A = { oneLine: '11 Keep Ave, Toms River, NJ 08753' };
    const cr = await call('POST', `/borrowers/${borrowerId}/track-records`, { propertyAddress: A, dealType: 'flip', purchasePrice: 100000 });
    const id = (await cr.json()).trackRecordId;
    const before = (await db.query(`SELECT property_address, address_key FROM track_records WHERE id=$1`, [id])).rows[0];

    // (a) OMIT the address entirely, change a figure.
    const r1 = await call('PUT', `/track-records/${id}`, { salePrice: 175000 });
    ok(r1.status === 200, `an edit with NO propertyAddress saves (got HTTP ${r1.status})`);
    let row = (await db.query(`SELECT property_address, address_key, sale_price FROM track_records WHERE id=$1`, [id])).rows[0];
    ok(JSON.stringify(row.property_address) === JSON.stringify(before.property_address), 'the stored address is kept, not nulled');
    ok(row.address_key === before.address_key, 'the dedupe key is kept in step with the address');
    ok(Number(row.sale_price) === 175000, 'the field the edit DID send landed');

    // (b) a BLANK address object also means "keep existing".
    const r2 = await call('PUT', `/track-records/${id}`, { propertyAddress: {}, rehabAmount: 20000 });
    ok(r2.status === 200, `an edit with a BLANK propertyAddress saves (got HTTP ${r2.status})`);
    row = (await db.query(`SELECT property_address, rehab_amount FROM track_records WHERE id=$1`, [id])).rows[0];
    ok(JSON.stringify(row.property_address) === JSON.stringify(before.property_address), 'a blank address never overwrites the stored one');
    ok(Number(row.rehab_amount) === 20000, 'the other field still landed alongside the blank address');

    // (c) a REAL new address DOES change it.
    const B = { oneLine: '22 Move Rd, Jackson, NJ 08527' };
    await call('PUT', `/track-records/${id}`, { propertyAddress: B });
    row = (await db.query(`SELECT property_address, address_key FROM track_records WHERE id=$1`, [id])).rows[0];
    ok(row.property_address && row.property_address.oneLine === B.oneLine, 'a genuine address change still rewrites the address');
    ok(row.address_key && row.address_key !== before.address_key, '…and its dedupe key moves with it');

    // (d) an edit that touches ZERO columns still returns 200, not a SQL error.
    const r3 = await call('PUT', `/track-records/${id}`, { propertyAddress: {} });
    ok(r3.status === 200, `an edit that changes nothing returns 200 (SET clause stays valid) — got HTTP ${r3.status}`);
  }

  console.log('\n4. A CREATE still requires an address');
  {
    const r = await call('POST', `/borrowers/${borrowerId}/track-records`, { dealType: 'flip', purchasePrice: 50000 });
    ok(r.status === 400, `create with no address is refused (got HTTP ${r.status})`);
    ok(/address is required/i.test((await r.json()).error || ''), 'the refusal names the address');
  }

  console.log('\n5. The borrower door keeps the stored address on a blank edit too');
  {
    const bId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Blank','Borrower',$1) RETURNING id`,
      [`blankborrower+${tag}@x.test`])).rows[0].id;
    // The login row carries token_version, re-read on every request.
    await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [bId]);
    const btoken = C.signJwt({ sub: bId, kind: 'borrower', tv: 0 });
    const bcall = (method, path, body) => fetch(`${base}/api/borrower${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${btoken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const A = { oneLine: '3 Borrower Blvd, Lakewood, NJ 08701' };
    const cr = await bcall('POST', '/track-records', { propertyAddress: A, dealType: 'flip', purchasePrice: 120000 });
    const id = (await cr.json()).trackRecordId;
    const before = (await db.query(`SELECT property_address FROM track_records WHERE id=$1`, [id])).rows[0];
    const r1 = await bcall('PUT', `/track-records/${id}`, { salePrice: 200000 });
    ok(r1.status === 200, `borrower edit with no address saves (got HTTP ${r1.status})`);
    let row = (await db.query(`SELECT property_address, sale_price FROM track_records WHERE id=$1`, [id])).rows[0];
    ok(JSON.stringify(row.property_address) === JSON.stringify(before.property_address), 'borrower door keeps the stored address');
    ok(Number(row.sale_price) === 200000, 'the borrower edit still landed the field it sent');
    // The incremental SET builder must survive an edit that touches zero columns.
    const r2 = await bcall('PUT', `/track-records/${id}`, { propertyAddress: {} });
    ok(r2.status === 200, `a borrower edit that changes nothing returns 200, not a SQL error (got HTTP ${r2.status})`);
    // A borrower CREATE still requires the address.
    const r3 = await bcall('POST', '/track-records', { dealType: 'flip' });
    ok(r3.status === 400, `borrower create with no address is refused (got HTTP ${r3.status})`);
  }

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'}  an edit touches only what it said — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
