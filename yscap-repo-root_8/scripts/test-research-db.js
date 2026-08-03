/**
 * THE RESEARCH WAREHOUSE, against a REAL database and the REAL HTTP routes
 * (db/409 + db/410, src/lib/research/*, src/routes/research.js).
 *
 * What it proves, in order:
 *   1. INGEST — one imported appraisal becomes a subject property, a property per
 *      comparable, the observations, the sales and the appraiser record.
 *   2. IDEMPOTENCE — running it twice changes nothing. This is what makes the
 *      back-fill re-runnable and a re-import safe.
 *   3. DEDUPE ACROSS REPORTS — the same house on two different appraisals is ONE
 *      property with two observations, and the newer report wins the roll-up.
 *   4. THE AFTER-REPAIR RULE — a renovation report's subject condition describes
 *      the FINISHED house, so it must never roll up as the property's condition
 *      today. This is the subtlest correctness rule in the whole warehouse.
 *   5. SUPERSEDED — a replaced report is retired, not counted twice.
 *   6. THE SKIP LEDGER — a comparable with an unusable address is skipped, counted
 *      and explained, never stored under an invented key.
 *   7. SEARCH — every filter the screen offers, over the real SQL.
 *   8. THE ROUTES — staff-only, and the valuation flow end to end: create, add
 *      comps, adjust, reconcile, finalize, and refuse to edit a finished one.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-research-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const ingest = require('../src/lib/research/ingest');
const S = require('../src/lib/research/search');
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

const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
// A licence number unique to this run, so re-running the suite never folds this
// test's appraiser into the one a previous run left behind.
const LIC = `42RG${String(process.pid).padStart(5, '0')}${Math.floor(Math.random() * 900 + 100)}`;
// …and a surname unique to this run, for the same reason.
const SURNAME = 'Kessler' + String(process.pid).split('').map((d) => 'abcdefghij'[+d]).join('');

/** Insert an appraisal + its comparables directly, exactly as the importer writes them. */
async function makeAppraisal(appId, o) {
  const a = (await db.query(
    `INSERT INTO appraisals (application_id, form_type, effective_date, appraised_value, as_is_value,
       arv_value, condition_of_appraisal, subject_address, subject_city, subject_state, subject_zip,
       condo_unit_identifier, apn, property_category, units, year_built, gla, beds, baths_full, baths_half,
       rooms, condition_uad, quality_uad, lot_area, contract_price, contract_date,
       prior_sale_amount, prior_sale_date, appraiser_name, appraiser_company, license_id, license_state,
       license_type, appraiser_phone, appraiser_email, comp_split_confidence, superseded)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
             $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37) RETURNING id`,
    [appId, o.form || 'FNM1004', o.date, o.appraised || null, o.asIs || null, o.arv || null,
     o.conditionOf || null, o.address, o.city, o.state, o.zip || null, o.unit || null, o.apn || null,
     o.category || 'SFR (1 unit)', o.units || 1, o.yearBuilt || null, o.gla || null, o.beds || null,
     o.bathsFull || null, o.bathsHalf || null, o.rooms || null, o.condition || null, o.quality || null,
     o.lot || null, o.contractPrice || null, o.contractDate || null,
     o.priorAmount || null, o.priorDate || null,
     o.appraiser || null, o.company || null, o.license || null, o.licenseState || null,
     o.licenseType || null, o.phone || null, o.email || null, o.splitConfidence || null,
     o.superseded === true])).rows[0].id;
  for (const c of o.comps || []) {
    await db.query(
      `INSERT INTO appraisal_comparables (appraisal_id, seq, is_subject, address, city, state, zip,
         sale_price, adjusted_price, gla, sale_date, condition_uad, condition_text, comp_set, beds,
         baths_full, baths_half, sale_status, proximity, gross_adj_pct, net_adj_pct, adjustments)
       VALUES ($1,$2,false,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [a, c.seq, c.address, c.city, c.state, c.zip || null, c.price || null, c.price || null,
       c.gla || null, c.saleDate || null, c.condition || null, c.conditionText || null,
       c.set || 'unknown', c.beds || null, c.bathsFull || null, c.bathsHalf || null,
       c.status || 'closed', c.proximity || null, c.grossPct || null, c.netPct || null,
       JSON.stringify(c.adjustments || [])]);
  }
  return a;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const D = { query: (t, p) => db.query(t, p) };
  try {
    // ---- fixtures ---------------------------------------------------------
    const bid = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Research','Test',$1) RETURNING id`,
      [`research-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `1 Warehouse Way ${sfx}` })])).rows[0].id;

    // A town name unique to this run, in LETTERS only (a digit in a city name would
    // not survive normalization). Two runs sharing a town would see each other's rows.
    // Lower-case after the first letter on purpose: the warehouse title-cases a town
    // for display, so a town name in mixed case would not compare equal to itself.
    const CITY = 'Testville' + String(process.pid).split('').map((d) => 'abcdefghij'[+d]).join('')
      + String(Math.floor(Math.random() * 1e6)).split('').map((d) => 'klmnopqrst'[+d]).join('');
    const A1 = await makeAppraisal(appId, {
      date: '2026-05-01', appraised: 450000, asIs: 430000, address: '26 South 10th Street',
      city: CITY, state: 'NJ', zip: '08854', apn: '12-34', yearBuilt: '1955', gla: 1500,
      beds: 3, bathsFull: 2, bathsHalf: 1, rooms: 7, condition: 'C4', quality: 'Q4', lot: '0.17 ac',
      contractPrice: 420000, contractDate: '2026-03-15', priorAmount: 300000, priorDate: '2019-06-01',
      appraiser: `John Q. ${SURNAME}, SRA`, company: 'Acme Appraisal LLC', license: LIC,
      licenseState: 'NJ', licenseType: 'Certified Residential', phone: '(973) 555-1212',
      email: 'john@acme.test', splitConfidence: 'narrative',
      comps: [
        { seq: '1', address: '12 Maple Ave', city: CITY, state: 'NJ', zip: '08854',
          price: 415000, gla: 1400, saleDate: '2026-02-01', condition: 'C4', set: 'as_is', beds: 3,
          bathsFull: 2, proximity: '0.35 miles', grossPct: 8, netPct: 2,
          adjustments: [{ type: 'Age', description: '1962', amount: -2000 },
            { type: 'Site', description: '0.19 ac', amount: 1000 }] },
        { seq: '2', address: '98 Oak Street', city: CITY, state: 'NJ', zip: '08854',
          price: 460000, gla: 1600, saleDate: '2026-01-01', condition: 'C3', set: 'arv', beds: 4 },
        // A comparable the report described too thinly to identify — no house number.
        { seq: '3', address: 'Elm Court', city: CITY, state: 'NJ', price: 390000, gla: 1300 },
        // A LISTING, not a sale: its price is an asking price.
        { seq: '4', address: '7 Birch Ln', city: CITY, state: 'NJ', zip: '08854',
          price: 505000, gla: 1550, saleDate: '2026-06-01', status: 'active', conditionText: 'Avg-Good' },
      ],
    });

    // ---- 1. ingest ---------------------------------------------------------
    const r1 = await ingest.ingestAppraisal(D, A1);
    ok(r1.ok, 'the appraisal folds into the warehouse');
    ok(r1.observations === 4, `subject + 3 identifiable comparables become observations (got ${r1.observations})`);
    ok(r1.skipped.length === 1 && /did not write enough of this address/.test(r1.skipped[0].why),
      'the comparable with no house number is SKIPPED with a reason, not stored under an invented key');

    const log = (await db.query(`SELECT * FROM property_ingest_log WHERE appraisal_id=$1`, [A1])).rows[0];
    ok(log && log.status === 'ok' && log.rows_skipped === 1 && (log.skip_reasons || []).length === 1,
      'the skip is COUNTED on the ingest ledger — a silent skip is indistinguishable from having no comps');

    const subj = (await db.query(
      `SELECT p.* FROM properties p JOIN property_observations o ON o.property_id=p.id
        WHERE o.appraisal_id=$1 AND o.role='subject'`, [A1])).rows[0];
    ok(subj && /26 S 10th St/.test(subj.display_address), 'the subject address is normalized on the way in');
    ok(Number(subj.gla) === 1500 && subj.beds === 3 && subj.year_built === 1955,
      'the subject facts roll up onto the property');
    ok(Number(subj.baths_total) === 2.5, 'baths_total combines full + half (2 full + 1 half = 2.5)');
    ok(subj.condition_rank === 4, 'the ordinal condition rank is generated from the UAD code');
    ok(Number(subj.lot_sqft) === 7405, 'the free-text lot size is parsed into searchable square feet');
    ok(subj.subject_count === 1 && subj.comp_count === 0, 'it is counted as our own subject, not as a comp');

    const maple = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%12 Maple Ave%`, CITY])).rows[0];
    ok(maple && Number(maple.last_sale_price) === 415000, "the comparable's sale price rolls up");
    ok(maple.asis_comp_count === 1 && maple.arv_comp_count === 0,
      'WHICH GRID it was used on is recorded and counted — an as-is comp is not an ARV comp');
    ok(maple.year_built === 1962,
      "the comp's year built is mined out of the appraiser's Age adjustment line (the grid has no element for it)");
    ok(maple.condition_uad === 'C4', "the comparable's condition is stored — the owner's most important comp fact");

    const oak = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%98 Oak St%`, CITY])).rows[0];
    ok(oak && oak.arv_comp_count === 1 && oak.asis_comp_count === 0,
      'the ARV-grid comparable is counted on the ARV side only');
    const birch = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%7 Birch Ln%`, CITY])).rows[0];
    ok(birch && birch.last_sale_price == null && Number(birch.last_list_price) === 505000,
      'A LISTING IS NOT A SALE — its asking price lands on last_list_price, never on last_sale_price');
    ok(birch.condition_text === 'Avg-Good' && birch.condition_uad === null,
      'a worded condition rating is kept instead of being dropped for not being a UAD code');

    const sales = (await db.query(
      `SELECT source, sale_date, sale_price FROM property_sales WHERE property_id=$1 ORDER BY sale_date`,
      [subj.id])).rows;
    ok(sales.some((s) => s.source === 'subject_prior_sale' && Number(s.sale_price) === 300000),
      "the subject's earlier sale is recorded as a transaction");
    ok(sales.some((s) => s.source === 'subject_contract' && Number(s.sale_price) === 420000),
      'the purchase under contract is recorded too');
    ok(Number(subj.last_sale_price) === 300000,
      'the last CLOSED sale is the 2019 one — the pending contract does not become a sale price');

    const appr = (await db.query(`SELECT * FROM appraisers WHERE license_id=$1`, [LIC])).rows[0];
    ok(appr && appr.name === `John Q. ${SURNAME}, SRA` && appr.email === 'john@acme.test'
      && appr.phone === '(973) 555-1212', 'the appraiser record carries their contact details');
    ok(appr.appraisal_count === 1 && appr.file_count === 1, 'their report and file counts are right');
    const contacts = (await db.query(`SELECT kind FROM appraiser_contacts WHERE appraiser_id=$1`, [appr.id])).rows;
    ok(contacts.length >= 3, 'every contact detail on the report is kept in their contact book');

    // ---- 2. idempotence ----------------------------------------------------
    const before = (await db.query(`SELECT count(*)::int n FROM property_observations`)).rows[0].n;
    const r2 = await ingest.ingestAppraisal(D, A1);
    const after = (await db.query(`SELECT count(*)::int n FROM property_observations`)).rows[0].n;
    ok(r2.ok && before === after, 'RUNNING THE INGEST TWICE CHANGES NOTHING — the back-fill is safe to re-run');
    const m2 = (await db.query(`SELECT comp_count FROM properties WHERE id=$1`, [maple.id])).rows[0];
    ok(m2.comp_count === 1, 'a second pass does not double the comp count');

    // ---- 3. the same house on a SECOND report ------------------------------
    const app2 = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `2 Warehouse Way ${sfx}` })])).rows[0].id;
    const A2 = await makeAppraisal(app2, {
      date: '2026-07-01', appraised: 500000, address: '99 Cedar Rd', city: CITY, state: 'NJ',
      zip: '08854', gla: 1800, beds: 4, condition: 'C3',
      appraiser: `JOHN ${SURNAME.toUpperCase()}`, company: 'Bravo Valuation Inc', license: LIC.replace(/^(..)(....)/, '$1-$2-'),
      licenseState: 'New Jersey', phone: '(973) 555-9999', email: 'jk@bravo.test',
      comps: [
        // The SAME house as comp 1 above, written differently.
        { seq: '1', address: '12 Maple Avenue', city: CITY, state: 'NJ',
          price: 415000, gla: 1410, saleDate: '2026-02-01', condition: 'C3', set: 'arv', beds: 3 },
      ],
    });
    ok((await ingest.ingestAppraisal(D, A2)).ok, 'the second report folds in');

    const maple3 = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%12 Maple Ave%`, CITY])).rows;
    ok(maple3.length === 1,
      'THE SAME HOUSE ON TWO REPORTS IS ONE PROPERTY — "12 Maple Ave" and "12 Maple Avenue" do not split');
    ok(maple3[0].observation_count === 2 && maple3[0].comp_count === 2,
      'both reports are kept as separate observations of it');
    ok(maple3[0].condition_uad === 'C3',
      'the NEWER report wins the roll-up (July said C3, May said C4)');
    ok(maple3[0].arv_comp_count === 1 && maple3[0].asis_comp_count === 1,
      'it was used on an as-is grid once and an ARV grid once, and both are counted');
    const mapleSales = (await db.query(
      `SELECT count(*)::int n FROM property_sales WHERE property_id=$1`, [maple3[0].id])).rows[0];
    ok(mapleSales.n === 1,
      'both reports describe the SAME sale, so it is stored once — deduped on the property, month and price');

    const appr2 = (await db.query(`SELECT * FROM appraisers WHERE name ILIKE $1`, [`%${SURNAME}%`])).rows;
    ok(appr2.length === 1,
      'THE LICENCE IS THE IDENTITY — the same appraiser at a new firm is still one record, not two');
    ok(appr2[0].company === 'Bravo Valuation Inc' && appr2[0].phone === '(973) 555-9999',
      "the newer report's firm and phone are shown as current");
    const allContacts = (await db.query(
      `SELECT kind, value FROM appraiser_contacts WHERE appraiser_id=$1 AND kind='phone'`, [appr2[0].id])).rows;
    ok(allContacts.length === 2, 'and the OLD phone number is still in their contact book, not overwritten');
    ok(appr2[0].file_count === 2, 'both files are counted against them');

    // ---- 3b. MERGING FILLS THE GAPS, IT DOES NOT BLANK THEM -----------------
    // The owner's rule in their own words: "it should add the missing information —
    // one appraisal had it, the other didn't". A THIRD report on the same house,
    // NEWER than both, that states the price and the bedrooms and nothing else.
    // The newest report wins where it SPEAKS; where it is silent, the property must
    // keep what an older report told us rather than losing it. Getting this backwards
    // is the obvious way to write a roll-up and it would quietly empty the warehouse
    // one thin report at a time.
    const app2b = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `2b Warehouse Way ${sfx}` })])).rows[0].id;
    const A2b = await makeAppraisal(app2b, {
      date: '2026-09-01', appraised: 505000, address: '98 Cedar Rd', city: CITY, state: 'NJ',
      // A DIFFERENT appraiser on purpose — this is the owner's actual scenario
      // ("if you find two appraisals with the same comparable"), and it keeps the
      // appraiser-book assertions above measuring one person.
      zip: '08854', appraiser: `Dana ${SURNAME.replace('Kessler', 'Whitfield')}`, company: 'Third Look Appraisal LLC',
      comps: [
        // The same house a THIRD time — priced and counted, but silent on size,
        // condition and bedrooms.
        { seq: '1', address: '12 MAPLE AVE.', city: CITY, state: 'NJ', price: 419000,
          saleDate: '2026-02-01', set: 'as_is' },
      ],
    });
    ok((await ingest.ingestAppraisal(D, A2b)).ok, 'a third, thinner report on the same house folds in');

    const maple4 = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%12 Maple Ave%`, CITY])).rows;
    ok(maple4.length === 1, 'still ONE property — a third spelling does not split it either');
    ok(maple4[0].observation_count === 3, 'and all three reports are kept as separate observations');
    ok(Number(maple4[0].gla) === 1410 && maple4[0].beds === 3 && maple4[0].condition_uad === 'C3',
      'THE FACTS THE NEWEST REPORT DID NOT STATE ARE KEPT FROM THE ONES THAT DID — a thin report never blanks the record');

    // And the reverse direction: a fact only the OLDEST report ever stated must
    // survive every later report that was silent on it.
    const oldestOnly = (await db.query(
      `SELECT o.observed_on, o.gla, o.condition_uad FROM property_observations o
        WHERE o.property_id = $1 ORDER BY o.observed_on DESC NULLS LAST`, [maple4[0].id])).rows;
    ok(oldestOnly.length === 3 && oldestOnly[0].gla == null,
      'the newest observation genuinely stated no size — so the property row is answering from an older one, not from itself');

    // ---- 4. the after-repair rule ------------------------------------------
    const app3 = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `3 Warehouse Way ${sfx}` })])).rows[0].id;
    const A3 = await makeAppraisal(app3, {
      date: '2026-06-01', asIs: 300000, arv: 550000, conditionOf: 'SubjectToRepairs',
      address: '4 Reno Rd', city: CITY, state: 'NJ', zip: '08854', gla: 1600,
      beds: 3, condition: 'C2', quality: 'Q3', yearBuilt: '1930',
      appraiser: 'Dana Reyes', company: 'Reno Appraisals', license: `RG${LIC.slice(-6)}`, licenseState: 'NJ',
    });
    await ingest.ingestAppraisal(D, A3);
    const reno = (await db.query(
      `SELECT * FROM properties WHERE display_address LIKE $1 AND city=$2`, [`%4 Reno Rd%`, CITY])).rows[0];
    const renoObs = (await db.query(
      `SELECT condition_uad, condition_basis FROM property_observations WHERE appraisal_id=$1`, [A3])).rows[0];
    ok(renoObs.condition_uad === 'C2' && renoObs.condition_basis === 'as_repaired',
      'the renovation report STATED C2 and the observation records it, marked as the after-repair condition');
    ok(reno.condition_uad === null,
      'BUT IT DOES NOT ROLL UP — C2 describes the finished house, and the property page must not claim '
      + 'a gutted 1930 house is in like-new condition today');
    ok(reno.year_built === 1930 && Number(reno.gla) === 1600,
      'everything that is true either way (size, year built) still rolls up from the same report');

    // ---- 5. superseded -----------------------------------------------------
    await db.query(`UPDATE appraisals SET superseded = true WHERE id=$1`, [A3]);
    const r3 = await ingest.ingestAppraisal(D, A3);
    ok(r3.ok && r3.superseded, 'a superseded report is retired rather than re-ingested');
    const renoLeft = (await db.query(
      `SELECT count(*)::int n FROM property_observations WHERE appraisal_id=$1`, [A3])).rows[0].n;
    ok(renoLeft === 0, 'its observations are taken back out, so nothing is counted twice');
    const renoAfter = (await db.query(`SELECT observation_count FROM properties WHERE id=$1`, [reno.id])).rows[0];
    ok(renoAfter.observation_count === 0, 'and the property it touched is re-rolled without it');
    const skippedLog = (await db.query(`SELECT status FROM property_ingest_log WHERE appraisal_id=$1`, [A3])).rows[0];
    ok(skippedLog.status === 'skipped', 'the ledger records WHY, so the back-fill does not keep retrying it');

    // ---- 6. the back-fill --------------------------------------------------
    const bf = await ingest.backfill(D, { limit: 50 });
    ok(bf.scanned >= 0 && bf.failed === 0, 'the back-fill runs clean over the corpus');
    const bf2 = await ingest.backfill(D, { limit: 50 });
    ok(bf2.scanned === 0,
      'and a second pass has nothing left to do — it self-drains instead of re-reading everything every boot');

    // ---- 7. search ---------------------------------------------------------
    const q = async (f) => (await S.searchProperties(D, Object.assign({ city: CITY }, f))).rows;
    ok((await q({})).length >= 4, 'the town filter finds the properties we just filed');
    ok((await q({ beds_min: 4 })).every((r) => r.beds >= 4), 'a bedroom floor filters');
    ok((await q({ price_min: 400000, price_max: 450000 })).every(
      (r) => Number(r.last_sale_price) >= 400000 && Number(r.last_sale_price) <= 450000), 'a price range filters');
    ok((await q({ sqft_min: 1450 })).every((r) => Number(r.gla) >= 1450), 'a size floor filters');
    ok((await q({ baths_min: 2.5 })).every((r) => Number(r.baths_total) >= 2.5),
      'a bathroom floor filters on the combined count');
    const better = await q({ condition_worst: 'C3' });
    ok(better.length > 0 && better.every((r) => r.condition_rank <= 3),
      'CONDITION IS ORDINAL — "C3 or better" means rank 1..3, not a string comparison');
    ok((await q({ comp_set: 'arv' })).every((r) => r.arv_comp_count > 0), 'the ARV-grid filter works');
    ok((await q({ comp_set: 'as_is' })).every((r) => r.asis_comp_count > 0), 'the as-is-grid filter works');
    ok((await q({ role: 'subject' })).every((r) => r.subject_count > 0), 'our own subjects can be isolated');
    ok((await q({ sold_from: '2026-01-01' })).every((r) => String(r.last_sale_date) >= '2026-01-01'),
      'a sale-date floor filters');
    const fts = await S.searchProperties(D, { q: `maple ${CITY}` });
    ok(fts.rows.length === 1 && /Maple/.test(fts.rows[0].display_address),
      'ADDRESS SEARCH IS WORD-ORDER-FREE — full-text finds it without a leading-wildcard scan');
    const facets = await S.facets(D, { city: CITY });
    ok(facets.total >= 4 && Array.isArray(facets.cities) && facets.conditions.length > 0,
      'the facet counts come back in one round trip');
    const sortedDesc = await q({ sort: 'price_desc', has_sale: '1' });
    ok(sortedDesc.length < 2 || Number(sortedDesc[0].last_sale_price) >= Number(sortedDesc[1].last_sale_price),
      'sorting by price works');

    // ---- 8. the routes -----------------------------------------------------
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Research Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`res-lo-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const anon = await call(server, 'GET', '/api/research/properties', null);
    ok(anon.status === 401, 'the research desk is closed to anyone without a staff session');

    // A LOAN OFFICER — deliberately NOT a see-all-files role — must still see the
    // whole warehouse (the owner's "make it available for all the staff users").
    const list = await call(server, 'GET', `/api/research/properties?city=${encodeURIComponent(CITY)}`, token);
    ok(list.status === 200 && list.body.rows.length >= 4,
      'an ordinary loan officer sees every property, with no per-file scoping');
    ok(list.body.facets && typeof list.body.total === 'number', 'the search returns its facets and a total');

    const stats = await call(server, 'GET', '/api/research/stats', token);
    ok(stats.status === 200 && stats.body.properties > 0, 'the stats endpoint answers');

    const detail = await call(server, 'GET', `/api/research/properties/${maple3[0].id}`, token);
    ok(detail.status === 200 && detail.body.observations.length === 3 && detail.body.sales.length >= 1,
      'the property page shows EVERY report that mentioned it (all three), and its sales');

    const aList = await call(server, 'GET', `/api/research/appraisers?q=${SURNAME}`, token);
    ok(aList.status === 200 && aList.body.rows.length === 1, 'the appraiser directory searches by name');
    const aDetail = await call(server, 'GET', `/api/research/appraisers/${appr2[0].id}`, token);
    ok(aDetail.status === 200 && aDetail.body.files.length === 2
      && aDetail.body.licenses.length >= 1 && aDetail.body.contacts.length >= 4,
    'THE APPRAISER PROFILE LISTS EVERY FILE THEY APPRAISED, with their licences and contacts');

    const comps = await call(server, 'GET', `/api/research/comps?property_id=${subj.id}&sold_within_months=36`, token);
    ok(comps.status === 200 && comps.body.rows.length > 0
      && comps.body.rows.every((r) => r.match_score != null && r.id !== subj.id),
    'the comparable finder ranks candidates and never returns the subject itself');
    ok(comps.body.rows.every((r) => Array.isArray(r.match_reasons) && r.match_reasons.length),
      'and every score shows its working');

    // ---- the valuation flow ----
    const made = await call(server, 'POST', '/api/research/valuations', token,
      { property_id: subj.id, title: 'Test valuation' });
    ok(made.status === 201 && made.body.valuation.id, 'a valuation is created off a property');
    const vid = made.body.valuation.id;
    ok(made.body.valuation.subject_snapshot.gla != null,
      'THE SUBJECT IS SNAPSHOTTED, not referenced — the report must still reproduce years later');

    const added = await call(server, 'POST', `/api/research/valuations/${vid}/comps`, token,
      { property_ids: [maple3[0].id, oak.id, birch.id] });
    ok(added.status === 200 && added.body.comps.length === 3, 'comparables are added to the grid');
    ok(added.body.grid.value.indicatedValue != null, 'and a value comes back straight away');
    ok(added.body.grid.comps.some((c) => (c.warnings || []).some((w) => w.code === 'not_closed')),
      'the listing among them is flagged as an asking price, not a sale');

    const compRow = added.body.comps.find((c) => c.property_id === maple3[0].id);
    const edited = await call(server, 'PATCH', `/api/research/valuations/${vid}/comps/${compRow.id}`, token,
      { adjustments: [{ key: 'gla', amount: 12000 }, { key: 'made_up_line', amount: 999999 }] });
    ok(edited.status === 200, 'an adjustment can be typed in');
    const editedComp = edited.body.comps.find((c) => c.id === compRow.id);
    ok(Number(editedComp.net_adjustment) === 12000,
      'AN UNKNOWN GRID LINE IS DROPPED — it can never be silently summed into the total');
    ok(Number(editedComp.adjusted_price) === Number(editedComp.sale_price) + 12000,
      'the adjusted price is recomputed on the server, so the stored figure can never drift from the lines');

    const excluded = await call(server, 'PATCH', `/api/research/valuations/${vid}/comps/${compRow.id}`, token,
      { included: false });
    // The listing carries no sale price, so it was never in the value to begin with —
    // two priced comps go in, one is switched off, one is left.
    ok(added.body.grid.value.compCount === 2 && excluded.body.grid.value.compCount === 1,
      'switching a comp off takes it out of the value, and a listing with no sale price was never in it');
    await call(server, 'PATCH', `/api/research/valuations/${vid}/comps/${compRow.id}`, token, { included: true });

    const finalized = await call(server, 'POST', `/api/research/valuations/${vid}/finalize`, token, {});
    ok(finalized.status === 200 && finalized.body.valuation.status === 'final', 'a valuation can be finished');
    ok(finalized.body.valuation.indicated_value != null && finalized.body.valuation.confidence_label,
      'the headline figures are stored on it');
    const blocked = await call(server, 'PATCH', `/api/research/valuations/${vid}/comps/${compRow.id}`, token,
      { adjustments: [] });
    ok(blocked.status === 409, 'A FINISHED VALUATION IS FROZEN — editing it is refused, with a way forward');
    const dup = await call(server, 'POST', `/api/research/valuations/${vid}/duplicate`, token, {});
    ok(dup.status === 201 && dup.body.comps.length === 3 && dup.body.valuation.version === 2,
      'and a revision copies it, comps and all, instead of destroying the original');

    // Only platform-setup may run the back-fill by hand.
    const bfDenied = await call(server, 'POST', '/api/research/backfill', token, {});
    ok(bfDenied.status === 403, 'an ordinary officer cannot trigger a corpus-wide back-fill');

    // ---- REGRESSIONS from the 2026-08-03 audit ------------------------------
    // Each of these FAILS on the code as it stood before that pass.

    // (1) "SOLD AT ANY TIME" MUST ACTUALLY REMOVE THE WINDOW. The route defaults
    // to 18 months. The screen's "any time" option used to be sent as an EMPTY
    // value, which the client's query-string builder drops before it reaches the
    // wire — so the default quietly won and the option did nothing. It is sent as
    // `0` now. The response echoes the filters it actually applied, so this is
    // exact rather than inferred from a row count.
    const subjProp = maple3[0].id;
    const cDefault = await call(server, 'GET', `/api/research/comps?property_id=${subjProp}`, token);
    ok(cDefault.status === 200 && Number(cDefault.body.filters.sold_within_months) === 18,
      'a comp search with no time filter still defaults to the last 18 months');
    const cAny = await call(server, 'GET', `/api/research/comps?property_id=${subjProp}&sold_within_months=0`, token);
    ok(cAny.status === 200 && cAny.body.filters.sold_within_months === undefined,
      '"sold at any time" (0) genuinely removes the 18-month window — the option is not a no-op');
    const cAnyEmpty = await call(server, 'GET', `/api/research/comps?property_id=${subjProp}&sold_within_months=`, token);
    ok(cAnyEmpty.status === 200 && cAnyEmpty.body.filters.sold_within_months === undefined,
      'and a hand-written empty value still means the same thing');

    // (2) THE COMP SEARCH MUST NOT PIN ITSELF TO "MOST RECENT". Naming a sort in
    // the route's defaults made search.js's "placed subject → sort by distance"
    // fallback dead for the only caller that supplies coordinates, so the SQL
    // LIMIT kept the 60 most recently sold rows and the nearest comps could be
    // missing entirely. No default sort means the fallback decides.
    ok(cDefault.body.filters.sort === undefined,
      'the comp search names no sort of its own, so the nearest-first fallback can apply');

    // (3) A VALUATION'S HEADING SAVES. The PATCH wrote the subject snapshot but
    // never `subject_address`, which is the column the page header and the
    // valuations list both read — so a valuation born "Untitled property" stayed
    // that way however many times the address was typed in.
    const draftId = dup.body.valuation.id;
    const named = await call(server, 'PATCH', `/api/research/valuations/${draftId}`, token,
      { subject: { display_address: '9 Rosewood Ave' } });
    ok(named.status === 200 && named.body.valuation.subject_address === '9 Rosewood Ave',
      'typing the subject address on a valuation actually saves it to the heading');
    const reread = await call(server, 'GET', `/api/research/valuations/${draftId}`, token);
    ok(reread.body.valuation.subject_address === '9 Rosewood Ave',
      'and it is still there when the valuation is re-read');

    // (4) MARKING A PAIR "NOT A DUPLICATE" IS PERMANENT, so it is gated like its
    // two siblings. It was the only warehouse-shape mutation left open to any
    // staff user.
    const ndDenied = await call(server, 'POST', '/api/research/duplicates/not-duplicate', token,
      { property_id: maple3[0].id, other_property_id: subj.property_id || maple3[0].id });
    ok(ndDenied.status === 403,
      'an ordinary officer cannot permanently suppress a duplicate pair');

    // (4b) THE RELAXATION LADDER — a comp search says how hard it had to look, and
    // how much of the town we hold at all, so a thin answer can never read as a
    // confident one. `filters` is what was ASKED for; `applied_filters` is what
    // actually ran; they differ exactly when the ladder relaxed something.
    const lad = await call(server, 'GET',
      `/api/research/comps?property_id=${subjProp}&want=25&relaxable=radius_miles,sold_within_months`, token);
    ok(lad.status === 200 && Array.isArray(lad.body.ladder) && lad.body.ladder.length >= 1,
      'a comp search reports every rung it tried');
    ok(lad.body.ladder.every((s) => typeof s.found === 'number' && s.label),
      'and each rung says what it looked for and what it found');
    ok(lad.body.coverage && typeof lad.body.coverage.properties === 'number',
      'and how many properties we hold in that town at all — the denominator an empty answer needs');
    ok(lad.body.relaxed_to === 'any_time' || lad.body.ladder.length > 1,
      'wanting more than the town holds walks the ladder outwards rather than just answering short');
    ok(lad.body.applied_filters !== undefined && lad.body.filters !== undefined,
      'what was asked for and what actually ran are BOTH reported');
    // The ladder's own steering parameters must never reach the query builder.
    ok(lad.body.filters.want === undefined && lad.body.filters.relaxable === undefined,
      'the ladder controls are not filters and never leak into the search');
    // An EXPLICIT choice is never relaxed — only what the screen declared as its default.
    const strict = await call(server, 'GET',
      `/api/research/comps?property_id=${subjProp}&want=25&sold_within_months=6`, token);
    ok(strict.status === 200
      && Number(strict.body.applied_filters.sold_within_months) === 6,
    'a time window the user actually typed is honoured, never widened underneath them');

    // (4c) WHAT NAMES THE SUBJECT IS NOT A FILTER ON THE ANSWER. `application_id`
    // selects WHICH property we are finding comps for; `search.js` also reads it
    // as `EXISTS (… o.application_id = …)`, so leaving it in the filters meant the
    // loan-file entry point could only ever return the comps that file's OWN
    // appraisal had already used — and the ladder then dressed the shortfall up as
    // "we looked as hard as we could, this town is thin".
    const byApp = await call(server, 'GET', `/api/research/comps?application_id=${appId}&want=25`, token);
    const byProp = await call(server, 'GET', `/api/research/comps?property_id=${subjProp}&want=25`, token);
    ok(byApp.status === 200, 'a comp search can be anchored on a loan file');
    ok(byApp.body.filters.application_id === undefined && byApp.body.applied_filters.application_id === undefined,
      'the loan file NAMES the subject — it never becomes a filter on the comparables');
    ok(byApp.body.total >= byProp.body.total,
      'so the loan-file door finds at least as much as the same subject by property id');
    ok(byApp.body.filters.property_id === undefined && byApp.body.filters.gla === undefined,
      'the other subject selectors are not filters either');

    // (4d) THE COVERAGE COUNT NEVER STATES A FALSE ZERO. A ZIP-only subject used to
    // be told "we hold no properties at all in that area" because the query keyed
    // on `state = NULL`. A panel built to stop the tool overstating itself must
    // never itself be the thing that overstates.
    const zipOnly = await call(server, 'GET',
      '/api/research/comps?zip=08854&state=NJ&want=25', token);
    ok(zipOnly.status === 200 && zipOnly.body.coverage
      && zipOnly.body.coverage.properties > 0,
    'a subject named by ZIP still gets a truthful coverage count, not a false zero');
    const nowhere = await call(server, 'GET', '/api/research/comps?city=&state=&zip=', token);
    ok(nowhere.status === 200 && nowhere.body.coverage === null,
      'and with no locality named at all it reports NO coverage rather than zero');

    // (4e) EVERY RUNG STRICTLY WIDENS. A rung that replaced the caller's band could
    // return FEWER rows than the query before it, under a label that says "wider".
    const wide = await call(server, 'GET',
      `/api/research/comps?property_id=${subjProp}&sqft_min=100&sqft_max=100000&relaxable=sqft_min,sqft_max&want=25`,
      token);
    ok(wide.status === 200 && wide.body.ladder.every((s, i, arr) => i === 0 || s.found >= arr[0].found),
      'no rung of the ladder ever finds less than the first query did');
    ok(Number(wide.body.applied_filters.sqft_min) <= 100 && Number(wide.body.applied_filters.sqft_max) >= 100000,
      'a caller-supplied size band is only ever widened, never replaced with a narrower one');

    // (4f) EVERY FACT THE REPORT STATED CROSSES THE LAST HOP (db/422), and lands on
    // the CORRECT SIDE. A fact about the PROPERTY rolls up so the search can reach
    // it; a fact about the REPORT stays on the observation, because rolling
    // `lender_name` onto a property would let the newest appraisal overwrite a
    // durable answer with something only ever true of one report.
    const factsAppId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `9 Fact Way ${sfx}` })])).rows[0].id;
    const factsA = (await db.query(
      `INSERT INTO appraisals (application_id, form_type, effective_date, subject_address, subject_city,
         subject_state, subject_zip, property_tax_amount, property_tax_year, cost_new_total,
         off_site_improvements, condo_project_name, condo_units_planned,
         lender_name, form_version, addendum_text, seller_is_owner, superseded)
       VALUES ($1,'FNM1073','2026-05-02',$2,$3,'NJ','08854', 12345.67, 2025, 310000.00,
         $4, 'Harbor Point', 120, 'Other Lender Bank NA', 'UAD 2.6', 'Corner lot.', true, false)
       RETURNING id`,
      [factsAppId, `9 Fact Way ${sfx}`, CITY, JSON.stringify(['Curb', 'Gutter'])])).rows[0].id;
    await ingest.ingestAppraisal(D, factsA);
    const fObs = (await db.query(
      `SELECT * FROM property_observations WHERE appraisal_id=$1 AND role='subject'`, [factsA])).rows[0];
    const fProp = (await db.query(`SELECT * FROM properties WHERE id=$1`, [fObs.property_id])).rows[0];

    ok(Number(fObs.property_tax_amount) === 12345.67 && fObs.condo_project_name === 'Harbor Point'
      && fObs.lender_name === 'Other Lender Bank NA' && fObs.addendum_text === 'Corner lot.',
    'every db/422 fact the report stated reaches the observation — property AND report facts alike');
    ok(Number(fProp.property_tax_amount) === 12345.67 && fProp.condo_project_name === 'Harbor Point'
      && Number(fProp.condo_units_planned) === 120,
    'and the PROPERTY facts roll up onto the property, where the search can reach them');
    ok(!('lender_name' in fProp) && !('addendum_text' in fProp) && !('form_version' in fProp),
      'while the REPORT facts have no property column at all — they can never overwrite a durable answer');
    // A jsonb column reads back as a JS array; binding it raw is what wiped every
    // fact off every property in PR #974, so prove it survived the round trip.
    ok(Array.isArray(fProp.off_site_improvements) && fProp.off_site_improvements.includes('Curb'),
      'a jsonb fact round-trips through the roll-up instead of throwing on the bind');
    ok(Number(fProp.rollup_version) === 3, 'the property is stamped at the widened roll-up version');

    // …AND THE POINT OF ALL THAT: they are searchable.
    const taxHit = await S.searchProperties(db, { tax_min: 12000, tax_max: 13000, state: 'NJ' });
    ok(taxHit.rows.some((r) => r.id === fProp.id), 'a property can be found by its tax bill');
    const projHit = await S.searchProperties(db, { condo_project: 'harbor point' });
    ok(projHit.rows.some((r) => r.id === fProp.id), 'and by the name of its condo project, case-insensitively');

    // (4g) THE MARKET GRID (db/423). The 1004MC states its windows RELATIVELY
    // ("last 3 months"), which two reports written months apart cannot share an
    // axis on. Each window is resolved against that report's own effective date
    // into real dates — that is what turns a pile of reports into a time series.
    const MK = require('../src/lib/research/market');
    const mktGrid = {
      MedianSalesPrice: { prior712: 412000, prior46: 441000, last3: 452500, trend: 'Increasing' },
      Supply: { prior712: 5.1, prior46: 3.8, last3: 2.5, trend: 'Declining' },
      TotalSales: { prior712: 88, prior46: 41, last3: 26 },
      MedianSalesDOM: { prior712: 61, prior46: 44, last3: 29 },
    };
    const mktApp = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type) VALUES ($1,$2,'rtl') RETURNING id`,
      [bid, JSON.stringify({ line1: `2 Market Rd ${sfx}` })])).rows[0].id;
    const mktA = (await db.query(
      `INSERT INTO appraisals (application_id, form_type, effective_date, subject_address, subject_city,
         subject_state, subject_zip, market_trends, nbhd_builtup, nbhd_value_trend, present_land_use,
         market_conditions_comment, superseded)
       VALUES ($1,'FNM1004','2026-05-01',$2,$3,'NJ','08854',$4,'Over 75%','Increasing',$5,
         'Market is tightening.', false) RETURNING id`,
      [mktApp, `2 Market Rd ${sfx}`, CITY, JSON.stringify(mktGrid),
        JSON.stringify([{ use: 'One-Unit', pct: 85 }])])).rows[0].id;
    const mktOut = await ingest.ingestAppraisal(D, mktA);
    ok(mktOut.market === 1 && mktOut.marketPeriods === 3,
      'a report carrying a 1004MC grid files one market read with all three windows');

    const mObs = (await db.query(`SELECT * FROM market_observations WHERE appraisal_id=$1`, [mktA])).rows[0];
    const mPer = (await db.query(
      `SELECT * FROM market_periods WHERE observation_id=$1 ORDER BY period_start`, [mObs.id])).rows;
    ok(mPer.length === 3 && mPer.every((p) => p.period_start && p.period_end),
      'every window is stored with REAL dates, never the form\'s relative wording');
    ok(mPer[0].period_start === '2025-05-01' && mPer[2].period_end === '2026-05-01',
      'and they are anchored on the report\'s own effective date, covering the full prior year');
    ok(mPer[0].period_end === mPer[1].period_start && mPer[1].period_end === mPer[2].period_start,
      'the three windows are contiguous and non-overlapping, so stacked reports never double-count');
    ok(mObs.trends && mObs.trends.Supply === 'Declining' && mObs.nbhd_builtup === 'Over 75%'
      && Array.isArray(mObs.present_land_use),
    'the appraiser\'s trend conclusions and the page-1 neighbourhood read land with it');
    // The market is about an AREA, so it must never appear on the property row.
    const mProp = (await db.query(
      `SELECT * FROM properties WHERE id=$1`, [mObs.property_id])).rows[0];
    ok(mProp && !('months_supply' in mProp) && !('nbhd_value_trend' in mProp),
      'and NONE of it is filed on the property — a house never carries its town\'s statistics');

    await ingest.ingestAppraisal(D, mktA);
    const mAgain = (await db.query(
      `SELECT count(*)::int AS c FROM market_observations WHERE appraisal_id=$1`, [mktA])).rows[0].c;
    ok(mAgain === 1, 're-ingesting a report refreshes its market read rather than duplicating it');

    const series = await MK.summarize(db, { city: CITY, months: 60 });
    ok(series.months.length >= 3 && series.months.every((m) => m.reports > 0),
      'the reads assemble into a month-by-month series');
    ok(typeof series.reports === 'number' && /report count|report/i.test(series.note),
      'and every answer carries how many REPORTS it averaged — this is opinion data, not a measurement');

    // (5) THE APPRAISER PROFILE REPORTS REAL TOTALS, not the length of a list the
    // SQL capped — otherwise a busy appraiser's page reads "2000 properties"
    // forever and the filter underneath silently works inside a truncated set.
    const aTotals = await call(server, 'GET', `/api/research/appraisers/${appr2[0].id}`, token);
    ok(aTotals.status === 200 && aTotals.body.totals
      && typeof aTotals.body.totals.properties === 'number',
    'the appraiser profile carries the real property total alongside the capped list');
    ok(aTotals.body.totals.properties >= (aTotals.body.properties || []).length,
      'and that total is never smaller than the rows it shipped');

    // ---- cleanup -----------------------------------------------------------
    await db.query(`DELETE FROM property_valuations WHERE id IN ($1,$2)`, [vid, dup.body.valuation.id]);
    await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appId, app2, app2b, app3, factsAppId, mktApp]]);
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [bid]);
    // The warehouse deliberately SURVIVES the files (the observations are SET NULL,
    // not cascaded) — that is the point of a cross-file database, so clean up by key.
    await db.query(`DELETE FROM market_observations WHERE city = $1`, [CITY]);
    await db.query(`DELETE FROM properties WHERE city = $1`, [CITY]);
    await db.query(`DELETE FROM appraisers WHERE identity_key IN ($1,$2)`, [`lic:NJ:${LIC}`, `lic:NJ:RG${LIC.slice(-6)}`]);
    await db.query(`DELETE FROM appraisers WHERE name_key = $1`, [`dana ${SURNAME.replace('Kessler', 'Whitfield')}`.toLowerCase()]);
  } catch (e) {
    fail++;
    console.log('FAIL threw:', e && e.stack ? e.stack : e);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  console.log(`test-research-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
