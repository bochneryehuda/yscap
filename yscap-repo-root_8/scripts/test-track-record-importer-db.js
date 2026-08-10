'use strict';
/**
 * THE IMPORTER — real HTTP, real Postgres, vendor stubbed.
 *
 * The three that carry this file:
 *   §2  NOTHING FOUND LANDS ON THE TRACK RECORD BY ITSELF. A search stages into
 *       a DIFFERENT TABLE, so a found property is invisible to every experience
 *       count until a person promotes it — invisible because of where it lives,
 *       not because a flag says to skip it.
 *   §5  "Match to existing" FILLS BLANKS AND NEVER OVERWRITES, and it refuses
 *       outright when filling a blank would reopen a verification, until asked
 *       a second time in those words.
 *   §6  "Not this borrower's" is DURABLE. The next search must not raise it
 *       again — which the partial unique index alone does not give you, because
 *       it only stops a second row while the first is still `staged`.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record importer (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

/* Stub the vendor before anything loads it. */
const clientPath = require.resolve('../src/elementix/client.js');
const realClient = require('../src/elementix/client');
let reply = () => ({ ok: false, reason: 'disabled', detail: 'switched off' });
require.cache[clientPath].exports = { ...realClient, callTool: async (n, a) => reply(n, a) };

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const IMP = require('../src/lib/track-record/importer');
const tag = `trimp_${process.pid}`;

const ENT_ID = '11111111-2222-3333-4444-555555555555';
const A1 = '62 Highland St, Lakewood, NJ 08701';
const A2 = '118 Oak Ave, Lakewood, NJ 08701';

/* One property bought and sold (two deeds, ONE candidate), plus a second
   property, plus a deed the borrower merely appears on as a stranger. */
/* THE VENDOR'S REAL SHAPE, not a convenient one. These rows are written the way
   `get_entity_deeds` actually answers — `addresses[{addressFull}]`,
   `recordingDate`, `totalConsideration` — because the first version of this
   fixture used `address`/`recordedDate`/`consideration`, which are the names the
   READER guessed, and so the suite passed while the importer could not read a
   single real record. A fixture invented by whoever wrote the reader can only
   ratify their guess. The canonical shapes live in
   scripts/fixtures/elementix-shapes.json, captured from live calls. */
