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
    const { trackRecordSentOnly } = require('../src/routes/borrower');
    const full = { property_address: {}, deal_type: 'flip', sale_price: null, entity_name: null, owned_personally: false, address_key: 'k', entered_by_kind: 'staff' };
    const out = trackRecordSentOnly(full, { propertyAddress: { oneLine: 'x' } });
    ok(!('sale_price' in out) && !('deal_type' in out) && !('entity_name' in out) && !('owned_personally' in out),
      'absent body keys drop their columns (salePrice/dealType/entityName/ownedPersonally)');
    ok('property_address' in out && 'address_key' in out, 'the sent address (and its dedupe key) stays');
    ok('entered_by_kind' in out, 'the who-typed-this stamp always rides');
    const p = trackRecordSentOnly({ entity_name: null, owned_personally: true }, { ownedPersonally: true });
    ok('entity_name' in p, '"owned personally" still clears the entity even without entityName restated');
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

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'}  an edit touches only what it said — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
