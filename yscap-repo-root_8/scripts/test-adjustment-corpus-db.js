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

  await db.query('DELETE FROM property_observations WHERE property_id=$1', [pid]);
  await db.query('DELETE FROM properties WHERE id=$1', [pid]);
  console.log(fails ? `\ntest-adjustment-corpus-db: ${fails} FAILED` : '\ntest-adjustment-corpus-db: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('test-adjustment-corpus-db threw:', e && e.stack); process.exit(1); });