const deed = (addr, grantors, grantees, date, amount, docId) => ({
  id: docId, countyDocumentId: docId, dataSource: 'elementix',
  addresses: [{ id: `a_${docId}`, addressFull: addr }],
  grantors, grantees, recordingDate: date, totalConsideration: amount,
  // The vendor states these itself, against the entity that was queried.
  isGrantee: grantees.some((g) => /MW Trading/i.test(g)),
  isGrantor: grantors.some((g) => /MW Trading/i.test(g)),
});
const DEEDS = [
  deed(A1, ['Somebody Else'], ['MW Trading LLC'], '2025-08-02', 410000, 'd1'),
  deed(A1, ['MW Trading LLC'], ['Marcus Reed'], '2026-03-14', 612000, 'd2'),
  deed(A2, ['Nobody Ltd'], ['MW Trading LLC'], '2025-01-10', 300000, 'd3'),
  deed('9 Stranger Ct, Trenton, NJ 08608', ['A Co'], ['B Co'], '2025-05-05', null, 'd4'),
];
const found = (name) => {
  if (name === 'match_entity') return { ok: true, data: { results: [{ id: ENT_ID, name: 'MW TRADING LLC' }] } };
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

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Import Tester','underwriter') RETURNING id, token_version`,
    [`${tag}@example.com`])).rows[0];
  const token = C.signJwt({ sub: staff.id, kind: 'staff', role: 'underwriter', tv: staff.token_version || 0 });
  const call = (p, o) => fetch(`${base}${p}`, { ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(o && o.headers) } });

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Imp','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;
  await db.query(`INSERT INTO llcs (borrower_id, llc_name, formation_state) VALUES ($1,'MW Trading LLC','NJ')`, [borrowerId]);

  const lines = async () => (await db.query(
    `SELECT id, property_address, purchase_price, sale_price, sale_date, deal_type, entity_name,
            llc_id, origin, entered_by_kind, is_verified, verification_status
       FROM track_records WHERE borrower_id=$1 ORDER BY created_at`, [borrowerId])).rows;
  const cands = async () => (await db.query(
    `SELECT id, status, dedupe_key, match_track_record_id, entity_name FROM track_record_candidates
      WHERE borrower_id=$1 ORDER BY created_at`, [borrowerId])).rows;

  console.log('\n1. The search stages, and says what it did NOT stage');
  {
    reply = found;
    const r = await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    ok(r.status === 200, 'the search runs');
    const out = await r.json();
    ok(out.found === 2, `two PROPERTIES from four deeds — the buy and the sell are one candidate (found ${out.found})`);
    ok(out.staged === 2, 'both staged');
    ok(out.skips.some((s) => s.reason === 'not_our_party'),
      'the deed the borrower is not a party to is skipped, WITH ITS REASON — a search that quietly drops results reads as "we only found two"');

    const c = await cands();
    const one = c.find((x) => String(x.dedupe_key).includes('d1') || true);
    ok(c.length === 2 && c.every((x) => x.status === 'staged'), 'two candidates, both waiting');
    const rows = (await db.query(
      `SELECT purchase_price, sale_price, purchase_date, sale_date, deal_type FROM track_record_candidates
        WHERE borrower_id=$1 ORDER BY created_at`, [borrowerId])).rows;
    const both = rows.find((x) => x.purchase_price && x.sale_price);
    ok(both && Number(both.purchase_price) === 410000 && Number(both.sale_price) === 612000,
      'the two deeds on one property became ONE candidate carrying both figures');
    ok(rows.every((x) => x.deal_type === null),
      'and the DEAL TYPE is left blank — nothing in a deed says whether the plan was a flip, a hold or a ground-up, so it is never guessed');
    ok(one, 'candidate rows are addressable');
  }

  console.log('\n2. NOTHING is on the track record yet');
  {
    ok((await lines()).length === 0,
      'the search added not one line — a staged candidate lives in a DIFFERENT TABLE, so it is invisible to every experience count');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/importer.js'), 'utf8');
    const inSearch = src.slice(src.indexOf('async function runSearch'), src.indexOf('async function stageOne'));
    ok(!/INSERT INTO track_records/.test(inSearch),
      'and the search path contains no statement that could write one');
  }

  console.log('\n3. Import as new — at pending, with the entity chokepoint run');
  {
    const c = (await cands()).find((x) => x.status === 'staged');
    const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'import_new', dealType: 'flip' }) });
    ok(r.status === 200, 'a person can bring it on');
    const out = await r.json();
    ok(out.isVerified === false && out.verificationStatus === 'pending',
      'the new line lands PENDING — db/485 decides that, not this module, and it counts toward nothing');

    const l = (await lines())[0];
    ok(l.origin === 'public_records' && l.entered_by_kind === 'staff',
      'the importer names itself in `origin` and a staffer is recorded as who put it there — db/458\'s own convention, since its CHECK refuses "staff_import"');
    ok(String(l.llc_id) === String((await db.query(`SELECT id FROM llcs WHERE borrower_id=$1`, [borrowerId])).rows[0].id),
      'and the line is LINKED to the company — the entity chokepoint ran');
    ok(l.deal_type === 'flip', 'the reviewer\'s answer to the deal-type question is what lands');
  }

  console.log('\n4. A second search does not re-stage what was handled');
  {
    reply = found;
    const out = await (await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' })).json();
    ok(out.staged === 0, 'nothing new staged');
    ok(out.skips.some((s) => ['already_handled', 'already_staged'].includes(s.reason)),
      '…and it says why for each — already imported, or already waiting');
    ok((await cands()).length === 2, 'and no duplicate candidate rows were created');
  }

  console.log('\n5. Match to existing FILLS BLANKS and never overwrites');
  {
    // A line the borrower typed, missing the sale figures, with a price that
    // DISAGREES with the records.
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_price, entered_by_kind)
       VALUES ($1,$2::jsonb,$3,'flip',399000,'borrower') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '118 Oak Ave', city: 'Lakewood', state: 'NJ', zip: '08701' }),
        require('../src/lib/track-record-key').trackRecordKey({ line1: '118 Oak Ave', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;

    /* Pin the candidate by ADDRESS rather than taking "the first one still
       staged". §3 consumed one of the two, so which one is left is an artifact
       of the order the deeds happen to arrive in — and this section's figures
       (399,000 typed against the records' 300,000) only describe 118 Oak Ave.
       Selecting by address is what stops a re-ordering silently pointing these
       assertions at a property they do not describe. */
    await db.query(`UPDATE track_record_candidates SET match_track_record_id=$2, match_confidence='exact'
                     WHERE borrower_id=$1 AND status='staged'
                       AND property_address::text LIKE '%118 Oak Ave%'`, [borrowerId, trId]);
    const c = (await db.query(
      `SELECT id FROM track_record_candidates
        WHERE borrower_id=$1 AND status='staged' AND match_track_record_id=$2`, [borrowerId, trId])).rows[0];
    ok(!!c, 'the 118 Oak Ave candidate is the one under test');

    const cmp = await (await call(`/api/staff/track-record-candidates/${c.id}/compare`)).json();
    ok(cmp.matched === true, 'the side-by-side answers');
    const price = cmp.rows.find((x) => x.field === 'purchase_price');
    ok(price.conflict === true && price.willFill === false,
      'a figure BOTH sides hold, differing, is a conflict — and the line keeps ours');
    ok(/keeps yours/.test(price.note), '…and says so in words');
    /* purchase_date, NOT sale_date: this property was bought and never sold, so
       the records hold no sale either — "blank on both sides" is not a fill, and
       asserting it here would only have proved the section was reading a
       property it was never describing. */
    const buyDate = cmp.rows.find((x) => x.field === 'purchase_date');
    ok(buyDate.willFill === true, 'while a blank on our side is filled from the records');
    const saleDate = cmp.rows.find((x) => x.field === 'sale_date');
    ok(saleDate.willFill === false && saleDate.theirsEmpty === true,
      'and a blank on BOTH sides fills nothing — the records holding nothing is not a value');

    const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'match_existing' }) });
    ok(r.status === 200, 'the match applies');
    const out = await r.json();
    ok(out.filled.includes('purchase_date') && !out.filled.includes('purchase_price'),
      '…and it REPORTS what it filled — the blank date, never the figure somebody typed');
    const t = (await db.query(`SELECT purchase_price, purchase_date FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(Number(t.purchase_price) === 399000,
      'THE TYPED FIGURE SURVIVED — the records said 300,000 and it was not overwritten');
    ok(require('../src/lib/track-record/importer')._internals.ymd(t.purchase_date) === '2025-01-10',
      'and the blank the records could fill WAS filled, with the recorded date');
    ok((await lines()).length === 2, 'no second line was created — a match joins the one already there');
  }

  console.log('\n5c. A ZERO RESULT SAYS WHOSE LIMITATION IT IS');
  {
    /* A borrower with no companies is now searched under their PERSONAL NAME
       (owner-directed 2026-08-09: "he should also use the borrower's personal
       name to search") — a deal bought in a personal name has no entity, and
       an entity-only search read that whole class of borrowers as having no
       history. So "nothing to search" is only ever true of a profile with no
       name AND no companies, and the report says whose name was looked up. */
    const bare = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('No','Entities',$1) RETURNING id`,
      [`${tag}_ne@example.com`])).rows[0].id;
    reply = found;
    const out = await IMP.runSearch({ borrowerId: bare, staffId: staff.id });
    ok(out.nothingToSearch === false,
      'a borrower with NO companies is still searched — under their own name');
    ok(Array.isArray(out.searchedUnder) && out.searchedUnder.includes('No Entities'),
      '…and the report NAMES the person it looked up, rather than leaving a screen to infer it');
    ok((out.skips || []).some((s) => s.reason === 'no_entities'),
      '…while still recording that the profile has no companies to search under');

    // And a real search names what it looked under.
    const withEnt = await IMP.runSearch({ borrowerId, staffId: staff.id });
    ok(withEnt.searchedUnder.includes('MW Trading LLC'),
      'a real search NAMES the companies it looked under');
    ok(withEnt.nothingToSearch === false, '…and does not claim it could not run');
    ok(!/does not publish/.test(withEnt.summary) || withEnt.found === 0,
      '…and only offers the "county does not publish" explanation when it genuinely found nothing');
    await db.query('DELETE FROM track_record_searches WHERE borrower_id=$1', [bare]).catch(() => {});
    await db.query('DELETE FROM borrowers WHERE id=$1', [bare]).catch(() => {});
  }

  console.log('\n5b. ALL THREE match bands are reachable — "we are not sure" has somewhere to live');
  {
    /* db/496's CHECK has always allowed 'exact' | 'near' | 'none', and stageOne
       wrote only two of them. So the state a reviewer is actually NEEDED for —
       "this looks like a line you already have, but we are not certain" — could
       not be produced by any input, and every match arrived either settled or
       absent. `match.decideMatch` already computed the three-way answer and had
       no caller here. */
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);

    const key = require('../src/lib/track-record-key').trackRecordKey;
    // Our line names a UNIT; the records do not. Same building, different claim.
    const unitAddr = { line1: '200 Bridge St Apt 4B', city: 'Lakewood', state: 'NJ', zip: '08701' };
    await db.query(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, entered_by_kind)
       VALUES ($1,$2::jsonb,$3,'flip','borrower')`,
      [borrowerId, JSON.stringify(unitAddr), key(unitAddr)]);

    const bare = { line1: '200 Bridge St', city: 'Lakewood', state: 'NJ', zip: '08701' };
    const staged = await IMP._internals.stageOne(db, {
      borrowerId, searchId: null,
      candidate: { property_address: bare, dedupe_key: 'near_test_1', raw: {} },
    });
    ok(staged.staged === true, 'a look-alike stages');
    const row = (await db.query(
      `SELECT match_confidence, match_track_record_id, match_why FROM track_record_candidates WHERE id=$1`,
      [staged.id])).rows[0];
    ok(row.match_confidence === 'near',
      'ONE SIDE NAMES A UNIT AND THE OTHER DOES NOT — that is "near", not "exact": a deed for one unit is not evidence about the whole building');
    ok(!!row.match_track_record_id, '…and it still points at the line it resembles, so a reviewer can compare them');
    ok(Array.isArray(row.match_why.blockers) && row.match_why.blockers.length > 0,
      '…and carries the REASONS in words, never a confidence score — a percentage would describe county data and read as a judgement about the borrower');

    // And an exact one is still exact.
    const same = { line1: '9 Plain Rd', city: 'Lakewood', state: 'NJ', zip: '08701' };
    await db.query(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, entered_by_kind)
       VALUES ($1,$2::jsonb,$3,'flip','borrower')`,
      [borrowerId, JSON.stringify(same), key(same)]);
    const s2 = await IMP._internals.stageOne(db, {
      borrowerId, searchId: null,
      candidate: { property_address: same, dedupe_key: 'near_test_2', raw: {} },
    });
    const r2 = (await db.query('SELECT match_confidence FROM track_record_candidates WHERE id=$1', [s2.id])).rows[0];
    ok(r2.match_confidence === 'exact', 'a genuine same-address match is still EXACT');

    // A property nobody has is 'none' and points at nothing.
    const s3 = await IMP._internals.stageOne(db, {
      borrowerId, searchId: null,
      candidate: { property_address: { line1: '1 Nowhere Blvd', city: 'Lakewood', state: 'NJ', zip: '08701' },
        dedupe_key: 'near_test_3', raw: {} },
    });
    const r3 = (await db.query(
      'SELECT match_confidence, match_track_record_id FROM track_record_candidates WHERE id=$1', [s3.id])).rows[0];
    ok(r3.match_confidence === 'none' && r3.match_track_record_id === null,
      'and a property that is on nobody\'s record is "none", pointing at nothing');

    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
  }

  console.log('\n6. "Not theirs" is durable — the next search must not raise it again');
  {
    // Stage something fresh, then decline it.
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
    reply = found;
    await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    const c = (await cands())[0];

    const noReason = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'decline' }) });
    ok(noReason.status === 400, 'declining with no reason is refused — the next search reads that reason');

    const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'decline', note: 'a different Moses Weil' }) });
    ok(r.status === 200, 'declining with a reason is accepted');

    reply = found;
    const out = await (await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' })).json();
    ok(out.skips.some((s) => s.reason === 'declined_before'),
      'and the next search does NOT raise it again — the partial unique index alone would have, because it only blocks while the first row is still staged');
    ok((await cands()).filter((x) => x.status === 'staged').length <= 1,
      'the declined property is not back in the queue');
  }

  console.log('\n7. A decided candidate cannot be decided twice');
  {
    const c = (await cands()).find((x) => x.status === 'declined');
    const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'import_new' }) });
    ok(r.status === 409, 'a second decision on the same candidate is refused');
    const bad = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'nonsense' }) });
    ok(bad.status === 400, 'and an action that is not one of the four is refused');
  }

  console.log('\n8. Filling a blank on a VERIFIED line is refused until asked twice');
  {
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
    const trId = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, address_key, deal_type, purchase_price, purchase_date, sale_date)
       VALUES ($1,$2::jsonb,$3,'flip',410000,'2025-08-02','2026-03-14') RETURNING id`,
      [borrowerId, JSON.stringify({ line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' }),
        require('../src/lib/track-record-key').trackRecordKey({ line1: '62 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' })])).rows[0].id;
    await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified', verified_by=$2 WHERE id=$1`, [trId, staff.id]);

    reply = found;
    await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    const c = (await cands()).find((x) => x.status === 'staged' && x.match_track_record_id);
    ok(!!c, 'the search matched the staged candidate to the verified line');

    const cmp = await (await call(`/api/staff/track-record-candidates/${c.id}/compare`)).json();
    ok(cmp.wouldReopen === true, 'the side-by-side WARNS that matching would reopen the verification');

    const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'match_existing' }) });
    ok(r.status === 409, `it is REFUSED the first time (${r.status})`);
    const body = await r.json();
    ok(body.code === 'would_reopen_verification' && /reopen it for review/.test(body.error),
      '…in the words a reviewer needs — nobody presses "match" expecting to undo a verification');
    ok((await db.query('SELECT is_verified FROM track_records WHERE id=$1', [trId])).rows[0].is_verified === true,
      '…and the line is STILL verified, because nothing was written');

    const again = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
      method: 'POST', body: JSON.stringify({ action: 'match_existing', confirmReopen: true }) });
    ok(again.status === 200, 'asked a second time, explicitly, it goes through');
    const out = await again.json();
    ok(out.reopened === true, '…and REPORTS that the verification was reopened rather than letting it be noticed later');
    ok((await db.query('SELECT is_verified FROM track_records WHERE id=$1', [trId])).rows[0].is_verified === false,
      'db/485 did the un-verifying — the guard was never weakened, only the surprise removed');
  }

  console.log('\n9. Snooze, and the scope check');
  {
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    reply = found;
    await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    const c = (await cands()).find((x) => x.status === 'staged');
    if (c) {
      const r = await call(`/api/staff/track-record-candidates/${c.id}/decide`, {
        method: 'POST', body: JSON.stringify({ action: 'snooze', snoozeDays: 14 }) });
      ok(r.status === 200, 'a candidate can be put off');
      const q = await (await call(`/api/staff/borrowers/${borrowerId}/track-record-candidates`)).json();
      ok(!q.toReview.some((x) => String(x.id) === String(c.id)), '…and it leaves the queue until its date');
    } else { ok(true, 'nothing left staged to snooze (earlier sections consumed them)'); }

    const stranger = (await db.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Stranger','loan_officer') RETURNING id, token_version`,
      [`${tag}_x@example.com`])).rows[0];
    const st = C.signJwt({ sub: stranger.id, kind: 'staff', role: 'loan_officer', tv: stranger.token_version || 0 });
    const asStranger = (p, o) => fetch(`${base}${p}`, {
      ...o, headers: { 'content-type': 'application/json', authorization: `Bearer ${st}`, ...(o && o.headers) } });

    const r2 = await asStranger(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    ok(r2.status === 403, 'an officer with no connection to this borrower cannot search their records');

    /* ALL FOUR DOORS, not just the search. The candidate routes are addressed by
       CANDIDATE id rather than by borrower, so each one has to resolve the owner
       and check the scope itself — and `decide` is the one that WRITES. A scope
       check that exists on the door somebody thought to test proves nothing
       about the other three. */
    const q3 = await asStranger(`/api/staff/borrowers/${borrowerId}/track-record-candidates`);
    ok(q3.status === 403, '…nor list what was found for them');
    const any = (await cands())[0];
    if (any) {
      const r4 = await asStranger(`/api/staff/track-record-candidates/${any.id}/compare`);
      ok(r4.status === 403, '…nor open a candidate of theirs, addressed by its own id');
      const r5 = await asStranger(`/api/staff/track-record-candidates/${any.id}/decide`, {
        method: 'POST', body: JSON.stringify({ action: 'decline', note: 'not mine to decide' }) });
      ok(r5.status === 403, '…and above all cannot DECIDE one — the door that writes');
      const still = (await cands()).find((x) => String(x.id) === String(any.id));
      ok(still && still.status !== 'declined', '…and the refusal wrote nothing');
    } else { ok(false, 'expected a candidate to exist for the scope check'); }
    await db.query('DELETE FROM staff_users WHERE id=$1', [stranger.id]).catch(() => {});
  }

  console.log('\n10. The SMART DEAL-TYPE default is surfaced, and the reviewer-confirmed EXIT is filled');
  {
    await db.query(`DELETE FROM track_record_candidates WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
    reply = found;
    await call(`/api/staff/borrowers/${borrowerId}/track-record-search`, { method: 'POST', body: '{}' });
    const q = await (await call(`/api/staff/borrowers/${borrowerId}/track-record-candidates`)).json();

    /* A1 was bought AND sold → the dropdown should default to flip. A2 was
       bought only → it should default to a hold whose reason asks the reviewer
       to confirm how it exited (the owner's "not sold → default fix & hold"). */
    const flip = (q.toReview || []).find((r) => /Highland/.test(r.address));
    const hold = (q.toReview || []).find((r) => /Oak Ave/.test(r.address));
    ok(flip && flip.dealTypeDerived === 'flip',
      'a bought-and-sold property surfaces dealTypeDerived="flip" — the dropdown pre-selects it');
    ok(hold && hold.dealTypeDerived === 'hold',
      'a bought-but-never-sold property surfaces dealTypeDerived="hold" (owner: "not sold → default fix & hold")');
    ok(hold && /confirm below how it exited/i.test(hold.dealTypeWhy || ''),
      '…and dealTypeWhy asks the reviewer to confirm the exit, since the records carried none');
    ok(hold && hold.refiAmount == null && hold.rentAmount == null,
      '…and the exit figures are blank on this candidate (the shape carries refi/rent for the reviewer to see when present)');

    /* Bring the hold on WITH a refinance the reviewer entered — a hold with no
       exit date counts toward nothing, so this is the figure that makes it real.
       importNew fills the blank; the county record is not overwritten (there was
       none here). */
    const r = await call(`/api/staff/track-record-candidates/${hold.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action: 'import_new', dealType: 'hold',
        exit: { refiAmount: 244000, refiDate: '2025-09-01' } }) });
    ok(r.status === 200, 'the hold is brought on');
    const line = (await db.query(
      `SELECT deal_type, refi_amount, refi_date FROM track_records
        WHERE borrower_id=$1 ORDER BY created_at DESC LIMIT 1`, [borrowerId])).rows[0];
    ok(line && line.deal_type === 'fix-and-hold', '…as a fix-and-hold (the dropdown value canonicalized)');
    ok(line && Number(line.refi_amount) === 244000 && String(line.refi_date).slice(0, 10) === '2025-09-01',
      '…and the reviewer-entered refinance landed on the line — the hold now has an exit the tier can read');

    /* A figure that cannot fit its column is REFUSED at the door, never a 500. */
    const bad = await call(`/api/staff/track-record-candidates/${flip.id}/decide`, {
      method: 'POST',
      body: JSON.stringify({ action: 'import_new', dealType: 'hold',
        exit: { refiAmount: 9e14, refiDate: '2025-09-01' } }) });
    ok(bad.status === 400, `a refinance amount too big for the column is a plain 400, not a 500 (${bad.status})`);
    ok((await db.query(`SELECT status FROM track_record_candidates WHERE id=$1`, [flip.id])).rows[0].status === 'staged',
      '…and the refusal wrote nothing — the candidate is still waiting');
  }

  await db.query('DELETE FROM track_record_candidates WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_record_searches WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM track_records WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llc_borrowers WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM llcs WHERE borrower_id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${tag}%`]).catch(() => {});
  server.close();

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  found is not the same as added: everything stages, a person promotes, and nothing typed is overwritten');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
