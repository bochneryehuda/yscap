/**
 * EVERY COMPARABLE ON THE APPRAISAL TAB STATES WHAT KIND OF BUILDING IT IS AND
 * HOW MANY DOORS IT HAS — against a real database and the real HTTP routes.
 *
 * The owner's first requirement for the research build is that no comparable can
 * appear anywhere in the system without those two facts. The appraisal tab — the
 * screen an underwriter actually reviews the appraiser's own comps on — showed
 * neither. THREE places can answer: the comparable row itself (populated for 769
 * of 769 real comparables by db/430-432), this report's observation in the
 * warehouse, and the property roll-up across every report that has ever
 * described that address.
 *
 * What this pins:
 *   1. THE ROW'S OWN ANSWER IS NEVER DISCARDED. The first cut nulled it and
 *      re-derived from the warehouse, on a premise about the schema that was
 *      false — so two real comparables at `212-1/2 Rancocas Rd`, whose house
 *      number `propertyKey` cannot parse, rendered "type not stated · units not
 *      stated" in red while the appraiser had written "2 units" on the grid.
 *   2. THE BEST-SOURCED ANSWER WINS, on the ingest's OWN `identityRank`: a
 *      measurement beats a grid statement beats a design-style reading beats a
 *      FORM inference. 409 of 769 real comparables get both facts from the form
 *      alone, so without this a genuinely counted six-family is re-labelled a
 *      house the moment it appears as a comparable on a 1004.
 *   3. THE PAIR MOVES TOGETHER. A count from one source beside a type from
 *      another lands "3 units · SFR (1 unit)" on one row — the self-contradiction
 *      the roll-up has its own rule to prevent.
 *   4. NO RAW DATABASE KEY REACHES A SCREEN. `properties.property_type` holds two
 *      vocabularies (a subject observation writes `multi_2_4`, a comparable
 *      writes `Multi 2–4`) and 130 of 955 real rows hold the key.
 *   5. AN UNKNOWN STAYS UNKNOWN — never guessed, and in particular NEVER
 *      inherited from the report's subject.
 *   6. BOTH DOORS — staff and borrower. The borrower's copy carries the two
 *      property facts and none of our internal bookkeeping.
 *   7. A WAREHOUSE FAILURE DEGRADES TO THE ROW, NOT TO "NOT STATED". The research
 *      ingest is fire-and-forget after an import and drains the back book 400
 *      reports per boot, so "the warehouse has not caught up yet" is the ordinary
 *      case, not the exotic one.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-comp-identity-db (no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const CI = require('../src/lib/research/comp-identity');
const app = require('../src/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const tag = `ci${process.pid}${Math.floor(Math.random() * 1e5)}`;

function call(server, method, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: token ? { authorization: `Bearer ${token}` } : {} },
    (res) => { let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { raw: b }; }
        resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject);
    r.end();
  });
}

// One property in the warehouse, with the roll-up it would have after however
// many reports have described it.
async function property(street, opts = {}) {
  return (await db.query(
    `INSERT INTO properties (address_key, display_address, street, city, state, zip,
       property_type, units, units_basis, observation_count)
     VALUES ($1,$2,$3,'Identitytown','NJ','07002',$4,$5,$6,$7) RETURNING id`,
    [`nj|identitytown|${street.toLowerCase()}|${tag}`, `${street} ${tag}`, street,
      opts.type || null, opts.units == null ? null : opts.units,
      opts.basis === undefined ? null : opts.basis, opts.observations || 1])).rows[0].id;
}

(async () => {
  let server, out = {};
  try {
    const bor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Comp','Identity',$1) RETURNING id`,
      [`${tag}@example.com`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, status, purchase_price, as_is_value, submitted_at)
       VALUES ($1,'underwriting',400000,400000,'2026-07-01') RETURNING id`, [bor])).rows[0].id;
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Comp Identity','super_admin',true,false,'x',0) RETURNING id`,
      [`s${tag}@t.test`])).rows[0].id;
    const staffToken = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // A 1025: the SUBJECT is a three-family. Nothing below may inherit that.
    const apprId = (await db.query(
      `INSERT INTO appraisals (application_id, form_type, property_type, units, as_is_value, imported_at, superseded)
       VALUES ($1,'FNM1025','Multi 2–4',3,400000,now(),false) RETURNING id`, [appId])).rows[0].id;

    // EVERY REAL COMPARABLE CARRIES BOTH FACTS AND ITS PROVENANCE (db/430-432):
    // 769 of 769 in the corpus carry a property type, 768 a unit count, 769 an
    // identity basis. The first version of this test inserted them blank, which
    // is a world that cannot occur — and that is exactly why it did not catch
    // the module discarding what the row already states.
    const comp = async (seq, street, price, own = {}) => (await db.query(
      `INSERT INTO appraisal_comparables (appraisal_id, is_subject, seq, address, city, state,
         sale_price, comp_set, property_type, units, identity_basis)
       VALUES ($1,false,$2,$3,'Identitytown','NJ',$4,'as_is',$5,$6,$7) RETURNING id`,
      [apprId, seq, `${street} ${tag}`, price,
        own.type === undefined ? null : own.type,
        own.units === undefined ? null : own.units,
        own.basis === undefined ? null : own.basis])).rows[0].id;
    const subjectRow = (await db.query(
      `INSERT INTO appraisal_comparables (appraisal_id, is_subject, seq, address, city, state)
       VALUES ($1,true,'0',$2,'Identitytown','NJ') RETURNING id`, [apprId, `1 Subject Way ${tag}`])).rows[0].id;

    // 1 — the appraiser wrote it on the grid.
    const cGrid = await comp('1', '10 Grid St', 510000, { type: 'Multi 2–4', units: 3, basis: 'grid' });
    const pGrid = await property('10 Grid St', { type: 'Multi 2–4', units: 3, basis: 'grid', observations: 2 });
    // 2 — the report FORM proves it (a 1004's grid only compares one-unit dwellings).
    const cForm = await comp('2', '20 Form Ave', 480000, { type: 'SFR (1 unit)', units: 1, basis: 'form' });
    const pForm = await property('20 Form Ave', { type: 'SFR (1 unit)', units: 1, basis: 'form' });
    // 3 — this report says nothing; another report described the same address.
    // THE ROW SAYS ONE UNIT BECAUSE THE FORM SAID SO; the warehouse holds a
    // MEASURED count from when the same address was some report's subject. The
    // measurement has to win, or a genuinely counted six-family is re-labelled a
    // house the moment it appears as a comparable on a 1004.
    const cRecords = await comp('3', '30 Records Rd', 495000, { type: 'SFR (1 unit)', units: 1, basis: 'form' });
    // A RAW CANONICAL KEY, which is what a SUBJECT observation writes and what
    // 130 of 955 real property rows hold. It must never reach a screen.
    const pRecords = await property('30 Records Rd', { type: 'multi_5_plus', units: 6, basis: 'subject', observations: 4 });
    // 4 — this report states a COUNT only; the roll-up states both. The pair must
    //     come from ONE source, so the roll-up wins whole.
    const cPartial = await comp('4', '40 Partial Pl', 470000, { type: null, units: 2, basis: 'grid' });
    const pPartial = await property('40 Partial Pl', { type: 'Multi 2–4', units: 4, basis: 'grid' });
    // 5 — nobody has ever established it. It must SAY so, and must not become the
    //     subject's three units.
    // A GRID-STATED COUNT WITH NO TYPE, against a warehouse that states both from
    // the report FORM alone. The measurement has to win the count.
    const cCountOnly = await comp('7', '70 CountOnly Rd', 445000, { type: null, units: 3, basis: 'grid' });
    const pCountOnly = await property('70 CountOnly Rd', { type: 'SFR (1 unit)', units: 1, basis: 'form' });
    const cUnknown = await comp('5', '50 Unknown Ct', 460000);
    // THE ROW STATES BOTH AND THE WAREHOUSE HAS NEVER SEEN IT — the shape of the
    // two real `212-1/2 Rancocas Rd` comparables, whose house number
    // `propertyKey` cannot parse. They rendered "type not stated · units not
    // stated" in red while the appraiser had written "2 units" on the grid.
    const cUnkeyed = await comp('6', '60 Unkeyed Ln', 455000, { type: 'Multi 2–4', units: 2, basis: 'grid' });
    const pUnknown = await property('50 Unknown Ct', {});

    const obs = async (compId, propId, o) => db.query(
      `INSERT INTO property_observations (property_id, appraisal_id, application_id, comparable_id,
         role, comp_seq, observed_on, address_as_stated, property_type, units, identity_basis)
       VALUES ($1,$2,$3,$4,'comparable',$5,CURRENT_DATE,$6,$7,$8,$9)`,
      [propId, apprId, appId, compId, o.seq, o.address, o.type || null,
        o.units == null ? null : o.units, o.basis || null]);
    await obs(cGrid, pGrid, { seq: '1', address: '10 Grid St', type: 'Multi 2–4', units: 3, basis: 'grid' });
    await obs(cForm, pForm, { seq: '2', address: '20 Form Ave', type: 'SFR (1 unit)', units: 1, basis: 'form' });
    await obs(cRecords, pRecords, { seq: '3', address: '30 Records Rd' });
    await obs(cPartial, pPartial, { seq: '4', address: '40 Partial Pl', units: 2, basis: 'grid' });
    await obs(cUnknown, pUnknown, { seq: '5', address: '50 Unknown Ct' });
    await obs(cCountOnly, pCountOnly, { seq: '7', address: '70 CountOnly Rd', units: 3, basis: 'grid' });

    // ---- A. THE DECISION ITSELF ----------------------------------------
    const rows = (await db.query(
      `SELECT * FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY seq`, [apprId])).rows;
    const appr = (await db.query(`SELECT * FROM appraisals WHERE id=$1`, [apprId])).rows[0];
    const got = await CI.attachCompIdentity(rows, { db, appraisal: appr });
    const by = (id) => got.find((r) => r.id === id) || {};

    ok(by(cGrid).property_type === 'Multi 2–4' && Number(by(cGrid).units) === 3,
      'a comp the appraiser described on the grid states both facts');
    ok(by(cGrid).identity_source === 'grid',
      'and says the appraiser wrote it — not that we worked it out');
    ok(Number(by(cGrid).identity_observations) === 2 && by(cGrid).property_id === pGrid,
      'it carries the warehouse link, so a reviewer can reach every other report on that address');

    ok(by(cForm).identity_source === 'form' && Number(by(cForm).units) === 1,
      'a one-unit comp proven by the report FORM is distinguishable from one the appraiser wrote down');

    // THE MEASUREMENT BEATS THE INFERENCE. The row says 1 unit because a 1004
    // says so; the warehouse counted 6 when the same address was a subject.
    ok(Number(by(cRecords).units) === 6,
      'a MEASURED count in our records beats a unit count the report form merely implied');
    ok(by(cRecords).identity_source === 'records',
      'and it says the answer did NOT come from this report');
    ok(by(cRecords).property_type === 'Multi 5+',
      'and the type is shown in the portal\'s own words — never the raw database key');

    ok(by(cPartial).property_type === 'Multi 2–4' && Number(by(cPartial).units) === 4,
      'a source stating BOTH breaks a tie against one stating only a count');
    ok(by(cPartial).identity_source === 'records' && Number(by(cPartial).units) !== 2,
      'so a row can never read "2 units" beside a type describing a different building');

    // …BUT THE RANK DECIDES FIRST, AND A PICK NEVER DELETES WHAT THE ROW SAID.
    // Preferring a complete answer BEFORE the rank let a form inference (rank 1)
    // stating both beat a grid statement (rank 3) stating only a count — and then
    // deleted that count and reddened the cell, which is the exact class the
    // module's header declares impossible.
    ok(Number(by(cCountOnly).units) === 3,
      'a GRID-stated count survives a form-inferred pair that would have overwritten it');
    ok(by(cCountOnly).identity_source === 'grid' && by(cCountOnly).property_type == null,
      'and the TYPE stays unstated rather than being borrowed from the reading that lost — '
      + '"3 units" beside "SFR (1 unit)" is the self-contradiction the pair rule exists to stop');

    ok(by(cUnknown).property_type == null && by(cUnknown).units == null,
      'a comp nobody has established stays unknown');
    ok(by(cUnknown).identity_source == null,
      'and carries no source, so the screen says "not stated" rather than showing a blank');
    // The only comps that may read 3 units are the two that STATE three: the
    // grid-described one and the count-only one. Nothing else may pick up the
    // subject's three.
    ok(!got.some((r) => !r.is_subject && Number(r.units) === 3
      && r.id !== cGrid && r.id !== cCountOnly),
    'NOTHING is inherited from the subject — a 3-unit subject does not make its comps 3-unit');

    // THE ROW'S OWN ANSWER SURVIVES A WAREHOUSE THAT HAS NEVER SEEN IT. This is
    // the `212-1/2 Rancocas Rd` case, and it is what the first cut got wrong.
    ok(by(cUnkeyed).property_type === 'Multi 2–4' && Number(by(cUnkeyed).units) === 2,
      'a comparable the warehouse could not key still states what the appraiser wrote on the grid');
    ok(by(cUnkeyed).identity_source === 'grid',
      'and still says the appraiser wrote it');

    const subj = by(subjectRow);
    ok(subj.property_type === 'Multi 2–4' && Number(subj.units) === 3 && subj.identity_source === 'subject',
      'the subject row states what the report itself says about the subject');

    // ---- B. IT DEGRADES TO THE ROW, NOT TO NOTHING ---------------------
    const broken = { query: async () => { throw new Error('warehouse down'); } };
    const degraded = await CI.attachCompIdentity(rows, { db: broken, appraisal: appr });
    const dg = (id) => degraded.find((r) => r.id === id) || {};
    ok(Array.isArray(degraded) && degraded.length === rows.length,
      'an unreachable warehouse still renders the appraisal tab');
    ok(dg(cGrid).property_type === 'Multi 2–4' && Number(dg(cGrid).units) === 3,
      'and every comparable still states what its own row says — one failed read must never blank a whole grid');
    ok(dg(cUnknown).property_type == null && dg(cUnknown).identity_source == null,
      'while a row that genuinely states neither still says so');
    ok((await CI.attachCompIdentity(null, { db })).length === 0, 'no comps at all is not an error');
    // The rows handed in are the caller's — a route re-uses them for the implied-value
    // read and the collateral score, so mutating them would change those numbers.
    ok(rows.every((r) => !('identity_source' in r)), 'the caller\'s own rows are not mutated');

    // ---- C. BOTH DOORS -------------------------------------------------
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    const staff = await call(server, 'GET', `/api/appraisal/${appId}`, staffToken);
    ok(staff.status === 200, 'the staff appraisal tab answers');
    const sc = (staff.body.comparables || []).find((c) => c.id === cRecords) || {};
    ok(sc.property_type === 'Multi 5+' && Number(sc.units) === 6 && sc.identity_source === 'records',
      'and every comparable on it states its type and unit count');

    // A borrower authenticates against `borrower_auth`, not `borrowers` — without
    // the login row every request is refused as a revoked session.
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version)
                    VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [bor]);
    const borToken = C.signJwt({ sub: bor, kind: 'borrower', tv: 0 });
    const b = await call(server, 'GET', `/api/borrower/applications/${appId}/appraisal`, borToken);
    ok(b.status === 200, 'the borrower property report answers');
    const bc = (b.body.comparables || []).find((c) => c.id === cRecords) || {};
    ok(bc.property_type === 'Multi 5+' && Number(bc.units) === 6,
      'the borrower sees the same two property facts — a fix on one surface is not a fix');
    ok(!('property_id' in bc) && !('identity_observations' in bc),
      'but not our warehouse id, and not how many of our reports describe that address');

    out = { pass, fail };
  } catch (e) {
    console.log('FAIL threw: ' + (e && e.stack || e));
    fail++;
  } finally {
    if (server) server.close();
    try {
      await db.query(`DELETE FROM property_observations WHERE application_id IN (SELECT id FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email=$1))`, [`${tag}@example.com`]);
      await db.query(`DELETE FROM properties WHERE address_key LIKE $1`, [`%|${tag}`]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email=$1)`, [`${tag}@example.com`]);
      await db.query(`DELETE FROM borrowers WHERE email=$1`, [`${tag}@example.com`]);
      await db.query(`DELETE FROM staff_users WHERE email=$1`, [`s${tag}@t.test`]);
    } catch (_) { /* cleanup is best-effort */ }
    await db.pool.end().catch(() => {});
  }
  console.log(`test-appraisal-comp-identity-db: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
  process.exit(fail ? 1 : 0);
})();
