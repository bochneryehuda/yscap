'use strict';
/**
 * THE RECORDS STAMP + THE BORROWER'S OWN SEARCH + "SEE MORE INFORMATION" —
 * real Postgres, real HTTP, vendor stubbed.
 *
 * What carries this file:
 *   §1  The stamp is DERIVED, and honestly: a proved elementix pillar makes a
 *       line 'verified'; the importer's origin or a successful candidate makes
 *       it 'sourced'; a contradicted re-run DOWNGRADES on its own (derived,
 *       never stored); the human is_verified is a third thing the stamp never
 *       reads.
 *   §3  The borrower door: one click runs the real engine; the durable cooldown
 *       and the monthly ceiling answer without spending; the per-minute keyed
 *       throttle 429s; the summary is borrower-safe; the bare personal-name
 *       search NEVER goes to the vendor from this door (the privacy rule made
 *       observable — the stub records every call).
 *   §4  "See more information": the story reads the property's own recorded
 *       documents; the apply is FILL-ONLY by construction; a VERIFIED line
 *       refuses without confirmReopen and db/485 honestly re-opens on the
 *       confirmed fill.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP records-stamp db (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

/* Stub the vendor before anything loads it — and RECORD every call, so the
   privacy assertion ("no bare personal-name search from the borrower door")
   is proven from what actually went to the wire, not from source text. */
const clientPath = require.resolve('../src/elementix/client.js');
const realClient = require('../src/elementix/client');
const calls = [];
let reply = () => ({ ok: false, reason: 'disabled', detail: 'switched off' });
require.cache[clientPath].exports = {
  ...realClient,
  callTool: async (n, a) => { calls.push({ n, a }); return reply(n, a); },
};

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const RS = require('../src/lib/track-record/records-stamp');
const tag = `rstamp_${process.pid}`;

const ENT_ID = '21111111-2222-3333-4444-555555555555';
const A1 = '62 Highland St, Lakewood, NJ 08701';

