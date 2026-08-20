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
 *   §7  The entity ownership-check, both ways round: confirming a company ADDS
 *       confidence and can never take "Verified to Elementix" off a line the
 *       records proved (the post-merge audit finding), while REVOKING one
 *       withdraws the proof that rested on it — with the deed's own observation
 *       kept, a borrower-named deed untouched, and a human's decision reported
 *       rather than erased.
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

  console.log('\n1b. THE DISQUALIFIER — a line the records DISAGREE with never says "Verified to Elementix"');
  {
    // Reproduces the audit finding: a PROVED ownership beside a CONTRADICTED
    // exit — the module's own headline check, "they say they sold it and the
    // record still shows them owning it" — used to print ✓ Verified to
    // Elementix on the investor package.
    const both = async (over) => {
      const l = await line({ origin: 'public_records', addr: over.addr });
      for (const p of over.pillars) {
        await db.query(
          `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict, human_verdict, auto_checked_at)
           VALUES ($1,$2,'elementix',$3,$4, now())
           ON CONFLICT (track_record_id, pillar) DO UPDATE
             SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict,
                 human_verdict=EXCLUDED.human_verdict, auto_checked_at=EXCLUDED.auto_checked_at`,
          [l.id, p.pillar, p.auto, p.human || null]);
      }
      return l;
    };
    const clean = await both({ addr: '10 Clean Rd, Lakewood, NJ 08701', pillars: [{ pillar: 'ownership', auto: 'proved' }, { pillar: 'exit', auto: 'proved' }] });
    ok((await stampOf(clean.id)).records_stamp === 'verified', 'both pillars proved → VERIFIED (the control)');

    const contra = await both({ addr: '11 Contradicted Exit St, Lakewood, NJ 08701', pillars: [{ pillar: 'ownership', auto: 'proved' }, { pillar: 'exit', auto: 'contradicted' }] });
    const cs = await stampOf(contra.id);
    ok(cs.records_stamp === 'sourced',
      'ownership proved but the exit CONTRADICTED → falls back to sourced, never "Verified to Elementix"');
    ok(require('../src/lib/track-record/records-stamp').exportCellText(cs.records_stamp, cs.records_stamp_at).startsWith('○'),
      'and the export cell says Sourced, not a tick');

    const rejected = await both({ addr: '12 Human Rejected Ave, Lakewood, NJ 08701', pillars: [{ pillar: 'ownership', auto: 'proved', human: 'rejected' }] });
    ok((await stampOf(rejected.id)).records_stamp === 'sourced',
      'a human REJECTION outranks the machine — the stamp never re-asserts over a person');

    const confirmed = await both({ addr: '13 Human Confirmed Ln, Lakewood, NJ 08701', pillars: [{ pillar: 'ownership', auto: 'proved', human: 'confirmed' }] });
    ok((await stampOf(confirmed.id)).records_stamp === 'verified',
      'a human CONFIRMATION is not required and does not change it — a records match is a fact about the records');

    // The headline sentence must not claim more than the cells show.
    const rows = (await db.query(
      `SELECT ${RS.stampSelect('t')} FROM track_records t WHERE t.borrower_id=$1
         AND t.property_address->>'oneLine' LIKE ANY (ARRAY['10 Clean%','11 Contradicted%','12 Human Rejected%'])`,
      [borrowerId])).rows;
    const lineTxt = RS.summaryLine(rows);
    ok(/1 of 3 properties matched/.test(String(lineTxt)),
      `the export headline counts ONE of the three as matched (got: ${lineTxt})`);
  }

  console.log('\n1c. THE STAMP DATE ACTUALLY RENDERS — pg hands us a Date, not a string');
  {
    const l = await line({ origin: 'public_records', addr: '14 Dated St, Lakewood, NJ 08701' });
    const s = await stampOf(l.id);
    ok(s.records_stamp_at instanceof Date,
      '(the driver really does return a JS Date for these timestamptz columns — the premise of the bug)');
    const cell = RS.exportCellText(s.records_stamp, s.records_stamp_at);
    ok(/· \d{4}-\d{2}-\d{2}$/.test(cell), `the export cell carries the day (got: ${cell})`);
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
    // Rows that actually SPENT something — the ceiling deliberately ignores a
    // run that never reached the vendor (see 3b), so a fixture with no
    // api_calls would no longer count and would prove nothing.
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO track_record_searches (borrower_id, query, api_calls, run_at)
         VALUES ($1,'{"requestedBy":"borrower"}', 4, now() - interval '1 day')`,
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

  console.log('\n6. THE AUDIT FIXES — the dead end, the race, the cap, the outage, the id guard');
  {
    const SS = require('../src/lib/track-record/self-search');
    const C2 = require('../src/lib/crypto');
    // A second borrower with a CLEAN history, so these start from zero.
    const b2 = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Audit','Fixes',$1) RETURNING id`,
      [`${tag}-b2@example.com`])).rows[0].id;
    await db.query(
      `INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',0)
       ON CONFLICT (borrower_id) DO NOTHING`, [b2]);
    const t2 = C2.signJwt({ sub: b2, kind: 'borrower', tv: 0 });
    const call2 = (p, o) => fetch(`${base}${p}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${t2}`, ...(o && o.headers) },
    });

    // ── 6a. A run with NOTHING TO SEARCH must not charge them for it ──────
    // b2 has no companies and no linked records profile, so the engine cannot
    // search at all. Before the fix this still wrote a row that armed the
    // 15-minute cooldown AND burned 1 of 10 — while the screen told them, in
    // those words, to add a company and try again. That is a dead end.
    reply = found;
    const empty = await (await call2('/api/borrower/track-record-search', { method: 'POST', body: '{}' })).json();
    ok(empty.ran === true && empty.nothingToSearch === true, 'with nothing to search the run reports it plainly');
    ok(/add the company you buy under/i.test(String(empty.summary)), 'and the sentence tells them what to do');
    const spent = (await db.query(
      `SELECT COALESCE(api_calls,0) AS c FROM track_record_searches WHERE borrower_id=$1 ORDER BY run_at DESC LIMIT 1`,
      [b2])).rows[0];
    ok(Number(spent.c) === 0, '(it really did spend nothing)');
    const retry = await SS.selfSearch(b2);
    ok(retry.cooldown !== true,
      'the retry it just invited is NOT refused by the cooldown — a run that spent nothing does not lock them out');
    const counted = (await db.query(
      `SELECT count(*)::int AS c FROM track_record_searches
        WHERE borrower_id=$1 AND query->>'requestedBy'='borrower' AND COALESCE(api_calls,0) > 0`, [b2])).rows[0];
    ok(counted.c === 0, 'and nothing was charged against the 10-per-30-days ceiling');

    // ── 6b. ONE SEARCH AT A TIME ──────────────────────────────────────────
    // Three clicks landing together used to pass the read-then-act guards and
    // all run (measured: 3 full searches, and a borrower one under the ceiling
    // could push past it). The lock makes the losers say so instead.
    const b3 = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Race','Fixes',$1) RETURNING id`,
      [`${tag}-b3@example.com`])).rows[0].id;
    await db.query(`INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,'RS Trading LLC','NJ')`, [b3]);
    const burst = await Promise.all([SS.selfSearch(b3), SS.selfSearch(b3), SS.selfSearch(b3)]);
    const ranCount = burst.filter((r) => r.ran === true).length;
    ok(ranCount === 1, `three simultaneous clicks run the engine ONCE (ran: ${burst.map((r) => r.ran).join(',')})`);
    ok(burst.some((r) => r.running === true || r.cooldown === true),
      'and the losers say a search is already running — never a silent no-op');
    const rows3 = (await db.query(
      `SELECT count(*)::int AS c FROM track_record_searches WHERE borrower_id=$1 AND COALESCE(api_calls,0) > 0`, [b3])).rows[0];
    ok(rows3.c === 1, 'exactly one search row spent anything');

    // ── 6c. THE BORROWER DOES NOT SET THE BILL ────────────────────────────
    const b4 = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cap','Fixes',$1) RETURNING id`,
      [`${tag}-b4@example.com`])).rows[0].id;
    for (let i = 0; i < 20; i++) {
      await db.query(`INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,$2,'NJ')`,
        [b4, `Cap Test Holdings ${i} LLC`]);
    }
    calls.length = 0;
    const capped = await SS.selfSearch(b4);
    const entityLookups = calls.filter((c) => c.n === 'match_entity').length;
    ok(capped.ran === true, 'the capped search still runs');
    ok(entityLookups <= SS.BORROWER_ENTITY_CAP,
      `20 companies on the profile look up at most ${SS.BORROWER_ENTITY_CAP} (was ${entityLookups}) — one click cannot drain the office's shared allowance`);
    const capSkip = (await db.query(
      `SELECT skips FROM track_record_searches WHERE borrower_id=$1 ORDER BY run_at DESC LIMIT 1`, [b4])).rows[0];
    ok(Array.isArray(capSkip.skips) && capSkip.skips.some((s) => s.reason === 'entity_cap'),
      'and what it did not reach is RECORDED — no silent caps');

    // ── 6d. A FAILED READ MUST NOT ERASE THE STAMP ────────────────────────
    const keep = await line({ origin: 'public_records', addr: '20 Outage Rd, Lakewood, NJ 08701' });
    await db.query(
      `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict, auto_checked_at)
       VALUES ($1,'ownership','elementix','proved', now())
       ON CONFLICT (track_record_id, pillar) DO UPDATE
         SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict,
             human_verdict=NULL, auto_checked_at=EXCLUDED.auto_checked_at`, [keep.id]);
    ok((await stampOf(keep.id)).records_stamp === 'verified', '(the line is verified before the outage)');
    reply = () => { throw new Error('vendor unreachable'); };
    const outage = await require('../src/lib/track-record/verify-run')
      .runVerify(keep.id, { staffId: null, force: true }, db);
    ok(outage.readFailed === true, 'a forced re-read during an outage reports readFailed');
    ok(outage.pillarsWritten === false, 'and writes no verdicts at all');
    ok((await stampOf(keep.id)).records_stamp === 'verified',
      'so the stamp SURVIVES — a click on "Re-read the records" during an outage no longer destroys it');
    reply = found;

    // ── 6e. THE ID GUARD AND THE EMPTY SELECTION ──────────────────────────
    const staff2 = (await db.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Audit Fix Tester','underwriter') RETURNING id, token_version`,
      [`${tag}-staff2@example.com`])).rows[0];
    const st2 = C2.signJwt({ sub: staff2.id, kind: 'staff', role: 'underwriter', tv: staff2.token_version || 0 });
    const scall2 = (p, o) => fetch(`${base}${p}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${st2}`, ...(o && o.headers) },
    });
    const bad = await scall2('/api/staff/track-records/not-a-uuid/more-info', { method: 'POST', body: '{}' });
    ok(bad.status === 404, 'a malformed track-record id is a 404, not a 500 reading as "PILOT is broken"');
    const bad2 = await scall2('/api/staff/track-records/not-a-uuid/more-info/apply', { method: 'POST', body: '{}' });
    ok(bad2.status === 404, 'the apply door guards its id too');

    /* The line is at the address the stubbed records DO cover, and carries
       blanks — so the records genuinely have something to fill. Without that
       the assertion below is vacuous (it passes whether or not the fix is
       there), which is exactly how the first cut of this check slipped a
       mutation. The CONTROL immediately after proves the fixture was fillable. */
    const blank = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, entity_name, entered_by_kind)
       VALUES ($1,$2,'flip','RS Trading LLC','staff') RETURNING id`,
      [borrowerId, JSON.stringify({ oneLine: A1, street: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0];
    const LD = require('../src/lib/track-record/line-details');
    const none = await LD.applyFromRecords(blank.id, { staffId: staff2.id, fields: [] }, db);
    ok((none.applied || []).length === 0,
      'an EMPTY selection fills nothing — it no longer silently means "fill every blank on the line"');
    const all = await LD.applyFromRecords(blank.id, { staffId: staff2.id }, db);
    ok((all.applied || []).length > 0,
      `(control: the records really did have fields to fill — ${(all.applied || []).length} of them — so the check above is not vacuous)`);
    await db.query(`DELETE FROM track_records WHERE id=$1`, [blank.id]).catch(() => {});

    // ── 6f. THE FULL SCREEN FINDS THE BORROWER IT WAS SENT TO ─────────────
    // The queue is capped and ordered by recency, so narrowing it client-side
    // showed NOTHING for any borrower outside the cap: the full-screen link off
    // a loan file landed on "Nothing is waiting", which is false for a borrower
    // who has lines. The narrowing is the SERVER's job now.
    {
      const W = require('../src/lib/track-record/workspace');
      const mine = await W.loadQueue({ borrowerId, filter: 'all' }, db);
      ok(Array.isArray(mine.groups) && mine.groups.length === 1,
        `scoping to one borrower returns exactly that borrower's group (got ${(mine.groups || []).length})`);
      ok(mine.groups[0] && String(mine.groups[0].borrowerId) === String(borrowerId), 'and it is the right person');
      ok((mine.groups[0].lines || []).length > 0, 'with their lines on it');
      const other = await W.loadQueue({ borrowerId: b4, filter: 'all' }, db);
      ok((other.groups || []).every((g) => String(g.borrowerId) === String(b4)),
        'another borrower id returns only that borrower — never a neighbour');
      // AND it still ANDs onto the visibility scope rather than replacing it.
      const scoped = await W.loadQueue(
        { borrowerId, filter: 'all', visibleBorrowerSql: 'b.id = $1', params: ['00000000-0000-0000-0000-000000000000'] }, db);
      ok((scoped.groups || []).length === 0,
        'the borrower filter never widens the caller\'s own visibility scope');
    }

    // ── 6g. THE INVESTOR PDF SURVIVES A STAMPED LINE ──────────────────────
    // `✓` / `○` are not encodable in the PDF's WinAnsi font, and the builder
    // sits in a try/catch that only warns — so one stamped line made the
    // investor package's Track Record.pdf silently disappear from the ZIP.
    {
      const TRX = require('../src/lib/track-record-export');
      const cols = [
        { header: 'Property', key: 'property', w: 3 },
        { header: 'Review status', key: 'status', w: 1.5 },
        { header: 'Public records', key: 'records', w: 1.8 },
      ];
      for (const st of ['verified', 'sourced']) {
        const rows = [{
          property: '62 Highland St', status: 'Verified', __status: 'verified',
          records: RS.exportCellText(st, new Date()), __recordsStamp: st, __recordsStampAt: new Date(),
        }];
        let buf = null; let threw = null;
        try { buf = await TRX.buildTrackRecordPdf([{ title: 'FIX & FLIP', columns: cols, rows }], { borrowerName: 'T' }); }
        catch (e) { threw = e; }
        ok(!threw && Buffer.isBuffer(buf) && buf.length > 0,
          `the investor PDF builds with a ${st} line${threw ? ` (threw: ${threw.message})` : ''}`);
      }
      ok(RS.exportCellText('verified', null, { ascii: true }) === 'Verified to Elementix',
        'the ASCII cell carries the same words with no glyph');
      ok(!/[^ -ÿ]/.test(RS.exportCellText('verified', new Date(), { ascii: true }).replace('·', '')),
        'and everything left in it is inside the PDF font');
    }

    for (const id of [b2, b3, b4]) {
      await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM track_record_searches WHERE borrower_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM track_record_pillars WHERE track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)`, [id]).catch(() => {});
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [id]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [id]).catch(() => {});
    }
  }

  console.log('\n7. VERIFYING THE COMPANY ADDS CONFIDENCE — IT NEVER TAKES THE STAMP OFF');
  {
    /* THE POST-MERGE AUDIT FINDING, REPRODUCED THROUGH THE REAL DOOR.
       `POST /api/staff/llcs/:id/ownership-check` fans a verified entity out to
       every property it held, and its UPDATE was unconditional — so it wrote
       `auto_source='entity'` straight over an ownership pillar the RECORDS
       check had PROVED. The stamp is derived from exactly those two columns, so
       confirming a company TOOK "Verified to Elementix" off the line, on the
       screen and on the investor package: an action that can only ever add
       confidence was silently removing it. */
    const staff3 = (await db.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Carry Tester','underwriter') RETURNING id, token_version`,
      [`${tag}-staff3@example.com`])).rows[0];
    const st3 = C.signJwt({ sub: staff3.id, kind: 'staff', role: 'underwriter', tv: staff3.token_version || 0 });
    const scall3 = (path, o) => fetch(`${base}${path}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${st3}`, ...(o && o.headers) },
    });

    const mkEntity = async (name) => {
      const id = (await db.query(
        `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, name])).rows[0].id;
      await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [id, borrowerId]);
      return id;
    };
    /* A line the RECORDS proved: origin public_records (so it is at least
       'sourced' whatever happens to the pillar) plus a proved elementix
       ownership pillar. The pillar row is seeded by a trigger, hence upsert. */
    const mkLine = async (llcId, addr, provedByRecords) => {
      const id = (await db.query(
        /* `counts_from` is GENERATED (db/499) — a flip exits on its SALE date,
           so the holding period the carry judges is set by writing that. */
        `INSERT INTO track_records (borrower_id, llc_id, property_address, deal_type, origin,
                                    entered_by_kind, purchase_date, sale_date)
         VALUES ($1,$2,$3::jsonb,'flip','public_records','staff','2023-02-01','2024-05-01') RETURNING id`,
        [borrowerId, llcId, JSON.stringify({ oneLine: addr })])).rows[0].id;
      if (provedByRecords) {
        await db.query(
          `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict, auto_checked_at)
           VALUES ($1,'ownership','elementix','proved', now())
           ON CONFLICT (track_record_id, pillar) DO UPDATE
             SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict,
                 auto_checked_at=EXCLUDED.auto_checked_at`, [id]);
      }
      return id;
    };
    const own = async (id) => (await db.query(
      `SELECT auto_verdict, auto_source, satisfied_by_llc_id FROM track_record_pillars
        WHERE track_record_id=$1 AND pillar='ownership'`, [id])).rows[0];

    // ── 7a. THE PLAIN CONFIRMATION (no Check B) ───────────────────────────
    const e1 = await mkEntity(`${tag} Carry One LLC`);
    const proved1 = await mkLine(e1, '70 Stamp Keeper Rd, Lakewood, NJ 08701', true);
    const fresh1 = await mkLine(e1, '71 Never Checked Rd, Lakewood, NJ 08701', false);

    const s7 = await stampOf(proved1);
    ok(s7.records_stamp === 'verified', '(fixture) the records-proved line starts VERIFIED');
    ok(RS.exportCellText(s7.records_stamp, s7.records_stamp_at, { ascii: true }).startsWith('Verified to Elementix'),
      '(fixture) and its export cell says Verified to Elementix');

    const r7a = await scall3(`/api/staff/llcs/${e1}/ownership-check`, {
      method: 'POST',
      body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement', note: 'OA names them managing member' }),
    });
    ok(r7a.status === 200, 'confirming the company answers 200');
    const j7a = await r7a.json();

    const afterProved = await own(proved1);
    ok(afterProved.auto_verdict === 'proved' && afterProved.auto_source === 'elementix',
      'the records-proved ownership pillar is LEFT ALONE — no downgrade to no_data, no entity source');
    ok((await stampOf(proved1)).records_stamp === 'verified',
      'so "Verified to Elementix" SURVIVES a company confirmation (the audit finding)');
    ok(j7a.carry && j7a.carry.preserved === 1,
      `and the summary REPORTS the preserved row rather than claiming a carry (preserved ${j7a.carry && j7a.carry.preserved})`);

    // THE CONTROL — the guard must not have turned Check A off.
    const afterFresh = await own(fresh1);
    ok(afterFresh.auto_verdict === 'no_data' && afterFresh.auto_source === 'entity',
      '(control) a never-checked line still receives the carry — the guard did not switch Check A off');
    ok(j7a.carry.noData === 1, '(control) and it is counted');

    // ── 7b. THE assumeCheckB BRANCH — equally destructive before the fix ──
    const e2 = await mkEntity(`${tag} Carry Two LLC`);
    const proved2 = await mkLine(e2, '72 Assume Check B Rd, Lakewood, NJ 08701', true);
    const fresh2 = await mkLine(e2, '73 Assume Fresh Rd, Lakewood, NJ 08701', false);

    const r7b = await scall3(`/api/staff/llcs/${e2}/ownership-check`, {
      method: 'POST',
      body: JSON.stringify({ verified: true, evidenceKind: 'sos_officer_listing', assumeCheckB: true }),
    });
    ok(r7b.status === 200, 'confirming with assumeCheckB answers 200');
    const j7b = await r7b.json();

    const afterProved2 = await own(proved2);
    ok(afterProved2.auto_verdict === 'proved' && afterProved2.auto_source === 'elementix',
      'assumeCheckB does not restamp a records-proved pillar as entity-sourced either');
    ok((await stampOf(proved2)).records_stamp === 'verified',
      '…so the stamp survives that branch too — the carry’s own PROVED says LESS, because the stamp reads the source');
    ok(j7b.carry.preserved === 1 && j7b.carry.carried === 1,
      `(control) the fresh line WAS carried while the proved one was preserved (carried ${j7b.carry.carried}, preserved ${j7b.carry.preserved})`);
    const afterFresh2 = await own(fresh2);
    ok(afterFresh2.auto_verdict === 'proved' && afterFresh2.auto_source === 'entity'
      && String(afterFresh2.satisfied_by_llc_id) === String(e2),
      '(control) …stamped with WHICH entity carried it, exactly as before');

    // ── 7c. A NEGATIVE FINDING IS NEVER SUPPRESSED TO PROTECT A STAMP ─────
    /* The membership window is evidence about the BORROWER that the records
       read never saw — the entity held this property before they had anything
       to do with it. That contradiction writes over a proved row on purpose,
       and the line correctly falls back to 'sourced' rather than claiming a
       verification the file itself disagrees with. */
    const e3 = await mkEntity(`${tag} Carry Three LLC`);
    const proved3 = await mkLine(e3, '74 Joined Later Rd, Lakewood, NJ 08701', true);
    ok((await stampOf(proved3)).records_stamp === 'verified', '(fixture) starts VERIFIED');

    const r7c = await scall3(`/api/staff/llcs/${e3}/ownership-check`, {
      method: 'POST',
      body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement', heldFrom: '2030-01-01' }),
    });
    ok(r7c.status === 200, 'confirming an entity the borrower joined long after answers 200');
    const j7c = await r7c.json();
    const afterC = await own(proved3);
    ok(afterC.auto_verdict === 'contradicted',
      'a membership-window CONTRADICTION still writes over a records-proved pillar — a negative finding is never hidden');
    ok(j7c.carry.contradicted === 1 && j7c.carry.preserved === 0,
      '…and is reported as a contradiction, not as a preserved row');
    ok((await stampOf(proved3)).records_stamp === 'sourced',
      '…so the line honestly drops to Sourced instead of printing "Verified to Elementix" over a contradiction');

    // ── 7d. AND REVOKING THE COMPANY WITHDRAWS WHAT ITS CONTROL PROVED ────
    /* The mirror image, and it was live on merged main independently of the
       carry: when the records check runs while Check A holds, checks.js writes
       the pillar as elementix/proved carrying `controlVerdict:'confirmed'` — and
       it never sets `satisfied_by_llc_id`, so the revoke's "clear only what WE
       carried" matched nothing. The pillar stood after a revoke still stating
       that the borrower's control "has been confirmed", and the line kept
       printing "Verified to Elementix" on the investor package. */
    const recordsProof = async (llcId, addr, extra) => {
      const id = await mkLine(llcId, addr, false);
      await db.query(
        `INSERT INTO track_record_pillars (track_record_id, pillar, auto_source, auto_verdict,
                                           auto_confidence, auto_grade, auto_evidence, auto_checked_at)
         VALUES ($1,'ownership','elementix','proved','certain','superior',$2::jsonb, now())
         ON CONFLICT (track_record_id, pillar) DO UPDATE
           SET auto_source=EXCLUDED.auto_source, auto_verdict=EXCLUDED.auto_verdict,
               auto_confidence=EXCLUDED.auto_confidence, auto_grade=EXCLUDED.auto_grade,
               auto_evidence=EXCLUDED.auto_evidence, auto_checked_at=EXCLUDED.auto_checked_at`,
        [id, JSON.stringify({ why: 'The company is the grantee on the recorded deed.', ...extra })]);
      return id;
    };
    const ev = async (id) => (await db.query(
      `SELECT auto_evidence FROM track_record_pillars WHERE track_record_id=$1 AND pillar='ownership'`,
      [id])).rows[0].auto_evidence;

    const e4 = await mkEntity(`${tag} Carry Four LLC`);
    // Proved BECAUSE Check A held — the pillar a revoke has to answer for.
    const viaControl = await recordsProof(e4, '75 Via Control Rd, Lakewood, NJ 08701',
      { controlVerdict: 'confirmed', satisfiedByLlcId: e4 });
    // Proved by a deed naming the BORROWER themselves — no controlVerdict at all.
    const viaPerson = await recordsProof(e4, '76 Own Name Rd, Lakewood, NJ 08701', {});
    // Proved via control, but a HUMAN then confirmed the pillar.
    const viaHuman = await recordsProof(e4, '77 Human Said So Rd, Lakewood, NJ 08701',
      { controlVerdict: 'confirmed', satisfiedByLlcId: e4 });
    await db.query(
      `UPDATE track_record_pillars SET human_verdict='confirmed', human_by=$2, human_at=now()
        WHERE track_record_id=$1 AND pillar='ownership'`, [viaHuman, staff3.id]);

    await scall3(`/api/staff/llcs/${e4}/ownership-check`, {
      method: 'POST', body: JSON.stringify({ verified: true, evidenceKind: 'operating_agreement' }),
    });
    ok((await stampOf(viaControl)).records_stamp === 'verified', '(fixture) all three start VERIFIED');

    const r7d = await scall3(`/api/staff/llcs/${e4}/ownership-check`, {
      method: 'POST', body: JSON.stringify({ verified: false, reason: 'the operating agreement names somebody else' }),
    });
    ok(r7d.status === 200, 'revoking the company answers 200');
    const j7d = await r7d.json();

    const afterD = await own(viaControl);
    ok(afterD.auto_verdict === 'no_data',
      'a records proof that RESTED on Check A is withdrawn when Check A is revoked');
    ok(afterD.auto_source === 'elementix',
      '…DOWNGRADED, never wiped — what the deed says is a records observation and survives');
    const evD = await ev(viaControl);
    ok(evD && evD.needsControlCheck === true && evD.priorWhy && /grantee on the recorded deed/.test(String(evD.why)) === false,
      '…landing exactly where a fresh read would land it, with the old sentence kept as priorWhy');
    ok((await stampOf(viaControl)).records_stamp === 'sourced',
      'so the line stops saying "Verified to Elementix" the moment its basis is revoked');
    ok(j7d.carry.downgraded === 1, `and the summary says so (downgraded ${j7d.carry.downgraded})`);

    const afterP = await own(viaPerson);
    ok(afterP.auto_verdict === 'proved' && afterP.auto_source === 'elementix',
      '(control) a deed naming the BORROWER themselves carries no controlVerdict and is never touched');
    ok((await stampOf(viaPerson)).records_stamp === 'verified',
      '(control) …so its stamp survives the revoke, correctly');

    const afterH = await own(viaHuman);
    ok(afterH.auto_verdict === 'proved',
      'a pillar a HUMAN confirmed is never silently downgraded — a person’s decision is not erased');
    ok((j7d.carry.humanConfirmed || []).some((h) => String(h.trackRecordId) === String(viaHuman)),
      '…it is REPORTED instead, so the caller can raise entity_unverified against it');

    await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff3.id]).catch(() => {});
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
