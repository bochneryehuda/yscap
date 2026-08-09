'use strict';
/**
 * THE 2026-08-09 A-TO-Z AUDIT'S THREE SYSTEM FIXES, pinned:
 *
 *  H2 — a DECLINE is durable by PLACE, not only by key. The dedupe key has two
 *       families (doc:/addr:) and the doc form used to depend on vendor row
 *       order, so a declined house came back under a sibling key on the next
 *       search. Now: the key is minted from the SORTED set of document ids,
 *       and staging also asks the ADDRESS about prior declines/staged twins.
 *  M3 — the deed's COUNTERPARTY is kept (raw.counterparty) and written to
 *       track_records.seller_name at import — the related-party control's
 *       food, previously discarded (db/499's column sat orphaned).
 *  M4 — an EXPIRED snooze is back in the review queue, not in no bucket.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const IMP = require('../src/lib/track-record/importer');
const tag = `azfix_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'AZ Fixer','underwriter') RETURNING id`,
    [`azfix+${tag}@x.test`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Az','Fixes',$1) RETURNING id`,
    [`azfix+${tag}@x.test`])).rows[0].id;
  const addr = { oneLine: `41 Sibling Key Rd, Lakewood, NJ 08701` };

  console.log('\nH2a. A decline under a doc: key suppresses the same PLACE under an addr: key');
  {
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, property_address, dedupe_key, status, raw, decided_at)
       VALUES ($1,$2::jsonb,$3,'declined','{}'::jsonb, now())`,
      [borrowerId, JSON.stringify(addr), `doc:${tag}-oldform`]);
    const out = await IMP._internals.stageOne(db, {
      borrowerId, searchId: null,
      candidate: { property_address: addr, dedupe_key: `addr:something-else-${tag}`, purchase_date: '2025-01-10', raw: {} },
    });
    ok(out.staged === false && out.reason === 'declined_before',
      `the sibling-key re-appearance is refused as already declined (got ${out.staged ? 'STAGED' : out.reason})`);
  }

  console.log('\nH2b. The doc key is minted from the SORTED id set — vendor row order cannot move it');
  {
    const mk = (deeds) => IMP.candidatesFrom(
      { deeds, mortgages: [] }, ['AZ HOLDINGS LLC']);
    const buy = { countyDocumentId: 'ZDOC-9', date: '2025-02-01', amount: 200000, grantees: ['AZ HOLDINGS LLC'], grantors: ['OUTSIDE SELLER CO'], addresses: [{ oneLine: '7 Stable Key Ct, Lakewood, NJ 08701' }] };
    const sell = { countyDocumentId: 'ADOC-1', date: '2026-01-15', amount: 380000, grantors: ['AZ HOLDINGS LLC'], grantees: ['SOME BUYER LLC'], addresses: [{ oneLine: '7 Stable Key Ct, Lakewood, NJ 08701' }] };
    const one = mk([buy, sell]).candidates[0];
    const two = mk([sell, buy]).candidates[0];
    ok(!!one && !!two && one.dedupe_key === two.dedupe_key,
      `both orders mint ONE key (${one && one.dedupe_key})`);
    ok(one.dedupe_key === 'doc:ADOC-1+ZDOC-9', 'the key is the sorted joined id set');
    ok(one.raw.counterparty === 'OUTSIDE SELLER CO',
      'M3: the acquisition counterparty (the seller) is kept on the candidate');
    ok(one.raw.buyer_name === 'SOME BUYER LLC', '…and the exit buyer too');
  }

  console.log('\nM3. importNew writes the counterparty to track_records.seller_name');
  {
    const cid = (await db.query(
      `INSERT INTO track_record_candidates
         (borrower_id, property_address, dedupe_key, status, raw, purchase_date, purchase_price, sale_date, sale_price)
       VALUES ($1,$2::jsonb,$3,'staged',$4::jsonb,'2025-03-02',210000,'2026-02-14',390000) RETURNING id`,
      [borrowerId, JSON.stringify({ oneLine: `88 Counterparty Ave, Lakewood, NJ 08701` }),
        `doc:${tag}-m3`, JSON.stringify({ counterparty: 'UNRELATED SELLER LLC' })])).rows[0].id;
    const out = await IMP.decideCandidate(cid, { action: 'import_new', staffId, dealType: 'flip' });
    const row = (await db.query(`SELECT seller_name, is_verified FROM track_records WHERE id=$1`, [out.trackRecordId])).rows[0];
    ok(row.seller_name === 'UNRELATED SELLER LLC', `seller_name landed on the line (got ${row.seller_name})`);
    ok(row.is_verified === false, 'the imported line still lands pending (db/485 untouched)');
  }

  console.log('\nM4. An EXPIRED snooze is back in the review bucket');
  {
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, property_address, dedupe_key, status, snoozed_until, raw)
       VALUES ($1,$2::jsonb,$3,'snoozed', now() - interval '1 day', '{}'::jsonb)`,
      [borrowerId, JSON.stringify({ oneLine: `5 Snooze Ln, Lakewood, NJ 08701` }), `doc:${tag}-snz`]);
    const q = await IMP.loadQueue(borrowerId, db, {});
    const inReview = (q.toReview || []).some((r) => String(r.address || '').includes('Snooze Ln'));
    const anywhere = ['toReview', 'alreadyHere', 'declined'].flatMap((k) => q[k] || []);
    ok(inReview, 'the expired snooze renders in "to review"');
    ok(anywhere.some((r) => String(r.address || '').includes('Snooze Ln')), '…and is in SOME bucket (never fetched-but-rendered-nowhere)');
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'}  a decline is durable by place, the counterparty is kept, and a snooze comes back — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
