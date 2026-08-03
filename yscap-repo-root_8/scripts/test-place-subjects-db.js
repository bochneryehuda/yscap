/**
 * PLACING THE PROPERTIES WE LENT ON — against a real database.
 *
 * Every one of the 132 subject properties in the warehouse is unplaced, because
 * appraisers give coordinates for their COMPARABLES and not for the subject. The
 * arithmetic that fixes that is proved in `test-trilaterate-pure.js`; this proves
 * the part that touches the database, which is the part a pure test cannot see.
 *
 * THAT DISTINCTION IS THE WHOLE REASON THIS FILE EXISTS. `placeSubjectsOnce`
 * catches its own errors so a placement can never break a boot — which is exactly
 * the shape that let `buildWholeLoanContext` run dark for weeks on three wrong
 * column names, reporting a clean null every single time. A mocked `db.query`
 * would agree with any column name you typed. So every assertion below runs
 * against real tables.
 *
 * What this pins:
 *   1. IT PLACES, and lands on the real spot.
 *   2. IT STAMPS THE ESTIMATE AS AN ESTIMATE — `geo_source='comp_trilateration'`,
 *      and `geo_precision` gets its OWN token rather than the geocoders'
 *      'address', so nothing can read a derived position as a measured one.
 *   3. IT ONLY EVER FILLS A BLANK — a property carrying the appraiser's own
 *      coordinate, or a real geocoder's, is never touched.
 *   4. IT REFUSES RATHER THAN GUESSES, and the refusal is counted with a reason.
 *   5. THE BEST-FITTING REPORT WINS when a house was the subject of two.
 *   6. THE LIMIT IS ON PROPERTIES, NOT ON (property, report) PAIRS — bounding by
 *      pairs can hand a property only half its reports, place it from the worse
 *      one, and then never look again, because the write is fill-only.
 *   7. IT IS SELF-DRAINING — a second pass places nothing new.
 *   8. AN ERROR IS REPORTED, NOT SWALLOWED.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

if (!process.env.DATABASE_URL) { console.log('SKIP test-place-subjects-db (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const PS = require('../src/lib/research/place-subjects');
const { _internals } = require('../src/lib/research/trilaterate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const tag = `ps${process.pid}${Math.floor(Math.random() * 1e5)}`;

const MI = _internals.MI_PER_DEG;
const rad = (d) => (d * Math.PI) / 180;
/** A point `dy` miles north and `dx` miles east of (lat,lng). */
const at = (lat, lng, dy, dx) => ({ lat: lat + dy / MI, lng: lng + dx / (MI * Math.cos(rad(lat))) });
const distMi = (a, b) => Math.hypot((b.lng - a.lng) * MI * Math.cos(rad(a.lat)), (b.lat - a.lat) * MI);
/** A grid states its distance to a hundredth of a mile — so the fixture does too. */
const stated = (t, p) => (Math.round(distMi(t, p) / 0.01) * 0.01).toFixed(2);

