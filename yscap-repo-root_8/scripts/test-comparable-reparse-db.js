/**
 * A PARSER BUG ON A REPORT ALREADY IMPORTED — and the only thing that heals it.
 *
 * `research/ingest.js`'s `INGEST_VERSION` re-reads a report INTO the warehouse,
 * but `ingestAppraisal` reads the STORED `appraisals` / `appraisal_comparables`
 * rows — so it faithfully re-reads whatever the parser wrote. It heals a
 * WAREHOUSE bug and can do nothing at all about a PARSER one. db/426 assumed
 * otherwise, and the wrong 2-4 unit room counts it fixed would have stayed on
 * every report already on disk.
 *
 * `backfillComparableParseOnce` re-PARSES the stored source XML and rewrites the
 * grid fields. This proves it on a real database with real stored bytes: a
 * comparable stored the way the old parser stored it (unit 1's 5 rooms / 3 beds /
 * 1 bath, no price per foot) is healed to the property's 14 / 7 / 3 with its
 * per-unit breakdown and its price per BUILDING foot.
 *
 * DB-gated. Run: DATABASE_URL=... node scripts/test-comparable-reparse-db.js
 */
process.env.JWT_SECRET = 'x';
const db = require('../src/db');
const storage = require('../src/lib/storage');
const desk = require('../src/lib/appraisal/desk');
const { COMP_PARSE_VERSION } = require('../src/lib/appraisal/import');
const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const R = (r, b, ba) => `<ROOM_ADJUSTMENT TotalRoomCount="${r}" TotalBedroomCount="${b}" TotalBathroomCount="${ba}"/>`;
const XML = `<?xml version="1.0"?><VALUATION_RESPONSE><REPORT AppraisalFormType="FNM1025"><PROPERTY><SALES_COMPARISON>
<COMPARABLE_SALE PropertySequenceIdentifier="1" SalesPriceAmount="600000" SalesPricePerGrossBuildingAreaAmount="121.40">
 <LOCATION PropertyStreetAddress="9 Reparse Rd ${sfx}" PropertyCity="Newark" PropertyState="NJ" PropertyPostalCode="07103"/>
 ${R(5,3,'1.0')}${R(5,2,'1.0')}${R(4,2,'1.0')}
 <SALE_PRICE_ADJUSTMENT _Type="View" _Description="N;Res;" _Amount="0"/>
 <SALE_PRICE_ADJUSTMENT _Type="Location" _Description="A;BsySt;" _Amount="-5000"/>
</COMPARABLE_SALE></SALES_COMPARISON></PROPERTY></REPORT></VALUATION_RESPONSE>`;
let bid, appId, docId, apprId;

// ── THE LIST THAT DRIVES THE SWEEP MUST HAVE NO DUPLICATE ─────────────────────
// `REPARSED` is mapped straight into `SET ${k} = $n`, so one name listed twice
// produces `view_rating = $2 … view_rating = $15`; Postgres refuses the whole
// statement ("multiple assignments to same column") and the pass's own catch
// swallows it. The report is then never stamped, so it is re-read from storage on
// EVERY boot and repaired on NONE — the entire back book, silently. It shipped
// exactly that way once, and CI stayed green because this fixture's grid happened
// to carry no View or Location row, so all four duplicated columns were null.
// Both halves of that hole are closed: the fixture now states them, and this
// assertion needs no fixture at all.
const reparsedNames = require('fs')
  .readFileSync(require('path').join(__dirname, '../src/lib/appraisal/desk.js'), 'utf8')
  .match(/const REPARSED = \[([\s\S]*?)\];/)[1]
  .match(/'[a-z0-9_]+'/g).map((x) => x.slice(1, -1));
const dupNames = reparsedNames.filter((n, i) => reparsedNames.indexOf(n) !== i);
let structuralOk = true;
if (dupNames.length) {
  structuralOk = false;
  console.log(`FAIL REPARSED lists ${[...new Set(dupNames)].join(', ')} twice — every re-parse `
    + 'UPDATE will be refused by Postgres and swallowed, so the sweep repairs nothing');
} else {
  console.log(`PASS REPARSED is duplicate-free (${reparsedNames.length} columns)`);
}

