'use strict';
/**
 * THE PROPERTY TYPE SURVIVES THE ROUND TRIP (owner-reported 2026-08-16: "on all
 * the sides, we don't have a property type").
 *
 * NOTHING WAS BROKEN IN THE OBVIOUS PLACE. The column has existed since db/031,
 * the borrower's tool has ASKED for a property type since it shipped, and both
 * save doors have always stored it. What the borrower's own list endpoint never
 * did was SEND IT BACK — so the tool reloaded with an empty picker, and because
 * that form posts every field it shows, the very next save wrote a blank over
 * the answer. Nothing threw and nothing logged; the field was collected, stored,
 * and quietly erased on the next touch.
 *
 * That is why this suite exists and why it is a DB test rather than a pure one:
 * the defect was a missing column in a SELECT, and no amount of unit testing the
 * sanitizer can see one. Every section below walks a real HTTP round trip.
 *
 *   1. the borrower's own door — save, read back, and the AUTOSAVE ECHO that was
 *      doing the erasing
 *   2. the staff door + workspace.loadLine — the Track Record Center's own feed
 *   3. what the door refuses (an appraisal form code) and canonicalises
 *   4. a retired spelling still round-trips
 *   5. the CorrFirst export reads the value straight off the column
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const tag = `trptype_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Type Tester','super_admin') RETURNING id, token_version`,
    [`ptype+${tag}@x.test`])).rows[0];
  const staffTok = C.signJwt({ sub: staff.id, kind: 'staff', role: 'super_admin', tv: staff.token_version || 0 });

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Prop','Type',$1) RETURNING id`,
    [`ptypeborrower+${tag}@x.test`])).rows[0];
  // The borrower's own session. The login row is required, not decorative:
  // `authenticate` re-validates the token's version against borrower_auth on
  // every request, so a token without one answers 401 session_revoked.
  await db.query(
    `INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`,
    [borrower.id]);
  const borrowerTok = C.signJwt({ sub: borrower.id, kind: 'borrower', tv: 0 });

  const asStaff = (method, path, body) => fetch(`${base}/api/staff${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${staffTok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const asBorrower = (method, path, body) => fetch(`${base}/api/borrower${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${borrowerTok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const stored = async (id) =>
    (await db.query(`SELECT property_type FROM track_records WHERE id=$1`, [id])).rows[0].property_type;

  /* ── 1. the borrower's own door — the bug, exactly as reported ────────── */
  console.log('\n1. A borrower saves a property type and it is still there afterwards');
  const addr = { oneLine: '9 Storage Way, Toms River, NJ 08753', street: '9 Storage Way', city: 'Toms River', state: 'NJ', zip: '08753' };
  const created = await asBorrower('POST', '/track-records', {
    propertyAddress: addr, dealType: 'flip', purchasePrice: 300000,
    salePrice: 470000, saleDate: '2025-04-01', propertyType: 'Self storage',
  });
  ok(created.status === 200 || created.status === 201, `the borrower's save is accepted (HTTP ${created.status})`);
  const trId = (await created.json()).trackRecordId
    || (await db.query(`SELECT id FROM track_records WHERE borrower_id=$1 ORDER BY created_at DESC LIMIT 1`, [borrower.id])).rows[0].id;
  ok(await stored(trId) === 'Self storage', 'the type is stored on the row');

  {
    // THE ACTUAL DEFECT: this list is the ONLY thing the tool reloads from.
    const rows = await (await asBorrower('GET', '/track-records')).json();
    const mine = rows.find((r) => r.id === trId);
    ok(!!mine, 'the borrower can read their own line back');
    ok(Object.prototype.hasOwnProperty.call(mine || {}, 'property_type'),
      'the borrower list CARRIES property_type at all — without this the picker reloads empty');
    ok(mine && mine.property_type === 'Self storage',
      `the borrower reads back the type they chose (got ${JSON.stringify(mine && mine.property_type)})`);
  }

  {
    /* THE ERASURE. The tool posts EVERY field it shows on every save, so after a
       reload that had blanked the picker it sent propertyType:''. That is a
       legitimate "clear it" from a user who saw the box — which is precisely why
       the round trip above has to work: the door cannot tell a deliberate blank
       from a blank the screen invented. Proven here in the order it happened. */
    const echo = await asBorrower('PUT', `/track-records/${trId}`, {
      propertyAddress: addr, dealType: 'flip', purchasePrice: 300000,
      salePrice: 470000, saleDate: '2025-04-01', propertyType: '',
    });
    ok(echo.status === 200, `the blanking save is accepted (HTTP ${echo.status})`);
    ok(await stored(trId) === null, 'a blank the user actually chose DOES clear the field');

    // And the round trip that stops the screen ever sending that blank by itself.
    await asBorrower('PUT', `/track-records/${trId}`, { propertyAddress: addr, propertyType: 'Warehouse' });
    const rows = await (await asBorrower('GET', '/track-records')).json();
    ok((rows.find((r) => r.id === trId) || {}).property_type === 'Warehouse',
      're-saving and re-reading is stable — the reload can no longer invent a blank');
  }

  {
    // An edit that never MENTIONS the type must preserve it (trackRecordSentOnly).
    await asBorrower('PUT', `/track-records/${trId}`, { propertyAddress: addr, purchasePrice: 310000 });
    ok(await stored(trId) === 'Warehouse', 'an edit that says nothing about the type preserves it');
  }

  /* ── 2. the staff door and the Track Record Center's own feed ─────────── */
  console.log('\n2. Staff can see and set it, and the Track Record Center is fed');
  {
    const rows = await (await asStaff('GET', `/borrowers/${borrower.id}/track-records`)).json();
    ok((rows.find((r) => r.id === trId) || {}).property_type === 'Warehouse',
      'the staff list carries the type (the ledger row reads it from here)');

    const put = await asStaff('PUT', `/track-records/${trId}`, { propertyAddress: addr, propertyType: 'Office' });
    ok(put.status === 200, `staff can change the type (HTTP ${put.status})`);
    ok(await stored(trId) === 'Office', 'the staff edit landed');

    // workspace.loadLine is what <LineDetail> renders and edits — it selected the
    // whole row and then dropped this field on the way out.
    const line = await (await asStaff("GET", `/track-records/${trId}/workspace`)).json();
    const shaped = (line && line.line) || {};
    ok(Object.prototype.hasOwnProperty.call(shaped, 'propertyType'),
      'the line loader CARRIES propertyType — without this the Center has nothing to show or edit');
    ok(shaped.propertyType === 'Office', `the line loader returns the stored type (got ${JSON.stringify(shaped.propertyType)})`);
  }

  /* ── 3. what the door refuses, and what it tidies ─────────────────────── */
  console.log('\n3. The door refuses a form code and canonicalises a spelling');
  {
    /* db/322's class: FNM1025 is the Fannie Mae appraisal FORM for a 2-4 unit
       report, not a property type — and `track-record-from-file.js` copies
       applications.property_type onto a line verbatim, so this column could
       inherit one. */
    await asStaff('PUT', `/track-records/${trId}`, { propertyAddress: addr, propertyType: 'FNM1025' });
    ok(await stored(trId) === null, 'an appraisal form code is refused, never stored as a property type');

    await asStaff('PUT', `/track-records/${trId}`, { propertyAddress: addr, propertyType: '  single family  ' });
    ok(await stored(trId) === 'Single-family',
      'a recognised spelling is stored in the vocabulary\'s own words, so every reader agrees');

    // An import or ClickUp may know a type this vocabulary does not. Refusing it
    // would drop a real fact rather than store it.
    await asStaff('PUT', `/track-records/${trId}`, { propertyAddress: addr, propertyType: 'Marina berth' });
    ok(await stored(trId) === 'Marina berth', 'an unrecognised type is still accepted');
  }

  /* ── 4. the retired spelling ──────────────────────────────────────────── */
  console.log('\n4. The retired "Condo / townhome" is still somebody\'s answer');
  {
    await db.query(`UPDATE track_records SET property_type='Condo / townhome' WHERE id=$1`, [trId]);
    const rows = await (await asStaff('GET', `/borrowers/${borrower.id}/track-records`)).json();
    ok((rows.find((r) => r.id === trId) || {}).property_type === 'Condo / townhome',
      'a legacy value reads back untouched — the picker offers it back to itself');
    const line = await (await asStaff("GET", `/track-records/${trId}/workspace`)).json();
    ok(line.line.propertyType === 'Condo / townhome', 'and the Center renders it rather than a blank');
  }

  /* ── 5. it reaches the note buyer's own CSV ───────────────────────────── */
  console.log('\n5. The value reaches CorrFirst\'s own form');
  {
    const cf = require('../src/lib/corrfirst-track-record');
    /* TWO statements, deliberately. db/485 resets the review on a material
       change and property_type is on its list, so setting the type and the
       verification together lets the trigger overwrite the verification in the
       same breath — which is the trigger working, not a bug. Type first, verify
       second, exactly as a human does it. */
    await db.query(`UPDATE track_records SET property_type='Office' WHERE id=$1`, [trId]);
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified' WHERE id=$1`, [trId]);
    ok((await db.query(`SELECT is_verified FROM track_records WHERE id=$1`, [trId])).rows[0].is_verified === true,
      'the line is verified (only a verified line is exported)');
    // The export is keyed on a LOAN FILE, so the borrower needs one to export from.
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status)
       VALUES ($1,$2,'underwriting') RETURNING id`,
      [borrower.id, JSON.stringify({ oneLine: '1 Export Way, Lakewood, NJ 08701' })])).rows[0].id;
    const loaded = await cf.loadCorrfirstTrackRecords(appId, db);
    ok(!!loaded, 'the export loader finds the file');
    const rows = (loaded && loaded.records) || [];
    const mine = rows.find((r) => String(r.id) === String(trId));
    ok(!!mine, 'the export loader reads the verified line');
    ok(mine && mine.property_type === 'Office',
      'the export reads the property type straight off the column — this is the whole reason it must round-trip');
    ok(cf.corrfirstPropertyType({ property_type: 'Office' }).value === 'Office',
      'and an office building goes out as "Office" rather than the blank "Commercial" used to produce');
  }

  server.close();
  await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrower.id]);
  await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrower.id]);
  await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [borrower.id]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower.id]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff.id]);

  console.log(`\n${fail ? 'FAILED' : 'OK '} the property type survives the round trip — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
