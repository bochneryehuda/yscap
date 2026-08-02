/**
 * THE STANDALONE XML UPLOAD (db/410, src/lib/research/xml-import.js, the
 * `/api/research/imports` routes) — against a REAL database and the REAL routes.
 *
 * The owner asked to be able to feed the research database directly: "we should be
 * able to manually add XML appraisal reports to build up our database", single or
 * bulk. That door has to be held to a higher bar than a convenience feature,
 * because it writes into the same warehouse the comp search and the valuation tool
 * read — a report filed differently from the loan-file reports would quietly make
 * half the market unsearchable.
 *
 * What it proves, in order:
 *   1. A report uploaded with NO LOAN FILE lands: the subject property, a property
 *      per comparable, the observations, the sales, and the appraiser record.
 *   2. IT IS THE SAME READ. The same XML through the upload door and through the
 *      loan-file door produces the same facts on the same property rows.
 *   3. IDEMPOTENT. The same file uploaded twice is one report, not two — no comp
 *      count doubles, no second copy of any property.
 *   4. THE TWO DOORS RECONCILE. Upload a report, then import THAT SAME report onto
 *      a loan file: the file's copy wins, the upload is retired, and the property
 *      is left with ONE observation — not two counting the same appraiser twice.
 *   5. NOTHING IS GUESSED. An unreadable file is recorded with a reason in words
 *      and writes nothing; a comparable with an unusable address is skipped and
 *      counted.
 *   6. IT NEVER TOUCHES A LOAN FILE. No application, no `appraisals` row, no
 *      condition, no finding is created by an upload.
 *   7. THE ROUTES — staff-only, single and bulk, and the import list.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-research-xml-import-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const XI = require('../src/lib/research/xml-import');
const ingest = require('../src/lib/research/ingest');
const { importAppraisal } = require('../src/lib/appraisal/import');
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

// Everything this run writes is namespaced, so re-running the suite never folds
// into what a previous run left behind (the warehouse dedupes on the ADDRESS, which
// is exactly what makes a shared fixture address dangerous here).
const RUN = `${process.pid}${Math.floor(Math.random() * 1000)}`;
const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[+d] || 'x').join('');
// A town name unique to this run, letters only — `titleCity` title-cases for
// display and the key lowercases, so a mixed-case fixture would not compare equal.
const TOWN = 'Piscat' + letters(RUN);
const LIC = `42RG${String(process.pid).padStart(5, '0')}${Math.floor(Math.random() * 900 + 100)}`;
const SURNAME = 'Kessler' + letters(process.pid);

const base = (o = {}) => appraisalXml(Object.assign({
  city: TOWN,
  appraiserName: `John Q ${SURNAME}`,
  licenseId: LIC,
  comps: [
    { seq: '1', address: `12 Elm St`, city: TOWN, state: 'NJ', zip: '08854',
      price: 415000, saleDate: '2026-04-10', gla: 1480, beds: 3, baths: '2.1',
      condition: 'C3', quality: 'Q4', proximity: '0.34 miles', adjusted: 421000, yearBuilt: 1958 },
    { seq: '2', address: `18 Oak Ave`, city: TOWN, state: 'NJ', zip: '08854',
      price: 432500, saleDate: '2026-03-02', gla: 1610, beds: 4, baths: '2.0',
      condition: 'C4', quality: 'Q4', proximity: '0.61 miles', adjusted: 425500, yearBuilt: 1971 },
  ],
}, o));

const propByAddress = async (street) => (await db.query(
  `SELECT * FROM properties WHERE lower(street) = lower($1) AND lower(city) = lower($2)`,
  [street, TOWN])).rows[0] || null;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const D = { query: (t, p) => db.query(t, p), getClient: () => db.getClient() };
  try {
    const staff = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Research Uploader','processor',true,false,'x',0) RETURNING id`,
      [`xmlimport-${RUN}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staff, kind: 'staff', role: 'processor', tv: 0 });

    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Xml','Import',$1) RETURNING id`,
      [`xmlimport-${RUN}@test.local`])).rows[0].id;

    // =====================================================================
    // 1. AN UPLOAD WITH NO LOAN FILE LANDS
    // =====================================================================
    const xml = base();
    const r1 = await XI.importXml(D, { xml, filename: 'report-one.xml', uploadedBy: staff });
    ok(r1.ok && r1.status === 'ok', `an uploaded report is accepted (${r1.reason || 'ok'})`);
    ok(r1.comparables === 2, 'both comparables on the grid were read');
    // The subject plus its two comparables — three distinct properties.
    ok(r1.properties === 3, `the subject and both comparables became properties (got ${r1.properties})`);
    ok(r1.observations === 3, 'one observation each — what THIS report said about each property');

    const subj = await propByAddress('26 S 10th St');
    ok(!!subj, 'the subject property is in the warehouse');
    ok(subj && Number(subj.gla) === 1520 && subj.year_built === 1962 && subj.beds === 3,
      'and it carries the size, the year built and the bedroom count the report stated');
    ok(subj && subj.condition_uad === 'C3' && subj.quality_uad === 'Q4',
      'and the condition and quality ratings — the owner\'s "very important" fact');
    ok(subj && subj.subject_count === 1 && subj.comp_count === 0,
      'the subject is recorded as a subject, not as somebody\'s comparable');

    const comp1 = await propByAddress('12 Elm St');
    ok(!!comp1, 'a comparable became a property of its own');
    ok(comp1 && Number(comp1.last_sale_price) === 415000 && comp1.last_sale_date === '2026-04-01',
      'with the price it sold for and the month it settled');
    ok(comp1 && comp1.condition_uad === 'C3' && Number(comp1.gla) === 1480 && comp1.beds === 3,
      'and its condition, size and bedroom count off the grid');
    ok(comp1 && comp1.year_built === 1958,
      'and its year built, mined out of the appraiser\'s own adjustment line (no MISMO element carries it)');
    ok(comp1 && comp1.comp_count === 1 && comp1.asis_comp_count === 1,
      'and it is counted as an AS-IS comparable — which grid it was used on');

    const appraiser = (await db.query(
      `SELECT * FROM appraisers WHERE license_id = $1`, [LIC])).rows[0];
    ok(!!appraiser, 'the appraiser who signed the uploaded report is in the registry');
    ok(appraiser && appraiser.phone === '(973) 555-1212' && appraiser.email === 'john@acme.test',
      'with the contact details off the report');
    ok(appraiser && appraiser.import_count === 1 && appraiser.appraisal_count === 0,
      'an uploaded report counts as an UPLOAD, not as a loan-file appraisal — two counters, two meanings');
    ok(appraiser && appraiser.last_report_date === '2026-05-14',
      'and their date range covers it, so a prolific uploader does not read as inactive');

    const hdr = (await db.query(`SELECT * FROM research_imports WHERE id = $1`, [r1.importId])).rows[0];
    ok(hdr && hdr.status === 'ok' && hdr.observations_written === 3 && hdr.comparables_seen === 2,
      'the import is recorded with what it wrote');
    ok(hdr && hdr.subject_property_id === (subj && subj.id) && hdr.appraiser_id === (appraiser && appraiser.id),
      'and points at the property and the appraiser, so the screen can link straight to them');

    // =====================================================================
    // 1b. THE FACTS THAT USED TO BE STORED AND UNSEARCHABLE (db/413)
    // =====================================================================
    // Every one of these was already read, validated and stored on the OBSERVATION
    // and was invisible to the search, which queries `properties` alone.
    ok(subj && subj.property_rights === 'FeeSimple' && subj.lot_shape === 'Rectangular'
      && subj.lot_dimensions === '60 x 123',
    'how the property is held, and the shape and size of its land, now roll up to where the search can see them');
    ok(subj && subj.sfha === false && subj.flood_zone === 'X',
      'and the flood determination — a REAL "no", not a missing value');

    // THE SUBJECT'S VIEW WAS DROPPED ON EVERY SINGLE REPORT. A comparable's rating
    // comes off a structured element spelling it out ("Neutral"); the subject's is
    // the UAD coded triple "N;Res;" in a free-text comment, and the reader only
    // accepted the spelled-out words — so it matched nothing, ever.
    ok(subj && subj.view_rating === 'Neutral',
      `the subject's UAD view code is decoded, not discarded (got ${subj && subj.view_rating})`);
    const subjObs = (await db.query(
      `SELECT facts FROM property_observations WHERE property_id = $1 AND role = 'subject' LIMIT 1`,
      [subj.id])).rows[0];
    ok(subjObs && subjObs.facts && subjObs.facts.view_rating === 'N;Res;',
      'and the FACTORS behind it are kept in full — the code carries what the view is OF, not just how good it is');

    // A flood-zone property, read the same way, must come back as a real yes.
    const flood = await XI.importXml(D, {
      // Its own comparables on purpose: reusing the first report's would legitimately
      // raise their comp counts and break the "counted once" assertions below, which
      // are about a RE-UPLOAD of one report, not about two different reports.
      xml: base({ street: '3 Riverbank Rd', sfha: 'Y', floodZone: 'AE', viewCode: 'A;Comm;',
        effectiveDate: '2026-05-20', signedDate: '2026-05-21',
        comps: [
          { seq: '1', address: '4 Riverbank Rd', city: TOWN, state: 'NJ', zip: '08854',
            price: 380000, saleDate: '2026-04-02', gla: 1400, beds: 3, baths: '2.0',
            condition: 'C4', quality: 'Q4', yearBuilt: 1965 },
        ] }),
      filename: 'flood.xml', uploadedBy: staff,
    });
    ok(flood.ok, 'a second report lands');
    const floodProp = await propByAddress('3 Riverbank Rd');
    ok(floodProp && floodProp.sfha === true && floodProp.flood_zone === 'AE',
      'a property IN a flood zone is recorded as such, so "show me the flood-zone properties" is now a real question');
    ok(floodProp && floodProp.view_rating === 'Adverse',
      'and an adverse view decodes too');

    // The three-state rule: asking for neither must return both, and a property
    // nobody has said either way about must never be answered as a "no".
    const S = require('../src/lib/research/search');
    const yes = await S.searchProperties(db, { city: TOWN, sfha: '1', limit: 50 });
    const no = await S.searchProperties(db, { city: TOWN, sfha: '0', limit: 50 });
    ok(yes.rows.some((r) => r.street === '3 Riverbank Rd') && !yes.rows.some((r) => r.street === '26 S 10th St'),
      'the flood-zone filter finds the flood-zone property and only it');
    ok(no.rows.some((r) => r.street === '26 S 10th St') && !no.rows.some((r) => r.street === '3 Riverbank Rd'),
      'and asking for NOT in a flood zone finds the other one');
    const either = await S.searchProperties(db, { city: TOWN, limit: 50 });
    ok(either.total > yes.total + no.total - 1 && either.total >= yes.total,
      'while asking for neither returns everything, including the properties no report has said either way about');

    // =====================================================================
    // 2. IT NEVER TOUCHES A LOAN FILE
    // =====================================================================
    const appraisalsAfter = (await db.query(
      // Scoped to THIS run's appraiser licence — the fixture address is shared
      // across runs, and a previous run's section-4 import legitimately leaves one.
      `SELECT count(*)::int n FROM appraisals WHERE license_id = $1`, [LIC])).rows[0].n;
    ok(appraisalsAfter === 0,
      'AN UPLOAD CREATES NO APPRAISAL ROW — it cannot reach a loan file, a condition or a finding');

    // =====================================================================
    // 3. IDEMPOTENT — the same file twice is ONE report
    // =====================================================================
    const r2 = await XI.importXml(D, { xml, filename: 'report-one-again.xml', uploadedBy: staff });
    ok(r2.ok && r2.importId === r1.importId,
      'THE SAME FILE UPLOADED AGAIN REFRESHES ITS OWN RECORD — it is keyed on the file\'s contents');
    const comp1b = await propByAddress('12 Elm St');
    ok(comp1b && comp1b.comp_count === 1,
      'and the comparable is still counted ONCE — a re-upload never doubles a comp count');
    const obsCount = (await db.query(
      `SELECT count(*)::int n FROM property_observations WHERE import_id = $1`, [r1.importId])).rows[0].n;
    ok(obsCount === 3, 'and there are still exactly three observations, not six');

    // =====================================================================
    // 4. THE TWO DOORS RECONCILE — the loan file's copy wins
    // =====================================================================
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, loan_type)
       VALUES ($1,$2,'rtl') RETURNING id`,
      [borrower, JSON.stringify({ line1: '26 S 10th St', city: TOWN, state: 'NJ' })])).rows[0].id;
    const imp = await importAppraisal(D, { applicationId: appId, xml });
    ok(imp.ok, 'the SAME report imports onto a loan file the normal way');

    // THIS IS ALSO THE CI COVERAGE FOR THE SHARED ROW-SHAPING. `appraisalRowFrom`
    // and `comparableRowFrom` were factored out of this importer so the upload door
    // could reuse them; the appraisal suites that would normally guard the loan-file
    // importer all SKIP without the real corpus, which is not in the repository. So
    // the loan-file path is asserted here, on the synthetic report, rather than
    // being left unproven on every deploy.
    const stored = (await db.query(
      `SELECT form_type, subject_address, subject_city, gla, beds, year_built,
              condition_uad, quality_uad, appraiser_name, license_id, effective_date,
              as_is_value, lot_area
         FROM appraisals WHERE id = $1`, [imp.appraisalId])).rows[0];
    ok(stored && stored.subject_address === '26 S 10th St' && stored.form_type === 'FNM1004'
      // `year_built` is a TEXT column on appraisals (the parser keeps it as the
      // digits it read); compare it as a number so the assertion says what it means.
      && Number(stored.gla) === 1520 && stored.beds === 3 && Number(stored.year_built) === 1962
      && stored.condition_uad === 'C3' && stored.quality_uad === 'Q4'
      && stored.license_id === LIC && stored.effective_date === '2026-05-14'
      && Number(stored.as_is_value) === 430000,
    'the appraisal row carries every fact the parser read — the shared shaping is unchanged');
    const storedComps = (await db.query(
      `SELECT seq, address, sale_price, adjusted_price, gla, sale_date, condition_uad,
              beds, baths, days_on_market, gross_adj_pct, adjustments, comp_set
         FROM appraisal_comparables WHERE appraisal_id = $1 AND is_subject = false ORDER BY seq`,
      [imp.appraisalId])).rows;
    ok(storedComps.length === 2, 'both comparables are stored against the file');
    ok(storedComps[0] && storedComps[0].address === '12 Elm St'
      && Number(storedComps[0].sale_price) === 415000 && Number(storedComps[0].adjusted_price) === 421000
      && Number(storedComps[0].gla) === 1480 && storedComps[0].condition_uad === 'C3'
      && storedComps[0].beds === 3 && storedComps[0].baths === '2.1'
      && storedComps[0].days_on_market === '21'
      && Array.isArray(storedComps[0].adjustments) && storedComps[0].adjustments.length > 0,
    'with the whole grid line — price, adjusted price, size, condition, rooms, days on market and the adjustments');
    ok((await db.query(`SELECT year_built, living_area_sqft FROM applications WHERE id=$1`, [appId])).rows[0].year_built === 1962,
      'and the import still fills the loan file\'s own facts from the report');

    await ingest.ingestAppraisal(D, imp.appraisalId);

    const hdr2 = (await db.query(`SELECT * FROM research_imports WHERE id = $1`, [r1.importId])).rows[0];
    ok(hdr2 && hdr2.status === 'skipped' && hdr2.appraisal_id === imp.appraisalId,
      'THE UPLOADED COPY IS RETIRED and points at the loan file\'s copy, which has the photographs');
    const stillMine = (await db.query(
      `SELECT count(*)::int n FROM property_observations WHERE import_id = $1`, [r1.importId])).rows[0].n;
    ok(stillMine === 0, 'and its observations are gone');
    const comp1c = await propByAddress('12 Elm St');
    ok(comp1c && comp1c.comp_count === 1,
      'SO THE COMPARABLE IS STILL COUNTED ONCE — one report is one report, whichever door it came through');
    ok(comp1c && Number(comp1c.last_sale_price) === 415000,
      'and the sale it taught us survives the retirement — a sale still happened');

    // =====================================================================
    // 5. AND THE OTHER WAY ROUND — an upload of a report already on a file
    // =====================================================================
    const r3 = await XI.importXml(D, { xml: base({ apn: 'other' }), filename: 'dup.xml', uploadedBy: staff });
    ok(r3.status === 'skipped' && r3.appraisalId === imp.appraisalId,
      'uploading a report a loan file already carries stands down and says where it lives');
    ok(/already in the database/i.test(r3.reason || ''),
      'in words a person can read, not a code');

    // =====================================================================
    // 6. NOTHING IS GUESSED
    // =====================================================================
    const bad = await XI.importXml(D, { xml: '<html><body>not an appraisal</body></html>', filename: 'wrong.xml', uploadedBy: staff });
    ok(!bad.ok && bad.status === 'error' && bad.reason,
      'a file that is not an appraisal is refused with a reason');
    const badRow = (await db.query(`SELECT * FROM research_imports WHERE id = $1`, [bad.importId])).rows[0];
    ok(badRow && badRow.status === 'error' && badRow.error,
      'and the refusal is recorded, so nothing disappears silently');

    const emptyR = await XI.importXml(D, { xml: '   ', filename: 'empty.xml', uploadedBy: staff });
    ok(!emptyR.ok && /empty/i.test(emptyR.reason || ''), 'an empty file says so');

    // A comparable with no house number is not an address — it must be skipped and counted.
    const skipXml = base({
      street: '99 Cedar Ct',
      comps: [
        { seq: '1', address: 'Elm Street', city: TOWN, state: 'NJ', price: 400000,
          saleDate: '2026-04-10', gla: 1400, beds: 3, baths: '2.0', condition: 'C3', quality: 'Q4' },
        { seq: '2', address: '44 Spruce Way', city: TOWN, state: 'NJ', price: 405000,
          saleDate: '2026-04-11', gla: 1450, beds: 3, baths: '2.0', condition: 'C3', quality: 'Q4' },
      ],
    });
    const r4 = await XI.importXml(D, { xml: skipXml, filename: 'skip.xml', uploadedBy: staff });
    ok(r4.ok && r4.skipped.length === 1,
      'a comparable whose address has no house number is SKIPPED, never stored under an invented key');
    ok(r4.skipped[0] && /house number/i.test(r4.skipped[0].why || ''),
      'and the reason says what was missing');
    ok(r4.observations === 2, 'the rest of the report still lands — one bad line does not lose a report');

    // =====================================================================
    // 7. THE ROUTES
    // =====================================================================
    const anon = await call(server, 'POST', '/api/research/imports', null, { xml: base({ street: '5 Anon Rd' }) });
    ok(anon.status === 401, 'the upload door is not open to the world');

    const single = await call(server, 'POST', '/api/research/imports', token,
      { xml: base({ street: '77 Poplar Dr', effectiveDate: '2026-06-02', signedDate: '2026-06-03' }),
        filename: 'poplar.xml' });
    ok(single.status === 200 && single.body.summary.ok === 1,
      `a staff user uploads one file over HTTP (${single.status})`);
    ok(single.body.results[0].subjectAddress === '77 Poplar Dr',
      'and the answer names the property that landed');

    const bulk = await call(server, 'POST', '/api/research/imports', token, {
      files: [
        { filename: 'a.xml', xml: base({ street: '9 Aspen Ct', effectiveDate: '2026-06-04', signedDate: '2026-06-05' }) },
        { filename: 'b.xml', xml: base({ street: '11 Aspen Ct', effectiveDate: '2026-06-06', signedDate: '2026-06-07' }) },
        { filename: 'c.xml', xml: 'nonsense' },
      ],
    });
    ok(bulk.status === 200 && bulk.body.summary.total === 3 && bulk.body.summary.ok === 2 && bulk.body.summary.failed === 1,
      `a bulk upload reports each file separately (${JSON.stringify(bulk.body && bulk.body.summary)})`);
    ok(bulk.body.results[2] && bulk.body.results[2].reason,
      'ONE BAD FILE DOES NOT END THE UPLOAD — it is named and stepped over');

    const list = await call(server, 'GET', '/api/research/imports?limit=100', token);
    ok(list.status === 200 && Array.isArray(list.body.rows) && list.body.rows.length > 0,
      'the imports are listed');
    ok(list.body.rows.some((x) => x.filename === 'poplar.xml'),
      'including the one just uploaded');
    ok(list.body.rows.some((x) => x.status === 'error'),
      'and the failures are listed too, not hidden');

    console.log(`test-research-xml-import-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.log('FAIL threw:', e && e.stack || e);
    console.log(`test-research-xml-import-db: ${pass} passed, ${fail} failed`);
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fail ? 1 : 0);
})();
