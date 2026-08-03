'use strict';
/**
 * A deal WE funded lands on the borrower's track record (owner-reported
 * 2026-08-02: "I don't think it's really taking all the addresses from previous
 * stuff that the borrower did with us … it should really work … as not verified").
 *
 * PILOT imported a borrower's history from ClickUp and Encompass but never
 * recorded its OWN closings, so the deals we know the most about were the ones
 * missing. This proves the third writer, and proves it obeys every rule the
 * other two already do.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-funded-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const FROM = require('../src/lib/track-record-from-file');
const TRK = require('../src/lib/track-record-key');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };
const tag = `trfund_${process.pid}`;
const made = { borrowers: [], apps: [] };

async function borrower(n) {
  const id = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Funded',$2) RETURNING id`,
    [n, `${tag}_${n}@example.com`])).rows[0].id;
  made.borrowers.push(id); return id;
}
async function file(borrowerId, cols = {}) {
  const base = {
    status: 'funded',
    property_address: JSON.stringify({ oneLine: '18 Maple Ct, Lakewood, NJ 08701' }),
    loan_type: 'Purchase - Fix & Flip', purchase_price: 350000, rehab_budget: 60000,
    property_type: 'SFR', ...cols,
  };
  const names = Object.keys(base), vals = Object.values(base);
  const id = (await db.query(
    `INSERT INTO applications (borrower_id, ${names.join(',')})
     VALUES ($1, ${names.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`,
    [borrowerId, ...vals])).rows[0].id;
  made.apps.push(id); return id;
}
const lines = async (b) => (await db.query(
  `SELECT id, origin, is_verified, inferred, deal_type, notes, purchase_price, rehab_amount,
          property_type, address_key, property_address
     FROM track_records WHERE borrower_id=$1 ORDER BY created_at`, [b])).rows;

(async () => {
  await ensureSchema();

  // ---- A. a funded purchase reaches the record, unverified --------------------
  const b1 = await borrower('Solo');
  const a1 = await file(b1);
  const r1 = await FROM.addFromFundedFile(a1);
  ok(r1.ok && r1.added === 1, 'the funded deal was written to the track record');
  const l1 = await lines(b1);
  ok(l1.length === 1, 'exactly one line');
  ok(l1[0].is_verified === false, 'NOT VERIFIED — it is a lead for the team to confirm');
  ok(l1[0].inferred === true, '…and marked inferred');
  ok(l1[0].origin === 'pilot_funded', 'it says where it came from');
  ok(/YS Capital funded/i.test(l1[0].notes || ''), '…in plain words on the line itself');
  ok(Number(l1[0].purchase_price) === 350000 && Number(l1[0].rehab_amount) === 60000,
    'the figures came across from the file');
  ok(l1[0].deal_type === 'flip', 'a fix & flip purchase reads as a flip');
  ok(l1[0].address_key === TRK.trackRecordKey({ oneLine: '18 Maple Ct, Lakewood, NJ 08701' }),
    'and it carries the SHARED dedupe key, so no other writer can duplicate it');

  // ---- B. running it again never duplicates ------------------------------------
  await FROM.addFromFundedFile(a1);
  await FROM.addFromFundedFile(a1);
  ok((await lines(b1)).length === 1, 're-running writes NOTHING new');

  // ---- C. a property already on the record is FILLED, never duplicated ---------
  const b2 = await borrower('Existing');
  await db.query(
    `INSERT INTO track_records (borrower_id, property_address, origin, is_verified, notes)
     VALUES ($1,$2,'portal',false,'I did this one in 2024')`,
    [b2, JSON.stringify({ oneLine: '18 Maple Court, Lakewood, NJ 08701, USA' })]);
  const a2 = await file(b2);
  const r2 = await FROM.addFromFundedFile(a2);
  const l2 = await lines(b2);
  ok(l2.length === 1, 'the same house the borrower already listed is NOT added twice');
  ok(r2.filled === 1, '…it was filled instead');
  ok(Number(l2[0].purchase_price) === 350000, 'the blank figure was filled in');
  ok(l2[0].notes === 'I did this one in 2024', "the borrower's own note was NOT overwritten");
  ok(l2[0].origin === 'portal', "…and the line is still theirs, not re-stamped as ours");

  // ---- D. the CO-BORROWER gets it too ------------------------------------------
  const b3 = await borrower('Primary');
  const b4 = await borrower('Co');
  const a3 = await file(b3, { co_borrower_id: b4, property_address: JSON.stringify({ oneLine: '5 Grand Ave, Monsey, NY 10952' }) });
  await FROM.addFromFundedFile(a3);
  ok((await lines(b3)).length === 1 && (await lines(b4)).length === 1,
    'BOTH borrowers get the deal — a co-borrower did it too and is counted on their own next file');

  // ---- E. a refinance is a HOLD and carries no purchase price -------------------
  const b5 = await borrower('Refi');
  const a5 = await file(b5, {
    loan_type: 'Refinance - Cash Out', purchase_price: null, as_is_value: 500000,
    property_address: JSON.stringify({ oneLine: '77 Ross St, Brooklyn, NY 11211' }),
  });
  await FROM.addFromFundedFile(a5);
  const l5 = (await lines(b5))[0];
  ok(l5 && l5.deal_type === 'fix-and-hold', 'a refinance reads as a hold — they kept it');
  ok(l5 && l5.purchase_price === null, '…and carries NO purchase price (a refinance has none)');

  // ---- F. what it refuses to do -------------------------------------------------
  const b6 = await borrower('NotFunded');
  const a6 = await file(b6, { status: 'underwriting', property_address: JSON.stringify({ oneLine: '9 Pine St, Lakewood, NJ 08701' }) });
  const r6 = await FROM.addFromFundedFile(a6);
  ok(r6.added === 0 && r6.skipped.includes('not_funded'),
    'a file that has NOT funded is never put on the record (a track record is deals DONE)');
  ok((await lines(b6)).length === 0, '…nothing was written');

  const b7 = await borrower('NoAddr');
  const a7 = await file(b7, { property_address: JSON.stringify({ oneLine: 'Brooklyn, NY' }) });
  const r7 = await FROM.addFromFundedFile(a7);
  ok(r7.added === 0 && r7.skipped.includes('no_readable_address'),
    'an address we cannot read is never guessed onto the record');

  const b8 = await borrower('Deleted');
  const a8 = await file(b8, { deleted_at: new Date().toISOString(), property_address: JSON.stringify({ oneLine: '3 Elm Dr, Toms River, NJ 08753' }) });
  const r8 = await FROM.addFromFundedFile(a8);
  ok(r8.added === 0 && r8.skipped.includes('deleted'), 'a deleted file is never recorded');

  // ---- G. it can never break a funding ------------------------------------------
  const bad = await FROM.addFromFundedFile('not-a-uuid');
  ok(bad && bad.ok === false && !bad.added, 'a broken call returns a shape — it never throws at the funding door');

  // ---- H. previous files: the backfill walks the book ----------------------------
  await db.query(`DELETE FROM track_records WHERE borrower_id = ANY($1::uuid[])`, [[b1]]);
  await db.query(`DELETE FROM sync_runtime_state WHERE key='track_record_funded_backfill_v1'`).catch(() => {});
  const bf = await FROM.backfillFundedOnce({ limit: 500 });
  ok(bf.ok && bf.files > 0, 'the backfill walked the funded files');
  ok((await lines(b1)).length === 1, '…and the line it had lost came back');

  for (const a of made.apps) await db.query('DELETE FROM applications WHERE id=$1', [a]).catch(() => {});
  for (const b of made.borrowers) {
    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [b]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [b]).catch(() => {});
  }
  await db.query(`DELETE FROM sync_runtime_state WHERE key='track_record_funded_backfill_v1'`).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record-funded-db: our own closings reach the borrower\'s record, unverified, once, for both borrowers');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
