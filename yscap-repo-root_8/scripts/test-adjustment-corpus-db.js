/**
 * THE ADJUSTMENT CORPUS (db/440).
 *
 * `property_observations.adjustments` holds every line an appraiser wrote on a
 * comparable. As jsonb it can only be read one comparable at a time; as rows it
 * is one GROUP BY, and it is the one dataset here NO DATA VENDOR HAS — real
 * adjustments, in our own markets, from reports we paid for.
 *
 * The three things this pins, each of which was a real defect or a real
 * temptation:
 *
 *  1. THE WRITE IS IDEMPOTENT UNDER CONCURRENCY. `fireResearchIngest` is called
 *     from the import, the photo pass, the comparable re-parse and the boot
 *     backfill, so two ingests of one report genuinely overlap — and
 *     delete-then-insert is not atomic against an identical concurrent
 *     operation. Measured before the fix: a report seeded through two racing
 *     ingests stored exactly DOUBLE, and every median it fed counted it twice.
 *
 *  2. A NULL AMOUNT IS NOT ZERO. A line written with no figure means the
 *     appraiser looked and adjusted nothing; a line the form never asked for is
 *     absent. Collapsing them would make every average wrong.
 *
 *  3. THE BENCHMARK REFUSES A SMALL SAMPLE, and never calls itself a rate.
 *
 * Needs a database. Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

if (!process.env.DATABASE_URL) {
  console.log('test-adjustment-corpus-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

(async () => {
  const db = require(path.join(ROOT, 'src/db'));
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  const ingest = require(path.join(ROOT, 'src/lib/research/ingest'));
  const { writeAdjustments } = ingest._internals;
  await ensureSchema();
  const q = async (t, p = []) => (await db.query(t, p)).rows;

  const pid = (await q(
    `INSERT INTO properties (address_key, display_address, state, city, zip)
     VALUES ('adjcorpus-' || gen_random_uuid(), '1 Adjustment Rd', 'NJ', 'Paterson', '07501')
     RETURNING id`))[0].id;
  const obsId = (await q(
    `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
     VALUES ($1,'comparable','2026-01-15','[]'::jsonb) RETURNING id`, [pid]))[0].id;

  const LINES = [
    { type: 'GrossLivingArea', description: '2,100 sq ft', amount: -12000 },
    { type: 'RoomCount', description: '7/3/2.0', amount: -5000 },
    // A line written with NO figure: the appraiser looked and adjusted nothing.
    { type: 'Condition', description: 'C3', amount: null },
    // Two lines of the SAME type — which is why the row is keyed on POSITION and
    // not on the line type.
    { type: 'OtherFeature', description: 'IG POOL', amount: 8000 },
    { type: 'OtherFeature', description: 'Shed', amount: 500 },
  ];
  const place = { state: 'NJ', city: 'Paterson', zip: '07501' };
  const write = () => writeAdjustments(db, { observationId: obsId, propertyId: pid, adjustments: LINES, place, on: '2026-01-15' });

  await write();
  let rows = await q('SELECT * FROM property_adjustments WHERE observation_id=$1 ORDER BY seq', [obsId]);
  ok(rows.length === 5, `all five lines are rows (${rows.length})`);
  ok(rows[3].line_type === 'OtherFeature' && rows[4].line_type === 'OtherFeature',
    'two lines of the same type both survive — keyed on position, not on type');
  ok(rows[2].amount === null, 'a line written with NO figure is stored as NULL, not as zero');
  ok(Number(rows[0].amount) === -12000 && rows[0].city === 'Paterson',
    'the amount and the market keys ride on the row, so the benchmark needs no join');

  // 1. IDEMPOTENT, AND UNDER CONCURRENCY.
  await write(); await write();
  rows = await q('SELECT id FROM property_adjustments WHERE observation_id=$1', [obsId]);
  ok(rows.length === 5, `writing three times leaves five rows, not fifteen (${rows.length})`);
  await Promise.all([write(), write(), write(), write()]);
  rows = await q('SELECT id FROM property_adjustments WHERE observation_id=$1', [obsId]);
  ok(rows.length === 5, `and FOUR CONCURRENT writes still leave five (${rows.length}) — the race that stored double`);

  // A re-read that finds FEWER lines must not leave the extra ones standing.
  await writeAdjustments(db, { observationId: obsId, propertyId: pid, adjustments: LINES.slice(0, 2), place, on: '2026-01-15' });
  rows = await q('SELECT seq FROM property_adjustments WHERE observation_id=$1 ORDER BY seq', [obsId]);
  ok(rows.length === 2, `a thinner re-read trims the extras rather than leaving them (${rows.length})`);
  await write();

  // 3. THE BENCHMARK. Seed enough of one line to clear the sample floor.
  const extra = [];
  for (let i = 0; i < 12; i++) extra.push({ type: 'BathCount', description: '2.1', amount: -(3000 + i * 250) });
  const o2 = (await q(
    `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
     VALUES ($1,'comparable','2026-02-01','[]'::jsonb) RETURNING id`, [pid]))[0].id;
  await writeAdjustments(db, { observationId: o2, propertyId: pid, adjustments: extra, place, on: '2026-02-01' });

  const b = await ingest.adjustmentBenchmark(db, { lineType: 'BathCount', city: 'Paterson', state: 'NJ', months: 6000 });
  ok(b.ok && b.n === 12, `the benchmark answers from the market's own adjustments (n=${b.n})`);
  ok(b.median != null && b.q1 != null && b.q3 != null,
    `and reports the spread, not just a point (median ${b.median}, IQR ${b.q1}..${b.q3})`);
  ok(/not a per-unit rate/.test(b.basis || ''),
    'and SAYS it is not a per-unit rate — a -$5,000 room adjustment means nothing per room without the delta');

  const few = await ingest.adjustmentBenchmark(db, { lineType: 'GrossLivingArea', city: 'Paterson', state: 'NJ', months: 6000 });
  ok(!few.ok && /too few/.test(few.reason || ''),
    `it REFUSES below the sample floor rather than answering from one number (${few.reason})`);
  const nowhere = await ingest.adjustmentBenchmark(db, { lineType: 'BathCount', city: 'Nowheresville', state: 'ZZ', months: 6000 });
  ok(!nowhere.ok, 'and refuses in a market we have never lent in');

  // A ZERO adjustment is excluded from the benchmark but KEPT as a row — "the
  // appraiser considered this and adjusted nothing" is data about the grid, and
  // averaging it in would drag every median toward zero.
  const zeroRows = await q(
    `SELECT count(*)::int n FROM property_adjustments WHERE observation_id=$1 AND amount IS NULL`, [obsId]);
  ok(zeroRows[0].n === 1, 'the no-figure line is still on the record even though no benchmark counts it');

  // 2. THE BACK-FILL reaches an observation that predates the table.
  const o3 = (await q(
    `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
     VALUES ($1,'comparable','2025-06-01',$2::jsonb) RETURNING id`,
    [pid, JSON.stringify(LINES)]))[0].id;
  const before = (await q('SELECT count(*)::int n FROM property_adjustments WHERE observation_id=$1', [o3]))[0].n;
  ok(before === 0, 'an observation stored before db/440 has no rows');
  const bf = await ingest.backfillAdjustmentRowsOnce(db, { limit: 500 });
  const after = (await q('SELECT count(*)::int n FROM property_adjustments WHERE observation_id=$1', [o3]))[0].n;
  ok(after === 5, `the back-fill builds them from the jsonb it already carries (${after}, pass ${JSON.stringify(bf)})`);
  const again = await ingest.backfillAdjustmentRowsOnce(db, { limit: 500 });
  ok(again.scanned === 0, `and it self-drains — the second pass finds nothing (scanned ${again.scanned})`);

  // -------------------------------------------------------------------------
  // WHAT AN APPRAISER ACTUALLY PAID PER SQUARE FOOT (db/441).
  //
  // `adjustmentBenchmark` above returns the DOLLAR adjustments and says plainly
  // that they are not a rate. This divides each by the size difference it was
  // made for, which is the number a person actually wants. Measured over the 152
  // real reports before it was built: 468 of 473 usable, ZERO negative, ZERO
  // above $500 — median $40/sq ft.
  // -------------------------------------------------------------------------
  {
    const { unitDeltaFor } = ingest._internals;
    // THE SIGN CONVENTION, which is the whole thing. The appraiser adjusts the
    // comparable's price TOWARD the subject, so a comp BIGGER than the subject is
    // adjusted DOWN — and amount / (subject − comp) comes out POSITIVE.
    const bigger = unitDeltaFor('GrossLivingArea', 1500, 1800);
    ok(bigger && bigger.delta === -300 && bigger.basis === 'sqft',
      'a comparable 300 feet BIGGER gives a delta of -300, so a negative adjustment reads as a positive rate');
    const smaller = unitDeltaFor('GrossLivingArea', 1800, 1500);
    ok(smaller && smaller.delta === 300, 'and a smaller one gives +300');
    ok(unitDeltaFor('GrossBuildingArea', 2000, 1700) != null,
      'a 1025 grid states BUILDING area and gets a rate the same way');

    // ONLY THE SIZE LINES. A RoomCount adjustment covers rooms AND bedrooms AND
    // bathrooms together, so dividing it by a room difference would attribute the
    // bathrooms to the rooms — a rate that is wrong is worse than none.
    ok(unitDeltaFor('RoomCount', 8, 6) === null, 'a room-count line gets no rate — its delta is not one thing');
    ok(unitDeltaFor('Condition', 1500, 1200) === null, 'nor does a condition line');

    // NEVER FABRICATE, and never divide by almost nothing.
    ok(unitDeltaFor('GrossLivingArea', null, 1500) === null, 'a silent subject yields no delta');
    ok(unitDeltaFor('GrossLivingArea', 1500, null) === null, 'a silent comparable yields no delta');
    ok(unitDeltaFor('GrossLivingArea', 1500, 1490) === null,
      'a 10-foot difference yields none either — an ordinary adjustment over it reads as hundreds per foot');
    ok(unitDeltaFor('GrossLivingArea', 0, 1500) === null && unitDeltaFor('GrossLivingArea', 1500, -5) === null,
      'and a zero or negative size is not a size');

    // The rate, end to end, at a market that clears the floor.
    // The back-fill derives the delta from the OBSERVATION's own size and the
    // SUBJECT's, which lives on the appraisal — so the fixture carries both, the
    // way a real comparable observation does. Without them the pass correctly
    // cannot heal the row, which is itself the starvation guard below.
    const bor = (await q(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Adj','Rate',$1) RETURNING id`,
      [`adjrate-${process.pid}@example.test`]))[0].id;
    const app = (await q(
      `INSERT INTO applications (borrower_id, loan_type) VALUES ($1,'rtl') RETURNING id`, [bor]))[0].id;
    const appr = (await q(
      `INSERT INTO appraisals (application_id, gla) VALUES ($1, 1500) RETURNING id`, [app]))[0].id;
    const o4 = (await q(
      `INSERT INTO property_observations (property_id, appraisal_id, role, observed_on, gla, adjustments)
       VALUES ($1,$2,'comparable','2026-03-01',1700,'[]'::jsonb) RETURNING id`, [pid, appr]))[0].id;
    const sized = [];
    for (let i = 0; i < 10; i++) sized.push({ type: 'GrossLivingArea', description: 'x', amount: -(40 * (200 + i * 10)) });
    // One row per line, all with the same 200-foot delta → a clean $40/sq ft.
    await db.query(`UPDATE property_observations SET adjustments = $2::jsonb WHERE id = $1`,
      [o4, JSON.stringify(sized)]);
    await writeAdjustments(db, { observationId: o4, propertyId: pid, adjustments: sized, place,
      on: '2026-03-01', subjectGla: 1500, compGla: 1700 });
    const withDelta = await q(
      `SELECT count(*)::int n, count(unit_delta)::int d FROM property_adjustments WHERE observation_id=$1`, [o4]);
    ok(withDelta[0].d === 10, `every size line carries its delta (${withDelta[0].d}/${withDelta[0].n})`);

    const rate = await ingest.adjustmentRate(db, { city: 'Paterson', state: 'NJ', months: 6000 });
    ok(rate.ok && rate.n === 10, `the rate answers from the market's own adjustments (n=${rate.n})`);
    ok(rate.median > 0, `and it is POSITIVE — a negative rate is a misread, not a market ($${rate.median})`);
    ok(/per square foot/.test(rate.of || ''), 'and it says what it is per, so no screen can mislabel it');

    const nowhereRate = await ingest.adjustmentRate(db, { city: 'Nowheresville', state: 'ZZ', months: 6000 });
    ok(!nowhereRate.ok, 'and it refuses in a market we have never lent in');

    // THE BACK-FILL REACHES ROWS WRITTEN BEFORE db/441 — and then STOPS. The
    // first arm only picks observations with NO rows, so nulling a column could
    // never bring one back; and an observation whose sizes are too close yields a
    // PERMANENT null, so without a floor test the queue never drains.
    await db.query(`UPDATE property_adjustments SET unit_delta=NULL, unit_delta_basis=NULL
                     WHERE observation_id=$1`, [o4]);
    let passes = 0;
    for (let i = 0; i < 6; i++) { const r = await ingest.backfillAdjustmentRowsOnce(db, { limit: 500 }); passes++; if (!r.scanned) break; }
    const healed = await q(`SELECT count(unit_delta)::int d FROM property_adjustments WHERE observation_id=$1`, [o4]);
    ok(healed[0].d === 10, `the back-fill fills a delta on rows that already existed (${healed[0].d}, ${passes} pass(es))`);
    const drained = await ingest.backfillAdjustmentRowsOnce(db, { limit: 500 });
    ok(drained.scanned === 0, `and it genuinely drains rather than re-picking forever (scanned ${drained.scanned})`);
  }


  // -------------------------------------------------------------------------
  // THE AUDIT'S FINDINGS, PINNED.
  // -------------------------------------------------------------------------
  {
    const rowsOf = async (id) => (await q('SELECT count(*)::int n FROM property_adjustments WHERE observation_id=$1', [id]))[0].n;

    // A NULL AMOUNT IS NOT ZERO — and `Number('')`, `Number('  ')`, `Number(false)`
    // and `Number([])` are ALL 0, so the old finite-check turned four kinds of
    // nothing into a stated zero.
    const oNul = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2026-04-01','[]'::jsonb) RETURNING id`, [pid]))[0].id;
    await writeAdjustments(db, { observationId: oNul, propertyId: pid, place, on: '2026-04-01',
      adjustments: [{ type: 'A', amount: '' }, { type: 'B', amount: '   ' }, { type: 'C', amount: false },
        { type: 'D', amount: [] }, { type: 'E', amount: '1200' }, { type: 'F', amount: 0 }] });
    const amts = (await q('SELECT seq, amount FROM property_adjustments WHERE observation_id=$1 ORDER BY seq', [oNul]))
      .map((r) => (r.amount == null ? null : Number(r.amount)));
    ok(amts.slice(0, 4).every((a) => a === null),
      `blank, whitespace, false and [] are all NOTHING, not zero (${JSON.stringify(amts.slice(0, 4))})`);
    ok(amts[4] === 1200, 'a numeric STRING is still a real figure');
    ok(amts[5] === 0, 'and a stated zero is still a stated zero');

    // ONE OUT-OF-RANGE FIGURE MUST NOT TAKE THE WHOLE COMPARABLE DOWN. The column
    // is numeric(14,2) and the parser reads the grid amount with no ceiling, so a
    // single corrupt vendor field raised an overflow that lost every line on that
    // comparable — and then jammed the back-fill queue for ever.
    const oBig = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2026-04-02','[]'::jsonb) RETURNING id`, [pid]))[0].id;
    await writeAdjustments(db, { observationId: oBig, propertyId: pid, place, on: '2026-04-02',
      adjustments: [{ type: 'GrossLivingArea', amount: 99999999999999 }, { type: 'Condition', amount: -3000 }] });
    const big = (await q('SELECT seq, amount FROM property_adjustments WHERE observation_id=$1 ORDER BY seq', [oBig]));
    ok(big.length === 2, `both lines survive an unstorable figure (${big.length})`);
    ok(big[0].amount === null && Number(big[1].amount) === -3000,
      'the unstorable figure is dropped and its SIBLING is kept');

    // THE BACK-FILL MUST NOT STARVE. An observation that yields no rows was
    // re-selected on every boot, and under the real LIMIT window it blocked every
    // writable observation behind it — measured: three passes scanned the same 2,
    // wrote 0, and the good one was never reached.
    const oNone = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2026-05-01',$2::jsonb) RETURNING id`,
      [pid, JSON.stringify([{ description: 'no type at all', amount: 1 }])]))[0].id;
    const oGood = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2019-01-01',$2::jsonb) RETURNING id`,
      [pid, JSON.stringify([{ type: 'Condition', description: 'C4', amount: -1000 }])]))[0].id;
    // limit 1, newest first — the stuck observation owns the whole window.
    let sawGood = 0;
    for (let i = 0; i < 6; i++) { await ingest.backfillAdjustmentRowsOnce(db, { limit: 1 }); sawGood = await rowsOf(oGood); if (sawGood) break; }
    ok(await rowsOf(oNone) === 0, 'an observation with nothing to file writes nothing');
    ok(sawGood === 1, 'and the writable observation BEHIND it is still reached — it no longer owns the window');
    const drain = await ingest.backfillAdjustmentRowsOnce(db, { limit: 500 });
    ok(drain.scanned === 0, `and the queue genuinely drains (scanned ${drain.scanned})`);

    // THE SCOPE MUST NARROW ON EVERY PART GIVEN. A city-only benchmark spanned
    // states — Springfield NJ and Springfield OH answered as one "market" whose
    // median described neither.
    const other = (await q(
      `INSERT INTO properties (address_key, display_address, state, city, zip)
       VALUES ('adjscope-' || gen_random_uuid(), '2 Scope Rd', 'OH', 'Paterson', '43613')
       RETURNING id`))[0].id;
    const oOh = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2026-02-01','[]'::jsonb) RETURNING id`, [other]))[0].id;
    const ohLines = [];
    for (let i = 0; i < 12; i++) ohLines.push({ type: 'BathCount', amount: -9000 });
    await writeAdjustments(db, { observationId: oOh, propertyId: other, adjustments: ohLines,
      place: { state: 'OH', city: 'Paterson', zip: '43613' }, on: '2026-02-01' });
    const nj = await ingest.adjustmentBenchmark(db, { lineType: 'BathCount', city: 'Paterson', state: 'NJ', months: 6000 });
    const oh = await ingest.adjustmentBenchmark(db, { lineType: 'BathCount', city: 'Paterson', state: 'OH', months: 6000 });
    ok(nj.ok && oh.ok && nj.median !== oh.median,
      `two towns of the same name in different states are two markets (NJ ${nj.median} vs OH ${oh.median})`);
    ok(oh.n === 12, `and the state genuinely narrows rather than being ignored (n=${oh.n})`);

    // THE SAMPLE FLOOR MUST NOT FAIL OPEN. `3 < null` and `3 < NaN` are both FALSE,
    // and the `= 8` default only applies to `undefined` — so a floor read from
    // config as null returned a "benchmark" from three numbers with ok:true.
    // Seeded with exactly THREE, so the floor is the only thing standing between
    // a caller and a "benchmark" built from three numbers.
    const oThin = (await q(
      `INSERT INTO property_observations (property_id, role, observed_on, adjustments)
       VALUES ($1,'comparable','2026-06-01','[]'::jsonb) RETURNING id`, [pid]))[0].id;
    await writeAdjustments(db, { observationId: oThin, propertyId: pid, place, on: '2026-06-01',
      adjustments: [{ type: 'ThinLine', amount: -100 }, { type: 'ThinLine', amount: -200 }, { type: 'ThinLine', amount: -300 }] });
    const thinDefault = await ingest.adjustmentBenchmark(db, { lineType: 'ThinLine', city: 'Paterson', state: 'NJ', months: 6000 });
    ok(!thinDefault.ok && thinDefault.n === 3,
      `three adjustments are refused at the default floor (n=${thinDefault.n})`);
    for (const bad of [null, NaN, 0, -5, 'abc']) {
      const r = await ingest.adjustmentBenchmark(db, { lineType: 'ThinLine', city: 'Paterson', state: 'NJ', months: 6000, minSample: bad });
      ok(!r.ok, `a minSample of ${JSON.stringify(bad)} falls back to the real floor rather than opening the gate`);
    }
    const explicit = await ingest.adjustmentBenchmark(db, { lineType: 'ThinLine', city: 'Paterson', state: 'NJ', months: 6000, minSample: 2 });
    ok(explicit.ok && explicit.n === 3, 'while a real, deliberate floor of 2 is honoured');

    await db.query('DELETE FROM property_observations WHERE property_id=$1', [other]);
    await db.query('DELETE FROM properties WHERE id=$1', [other]);
  }

  await db.query('DELETE FROM property_observations WHERE property_id=$1', [pid]);
  await db.query('DELETE FROM properties WHERE id=$1', [pid]);
  await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email = $1)`,
    [`adjrate-${process.pid}@example.test`]);
  await db.query(`DELETE FROM borrowers WHERE email = $1`, [`adjrate-${process.pid}@example.test`]);
  console.log(fails ? `\ntest-adjustment-corpus-db: ${fails} FAILED` : '\ntest-adjustment-corpus-db: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('test-adjustment-corpus-db threw:', e && e.stack); process.exit(1); });