(async () => {
  const made = { props: [], apprs: [], apps: [], bors: [] };
  try {
    const bor = (await db.query(
      'INSERT INTO borrowers (first_name,last_name,email) VALUES (\'Place\',\'Subjects\',$1) RETURNING id',
      [`${tag}@example.com`])).rows[0].id;
    made.bors.push(bor);
    // ONE CURRENT APPRAISAL PER FILE (`uq_appraisals_one_current`), so every
    // report in this fixture gets its own file — which is also the real shape:
    // two reports about one house are two loans on it.
    const newFile = async () => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, status, purchase_price, as_is_value, submitted_at)
         VALUES ($1,'underwriting',400000,400000,'2026-07-01') RETURNING id`, [bor])).rows[0].id;
      made.apps.push(id);
      return id;
    };

    /** A warehouse property with no position of any kind. */
    const property = async (label, coords = null) => {
      const id = (await db.query(
        `INSERT INTO properties (address_key, display_address, street, city, state, latitude, longitude)
         VALUES ($1,$2,$3,'Placetown','NJ',$4,$5) RETURNING id`,
        [`${tag}:${label}`, `${label} ${tag}`, label,
          coords ? coords.lat : null, coords ? coords.lng : null])).rows[0].id;
      made.props.push(id);
      return id;
    };
    /** A report, with this property as its SUBJECT and comparables around it. */
    const report = async (propertyId, truth, offsets) => {
      const apprId = (await db.query(
        `INSERT INTO appraisals (application_id, form_type, imported_at, superseded)
         VALUES ($1,'FNM1004',now(),false) RETURNING id`, [await newFile()])).rows[0].id;
      made.apprs.push(apprId);
      await db.query(
        'INSERT INTO property_observations (property_id, appraisal_id, role) VALUES ($1,$2,\'subject\')',
        [propertyId, apprId]);
      let seq = 0;
      for (const [dy, dx] of offsets) {
        seq++;
        const p = at(truth.lat, truth.lng, dy, dx);
        await db.query(
          `INSERT INTO appraisal_comparables (appraisal_id, is_subject, seq, address, city, state,
             latitude, longitude, proximity)
           VALUES ($1,false,$2,$3,'Placetown','NJ',$4,$5,$6)`,
          [apprId, String(seq), `${seq} Comp St ${tag}`, p.lat, p.lng, `${stated(truth, p)} miles SW`]);
      }
      return apprId;
    };
    const readGeo = async (id) => (await db.query(
      'SELECT geo_latitude, geo_longitude, geo_source, geo_precision, latitude FROM properties WHERE id=$1',
      [id])).rows[0];

    // ── 1. IT PLACES, AND LANDS ON THE REAL SPOT ────────────────────────────
    const TRUTH = { lat: 40.7128, lng: -74.006 };
    const pGood = await property('1 Findable Way');
    await report(pGood, TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]]);

    // ── 3. A PROPERTY THAT ALREADY HAS A COORDINATE ─────────────────────────
    // Its comparables would resolve perfectly; the point is that we never look.
    const APPRAISERS_OWN = { lat: 41.5, lng: -73.5 };
    const pHeld = await property('2 Already Placed', APPRAISERS_OWN);
    await report(pHeld, { lat: 41.0, lng: -74.5 }, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]]);

    // ── 4. A REPORT THAT CANNOT RESOLVE ─────────────────────────────────────
    // Two comparables: two circles meet at two points, and nothing chooses.
    const pThin = await property('3 Two Circles');
    await report(pThin, { lat: 40.9, lng: -74.2 }, [[0.5, 0.2], [-0.4, 0.6]]);

    // ── 5/6. A HOUSE WITH TWO REPORTS — THE BETTER FIT WINS ─────────────────
    // The FIRST report's comparables are nearly in a line but just resolvable, so
    // it fits loosely; the SECOND surrounds the house and fits tightly. Whichever
    // order the reports come back in, the tight one must be the one written.
    const TWO = { lat: 40.3, lng: -74.7 };
    const pTwo = await property('4 Two Reports');
    await report(pTwo, TWO, [[0.9, 0.42], [0.3, 0.36], [-0.3, 0.44], [-0.9, 0.38]]);
    await report(pTwo, TWO, [[0.6, 0.5], [-0.5, 0.7], [0.2, -0.8], [-0.7, -0.4]]);

    const r1 = await PS.placeSubjectsOnce(db, { limit: 1000 });
    ok(!r1.error, `the pass ran without error${r1.error ? ` — ${r1.error}` : ''}`);

    const gGood = await readGeo(pGood);
    ok(gGood.geo_latitude != null && gGood.geo_longitude != null,
      'a subject with three comparables around it is placed');
    const offFt = gGood.geo_latitude == null ? Infinity
      : distMi(TRUTH, { lat: Number(gGood.geo_latitude), lng: Number(gGood.geo_longitude) }) * 5280;
    ok(offFt < 200, `and it lands on the real place (${offFt.toFixed(0)} feet off)`);

    // 2 — AN ESTIMATE IS STAMPED AS AN ESTIMATE.
    ok(gGood.geo_source === PS.SOURCE,
      'the position is stamped as derived from the comparables, never left to look measured');
    ok(gGood.geo_precision === PS.PRECISION && PS.PRECISION !== 'address',
      '`geo_precision` gets its OWN token — the geocoders write \'address\', and a derived '
      + 'position must never be readable as one');
    ok(gGood.latitude === null,
      'and the appraiser\'s own coordinate column is left alone — the estimate lives in geo_*');

    // 3 — FILL-ONLY.
    const gHeld = await readGeo(pHeld);
    ok(Number(gHeld.latitude) === APPRAISERS_OWN.lat && gHeld.geo_latitude === null,
      'a property that already has a coordinate is never touched, however well its comparables fit');

    // 4 — REFUSED, NOT GUESSED, AND COUNTED.
    const gThin = await readGeo(pThin);
    ok(gThin.geo_latitude === null && gThin.geo_longitude === null,
      'two comparables place nothing — a second answer with nothing to choose between them '
      + 'is not a position');
    ok(r1.refused >= 1 && Object.keys(r1.reasons).length >= 1,
      'and the refusal is counted WITH a reason, so a silent nothing is never reported as done');
    // TALLIED BY CODE, EXPLAINED IN WORDS. Grouping on the sentence makes one
    // bucket per property (the mirror's prose names its own distance), and the
    // truncation that would fix that cuts off the half that says what to do —
    // "only 2 comparables with both a position and a stated distance" is exactly
    // 60 characters, so a 60-char key loses "two circles meet at two places".
    ok(r1.reasons.too_few && r1.reasons.too_few.count >= 1,
      'and it is tallied under a STABLE code, not under a sentence that carries its own numbers');
    ok(/two circles meet at two places/.test((r1.reasons.too_few || {}).example || ''),
      'while the words a person reads are kept WHOLE beside the code');

    // 5 — THE BETTER FIT WINS.
    const gTwo = await readGeo(pTwo);
    ok(gTwo.geo_latitude != null, 'a house with two reports is placed');
    const twoFt = gTwo.geo_latitude == null ? Infinity
      : distMi(TWO, { lat: Number(gTwo.geo_latitude), lng: Number(gTwo.geo_longitude) }) * 5280;
    ok(twoFt < 200, `and from the report that FITS BEST, not whichever came back first `
      + `(${twoFt.toFixed(0)} feet off)`);

    // 6 — THE QUEUE YIELDS EACH PROPERTY ONCE, NOT EACH (property, report) PAIR.
    //
    // THIS ASSERTION HAS TO BE ABLE TO FAIL, and three earlier attempts at it
    // could not — which is the same failure this file exists to prevent, one
    // level up. `scanned === 1` under a limit of 1 cannot tell the two apart: a
    // pair-limited query also returns one row and also scans one property.
    // Comparing a pair COUNT to a property count asserts a fact about the
    // FIXTURE, which no change to the code can falsify. And re-reading the
    // placement after an UNLIMITED pass cannot fail either, because an unlimited
    // pair-limited query still returns every one of a property's reports.
    //
    // What separates them is that a pair-counted queue hands the SAME property
    // back more than once. So: an unlimited pass must scan exactly as many rows
    // as there are unplaced properties (a pair-counted one would scan the larger
    // PAIR count), and every row it scans must be settled — placed or refused —
    // because a second visit to an already-placed property settles nothing (the
    // write is fill-only, so `rowCount` is 0 and neither counter moves).
    //
    // Both are measured against the pass's OWN predicate over the whole table,
    // so the fixture's own rows are not special-cased.
    const rOne = await PS.placeSubjectsOnce(db, { limit: 1 });
    ok(rOne.scanned === 1, 'a limit of 1 scans exactly ONE property');

    // THE TWO-REPORT PROPERTY GOES BACK IN THE QUEUE *AFTER* THAT PASS, not
    // before: a limit of 1 takes whichever property sorts first, and if that is
    // this one it is placed again and the fixture stops distinguishing anything.
    await db.query('UPDATE properties SET geo_latitude=NULL, geo_longitude=NULL, geo_source=NULL, '
      + 'geo_precision=NULL WHERE id=$1', [pTwo]);

    // MEASURED IMMEDIATELY BEFORE THE PASS THAT IS COMPARED TO IT. A refused
    // property stays unplaced and is offered again by the very next pass, so
    // summing `scanned` across two passes counts it twice and the comparison
    // fails on correct code — which is how the first cut of this assertion went.
    // Both counts run over the WHOLE table, using the pass's own predicate, so
    // rows another suite left unplaced are counted on both sides and cannot
    // skew it either way.
    const QUEUE_WHERE = `p.latitude IS NULL AND p.longitude IS NULL
        AND p.geo_latitude IS NULL AND p.geo_longitude IS NULL
        AND EXISTS (SELECT 1 FROM property_observations o
                     WHERE o.property_id = p.id AND o.role='subject' AND o.appraisal_id IS NOT NULL)`;
    const props = Number((await db.query(
      `SELECT count(*)::int n FROM properties p WHERE ${QUEUE_WHERE}`)).rows[0].n);
    const pairs = Number((await db.query(
      `SELECT count(*)::int n FROM property_observations o JOIN properties p ON p.id = o.property_id
        WHERE o.role='subject' AND o.appraisal_id IS NOT NULL AND ${QUEUE_WHERE}`)).rows[0].n);
    // The precondition, stated as a precondition rather than dressed up as a
    // result: without a property owning two reports there is nothing to detect.
    ok(pairs > props && props < 1000,
      `the fixture genuinely distinguishes the two (${pairs} pairs over ${props} properties)`);

    const rAll = await PS.placeSubjectsOnce(db, { limit: 1000 });
    ok(rAll.scanned === props,
      `the queue hands back one row per PROPERTY (${rAll.scanned} scanned for ${props} properties; `
      + `a pair-counted query would have handed back ${pairs})`);
    ok(rAll.placed + rAll.refused === rAll.scanned,
      'and every property it scanned was settled exactly once — a repeated property would be '
      + 'scanned and settle nothing, because the write is fill-only');

    // …and the property that owns TWO reports is placed from the BETTER of them,
    // which only a property-limited queue can do: a pair-limited one can hand it
    // a single report, place it from the worse fit, and — because the write is
    // fill-only — never look again.
    const gOne = await readGeo(pTwo);
    const oneFt = gOne.geo_latitude == null ? Infinity
      : distMi(TWO, { lat: Number(gOne.geo_latitude), lng: Number(gOne.geo_longitude) }) * 5280;
    ok(oneFt < 200, `and it saw BOTH of that property's reports (${oneFt.toFixed(0)} feet off)`);

    // 7 — SELF-DRAINING.
    const r2 = await PS.placeSubjectsOnce(db, { limit: 1000 });
    const gGood2 = await readGeo(pGood);
    ok(Number(gGood2.geo_latitude) === Number(gGood.geo_latitude),
      'a second pass does not move a position it already wrote');
    // A SECOND PASS FINDS NOTHING LEFT TO DO — self-draining. `typeof r2.reasons
    // === 'object'` was the assertion here and it can never fail: `reasons` is
    // initialised to `{}` on the first line of the function.
    // SELF-DRAINING, asserted on THIS test's own rows: the database is shared with
    // every other suite that ran against it, so a global `placed === 0` is not a
    // statement about this code. What is: a placed property is no longer a
    // CANDIDATE, which is what makes the queue shrink.
    const stillCandidate = Number((await db.query(
      `SELECT count(*)::int n FROM properties
        WHERE id = ANY($1::uuid[]) AND latitude IS NULL AND longitude IS NULL
          AND geo_latitude IS NULL AND geo_longitude IS NULL`, [[pGood, pTwo]])).rows[0].n);
    ok(stillCandidate === 0,
      'a placed property is no longer a candidate — every success permanently leaves the queue');

    // 8 — AN ERROR IS REPORTED, NOT SWALLOWED. This is the guard that would have
    // caught the `buildWholeLoanContext` class: a query that stops matching the
    // schema must be visible, not indistinguishable from "nothing to place".
    const broken = await PS.placeSubjectsOnce(
      { query: async () => { throw new Error('column "nope" does not exist'); } }, { limit: 5 });
    ok(broken.error && /nope/.test(broken.error),
      'a failure surfaces as `error` instead of reading as a clean, empty, successful pass');
    ok(broken.placed === 0, 'and it never claims to have placed anything');

    // The summary line says how WELL, not just how many.
    ok(/median/.test(PS.describePass(r1) || ''),
      'the boot summary reports the fit, not only the count');
    ok(PS.describePass({ placed: 0, scanned: 3, refused: 3, reasons: {}, residualsMi: [] }) === null,
      'and a pass that placed nothing says nothing rather than printing an empty boast');
  } finally {
    // Clean up in FK order.
    for (const id of made.apprs) {
      await db.query('DELETE FROM property_observations WHERE appraisal_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM appraisal_comparables WHERE appraisal_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM appraisals WHERE id=$1', [id]).catch(() => {});
    }
    for (const id of made.props) {
      await db.query('DELETE FROM property_observations WHERE property_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM properties WHERE id=$1', [id]).catch(() => {});
    }
    for (const id of made.apps) await db.query('DELETE FROM applications WHERE id=$1', [id]).catch(() => {});
    for (const id of made.bors) await db.query('DELETE FROM borrowers WHERE id=$1', [id]).catch(() => {});
  }

  console.log(fail
    ? `\ntest-place-subjects-db: ${pass} passed, ${fail} FAILED`
    : `\ntest-place-subjects-db: ${pass} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-place-subjects-db ERROR', e); process.exit(1); });
