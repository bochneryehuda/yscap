'use strict';
/**
 * THE BORROWER CONFIRMS THEIR OWN PROPERTIES — phase 8, real HTTP, real Postgres.
 *
 * The four that carry this file:
 *   §2  A BORROWER'S "YES" IS A CLAIM. It lands `pending`, stamped as theirs,
 *       and counts toward nothing until our team verifies it.
 *   §3  NOTHING INTERNAL LEAKS. The vendor payload, staff notes, the match
 *       reasoning and who decided are all absent from the borrower's view —
 *       asserted against the WHOLE response, not a hand-picked field list.
 *   §4  A "YES" ON A LINE THEY ALREADY HAVE WRITES NOTHING TO THAT LINE. The
 *       records never rewrite our data without a human choosing each change.
 *   §6  UNDO REMOVES ONLY A PRISTINE LINE. The moment anybody has worked it,
 *       it is theirs and is kept.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP borrower confirm (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const BC = require('../src/lib/track-record/borrower-confirm');
const TRK = require('../src/lib/track-record-key');
const tag = `trbc_${process.pid}`;

const A1 = { line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' };
const A2 = { line1: '118 Oak Ave', city: 'Lakewood', state: 'NJ', zip: '08701' };
const A3 = { line1: '9 Maple Ct', city: 'Lakewood', state: 'NJ', zip: '08701' };

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bee','Confirm',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0];
  const borrowerId = borrower.id;
  /* The login row is what carries `token_version`, and `authenticate` re-reads
     it on every request — without one the token is refused as session_revoked. */
  await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version)
                  VALUES ($1,'x',0) ON CONFLICT (borrower_id) DO NOTHING`, [borrowerId]);
  const token = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
  const call = (p, o) => fetch(`${base}${p}`, {
    ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(o && o.headers) } });

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Confirm Tester','underwriter') RETURNING id`,
    [`${tag}_s@example.com`])).rows[0];

  const stage = async (addr, extra = {}) => (await db.query(
    `INSERT INTO track_record_candidates
       (borrower_id, source, raw, property_address, purchase_price, purchase_date,
        sale_price, sale_date, entity_name, dedupe_key, match_track_record_id, match_confidence,
        match_why, internal_notes, status)
     VALUES ($1,'elementix',$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::uuid,$11,$12::jsonb,$13,'staged')
     RETURNING id`,
    [borrowerId,
      JSON.stringify({ deeds: [{ secretVendorField: 'DO-NOT-LEAK-RAW' }] }),
      JSON.stringify(addr),
      extra.purchasePrice || 410000, extra.purchaseDate || '2025-08-02',
      extra.salePrice || null, extra.saleDate || null,
      'MW Trading LLC', `k_${Math.random().toString(36).slice(2)}`,
      extra.matchTrackRecordId || null, extra.matchTrackRecordId ? 'exact' : 'none',
      JSON.stringify({ why: 'DO-NOT-LEAK-MATCHWHY' }), 'DO-NOT-LEAK-INTERNAL-NOTE'])).rows[0].id;

  const lines = async () => (await db.query(
    `SELECT id, property_address, is_verified, verification_status, entered_by_kind, origin, llc_id
       FROM track_records WHERE borrower_id=$1 ORDER BY created_at`, [borrowerId])).rows;

  console.log('\n1. The queue is the borrower\'s own, with honest progress');
  {
    await stage(A1);
    await stage(A2);
    const q = await (await call('/api/borrower/track-record-candidates')).json();
    ok(q.total === 2 && q.answered === 0 && q.remaining === 2, 'two to answer, none answered yet');
    ok(q.done === false && q.nothingToConfirm === false, 'and it is neither finished nor empty');
    ok(q.properties.every((p) => p.address && p.answered === false),
      'every one names its property and is unanswered');
    const seen = (await db.query(
      `SELECT count(*)::int n FROM track_record_candidates WHERE borrower_id=$1 AND borrower_seen_at IS NOT NULL`,
      [borrowerId])).rows[0].n;
    ok(seen === 2,
      'the server records that they were SHOWN — the "3 of 8" denominator survives closing the tab because it is not a client-side count');
  }

  console.log('\n2. A "yes" is a CLAIM — pending, stamped as the borrower\'s');
  {
    const q = await (await call('/api/borrower/track-record-candidates')).json();
    const first = q.properties[0];
    const r = await call(`/api/borrower/track-record-candidates/${first.id}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine', dealType: 'flip' }) });
    ok(r.status === 200, 'the borrower can say it is theirs');
    const out = await r.json();
    ok(out.isVerified === false && out.verificationStatus === 'pending',
      'the line lands PENDING — db/485 decides that, and it counts toward nothing until our team verifies it');

    const l = (await lines())[0];
    ok(l.entered_by_kind === 'borrower',
      'and it is recorded as the BORROWER\'S — writing "staff" here would make the audit trail say something untrue');
    ok(l.origin === 'public_records', '…while still saying where the figures came from');
    ok(!!l.llc_id, 'the entity chokepoint ran, so the company on the deed is now a real entity on their profile');

    const c = (await db.query(
      `SELECT decided_by, decided_by_borrower, decided_by_kind FROM track_record_candidates WHERE id=$1`,
      [first.id])).rows[0];
    ok(String(c.decided_by_borrower) === String(borrowerId) && c.decided_by_kind === 'borrower' && c.decided_by === null,
      'EXACTLY ONE DECIDER is recorded — a borrower id may never go in the staff column, and db/504 refuses both at once');
  }

  console.log('\n3. NOTHING INTERNAL LEAKS to the borrower');
  {
    const raw = await (await call('/api/borrower/track-record-candidates')).text();
    for (const secret of ['DO-NOT-LEAK-RAW', 'DO-NOT-LEAK-MATCHWHY', 'DO-NOT-LEAK-INTERNAL-NOTE']) {
      ok(!raw.includes(secret), `the whole response never contains ${secret}`);
    }
    for (const field of ['internal_notes', 'match_why', 'decided_by', 'search_id', 'proposed_llc_id', 'dedupe_key']) {
      ok(!raw.includes(field), `…nor the field name ${field}`);
    }
    ok(!/"raw"/.test(raw), '…nor the vendor payload under any key');
  }

  console.log('\n4. "Yes" on a line they ALREADY have writes nothing to that line');
  {
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_price, entered_by_kind)
       VALUES ($1,$2::jsonb,$3,'flip',777000,'borrower') RETURNING id`,
      [borrowerId, JSON.stringify(A3), TRK.trackRecordKey(A3)])).rows[0].id;
    const cid = await stage(A3, { matchTrackRecordId: trId, purchasePrice: 300000, purchaseDate: '2024-01-01' });

    const before = (await db.query(`SELECT * FROM track_records WHERE id=$1`, [trId])).rows[0];
    const r = await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine' }) });
    ok(r.status === 200, 'they can confirm one they already have');
    const out = await r.json();
    ok(out.alreadyOnRecord === true && out.status === 'merged', '…and it is settled as already on the record');

    const after = (await db.query(`SELECT * FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(Number(after.purchase_price) === 777000,
      'THEIR TYPED FIGURE IS UNTOUCHED — the records said 300,000 and a "yes" is not permission to rewrite a number they never looked at');
    ok(after.purchase_date === before.purchase_date && after.updated_at.getTime() === before.updated_at.getTime(),
      '…and the line was not written to at all');
  }

  console.log('\n5. "Not mine" is recorded AS THE BORROWER\'S, so staff can see and overturn it');
  {
    const cid = await stage({ line1: '5 Wrong Way', city: 'Lakewood', state: 'NJ', zip: '08701' });
    const r = await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'not_mine' }) });
    ok(r.status === 200, 'they can say a property is not theirs');

    const q = await require('../src/lib/track-record/importer').loadQueue(borrowerId);
    const dec = q.declined.find((x) => String(x.id) === String(cid));
    ok(!!dec, 'the staff queue still SEES it — a borrower answering from memory must not silently remove their own experience');
    ok(dec.decidedByKind === 'borrower' && dec.decidedByBorrower === true,
      '…and can tell it was the BORROWER who said so, not one of us');
  }

  console.log('\n6. Undo removes only a PRISTINE line');
  {
    const cid = await stage({ line1: '31 Undo Ln', city: 'Lakewood', state: 'NJ', zip: '08701' });
    const a = await (await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine', dealType: 'flip' }) })).json();
    const trId = a.trackRecordId;
    ok(!!trId, 'a yes created a line');

    const u = await (await call(`/api/borrower/track-record-candidates/${cid}/undo`, { method: 'POST' })).json();
    ok(u.lineRemoved === true, 'undoing it takes the line back off');
    ok((await db.query('SELECT 1 FROM track_records WHERE id=$1', [trId])).rows.length === 0, '…and the line is gone');
    const back = (await db.query('SELECT status FROM track_record_candidates WHERE id=$1', [cid])).rows[0];
    ok(back.status === 'staged', '…and the question is open again');

    // Now the same thing, but somebody has worked the line.
    const a2 = await (await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine', dealType: 'flip' }) })).json();
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_by=$2 WHERE id=$1`,
      [a2.trackRecordId, staff.id]);
    const u2 = await (await call(`/api/borrower/track-record-candidates/${cid}/undo`, { method: 'POST' })).json();
    ok(u2.lineRemoved === false && u2.lineKept === true,
      'a line OUR TEAM has verified is never deleted by an undo — it is theirs now');
    ok((await db.query('SELECT 1 FROM track_records WHERE id=$1', [a2.trackRecordId])).rows.length === 1,
      '…and it is still there');
  }

  console.log('\n7. The scope, the double-answer, and the staff decision');
  {
    const other = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Other','Person',$1) RETURNING id`,
      [`${tag}_o@example.com`])).rows[0].id;
    const theirs = (await db.query(
      `INSERT INTO track_record_candidates (borrower_id, source, raw, property_address, dedupe_key, status)
       VALUES ($1,'elementix','{}'::jsonb,$2::jsonb,'k_other','staged') RETURNING id`,
      [other, JSON.stringify(A1)])).rows[0].id;
    const r = await call(`/api/borrower/track-record-candidates/${theirs}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine' }) });
    ok(r.status === 404, 'a borrower cannot answer somebody ELSE\'S candidate');

    const cid = await stage({ line1: '8 Twice Rd', city: 'Lakewood', state: 'NJ', zip: '08701' });
    await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'not_mine' }) });
    const again = await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'mine' }) });
    ok(again.status === 409, 'and cannot answer the same one twice');

    const bad = await call(`/api/borrower/track-record-candidates/${cid}/answer`, {
      method: 'POST', body: JSON.stringify({ answer: 'maybe' }) });
    ok(bad.status === 400, 'an answer that is not one of the two is refused');

    // A STAFF decision is not the borrower's to undo.
    const sid = await stage({ line1: '12 Staff Said', city: 'Lakewood', state: 'NJ', zip: '08701' });
    await db.query(
      `UPDATE track_record_candidates SET status='declined', decided_by=$2::uuid, decided_by_kind='staff', decided_at=now()
        WHERE id=$1`, [sid, staff.id]);
    const u = await call(`/api/borrower/track-record-candidates/${sid}/undo`, { method: 'POST' });
    ok(u.status === 409, 'a borrower may not undo a decision OUR TEAM made');
    await db.query('DELETE FROM track_record_candidates WHERE borrower_id=$1', [other]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [other]).catch(() => {});
  }

  console.log('\n8. THE BORROWER CAN NEVER SPEND THE LOOKUP ALLOWANCE');
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/lib/track-record/borrower-confirm.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/require\(['"][^'"]*elementix/.test(code),
      'the module does not reach the vendor layer AT ALL — a throttle can be raised, an absent code path cannot');
    ok(!/researchProperty|runSearch|callTool/.test(code),
      '…and names no lookup, search or tool call anywhere');

    /* THE LEAK TEST ABOVE IS WEAKER THAN IT LOOKS, AND THIS IS WHY IT NEEDS A
       PARTNER. Mutating the projection to pass the whole row through tripped
       only ONE assertion (`decided_by`) — because the SELECT does not FETCH the
       vendor payload, the staff notes or the match reasoning, so a broken
       projection has nothing to leak. That is the right design (two layers), but
       it means the response-scanning assertions cannot prove the projection is
       safe on their own. The property that actually keeps the secrets out is the
       SELECT naming its columns, so that is what is guarded: `c.*` here would
       arm every one of those leaks at once, silently. */
    const sel = code.slice(code.indexOf('loadForBorrower'), code.indexOf('const shape'));
    ok(!/\bc\.\*/.test(sel) && !/SELECT\s+\*/i.test(sel),
      'the borrower queue SELECTS NAMED COLUMNS — `c.*` would fetch the vendor payload and the staff notes and leave only the projection between them and the borrower');
    for (const col of ['raw', 'internal_notes', 'match_why', 'search_id']) {
      ok(!new RegExp(`\\bc\\.${col}\\b`).test(sel), `…and never fetches c.${col}`);
    }
  }

  await db.query('DELETE FROM track_record_candidates WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrower_auth WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${tag}%`]).catch(() => {});
  server.close();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  a borrower\'s yes is a claim, nothing internal leaks, and their typed figures survive');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