// THE SKIP COMES AFTER THE STRUCTURAL CHECK, ON PURPOSE. It used to sit at the
// top of the file, so the one assertion here that needs NO database — the
// duplicate-free read of `REPARSED`, which is the guard for the defect that
// made this sweep repair nothing — was gated behind having one.
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-comparable-reparse-db DB half (no DATABASE_URL)');
  process.exit(structuralOk ? 0 : 1);
}


(async () => {
  try {
    bid = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Re','Parse',$1) RETURNING id`, [`rp${sfx}@t.test`])).rows[0].id;
    appId = (await db.query(`INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `9 Reparse Rd ${sfx}` })])).rows[0].id;
    const ref = await storage.save(Buffer.from(XML, 'utf8'), { filename: `a${sfx}.xml`, contentType: 'text/xml' });
    // A HALF-READ FILE. It still parses `ok` — that is the point.
    const truncSaved = await storage.save(Buffer.from(XML.slice(0, XML.indexOf('<ROOM_ADJUSTMENT')), 'utf8'),
      { filename: `t${sfx}.xml`, contentType: 'text/xml' });
    const truncRef = truncSaved.ref || truncSaved.storage_ref || truncSaved;
    docId = (await db.query(`INSERT INTO documents (application_id, filename, content_type, storage_ref, storage_provider, doc_kind)
      VALUES ($1,$2,'text/xml',$3,$4,'appraisal_xml') RETURNING id`,
    [appId, `a${sfx}.xml`, ref.ref || ref.storage_ref || ref, ref.provider || 'local'])).rows[0].id;
    const goodRef = ref.ref || ref.storage_ref || ref;
    // The report, stored as the OLD parser would have: comp_parse_version NULL.
    apprId = (await db.query(`INSERT INTO appraisals (application_id, form_type, effective_date, subject_address,
        subject_city, subject_state, subject_zip, source_xml_document_id, superseded, imported_at)
      VALUES ($1,'FNM1025','2026-05-01',$2,'Newark','NJ','07103',$3,false, now()) RETURNING id`,
    [appId, `9 Reparse Rd ${sfx}`, docId])).rows[0].id;
    await db.query(`INSERT INTO appraisal_comparables (appraisal_id, seq, is_subject, address, city, state, zip,
        sale_price, beds, baths, baths_full, baths_half, total_rooms, price_per_gla, comp_set)
      VALUES ($1,'1',false,$2,'Newark','NJ','07103',600000, 3,'1.0',1,0, 5, NULL, 'as_is')`,
    [apprId, `9 Reparse Rd ${sfx}`]);
    const before = (await db.query(`SELECT beds, total_rooms, baths_full, units, price_per_gla, price_per_gla_basis FROM appraisal_comparables WHERE appraisal_id=$1`, [apprId])).rows[0];
    console.log('BEFORE (what the old parser stored):', JSON.stringify(before));
    const res = await desk.backfillComparableParseOnce(50);
    console.log('pass:', JSON.stringify(res));
    const after = (await db.query(`SELECT beds, total_rooms, baths_full, units, unit_mix, price_per_gla, price_per_gla_basis FROM appraisal_comparables WHERE appraisal_id=$1`, [apprId])).rows[0];
    console.log('AFTER  (re-parsed from the XML):    ', JSON.stringify(after));
    const stamp = (await db.query(`SELECT comp_parse_version FROM appraisals WHERE id=$1`, [apprId])).rows[0];
    console.log('stamped version:', stamp.comp_parse_version);
    const again = await desk.backfillComparableParseOnce(50);
    console.log('second run (must not re-do it):', JSON.stringify(again));
    const good = after.beds === 7 && after.total_rooms === 14 && after.baths_full === 3
      && after.units === 3 && Array.isArray(after.unit_mix) && after.unit_mix.length === 3
      && Number(after.price_per_gla) === 121.40 && after.price_per_gla_basis === 'gba'
      && stamp.comp_parse_version === COMP_PARSE_VERSION;
    // ── A REPORT THAT WAS SILENT MUST NEVER BLANK A FACT ──────────────────
    // The sweep used to write all eleven grid columns UNCONDITIONALLY, so a
    // re-parse that read LESS than the original import destroyed what was there
    // and then stamped the row so it was never revisited. A truncated stored file
    // still parses `ok` — the XML reader recovers silently — so this is not a
    // hypothetical. Measured: beds 7 -> null, rooms 14 -> null, gla 2900 -> null,
    // leaving a price per foot with no foot.
    await db.query(`UPDATE appraisals SET comp_parse_version = NULL WHERE id=$1`, [apprId]);
    await db.query(`UPDATE documents SET storage_ref = $2 WHERE id = $1`, [docId, truncRef]);
    const before2 = (await db.query(
      `SELECT beds, total_rooms, gla FROM appraisal_comparables WHERE appraisal_id=$1`, [apprId])).rows[0];
    await desk.backfillComparableParseOnce(50);
    const after2 = (await db.query(
      `SELECT beds, total_rooms, gla FROM appraisal_comparables WHERE appraisal_id=$1`, [apprId])).rows[0];
    const kept = after2.beds === before2.beds && after2.total_rooms === before2.total_rooms;
    console.log(kept ? 'PASS a re-parse that reads less LEAVES the stored facts alone'
      : `FAIL a re-parse blanked stored facts: ${JSON.stringify(before2)} -> ${JSON.stringify(after2)}`);

    // ── ONE ROW PER seq, PINNED BY ID ─────────────────────────────────────
    // `appraisal_comparables` has no unique index on (appraisal_id, seq), and the
    // old `UPDATE … WHERE seq = $2` wrote comp 1's grid onto BOTH rows.
    await db.query(`UPDATE documents SET storage_ref = $2 WHERE id = $1`, [docId, goodRef]);
    await db.query(
      `INSERT INTO appraisal_comparables (appraisal_id, seq, is_subject, address, city, state, zip,
         sale_price, beds, total_rooms, gla, comp_set)
       VALUES ($1,'1',false,$2,'Newark','NJ','07103',555000, 9, 99, 999, 'as_is')`,
      [apprId, `9 Reparse Rd ${sfx} (dup)`]);
    await db.query(`UPDATE appraisals SET comp_parse_version = NULL WHERE id=$1`, [apprId]);
    await desk.backfillComparableParseOnce(50);
    const dupRows = (await db.query(
      `SELECT beds FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY sale_price`, [apprId])).rows;
    console.log(dupRows.length === 2 && dupRows.every((x) => x.beds === 7)
      ? 'PASS every row carrying a duplicated seq is written once, to itself'
      : `FAIL duplicate-seq rows: ${JSON.stringify(dupRows)}`);

    // ── AND THE VIEW / LOCATION CELLS REACH THE ROW ───────────────────────
    // Not a value check for its own sake: these are the four columns the
    // duplicate was in, so this is what proves the UPDATE was accepted at all.
    const vl = (await db.query(
      `SELECT view_rating, location_rating, view_type, location_type
         FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY sale_price DESC LIMIT 1`,
      [apprId])).rows[0] || {};
    const vlOk = vl.view_rating === 'Neutral' && vl.location_rating === 'Adverse'
      && vl.view_type === 'Residential' && vl.location_type === 'BusyRoad';
    console.log(vlOk
      ? 'PASS the view and location cells are read off the grid and reach the row'
      : `FAIL view/location did not land: ${JSON.stringify(vl)}`);

    const allOk = good && kept && vlOk && structuralOk
      && dupRows.length === 2 && dupRows.every((x) => x.beds === 7);
    console.log(allOk ? '\ntest-comparable-reparse-db: PASS — a stored wrong count was healed from the XML' : '\ntest-comparable-reparse-db: FAIL');
    // EVERY check, not just the last one. This line used to be a bare
    // `good ? 0 : 1`, which overwrote the failures the two checks above had
    // already recorded — so a real regression in either of them exited 0.
    process.exitCode = allOk ? 0 : 1;
  } catch (e) { console.log('THREW', e.stack || e); process.exitCode = 1; }
  finally {
    // The warehouse ingest is fire-and-forget; let it settle before the teardown
    // deletes the rows out from under it, or its FK insert races our DELETE.
    await new Promise((r) => setTimeout(r, 600));
    try {
      if (apprId) await db.query(`DELETE FROM appraisals WHERE id=$1`, [apprId]);
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (bid) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
    } catch (e) { console.log('cleanup:', e.message); }
    await db.pool.end().catch(() => {});
  }
})();
