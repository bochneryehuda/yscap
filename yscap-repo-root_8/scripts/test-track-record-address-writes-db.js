'use strict';
/**
 * THE ADDRESS WRITES, DRIVEN THROUGH THE REAL FUNCTIONS.
 *
 * Every assertion here reproduces something the 2026-08-09 pre-merge audit found
 * by running the real code against a real database, and each was proven to FAIL
 * before the fix. The phase-0 suite asserted these behaviours against HAND-BUILT
 * addresses and passed while the shipped code was still wrong — which is the
 * lesson worth keeping: a fixture you choose yourself can agree with your fix and
 * disagree with reality. These drive `address-heal.healColumn` and
 * `ingest.upsertTrackRecord` themselves.
 *
 * 1. D3 — the boot address-heal must not un-verify the book. db/493 handed the
 *    comparison to `pilot_address_same_place`, whose key could not READ the one
 *    shape address-heal repairs (a geocoder's one-line puts a comma after the
 *    house number, which made the key empty and the guard fail closed). db/497
 *    fixes the key. These fixtures are the shapes address-heal's own WHERE clause
 *    selects, not invented ones.
 *
 * 2. D2 — a ClickUp re-ingest must not churn a line, must not overwrite a human,
 *    and MUST still let a genuine correction through. The first cut made the
 *    address strictly fill-only and silently dropped real corrections arriving on
 *    the `source_task_id` arm, where nothing had confirmed the address at all.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record address writes (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const tag = `trkaddr_${process.pid}`;

const isVerified = async (id) =>
  (await db.query('SELECT is_verified FROM track_records WHERE id=$1', [id])).rows[0].is_verified;
const addrOf = async (id) =>
  (await db.query('SELECT property_address, address_key FROM track_records WHERE id=$1', [id])).rows[0];

(async () => {
  await ensureSchema();

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Addr Tester','underwriter') RETURNING id`,
    [`${tag}_staff@example.com`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Addr','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  /** A verified line holding `addr`. Verification is a separate UPDATE — db/485
      forbids a line being BORN verified. */
  async function verifiedLine(addr) {
    const id = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, sale_date, origin)
       VALUES ($1,$2::jsonb,'flip', CURRENT_DATE - INTERVAL '5 months', 'portal') RETURNING id`,
      [borrowerId, JSON.stringify(addr)])).rows[0].id;
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
        WHERE id=$1`, [id, staffId]);
    if (!(await isVerified(id))) throw new Error('fixture did not verify — the guard rejected the setup');
    return id;
  }

  // ══════════════════════════════════════════════════════════════════ D3
  console.log('\n1. D3 — the REAL boot address-heal, on the shapes it REALLY repairs');
  {
    const heal = require('../src/lib/address-heal');

    /* These four are the audit's own fixtures: the shapes `address-heal`'s WHERE
       clause actually selects (a long geocoder one-line, with and without a
       matching line1, and a legacy bare string). The phase-0 test used
       "62 Highland St" -> "62 Highland Street", which `canonicalizeAddressValue`
       declines to touch at all — so it asserted the fix on a row the heal would
       never have visited. */
    const LONG = '26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York, 11249, United States';
    const ids = {
      lineAndOne: await verifiedLine({ oneLine: LONG, line1: '26, South 10th Street', city: 'Brooklyn', state: 'New York', zip: '11249' }),
      oneOnly: await verifiedLine({ oneLine: LONG, city: 'Brooklyn', state: 'New York', zip: '11249' }),
      formattedOnly: await verifiedLine({ line1: '26 S 10th St', formatted_address: LONG, city: 'Brooklyn', state: 'NY', zip: '11249' }),
    };

    const before = {};
    for (const k of Object.keys(ids)) before[k] = await addrOf(ids[k]);

    /* Drive the column pass DIRECTLY rather than the boot entry point, so the
       assertion never depends on a `sync_runtime_state` marker having drained. */
    await heal.healColumn({ table: 'track_records', col: 'property_address' }, 500);

    let repaired = 0, lostVerification = 0, whichLost = [];
    for (const k of Object.keys(ids)) {
      const after = await addrOf(ids[k]);
      const changed = JSON.stringify(after.property_address) !== JSON.stringify(before[k].property_address);
      if (changed) repaired += 1;
      if (!(await isVerified(ids[k]))) { lostVerification += 1; whichLost.push(k); }
    }

    ok(repaired > 0, `the heal really did rewrite ${repaired} of these rows — the fixtures are shapes it visits`);
    ok(lostVerification === 0,
      `and NOT ONE of them lost its verification${whichLost.length ? ` — lost: ${whichLost.join(', ')}` : ''}`);

    // The guard did not simply get weaker: a genuinely different property still un-verifies.
    const other = await verifiedLine({ oneLine: '118 Oak Ave, Toms River, NJ 08753', line1: '118 Oak Ave', city: 'Toms River', state: 'NJ', zip: '08753' });
    await db.query(`UPDATE track_records SET property_address=$2::jsonb WHERE id=$1`,
      [other, JSON.stringify({ oneLine: '9 Elm St, Newark, NJ 07102', line1: '9 Elm St', city: 'Newark', state: 'NJ', zip: '07102' })]);
    ok(await isVerified(other) === false, 'a genuinely DIFFERENT property still un-verifies — the guard did not get weaker');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ══════════════════════════════════════════════════════════════════ D2
  console.log('\n2. D2 — the REAL ClickUp re-ingest');
  {
    const { upsertTrackRecord } = require('../src/clickup/ingest');
    const TASK = `${tag}-task`;

    const read = (addr, program) => ({ app: {
      property_address: addr,
      program: program || 'Fix & Flip w/ Construction',
      loan_type: 'Purchase',
      purchase_price: 250000,
      acquisition_date: '2024-02-01',
      actual_closing: '2024-11-01',
    } });
    const A = { oneLine: '62 Highland St, Lakewood, NJ 08701', line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' };
    const A_RESPELLED = { oneLine: '62 Highland Street, Lakewood, NJ 08701', line1: '62 Highland Street', city: 'Lakewood', state: 'NJ', zip: '08701' };
    const B = { oneLine: '118 Oak Ave, Toms River, NJ 08753', line1: '118 Oak Ave', city: 'Toms River', state: 'NJ', zip: '08753' };

    // (a) A SAME-PLACE RE-SPELLING IS NOT WRITTEN — no churn, no un-verify.
    const id1 = await upsertTrackRecord(borrowerId, read(A), TASK);
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2
        WHERE id=$1`, [id1, staffId]);
    await upsertTrackRecord(borrowerId, read(A_RESPELLED), TASK);
    const after1 = await addrOf(id1);
    ok(after1.property_address.line1 === '62 Highland St',
      'a re-spelling of the SAME place is not written — the line keeps its own text');
    ok(await isVerified(id1) === true, '…and the verification survives the re-ingest');

    // (b) A GENUINE CORRECTION ON THE TASK ARM STILL LANDS. This is what the
    //     first cut dropped: `byTask` matches on source_task_id and confirms
    //     nothing about the address.
    await upsertTrackRecord(borrowerId, read(B), TASK);
    const after2 = await addrOf(id1);
    ok(after2.property_address.line1 === '118 Oak Ave',
      'a REAL correction typed into the card lands — it is not silently dropped');
    ok(String(after2.address_key || '').includes('118'),
      'and the address_key moved with it, so the line stops colliding with the old house');
    ok(await isVerified(id1) === false,
      '…and it correctly un-verifies, because the line now claims a different property');

    // (c) A HUMAN'S DEAL TYPE IS NEVER OVERWRITTEN.
    await db.query(`UPDATE track_records SET deal_type='flip', inferred=false WHERE id=$1`, [id1]);
    await upsertTrackRecord(borrowerId, read(B, 'Rental / DSCR'), TASK);
    const dt = (await db.query('SELECT deal_type, inferred FROM track_records WHERE id=$1', [id1])).rows[0];
    ok(dt.deal_type === 'flip' && dt.inferred === false,
      "a staffer's corrected deal type stands, and `inferred` is not resurrected");

    // (d) THE RAW CLICKUP SHAPE IS STILL REPAIRED. address-heal declines it
    //     (canonicalizeAddressValue returns null), and left alone it renders a
    //     BLANK Property cell in the investor TPR package.
    const rawId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, source_task_id, origin)
       VALUES ($1,$2::jsonb,'flip',$3,'clickup_backfill') RETURNING id`,
      [borrowerId, JSON.stringify({ formatted_address: '9 Elm St, Newark, NJ 07102', lat: 40.73, lng: -74.17 }), `${TASK}-raw`])).rows[0].id;
    await upsertTrackRecord(borrowerId, read({ oneLine: '9 Elm St, Newark, NJ 07102', line1: '9 Elm St', city: 'Newark', state: 'NJ', zip: '07102' }), `${TASK}-raw`);
    const rawAfter = await addrOf(rawId);
    ok(rawAfter.property_address && rawAfter.property_address.line1 === '9 Elm St',
      'a row still holding the raw ClickUp shape IS repaired by a re-ingest — address-heal never reaches those');
    ok(!!(rawAfter.property_address.oneLine || rawAfter.property_address.line1),
      '…so it no longer renders a blank Property cell in the investor package (addrText reads oneLine/line1)');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  await db.query('DELETE FROM track_record_findings WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  address writes: the heal keeps the book verified, and a real correction still lands');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