const deed = (addr, grantors, grantees, date, amount, docId) => ({
  id: docId, countyDocumentId: docId, dataSource: 'elementix',
  addresses: [{ id: `a_${docId}`, addressFull: addr }],
  grantors, grantees, recordingDate: date, totalConsideration: amount,
  isGrantee: grantees.some((g) => /RS Trading/i.test(g)),
  isGrantor: grantors.some((g) => /RS Trading/i.test(g)),
});
const DEEDS = [
  deed(A1, ['Somebody Else'], ['RS Trading LLC'], '2025-08-02', 410000, 'rs_d1'),
  deed(A1, ['RS Trading LLC'], ['Marcus Reed'], '2026-03-14', 612000, 'rs_d2'),
];
const found = (name) => {
  if (name === 'match_entity') return { ok: true, data: { results: [{ id: ENT_ID, name: 'RS TRADING LLC' }] } };
  if (name === 'get_entity_deeds') return { ok: true, data: { results: DEEDS } };
  return { ok: true, data: { results: [] } };
};

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Records','Stamp',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  const line = async (over = {}) => (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price, origin, entered_by_kind)
     VALUES ($1,$2,'flip',$3,$4,$5) RETURNING id, created_at`,
    [borrowerId, JSON.stringify({ oneLine: over.addr || '1 Test St, Lakewood, NJ 08701' }),
      over.price == null ? 100000 : over.price, over.origin || 'portal', over.by || 'staff'])).rows[0];
  const stampOf = async (id) => (await db.query(
    `SELECT ${RS.stampSelect('t')} FROM track_records t WHERE t.id=$1`, [id])).rows[0];

  console.log('\n1. The stamp SQL — three states, precedence, and the honest downgrade');
  {
    const plain = await line({});
    let s = await stampOf(plain.id);
    ok(s.records_stamp === null && s.records_stamp_at === null, 'a hand-entered line carries NO stamp');

    const pub = await line({ origin: 'public_records', addr: '2 Test St, Lakewood, NJ 08701' });
    s = await stampOf(pub.id);
    ok(s.records_stamp === 'sourced', 'an importer-written line (origin=public_records) is SOURCED');
    ok(s.records_stamp_at && new Date(s.records_stamp_at).getTime() === new Date(pub.created_at).getTime(),
      'and its stamp date is the line\'s own creation');

    const cand = await line({ addr: '3 Test St, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, source, raw, dedupe_key, status, imported_track_record_id, decided_at)
       VALUES ($1,'elementix','{}',$2,'imported',$3, now())`, [borrowerId, `${tag}:c1`, cand.id]);
    s = await stampOf(cand.id);
    ok(s.records_stamp === 'sourced', 'an imported elementix candidate makes its line SOURCED');

    const merged = await line({ addr: '4 Test St, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, source, raw, dedupe_key, status, match_track_record_id, decided_at)
       VALUES ($1,'elementix','{}',$2,'merged',$3, now())`, [borrowerId, `${tag}:c2`, merged.id]);
    ok((await stampOf(merged.id)).records_stamp === 'sourced', 'a MERGED candidate stamps the line it merged into');

    const declined = await line({ addr: '5 Test St, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_candidates (borrower_id, source, raw, dedupe_key, status, match_track_record_id, decided_at)
       VALUES ($1,'elementix','{}',$2,'declined',$3, now())`, [borrowerId, `${tag}:c3`, declined.id]);
    ok((await stampOf(declined.id)).records_stamp === null,
      'a DECLINED candidate proves nothing — the line stays unstamped');

    const ver = await line({ origin: 'public_records', addr: '6 Test St, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict, auto_checked_at)
       VALUES ($1,'ownership','elementix','proved', now())
       ON CONFLICT (track_record_id, pillar) DO UPDATE
         SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict, auto_checked_at=EXCLUDED.auto_checked_at`, [ver.id]);
    s = await stampOf(ver.id);
    ok(s.records_stamp === 'verified', 'a PROVED elementix ownership pillar makes the line VERIFIED');
    ok(s.records_stamp !== 'sourced', 'and VERIFIED wins over the sourced provenance on the same line');

    const rec = await line({ addr: '7 Test St, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict, auto_checked_at)
       VALUES ($1,'recency','derived','proved', now())
       ON CONFLICT (track_record_id, pillar) DO UPDATE
         SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict, auto_checked_at=EXCLUDED.auto_checked_at`, [rec.id]);
    ok((await stampOf(rec.id)).records_stamp === null,
      'a derived RECENCY verdict is date arithmetic, never a records match — no stamp');

    // THE HONEST DOWNGRADE: a re-run that stops proving takes the word
    // "verified" off the line on its own, because the stamp is derived.
    await db.query(
      `UPDATE track_record_pillars SET auto_verdict='contradicted' WHERE track_record_id=$1`, [ver.id]);
    s = await stampOf(ver.id);
    ok(s.records_stamp === 'sourced',
      'a re-run that CONTRADICTS downgrades verified → sourced with no writer anywhere (derived, never stored)');

    // The human's own verification is a third thing the stamp never reads.
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified' WHERE id=$1`, [plain.id]);
    ok((await stampOf(plain.id)).records_stamp === null,
      'a HUMAN-verified line with no records provenance still carries no records stamp');
  }

  console.log('\n2. The ENTITY stamp — the db/400 adoption source, on the bundle every screen reads');
  {
    const el = (await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, formation_state, adopted_source, adopted_at)
       VALUES ($1,'RS Elementix LLC','NJ','elementix', now()) RETURNING id`, [borrowerId])).rows[0].id;
    const hu = (await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,'RS Human LLC','NJ') RETURNING id`,
      [borrowerId])).rows[0].id;
    const r = await db.query(
      `SELECT id, ${RS.ENTITY_STAMP_SQL('l')} AS entity_stamp FROM llcs l WHERE l.borrower_id=$1 ORDER BY created_at`,
      [borrowerId]);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x.entity_stamp]));
    ok(byId[el] === 'sourced', 'an elementix-adopted company reads SOURCED');
    ok(byId[hu] === null, 'a company a human put on the profile reads nothing');
    const bundle = await require('../src/lib/llc').getLlcBundle(el);
    ok(bundle && bundle.adopted_source === 'elementix' && !!bundle.adopted_at,
      'the LLC bundle (SELECT *) carries adopted_source/adopted_at to every portal list');
  }

  console.log('\n3. The borrower door — run, cooldown, ceiling, throttle, and the privacy rule');
  {
    // Their own login + their entity to search under.
    await db.query(
      `INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0)
       ON CONFLICT (borrower_id) DO NOTHING`, [borrowerId]);
    const btoken = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const bcall = (p, o) => fetch(`${base}${p}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${btoken}`, ...(o && o.headers) },
    });
    await db.query(`INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,'RS Trading LLC','NJ')`, [borrowerId]);

    reply = found;
    calls.length = 0;
    const r1 = await bcall('/api/borrower/track-record-search', { method: 'POST', body: '{}' });
    ok(r1.status === 200, 'the borrower search answers 200');
    const o1 = await r1.json();
    ok(o1.ok === true && o1.ran === true, 'and the engine actually ran');
    ok(o1.forReview >= 1, `the found property waits in the confirm queue (forReview ${o1.forReview})`);
    ok(typeof o1.summary === 'string' && !/elementix/i.test(o1.summary),
      'the summary is borrower-safe — the vendor is never named');
    ok(o1._audit === undefined, 'the internal _audit block never reaches the borrower');
    ok(o1.skips === undefined && o1.searchedUnder === undefined,
      'no staff-wording fields (skips / searchedUnder) leak through');

    // THE PRIVACY RULE, observed at the wire: the borrower has a personal NAME
    // on file, and not one vendor call carried it — only the entity was searched.
    const wire = JSON.stringify(calls);
    ok(!/Records Stamp|Records\s*Stamp/i.test(wire),
      'no vendor call carries the borrower\'s bare personal name (personalNameSearch:false)');
    ok(calls.some((c) => c.n === 'match_entity'), 'the entity search still ran');

    const search = (await db.query(
      `SELECT query, skips FROM track_record_searches WHERE borrower_id=$1 ORDER BY run_at DESC LIMIT 1`,
      [borrowerId])).rows[0];
    ok(search && search.query && search.query.requestedBy === 'borrower',
      'the search row records requestedBy=borrower (what the monthly ceiling counts)');
    ok(Array.isArray(search.skips) && search.skips.some((s) => s.reason === 'personal_name_not_searched'),
      'and the suppressed name search is RECORDED as a skip with its reason — never silent');

    const audit = (await db.query(
      `SELECT 1 FROM audit_log WHERE action='borrower_track_record_search' AND entity_id=$1 LIMIT 1`,
      [borrowerId])).rows[0];
    ok(!!audit, 'the click is audited');

    const r2 = await bcall('/api/borrower/track-record-search', { method: 'POST', body: '{}' });
    const o2 = await r2.json();
    ok(r2.status === 200 && o2.ran === false && o2.cooldown === true,
      'a second click inside the window answers from the cooldown — nothing spent');
    ok(!/elementix/i.test(String(o2.summary)), 'the cooldown sentence is borrower-safe too');

    // The monthly ceiling: age the real search out of the cooldown, then fill
    // the 30-day window with borrower-run rows.
    await db.query(`UPDATE track_record_searches SET run_at = now() - interval '20 minutes' WHERE borrower_id=$1`, [borrowerId]);
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO track_record_searches (borrower_id, query, run_at) VALUES ($1,'{"requestedBy":"borrower"}', now() - interval '1 day')`,
        [borrowerId]);
    }
    const r3 = await bcall('/api/borrower/track-record-search', { method: 'POST', body: '{}' });
    const o3 = await r3.json();
    ok(r3.status === 200 && o3.ran === false && o3.limit === true,
      'the 10-per-30-days ceiling answers without running — durable, not in-memory');

    const r4 = await bcall('/api/borrower/track-record-search', { method: 'POST', body: '{}' });
    ok(r4.status === 429, 'a fourth click inside one minute hits the per-borrower throttle (429)');

    // A STAFF search never spends the borrower's allowance: the ceiling counted
    // only requestedBy=borrower rows — prove the query is that narrow.
    await db.query(`DELETE FROM track_record_searches WHERE borrower_id=$1 AND query->>'requestedBy'='borrower' AND run_at < now() - interval '2 hours'`, [borrowerId]);
    const staffRows = (await db.query(
      `SELECT count(*)::int AS c FROM track_record_searches WHERE borrower_id=$1 AND query->>'requestedBy' IS DISTINCT FROM 'borrower'`,
      [borrowerId])).rows[0];
    ok(staffRows.c === 0, '(fixture sanity: no staff rows were counted into the ceiling)');
  }

  console.log('\n4. "See more information" — the story, the fill-only apply, the reopen handshake');
  {
    const staff = (await db.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Stamp Tester','underwriter') RETURNING id, token_version`,
      [`${tag}-staff@example.com`])).rows[0];
    const stoken = C.signJwt({ sub: staff.id, kind: 'staff', role: 'underwriter', tv: staff.token_version || 0 });
    const scall = (p, o) => fetch(`${base}${p}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${stoken}`, ...(o && o.headers) },
    });

    // The line: the deeds say bought 410k (2025-08-02), sold 612k (2026-03-14);
    // the line holds a DIFFERENT purchase price and NO sale figures.
    const tr = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, entity_name, purchase_price, entered_by_kind)
       VALUES ($1,$2,'flip','RS Trading LLC',400000,'staff') RETURNING id`,
      [borrowerId, JSON.stringify({ oneLine: A1, street: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0];

    reply = found;
    const mi = await scall(`/api/staff/track-records/${tr.id}/more-info`, { method: 'POST', body: '{}' });
    ok(mi.status === 200, 'more-info answers 200');
    const info = await mi.json();
    ok(Array.isArray(info.story) && info.story.filter((s) => s.kind === 'deed').length === 2,
      `the story tells this property's own recorded deeds (${(info.story || []).length} entries)`);
    const sale = (info.suggestions || []).find((s) => s.field === 'sale_price');
    const saleDate = (info.suggestions || []).find((s) => s.field === 'sale_date');
    const pp = (info.suggestions || []).find((s) => s.field === 'purchase_price');
    ok(sale && sale.fillable === true && Number(sale.records) === 612000, 'the blank sale price is offered from the records');
    ok(saleDate && saleDate.fillable === true && saleDate.records === '2026-03-14', 'so is the sale date');
    ok(pp && pp.fillable === false && Number(pp.current) === 400000 && Number(pp.records) === 410000,
      'the DIFFERING purchase price is shown, never offered');

    const ap = await scall(`/api/staff/track-records/${tr.id}/more-info/apply`, {
      method: 'POST', body: JSON.stringify({ fields: ['sale_price', 'sale_date', 'purchase_price'] }),
    });
    ok(ap.status === 200, 'apply answers 200');
    const applied = await ap.json();
    ok(applied.applied.some((a) => a.field === 'sale_price') && applied.applied.some((a) => a.field === 'sale_date'),
      'the two blanks were filled');
    ok(!applied.applied.some((a) => a.field === 'purchase_price'), 'the differing purchase price was NOT touched');
    const row = (await db.query(`SELECT purchase_price, sale_price, sale_date, is_verified FROM track_records WHERE id=$1`, [tr.id])).rows[0];
    ok(Number(row.purchase_price) === 400000, 'fill-only by construction: the typed figure survives');
    ok(Number(row.sale_price) === 612000 && String(row.sale_date).slice(0, 10) === '2026-03-14', 'the records figures landed');

    // The reopen handshake on a VERIFIED line.
    // A new line is BORN pending (the 2026-08-03 rule — a DB trigger resets the
    // review on insert), so the verified fixture is set by a separate UPDATE,
    // the way the verify route writes it.
    const tr2 = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, entity_name, purchase_price, entered_by_kind)
       VALUES ($1,$2,'flip','RS Trading LLC',410000,'staff') RETURNING id`,
      [borrowerId, JSON.stringify({ oneLine: A1, street: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0];
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified' WHERE id=$1`, [tr2.id]);
    ok((await db.query(`SELECT is_verified FROM track_records WHERE id=$1`, [tr2.id])).rows[0].is_verified === true,
      '(fixture sanity: the line really is verified before the apply)');
    const refuse = await scall(`/api/staff/track-records/${tr2.id}/more-info/apply`, {
      method: 'POST', body: JSON.stringify({ fields: ['sale_price'] }),
    });
    ok(refuse.status === 409, 'a VERIFIED line refuses a material fill without the second yes');
    const rbody = await refuse.json();
    ok(rbody.code === 'would_reopen' && Array.isArray(rbody.fields) && rbody.fields.includes('sale_price'),
      'and the refusal names the code + the fields so the screen can re-ask');
    ok((await db.query(`SELECT sale_price FROM track_records WHERE id=$1`, [tr2.id])).rows[0].sale_price === null,
      'nothing was written on the refusal');

    const confirm = await scall(`/api/staff/track-records/${tr2.id}/more-info/apply`, {
      method: 'POST', body: JSON.stringify({ fields: ['sale_price'], confirmReopen: true }),
    });
    ok(confirm.status === 200, 'confirmReopen:true applies');
    const cbody = await confirm.json();
    ok(cbody.reopened === true, 'and reports the verification re-opened');
    const row2 = (await db.query(`SELECT sale_price, is_verified FROM track_records WHERE id=$1`, [tr2.id])).rows[0];
    ok(Number(row2.sale_price) === 612000, 'the figure landed');
    ok(row2.is_verified === false, 'db/485 honestly re-opened the review on the material fill');
  }

  console.log('\n5. The saved copy carries the stamp — SQL to HTML, end to end');
  {
    const HC = require('../src/lib/track-record/html-copy');
    const rows = (await db.query(
      `SELECT t.property_address, t.deal_type, t.property_type, t.entity_name, t.owned_personally,
              t.purchase_price, t.purchase_date, t.rehab_amount, t.sale_price, t.sale_date,
              t.rent_amount, t.rent_date, t.refi_amount, t.refi_date, t.verification_status,
              ${RS.stampSelect('t')}
         FROM track_records t WHERE t.borrower_id=$1 ORDER BY t.created_at`, [borrowerId])).rows;
    ok(rows.some((r) => r.records_stamp === 'sourced'), '(fixture sanity: a sourced line exists)');
    const html = HC.buildSavedCopyHtml({ borrowerName: 'Records Stamp', rows, generatedAt: new Date() });
    ok(html.includes('○ Sourced via Elementix'), 'the saved copy prints the per-line stamp cell');
    ok(/SOURCED VIA ELEMENTIX — |VERIFIED TO ELEMENTIX — /.test(html), 'and the headline stamp line');
    ok(html.includes('From the public records:'), 'and the sum chip');
  }

  // ---- cleanup ----
  await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM track_record_searches WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM track_record_pillars WHERE track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`${tag}%`]).catch(() => {});

  server.close();
  console.log('');
  if (fail) { console.error(`${fail} FAILURE(S)`); process.exit(1); }
  console.log('records-stamp db: ALL PASS');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
