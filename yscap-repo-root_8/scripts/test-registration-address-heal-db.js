'use strict';
/**
 * DB test — db/292: the CURRENT registration's stored inputs.address/city
 * re-sync from the FILE on every boot (owner-reported 2026-07-24 follow-up:
 * the file said "392-394 Columbia Ave" but term-sheet surfaces kept the
 * registration-era "392 Columbia Ave"; #717 fixed the write paths, this heals
 * and keeps healed the already-registered data).
 *
 *   DATABASE_URL=postgres://… node scripts/test-registration-address-heal-db.js
 *
 * Proves against a real Postgres, by executing the migration file exactly as
 * boot does:
 *   · the reported case heals (current registration picks up the corrected
 *     address + city);
 *   · superseded (historical) registrations are never rewritten;
 *   · an address-TBD file changes nothing;
 *   · a string-shaped property_address heals to its full text;
 *   · a file without a component city syncs the address but leaves the stored
 *     city alone;
 *   · the migration is exactly idempotent (second run: zero changes).
 */
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP registration-address heal DB test (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const SQL = fs.readFileSync(path.join(R, 'db', '292_registration_address_sync.sql'), 'utf8');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const rnd = () => 'addrheal' + Math.random() + '@e.com';

  async function mkApp(propertyAddress) {
    const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('A','H',$1) RETURNING id`, [rnd()]);
    const a = await db.query(`INSERT INTO applications(borrower_id,property_address) VALUES($1,$2) RETURNING id`,
      [b.rows[0].id, propertyAddress == null ? null : JSON.stringify(propertyAddress)]);
    return a.rows[0].id;
  }
  async function mkReg(appId, inputs, isCurrent = true) {
    const r = await db.query(
      `INSERT INTO product_registrations(application_id, program, status, total_loan, inputs, quote, is_current)
       VALUES ($1,'standard','ELIGIBLE',500000,$2,'{}',$3) RETURNING id`,
      [appId, JSON.stringify(inputs), isCurrent]);
    return r.rows[0].id;
  }
  const inputsOf = async (id) => (await db.query(`SELECT inputs FROM product_registrations WHERE id=$1`, [id])).rows[0].inputs;

  // 1. THE REPORTED CASE — file corrected to the range address; the current
  //    registration still stores the registration-era one. Superseded row rides
  //    along on the same file and must stay untouched.
  const yuda = await mkApp({ line1: '392-394 Columbia Ave', city: 'Rochester', state: 'NY', zip: '14611' });
  const oldInputs = { address: '392 Columbia Ave', city: 'Rochester', state: 'NY', term: 12, purchasePrice: 200000 };
  const regOld = await mkReg(yuda, oldInputs, false);          // superseded history
  const regCur = await mkReg(yuda, { ...oldInputs }, true);    // current — must heal

  // 2. Address-TBD file — nothing to sync from; registration keeps its draft address.
  const tbd = await mkApp(null);
  const regTbd = await mkReg(tbd, { address: '12 Draft St', city: 'Albany' });

  // 3. String-shaped property_address — heals to the full text.
  const strApp = await mkApp('7 String Way, Utica, NY 13501');
  const regStr = await mkReg(strApp, { address: 'OLD SNAPSHOT', city: 'Utica' });

  // 4. File without a component city — address syncs, stored city stays.
  const noCity = await mkApp({ line1: '9 No City Rd', state: 'NY' });
  const regNoCity = await mkReg(noCity, { address: 'stale', city: 'KeptCity' });

  await db.query(SQL);   // exactly what every boot runs

  let cur = await inputsOf(regCur);
  ok(cur.address === '392-394 Columbia Ave', 'THE CASE: current registration healed to the corrected address');
  ok(cur.city === 'Rochester', 'THE CASE: city stays in sync');
  ok(cur.term === 12 && cur.purchasePrice === 200000, 'heal touches ONLY address/city — every other input intact');
  const old = await inputsOf(regOld);
  ok(old.address === '392 Columbia Ave', 'superseded registration is history — never rewritten');
  ok((await inputsOf(regTbd)).address === '12 Draft St', 'address-TBD file leaves the draft address alone');
  ok((await inputsOf(regStr)).address === '7 String Way, Utica, NY 13501', 'string-shaped file address heals to its full text');
  const nc = await inputsOf(regNoCity);
  ok(nc.address === '9 No City Rd', 'no-component-city file: address syncs');
  ok(nc.city === 'KeptCity', 'no-component-city file: stored city is left as-is');

  // 5. Exactly idempotent — a second boot changes nothing.
  const before = JSON.stringify([cur, old, nc]);
  const r2 = await db.query(SQL);
  ok(r2.rowCount === 0, 'second run updates ZERO rows (exact idempotency)');
  const after = JSON.stringify([await inputsOf(regCur), await inputsOf(regOld), await inputsOf(regNoCity)]);
  ok(before === after, 'second run is byte-identical (no churn)');

  // 6. Post-heal drift (address corrected AGAIN after the boot) — the next boot
  //    re-syncs: this is a CONTINUOUS guarantee, not a one-shot.
  await db.query(`UPDATE applications SET property_address='{"line1":"392-394 Columbia Ave","unit":"Unit B","city":"Rochester","state":"NY","zip":"14611"}'::jsonb WHERE id=$1`, [yuda]);
  await db.query(SQL);
  ok((await inputsOf(regCur)).address === '392-394 Columbia Ave', 'line1 unchanged → still in sync after another pass');

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool?.end?.();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
