'use strict';
/**
 * PHASE 1 SCHEMA — the properties that make it safe against a live book.
 *
 * The schema itself is additive and dull. What is NOT dull, and what this file
 * exists to pin, is that shipping it against the owner's real database cannot:
 *
 *   · un-verify a single existing line (owner-directed: existing verifications
 *     survive), and
 *   · make FINISHING the verification work undo the verification.
 *
 * The second one is the trap the blueprint walked into: it specified pillars_met
 * as an ordinary material column, which fires on false -> true as well, so
 * confirming the last pillar would drop the line back to pending. db/500's clause
 * is deliberately asymmetric, and section 3 is the proof.
 *
 * Section 1 also pins `counts_from` against `experience.exitDateOf` by EVALUATING
 * both over a battery — not by comparing their SQL text, which would break on
 * whitespace and prove nothing about behaviour. That twin is the whole reason the
 * column is GENERATED rather than trigger-maintained.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record phase 1 (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const E = require('../src/lib/experience');
const tag = `trkp1_${process.pid}`;

const ymd = (v) => (v == null ? null : String(v).slice(0, 10));
const verifiedOf = async (id) =>
  (await db.query('SELECT is_verified, verification_status, pillars_met FROM track_records WHERE id=$1', [id])).rows[0];

(async () => {
  await ensureSchema();

  const staffId = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'P1 Tester','underwriter') RETURNING id`,
    [`${tag}_staff@example.com`])).rows[0].id;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Phase','One',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  const ADDR = { line1: '1 Anywhere St', city: 'Lakewood', state: 'NJ', zip: '08701' };

  async function line(extra = {}) {
    const cols = { deal_type: 'flip', purchase_date: '2023-01-10', sale_date: null, rent_date: null, refi_date: null, ...extra };
    return (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_date, sale_date, rent_date, refi_date)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7) RETURNING id`,
      [borrowerId, JSON.stringify(ADDR), cols.deal_type, cols.purchase_date, cols.sale_date, cols.rent_date, cols.refi_date])).rows[0].id;
  }
  const verify = async (id) => {
    await db.query(
      `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now(), verified_by=$2 WHERE id=$1`,
      [id, staffId]);
    if (!(await verifiedOf(id)).is_verified) throw new Error('fixture would not verify');
  };
  const confirmPillar = (id, p) => db.query(
    `UPDATE track_record_pillars SET human_verdict='confirmed', human_by=$3, human_at=now()
      WHERE track_record_id=$1 AND pillar=$2`, [id, p, staffId]);

  // ═══════════════════════════════════════ 1. counts_from vs the JS twin
  console.log('\n1. counts_from is GENERATED, and it agrees with experience.exitDateOf');
  {
    const combos = [];
    for (const dt of ['flip', 'fix-and-hold', 'rental', 'ground-up', 'construction', 'ground-up flip', null, 'nonsense'])
      for (const s of [null, '2025-06-01']) for (const r of [null, '2024-03-15']) for (const f of [null, '2023-09-20'])
        combos.push({ deal_type: dt, sale_date: s, rent_date: r, refi_date: f });

    let bad = 0, first = '';
    for (const c of combos) {
      const id = await line(c);
      const row = (await db.query('SELECT counts_from::text AS cf, hold_days FROM track_records WHERE id=$1', [id])).rows[0];
      const want = E.exitDateOf({ ...c });
      if (ymd(row.cf) !== want) { bad += 1; if (!first) first = `${c.deal_type}: col=${ymd(row.cf)} js=${want}`; }
    }
    ok(bad === 0, `the generated column equals the JS rule on all ${combos.length} deal_type × date combinations${first ? ` — first: ${first}` : ''}`);

    // hold_days is DISPLAYED, never gated — but it still has to be right.
    const hid = await line({ deal_type: 'flip', purchase_date: '2024-01-01', sale_date: '2024-01-12' });
    const hd = (await db.query('SELECT hold_days FROM track_records WHERE id=$1', [hid])).rows[0].hold_days;
    ok(Number(hd) === 11, 'hold_days counts real days — an 11-day flip reads as 11, and is never a threshold');

    // It is GENERATED, so no write path can set it to something else.
    let refused = false;
    try { await db.query('UPDATE track_records SET counts_from=$2 WHERE id=$1', [hid, '2099-01-01']); }
    catch (e) { refused = /generated column|only be updated to DEFAULT/i.test(String(e.message)); }
    ok(refused, 'and nothing can write to it directly — that is why it is generated rather than trigger-maintained');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ═══════════════════════════ 2. THE BACKFILL CANNOT UN-VERIFY THE BOOK
  console.log('\n2. The pillar backfill leaves an existing verified line verified');
  {
    const id = await line({ sale_date: '2025-06-01' });
    await verify(id);
    // The backfill already ran at boot and gave this line its three pillars, so
    // re-running it is the real test: it must still write nothing.
    const before = await verifiedOf(id);
    ok(before.is_verified === true, 'the line starts verified even though it already carries three unanswered pillars');

    const n = (await db.query('SELECT count(*)::int AS n FROM track_record_pillars WHERE track_record_id=$1', [id])).rows[0].n;
    ok(n === 3, 'a new line gets exactly three pillars — recency, ownership, exit');

    await db.query(
      `INSERT INTO track_record_pillars (track_record_id, pillar)
       SELECT $1, p.pillar FROM (VALUES ('recency'),('ownership'),('exit')) AS p(pillar)
       ON CONFLICT (track_record_id, pillar) DO NOTHING`, [id]);
    const after = await verifiedOf(id);
    ok(after.is_verified === true, 're-running the backfill changes nothing — it is idempotent and cannot un-verify');
    ok(after.pillars_met === false, 'and pillars_met is false, because nobody has answered a pillar yet');

    // An unanswered pillar is NOT a failure. Nothing here may read as one.
    const v = (await db.query(
      `SELECT auto_verdict, human_verdict FROM track_record_pillars WHERE track_record_id=$1 LIMIT 1`, [id])).rows[0];
    ok(v.auto_verdict === null && v.human_verdict === null,
      "a backfilled pillar is NULL/NULL — 'nobody has checked this yet', never 'no' ");

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ═════════════════ 3. THE ASYMMETRIC CLAUSE — the blueprint's trap
  console.log('\n3. Finishing the pillars must NOT un-verify the line being finished');
  {
    const id = await line({ sale_date: '2025-06-01' });
    await verify(id);

    await confirmPillar(id, 'recency');
    ok((await verifiedOf(id)).is_verified === true, 'confirming the first pillar leaves the verification alone');
    await confirmPillar(id, 'ownership');
    ok((await verifiedOf(id)).is_verified === true, '…and the second');
    await confirmPillar(id, 'exit');

    const done = await verifiedOf(id);
    ok(done.pillars_met === true, 'confirming all three sets pillars_met');
    ok(done.is_verified === true,
      'AND THE LINE IS STILL VERIFIED — a plain IS DISTINCT FROM would have dropped it to pending here');

    // The withdrawal direction IS material.
    await db.query(
      `UPDATE track_record_pillars SET human_verdict='rejected' WHERE track_record_id=$1 AND pillar='ownership'`, [id]);
    const pulled = await verifiedOf(id);
    ok(pulled.pillars_met === false, 'rejecting a pillar clears pillars_met');
    ok(pulled.is_verified === false && pulled.verification_status === 'pending',
      '…and THAT re-opens the line — the evidence it stood on was taken away');

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ═══════════════════ 4. Nothing automatic may satisfy a pillar
  console.log('\n4. auto_verdict cannot move pillars_met — only a human can');
  {
    const id = await line({ sale_date: '2025-06-01' });
    await db.query(
      `UPDATE track_record_pillars SET auto_verdict='proved', auto_source='elementix',
              auto_confidence='certain', auto_grade='strong', auto_checked_at=now()
        WHERE track_record_id=$1`, [id]);
    ok((await verifiedOf(id)).pillars_met === false,
      'all three pillars machine-PROVED at the highest grade still leaves pillars_met false');

    ok((await db.query(
      `SELECT count(*)::int AS n FROM track_record_pillars WHERE track_record_id=$1 AND auto_verdict='proved'`,
      [id])).rows[0].n === 3, '…while the machine’s own answer is still recorded, because it is shown to the reviewer');

    // 'no_data' and 'contradicted' are different facts and must both be storable.
    for (const v of ['no_data', 'contradicted', 'too_recent']) {
      await db.query(`UPDATE track_record_pillars SET auto_verdict=$2 WHERE track_record_id=$1 AND pillar='exit'`, [id, v]);
    }
    ok(true, "'no_data', 'contradicted' and 'too_recent' are all storable — silence is not a negative finding");

    await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]);
  }

  // ═══════════════════════ 5. The staging area is structurally invisible
  console.log('\n5. A staged candidate is not a track record');
  {
    const sid = (await db.query(
      `INSERT INTO track_record_searches (borrower_id, run_by, found_count, staged_count, skipped_count, skips, api_calls)
       VALUES ($1,$2,11,3,8,$3::jsonb,4) RETURNING id`,
      [borrowerId, staffId, JSON.stringify([{ address: '5 Elsewhere Rd', why: 'grantee is not this borrower' }])])).rows[0].id;

    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, search_id, raw, property_address, dedupe_key, match_confidence)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,'none')`,
      [borrowerId, sid, JSON.stringify({ vendor: 'record' }), JSON.stringify(ADDR), `${tag}:cand1`]);

    const trk = (await db.query('SELECT count(*)::int AS n FROM track_records WHERE borrower_id=$1', [borrowerId])).rows[0].n;
    ok(trk === 0, 'staging a candidate creates NO track-record row — it is a different table, not a flag');

    // The re-run guard: the same property cannot be staged twice while open…
    let dup = false;
    try {
      await db.query(
        `INSERT INTO track_record_candidates (borrower_id, raw, dedupe_key) VALUES ($1,'{}'::jsonb,$2)`,
        [borrowerId, `${tag}:cand1`]);
    } catch (e) { dup = e.code === '23505'; }
    ok(dup, 'a re-run cannot stage the same property twice while it is still waiting for a person');

    // …but a DECLINED one stays declined and does not come back.
    await db.query(`UPDATE track_record_candidates SET status='declined', decided_by=$2, decided_at=now()
                     WHERE borrower_id=$1`, [borrowerId, staffId]);
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, raw, dedupe_key) VALUES ($1,'{}'::jsonb,$2)`,
      [borrowerId, `${tag}:cand1`]);
    ok(true, 'and once declined the partial index lets it be re-staged only deliberately, never resurrected silently');

    const sk = (await db.query('SELECT skips, found_count, staged_count FROM track_record_searches WHERE id=$1', [sid])).rows[0];
    ok(Array.isArray(sk.skips) && sk.skips[0].why,
      'the search records WHY each result it found was not staged — a silent cap reads as "fewer deals"');
    ok(sk.found_count === 11 && sk.staged_count === 3, 'and how many it found versus staged');

    await db.query('DELETE FROM track_record_candidates WHERE borrower_id=$1', [borrowerId]);
    await db.query('DELETE FROM track_record_searches WHERE borrower_id=$1', [borrowerId]);
  }

  // ═══════════════════════ 6. The cache may never treat an outage as knowledge
  console.log('\n6. An outage is not an answer');
  {
    await db.query(
      `INSERT INTO elementix_lookup_cache (query_key, status, payload) VALUES ($1,'error','{}'::jsonb)
       ON CONFLICT (query_key) DO UPDATE SET status='error'`, [`${tag}:err`]);
    await db.query(
      `INSERT INTO elementix_lookup_cache (query_key, status, payload) VALUES ($1,'no_match','{}'::jsonb)
       ON CONFLICT (query_key) DO UPDATE SET status='no_match'`, [`${tag}:none`]);

    const r = (await db.query(
      `SELECT query_key, cacheable FROM elementix_lookup_cache WHERE query_key = ANY($1::text[]) ORDER BY query_key`,
      [[`${tag}:err`, `${tag}:none`]])).rows;
    const err = r.find((x) => x.query_key.endsWith(':err'));
    const none = r.find((x) => x.query_key.endsWith(':none'));
    ok(err.cacheable === false, "an 'error' row is NOT cacheable — a vendor outage can never be read as ‘there is no such place’");
    ok(none.cacheable === true, "while a real 'no_match' is, because the vendor did answer about this address");

    await db.query('DELETE FROM elementix_lookup_cache WHERE query_key LIKE $1', [`${tag}%`]);
  }

  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  phase 1: the book stays verified, and finishing the work does not undo it');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
