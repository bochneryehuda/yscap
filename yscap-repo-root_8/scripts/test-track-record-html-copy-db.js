'use strict';
/**
 * THE SAVED COPY IS BUILT ON THE SERVER (mega-workspace phase E, 2026-08-09):
 * a track-record write that never opens the client tool must still refresh the
 * borrower's downloadable copy. The generator hangs off the ONE live-refresh
 * chokepoint (events.publishTrackRecordUpdate), debounced, best-effort.
 *
 * Pinned here, against a real Postgres + real storage:
 *  1. refreshSavedCopy writes a real documents row through saveSnapshot
 *     (kind track_record_html, is_current, borrower-visible, born accepted)
 *     whose BYTES carry the record — groups, counts, verification labels.
 *  2. Attacker-typed text is ESCAPED (an address is not our string).
 *  3. Nothing internal leaks: lo_notes / internal notes never reach the copy.
 *  4. A second refresh COALESCES onto the same row (the "Version 47" rule).
 *  5. The debounce queue folds N pokes into one rebuild; the events chokepoint
 *     actually queues it (the wiring, not just the module).
 *  6. The kill switch stops the WRITE.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const storage = require('../src/lib/storage');
const COPY = require('../src/lib/track-record/html-copy');
const tag = `htmlcopy_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Copy','Fresh',$1) RETURNING id`,
    [`copy+${tag}@x.test`])).rows[0].id;

  // Three deals across the three buckets. The entity name and the address carry
  // attacker-typed text; lo_notes carries a secret that must never appear.
  await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date,
                                purchase_price, sale_price, rehab_amount, entity_name, lo_notes)
     VALUES ($1, $2::jsonb, 'flip', '2025-02-01', '2025-12-01', 200000, 340000, 45000,
             '<img src=x onerror=alert(1)> LLC', 'LO-ONLY-SECRET')`,
    [borrowerId, JSON.stringify({ oneLine: '7 <script>alert(1)</script> Ct, Lakewood, NJ 08701' })]);
  await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, rent_date, rent_amount, purchase_price)
     VALUES ($1, $2::jsonb, 'hold', '2024-05-01', '2025-04-01', 2400, 250000)`,
    [borrowerId, JSON.stringify({ oneLine: '12 Rental Way, Lakewood, NJ 08701' })]);
  await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date, sale_price, purchase_price)
     VALUES ($1, $2::jsonb, 'ground_up', '2024-01-01', '2025-09-01', 610000, 150000)`,
    [borrowerId, JSON.stringify({ oneLine: '3 Builder Blvd, Toms River, NJ 08753' })]);

  console.log('\n1. refreshSavedCopy writes the borrower-visible document, from the DB alone');
  let first;
  {
    first = await COPY.refreshSavedCopy(borrowerId);
    ok(!!(first && first.documentId), `a documents row came back (${first && first.documentId})`);
    const d = (await db.query(
      `SELECT doc_kind, is_current, visibility, review_status, storage_ref, filename, uploaded_by_kind
         FROM documents WHERE id=$1`, [first.documentId])).rows[0];
    ok(d.doc_kind === 'track_record_html' && d.is_current === true, 'kind track_record_html, current');
    ok(d.visibility === 'borrower' && d.review_status === 'accepted', 'borrower-visible, born accepted (nobody reviews an autosnapshot)');
    ok(/^Track_Record_Copy_Fresh_\d{4}-\d{2}-\d{2}\.html$/.test(d.filename), `client filename convention kept (${d.filename})`);
    const html = String(await storage.read(d.storage_ref));
    ok(html.includes('Fix &amp; Flip') && html.includes('Fix &amp; Hold') && html.includes('Ground-up'), 'all three sections render');
    ok(html.includes('3 deals') && html.includes('1 fix &amp; flip') && html.includes('1 fix &amp; hold') && html.includes('1 ground-up'), 'the chips count the buckets');
    ok(html.includes('Sold $610,000'), 'a SOLD ground-up states its sale (the 2026-08-09 exit amendment)');
    ok(html.includes('Rents $2,400/mo'), 'a hold states its rent exit');
    ok(html.includes('Pending review'), 'verification column uses the tool\'s own labels');
    console.log('\n2. Escaping + leakage');
    ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;'), 'an attacker-typed address is escaped, never markup');
    ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'), '…and so is an attacker-typed entity name');
    ok(!html.includes('LO-ONLY-SECRET'), 'internal lo_notes never reach the borrower copy');
    ok(html.includes('/portal/#/track-record'), 'the call to action links the LIVE record');
  }

  console.log('\n3. A second refresh COALESCES (one row per session, the Version-47 rule)');
  {
    const second = await COPY.refreshSavedCopy(borrowerId);
    ok(second.documentId === first.documentId && second.coalesced === true,
      `same documents row updated in place (${second.documentId})`);
    const n = (await db.query(
      `SELECT count(*)::int AS n FROM documents WHERE borrower_id=$1 AND doc_kind='track_record_html'`,
      [borrowerId])).rows[0].n;
    ok(n === 1, `exactly one snapshot row exists (got ${n})`);
  }

  console.log('\n4. The debounce folds pokes; the events chokepoint queues it');
  {
    COPY.queueSavedCopyRefresh(borrowerId);
    COPY.queueSavedCopyRefresh(borrowerId);
    COPY.queueSavedCopyRefresh(borrowerId);
    ok(COPY._internals.pending.size === 1, 'three pokes, one pending rebuild');
    const flushed = await COPY.flushQueuedRefreshes();
    ok(flushed === 1 && COPY._internals.pending.size === 0, 'flush rebuilt exactly once and drained the queue');
    // the REAL wiring: the live-refresh publisher queues a copy rebuild
    await require('../src/lib/events').publishTrackRecordUpdate(borrowerId);
    ok(COPY._internals.pending.size === 1, 'publishTrackRecordUpdate queued a saved-copy refresh');
    await COPY.flushQueuedRefreshes();
  }

  console.log('\n5. The kill switch stops the write');
  {
    process.env.TRACK_RECORD_SERVER_COPY_DISABLED = '1';
    const out = await COPY.refreshSavedCopy(borrowerId);
    ok(out === null, 'disabled → no write, no error');
    COPY.queueSavedCopyRefresh(borrowerId);
    ok(COPY._internals.pending.size === 0, 'disabled → nothing queues');
    delete process.env.TRACK_RECORD_SERVER_COPY_DISABLED;
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'}  the saved copy is rebuilt server-side on every write path — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
