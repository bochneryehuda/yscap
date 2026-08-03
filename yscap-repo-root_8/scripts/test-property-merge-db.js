/**
 * TWO ROWS, ONE HOUSE (db/419, src/lib/research/property-merge.js) — against a REAL
 * database and the REAL routes.
 *
 * The owner's rule: the same comparable on two appraisals must never become two
 * properties, and merging must ADD what one report had and the other did not.
 *
 * Most of that was already true — the address key folds two spellings of one
 * address, and the roll-up merges the facts. This suite is about the REMAINDER, and
 * about the three things that make a merge dangerous:
 *
 *   1. THE INGEST FIX. A comparable that named no town used to key on its ZIP while
 *      the same house on a report that DID name the town keyed on the town — two
 *      rows, and the biggest single cause of a split. A comp with no city now
 *      inherits the SUBJECT's, gated on the ZIPs matching. Monotone: a different ZIP
 *      changes nothing.
 *   2. THE MERGE FILLS AND FOLDS, and never loses. The survivor ends up with the
 *      union of both sets of reports, every fact re-derived, the sales folded rather
 *      than duplicated, and the losing row snapshotted before it goes.
 *   3. IT REFUSES RATHER THAN GUESS. An undeclared table that points at `properties`
 *      is an ERROR, because three of the six references CASCADE — a table nobody
 *      declared would have its rows silently DELETED, not orphaned.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-property-merge-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const M = require('../src/lib/research/property-merge');
const ingest = require('../src/lib/research/ingest');
const XI = require('../src/lib/research/xml-import');
const { appraisalXml } = require('./lib/research-xml-fixture');
const app = require('../src/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: Object.assign({ 'content-type': 'application/json' },
        token ? { authorization: `Bearer ${token}` } : {},
        data ? { 'content-length': Buffer.byteLength(data) } : {}) },
    (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const RUN = `${process.pid}${Math.floor(Math.random() * 1000)}`;
const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[+d] || 'x').join('');
const TOWN = 'Mergeton' + letters(RUN);
const ZIP = '08854';
const LIC = `42MG${String(process.pid).padStart(5, '0')}${Math.floor(Math.random() * 900 + 100)}`;

const propBy = async (street, city) => (await db.query(
  `SELECT * FROM properties WHERE lower(street) = lower($1) AND lower(COALESCE(city,'')) = lower($2)`,
  [street, city || ''])).rows[0] || null;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const D = { query: (t, p) => db.query(t, p), getClient: () => db.getClient() };
  try {
    const staff = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Merge Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`merge-${RUN}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staff, kind: 'staff', role: 'super_admin', tv: 0 });
    const lo = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Merge Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`merge-lo-${RUN}@test.local`])).rows[0].id;
    const loToken = C.signJwt({ sub: lo, kind: 'staff', role: 'loan_officer', tv: 0 });

    // =====================================================================
    // 1. THE INGEST FIX — a comp with no town no longer splits off
    // =====================================================================
    // Report one names the town for both the subject and its comparable.
    const r1 = await XI.importXml(D, {
      xml: appraisalXml({
        street: '5 Anchor Rd', city: TOWN, zip: ZIP, licenseId: LIC,
        appraiserName: `Mia ${letters(process.pid)}stone`,
        effectiveDate: '2026-04-02', signedDate: '2026-04-03',
        comps: [{ seq: '1', address: '19 Harbor St', city: TOWN, state: 'NJ', zip: ZIP,
          price: 402000, saleDate: '2026-02-08', gla: 1440, beds: 3, baths: '2.0',
          condition: 'C3', quality: 'Q4', yearBuilt: 1964 }],
      }),
      filename: 'named-town.xml',
    });
    ok(r1.ok, `the town-naming report lands (${r1.reason || 'ok'})`);

    // Report two describes the SAME comparable but its address line carries no town —
    // the shape roughly a third of files arrive in.
    const r2 = await XI.importXml(D, {
      xml: appraisalXml({
        street: '7 Anchor Rd', city: TOWN, zip: ZIP, licenseId: LIC,
        appraiserName: `Mia ${letters(process.pid)}stone`,
        effectiveDate: '2026-05-02', signedDate: '2026-05-03',
        comps: [{ seq: '1', address: '19 Harbor St', city: '', state: 'NJ', zip: ZIP,
          price: 402000, saleDate: '2026-02-08', gla: 1440, beds: 3, baths: '2.0',
          condition: 'C3', quality: 'Q4', yearBuilt: 1964 }],
      }),
      filename: 'no-town.xml',
    });
    ok(r2.ok, `the town-less report lands (${r2.reason || 'ok'})`);

    const harbor = (await db.query(
      `SELECT * FROM properties WHERE lower(street) = '19 harbor st' AND state = 'NJ' AND zip = $1`, [ZIP])).rows;
    ok(harbor.length === 1,
      `A COMPARABLE THAT NAMED NO TOWN IS THE SAME PROPERTY, not a second row (got ${harbor.length})`);
    ok(harbor[0] && harbor[0].observation_count === 2,
      'and both reports are kept as observations of it');
    ok(harbor[0] && harbor[0].city && harbor[0].city.toLowerCase() === TOWN.toLowerCase(),
      'it took the town from the SUBJECT of the report it came in on — the ZIPs matched');

    // MONOTONE: a comp in a DIFFERENT ZIP must inherit nothing.
    const r3 = await XI.importXml(D, {
      xml: appraisalXml({
        street: '9 Anchor Rd', city: TOWN, zip: ZIP, licenseId: LIC,
        appraiserName: `Mia ${letters(process.pid)}stone`,
        effectiveDate: '2026-05-20', signedDate: '2026-05-21',
        comps: [{ seq: '1', address: '400 Faraway Blvd', city: '', state: 'NJ', zip: '07030',
          price: 500000, saleDate: '2026-03-01', gla: 1600, beds: 3, baths: '2.0',
          condition: 'C3', quality: 'Q4', yearBuilt: 1970 }],
      }),
      filename: 'other-zip.xml',
    });
    ok(r3.ok, 'a report with an out-of-ZIP comparable lands');
    const faraway = (await db.query(
      `SELECT city, address_key FROM properties WHERE lower(street) = '400 faraway blvd'`)).rows[0];
    ok(faraway && faraway.city === null && /\|z07030\|/.test(faraway.address_key),
      'A COMPARABLE IN A DIFFERENT ZIP INHERITS NOTHING — it still keys on its own ZIP, exactly as before');

    // =====================================================================
    // 2. THE SAFETY RAIL — an undeclared table refuses the merge
    // =====================================================================
    ok((await M._internals.assertRefsComplete(db)) > 0,
      'every table that points at a property is accounted for');
    await db.query(`CREATE TABLE IF NOT EXISTS zz_merge_probe_${RUN} (
      id serial PRIMARY KEY, property_id uuid REFERENCES properties(id) ON DELETE CASCADE)`);
    let threw = null;
    try { await M._internals.assertRefsComplete(db); } catch (e) { threw = e.message; }
    ok(threw && /does not know what to do/i.test(threw),
      'A TABLE NOBODY DECLARED REFUSES THE MERGE — three of the six references CASCADE, so an undeclared one would be silently DELETED, not orphaned');
    await db.query(`DROP TABLE zz_merge_probe_${RUN}`);

    // =====================================================================
    // 3. THE MERGE ITSELF
    // =====================================================================
    // Two rows that ARE one house: the same street and town, one carrying a unit.
    const keep = await propBy('5 Anchor Rd', TOWN);
    const drop = await propBy('7 Anchor Rd', TOWN);
    ok(keep && drop, 'two subject properties exist to merge');

    // Give the loser a fact the survivor does not have, and a photo-less sale, so the
    // merge has something real to carry.
    // The survivor is deliberately left WITHOUT these two, and the loser given them —
    // otherwise the assertion would pass on the survivor's own values and prove
    // nothing. (APN is fill-only everywhere in this codebase, so a survivor that
    // already has one correctly keeps it; that is not what is being tested here.)
    await db.query(`UPDATE properties SET county=NULL, apn=NULL WHERE id=$1`, [keep.id]);
    await db.query(`UPDATE properties SET county='Middlesex', apn='APN-${RUN}' WHERE id=$1`, [drop.id]);
    await db.query(
      `INSERT INTO property_sales (property_id, sale_date, sale_price, source, times_seen)
       VALUES ($1,'2019-06-01',310000,'test',1)`, [drop.id]);
    const beforeObs = (await db.query(
      `SELECT count(*)::int n FROM property_observations WHERE property_id IN ($1,$2)`, [keep.id, drop.id])).rows[0].n;

    const denied = await call(server, 'POST', '/api/research/duplicates/merge', loToken,
      { survivor_id: keep.id, merged_id: drop.id });
    ok(denied.status === 403, 'an ordinary officer cannot merge two properties — it deletes a row');

    const merged = await call(server, 'POST', '/api/research/duplicates/merge', token,
      { survivor_id: keep.id, merged_id: drop.id, cause: 'manual' });
    ok(merged.status === 200 && merged.body.ok, `the merge runs (${merged.status} ${JSON.stringify(merged.body).slice(0, 120)})`);

    ok((await db.query(`SELECT 1 FROM properties WHERE id=$1`, [drop.id])).rows.length === 0,
      'the losing row is gone');
    const after = (await db.query(`SELECT * FROM properties WHERE id=$1`, [keep.id])).rows[0];
    ok(after && after.observation_count === beforeObs,
      `every report from BOTH rows now describes the survivor (${after && after.observation_count} of ${beforeObs})`);
    ok(after && after.county === 'Middlesex' && after.apn === `APN-${RUN}`,
      'AND THE FACTS ONLY THE LOSER HAD ARE CARRIED — the owner\'s "add the missing information"');
    ok(after && Number(after.gla) > 0 && after.condition_uad,
      'the survivor still has its own facts, re-derived from the union of the reports');
    const carriedSale = (await db.query(
      `SELECT count(*)::int n FROM property_sales WHERE property_id=$1 AND sale_date='2019-06-01'`, [keep.id])).rows[0].n;
    ok(carriedSale === 1, 'and the sale only the loser knew about came across');

    // The record of what happened, and where the old link now points.
    const ledger = (await db.query(
      `SELECT * FROM property_merges WHERE merged_id=$1`, [drop.id])).rows[0];
    ok(ledger && ledger.survivor_id === keep.id && ledger.merged_by === staff,
      'the merge is recorded, with who did it');
    ok(ledger && ledger.merged_snapshot && ledger.merged_snapshot.property
      && ledger.merged_snapshot.property.apn === `APN-${RUN}`,
    'THE WHOLE LOSING ROW WAS SNAPSHOTTED BEFORE IT WENT — a merge deletes a row, so it must be able to say what was there');
    ok((await M.survivorOf(db, drop.id)) === keep.id, 'and we can answer "where did that property go?"');

    const followed = await call(server, 'GET', `/api/research/properties/${drop.id}`, token);
    ok(followed.status === 301 && followed.body.merged_into === keep.id,
      'A BOOKMARKED LINK TO THE MERGED PROPERTY DOES NOT DIE — it says where it went');

    // =====================================================================
    // 4. REFUSALS
    // =====================================================================
    const selfMerge = await call(server, 'POST', '/api/research/duplicates/merge', token,
      { survivor_id: keep.id, merged_id: keep.id });
    ok(selfMerge.status === 409 || selfMerge.status === 400, 'a property cannot be merged into itself');
    const gone = await call(server, 'POST', '/api/research/duplicates/merge', token,
      { survivor_id: keep.id, merged_id: drop.id });
    ok(gone.status === 409, 'merging a row that is already gone refuses cleanly rather than half-running');

    // =====================================================================
    // 5. "THESE ARE NOT THE SAME HOUSE" STICKS
    // =====================================================================
    const p1 = (await db.query(
      `INSERT INTO properties (address_key, display_address, street, unit, city, state, zip)
       VALUES ($1,'11 Twin Ct','11 Twin Ct','',$2,'NJ',$3) RETURNING id`,
      [`11 twin ct||${TOWN.toLowerCase()}|nj`, TOWN, ZIP])).rows[0].id;
    const p2 = (await db.query(
      `INSERT INTO properties (address_key, display_address, street, unit, city, state, zip)
       VALUES ($1,'11 Twin Ct Unit 2','11 Twin Ct','2',$2,'NJ',$3) RETURNING id`,
      [`11 twin ct|2|${TOWN.toLowerCase()}|nj`, TOWN, ZIP])).rows[0].id;

    const dupes = await call(server, 'GET', `/api/research/duplicates?property_id=${p1}&limit=50`, token);
    ok(dupes.status === 200 && dupes.body.rows.some((r) => r.a_id === p2 || r.b_id === p2),
      'the same address with and without a unit is offered as a candidate');
    const unitPair = dupes.body.rows.find((r) => r.a_id === p2 || r.b_id === p2);
    ok(unitPair && unitPair.confidence === 'needs a person',
      'and it is NEVER auto-merged — unit 2 and the whole building are genuinely different things');

    const notDup = await call(server, 'POST', '/api/research/duplicates/not-duplicate', token,
      { property_id: p1, other_property_id: p2, reason: 'checked the deed — 11 Twin Ct is the whole building' });
    ok(notDup.status === 200, 'a person can say they are two different houses');
    const after2 = await call(server, 'GET', `/api/research/duplicates?property_id=${p1}&limit=50`, token);
    ok(!after2.body.rows.some((r) => r.a_id === p2 || r.b_id === p2),
      'AND THE PAIR NEVER COMES BACK — otherwise the list trains people to ignore it');

    // Recorded once, canonically ordered, so the mirror image cannot be filed too.
    const ndRows = (await db.query(
      `SELECT * FROM property_not_duplicates WHERE property_id IN ($1,$2) OR other_property_id IN ($1,$2)`,
      [p1, p2])).rows;
    ok(ndRows.length === 1 && ndRows[0].property_id < ndRows[0].other_property_id,
      'stored as ONE canonically ordered row, so a detector written either way round cannot miss it');
    await M.markNotDuplicate(db, p2, p1, { reason: 'the other way round', by: staff });
    ok((await db.query(`SELECT count(*)::int n FROM property_not_duplicates
                         WHERE property_id IN ($1,$2) OR other_property_id IN ($1,$2)`, [p1, p2])).rows[0].n === 1,
    'and filing it the other way round adds nothing');

    // ---- cleanup -----------------------------------------------------------
    // Clean up by STREET as well as town: a row this run created may legitimately
    // have no city (the out-of-ZIP comparable), and leaving one behind would make the
    // next run's "is this one property or two?" count wrong.
    await db.query(
      `DELETE FROM properties WHERE city = $1
          OR lower(street) IN ('400 faraway blvd','19 harbor st','5 anchor rd','7 anchor rd','9 anchor rd','11 twin ct')`,
      [TOWN]);
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[staff, lo]]);
    await db.query(`DELETE FROM appraisers WHERE license_id = $1`, [LIC]);

    console.log(`test-property-merge-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.log('FAIL threw:', (e && e.stack) || e);
    console.log(`test-property-merge-db: ${pass} passed, ${fail} failed`);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fail ? 1 : 0);
})();
