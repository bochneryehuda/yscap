#!/usr/bin/env node
'use strict';
/**
 * LT test — THE DAILY PRICE SNAPSHOT, against a real database (db/659).
 *
 * The pure suite proves the ladder maths and every refusal the pass makes; what
 * only a real Postgres can prove is the WRITE, and the write is where this
 * feature can fail in a way nothing else would notice:
 *
 *   • THE UPSERT NAMES AN EXPRESSION INDEX. `ON CONFLICT (scenario_hash,
 *     taken_for_day, COALESCE(investor_key,''), program, COALESCE(rate_sheet,''))`
 *     resolves only if it matches db/659's index EXACTLY — get one expression
 *     wrong and Postgres answers 42P10 at RUNTIME, inside `takeSnapshot`'s own
 *     catch, so the job would report a reason nobody reads and record nothing.
 *     No unit test can see this; a suite that stubbed the database would agree
 *     with itself forever.
 *   • THE COALESCE IS THE POINT OF THE KEY. Two NULLs are DISTINCT in Postgres,
 *     so a raw nullable column would let one programme with no rate-sheet name
 *     be inserted twice a day, forever, and every report would count it twice.
 *   • A RETRY REPLACES, IT DOES NOT DOUBLE. A job that runs twice on one day is
 *     the ordinary case (a deploy, a restart), and the later reading wins.
 *   • MILLI-INTEGERS SURVIVE THE ROUND TRIP as integers, because a half-cent of
 *     float drift across a 365-day series is movement that did not happen.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. It
 * NEVER calls Lender Price: the vendor client is injected.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-price-snapshot-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const benchmark = require('../src/longterm/pricing/benchmark');
const snapshotLib = require('../src/longterm/pricing/snapshot');
const daily = require('../src/longterm/pricing/daily-pass');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** A scenario nothing else will ever use, so this suite owns its own series and
 *  can clean up after itself without touching a real one. */
const SCENARIO = { ...benchmark.DEFAULT_BENCHMARK, zip: '00001', fico: 601 };
const HASH = benchmark.scenarioHash(SCENARIO);

/** A fake Lender Price. `price` answers a raw blob and `parse` ignores it and
 *  answers the programmes this test wants — the same seam `snapshot.js` gives
 *  the worker, so no network and no credentials. */
const vendor = (programs) => ({
  configured: () => true,
  price: async () => ({ ok: true, raw: {} }),
  parse: () => ({ programs }),
});
// The investor registry is injected too: this is about the WRITE, not about
// which of 151 spellings of one investor resolves to which key.
const registry = { decorate: (programs) => ({ programs }) };

(async () => {
  await require('../src/migrate-boot').ensureSchema();

  const clean = () => db.query('DELETE FROM lt_price_snapshot WHERE scenario_hash = $1', [HASH]);
  await clean();

  console.log('\nA. db/659 is there, and its key is the one the upsert names');
  {
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'lt_price_snapshot' AND indexname = 'lt_price_snapshot_day_key'`,
    );
    check(idx.rows.length === 1, 'A1 the day key exists');
    const def = (idx.rows[0] || {}).indexdef || '';
    check(/UNIQUE/i.test(def), 'A2 …and it is UNIQUE — one row per series per day per investor per programme per sheet');
    check(/COALESCE\(investor_key/i.test(def) && /COALESCE\(rate_sheet/i.test(def),
      'A3 THE ONE THAT MATTERS: both nullable halves are COALESCEd — two NULLs are DISTINCT in Postgres, so a raw column would let one programme in twice a day forever');
  }

  console.log('\nB. one board becomes one day of one series');
  const DAY = '2026-08-30';
  {
    const out = await snapshotLib.takeSnapshot({
      scenario: SCENARIO, day: DAY, now: Date.UTC(2026, 7, 30, 17, 0, 0),
      lp: vendor([
        { investorKey: 'alpha', lender: 'Alpha Capital', program: 'DSCR 30 Yr', rateSheetName: 'Wholesale',
          rungs: [{ rate: 7.125, price: 99.875 }, { rate: 7.375, price: 100.5 }] },
        // No investor key AND no rate sheet — the row the COALESCE half of the
        // key exists for. Two of these, told apart only by their programme.
        { lender: 'Unmapped Lender', program: 'DSCR 30 Yr IO', rungs: [{ rate: 7.5, price: 100.25 }] },
        { lender: 'Unmapped Lender', program: 'DSCR 5/6 ARM', rungs: [{ rate: 6.99, price: 99.5 }] },
      ]),
      investorPrograms: registry,
    });
    check(out.ok === true && out.stored === 3, `B1 three programmes recorded (${out.stored}, ${out.reason || 'no reason'})`);
    const rows = await snapshotLib.loadDay(HASH, DAY);
    check(rows.length === 3, 'B2 …and three rows come back for that day');
    const alpha = rows.find((r) => r.investorKey === 'alpha');
    check(!!alpha && alpha.rungCount === 2, 'B3 a row carries its own rung count');
    check(!!alpha && alpha.ladder.length === 2 && alpha.ladder[0].rateMilli === 7125
      && alpha.ladder[0].bestPriceMilli === 99875,
    'B4 THE ONE THAT MATTERS: the ladder round-trips as INTEGERS — a half-cent of float drift across a year is movement that did not happen');
    check(!!alpha && Number.isInteger(alpha.parRateMilli) && alpha.parRateMilli === 7175,
      'B5 …and so does the interpolated par rate');
    check(await snapshotLib.alreadyTaken(HASH, DAY) === true, 'B6 and the day reports itself as taken');
  }

  console.log('\nC. a second pass on one day REPLACES, and never doubles');
  {
    const again = await snapshotLib.takeSnapshot({
      scenario: SCENARIO, day: DAY, now: Date.UTC(2026, 7, 30, 18, 0, 0),
      lp: vendor([
        { investorKey: 'alpha', lender: 'Alpha Capital', program: 'DSCR 30 Yr', rateSheetName: 'Wholesale',
          rungs: [{ rate: 7.125, price: 99.5 }, { rate: 7.375, price: 100.125 }] },
        { lender: 'Unmapped Lender', program: 'DSCR 30 Yr IO', rungs: [{ rate: 7.5, price: 100.25 }] },
        { lender: 'Unmapped Lender', program: 'DSCR 5/6 ARM', rungs: [{ rate: 6.99, price: 99.5 }] },
      ]),
      investorPrograms: registry,
    });
    check(again.ok === true, `C1 the retry succeeds (${again.reason || 'no reason'}) — the ON CONFLICT really does resolve against db/659's expression index, which is the one thing no unit test can see`);
    const rows = await snapshotLib.loadDay(HASH, DAY);
    check(rows.length === 3, `C2 THE ONE THAT MATTERS: still three rows, not six (${rows.length})`);
    const alpha = rows.find((r) => r.investorKey === 'alpha');
    check(!!alpha && alpha.ladder[0].bestPriceMilli === 99500,
      'C3 …and the LATER reading won — closer to the hour the series is meant to represent');
    const unmapped = rows.filter((r) => r.investorKey === null);
    check(unmapped.length === 2 && new Set(unmapped.map((r) => r.program)).size === 2,
      'C4 …and the two rows with no investor key and no rate sheet are still told apart by their programme');
  }

  console.log('\nD. a series knows what to compare against');
  {
    await snapshotLib.takeSnapshot({
      scenario: SCENARIO, day: '2026-08-28', now: Date.UTC(2026, 7, 28, 17, 0, 0),
      lp: vendor([{ investorKey: 'alpha', lender: 'Alpha Capital', program: 'DSCR 30 Yr', rateSheetName: 'Wholesale',
        rungs: [{ rate: 7.125, price: 100.0 }] }]),
      investorPrograms: registry,
    });
    const prev = await snapshotLib.previousDay(HASH, DAY);
    check(prev === '2026-08-28',
      `D1 the previous day is whatever we last managed to record (${prev}) — "the previous business day" without a holiday calendar to maintain`);
    check(await snapshotLib.previousDay(HASH, '2026-08-28') === null,
      'D2 …and the first day of a series has nothing before it, which is null rather than a guess');
    check(await snapshotLib.alreadyTaken(HASH, '2026-08-29') === false,
      'D3 a day nobody recorded is not taken');
  }

  console.log('\nE. a different scenario is a DIFFERENT series');
  {
    const other = { ...SCENARIO, fico: 602 };
    const otherHash = benchmark.scenarioHash(other);
    check(otherHash !== HASH, 'E1 an edited benchmark keys differently');
    check(await snapshotLib.alreadyTaken(otherHash, DAY) === false,
      'E2 THE ONE THAT MATTERS: …so it starts a NEW series rather than silently comparing two scenarios — a price is a price FOR a scenario');
    await db.query('DELETE FROM lt_price_snapshot WHERE scenario_hash = $1', [otherHash]);
  }

  console.log('\nF. the daily pass, end to end, against the real table');
  {
    // 2:00 PM Eastern on a day this series has nothing for.
    const NOW = Date.UTC(2026, 8, 2, 18, 0, 0);
    const first = await daily.dailyPass({
      scenario: SCENARIO, tz: 'America/New_York', now: NOW,
      lp: vendor([{ investorKey: 'alpha', lender: 'Alpha Capital', program: 'DSCR 30 Yr', rateSheetName: 'Wholesale',
        rungs: [{ rate: 7.25, price: 99.75 }] }]),
      investorPrograms: registry,
    });
    check(first.ok === true && first.stored === 1 && first.day === '2026-09-02',
      `F1 the day's first tick after the hour records it (${first.day}, ${first.stored})`);
    let called = 0;
    const second = await daily.dailyPass({
      scenario: SCENARIO, tz: 'America/New_York', now: NOW + 60000,
      lp: { configured: () => true, price: async () => { called += 1; return { ok: false }; }, parse: () => ({ programs: [] }) },
      investorPrograms: registry,
    });
    check(second.skipped === 'already' && called === 0,
      'F2 THE ONE THAT MATTERS: every later tick that day spends NO vendor call — one indexed SELECT, which is what makes it safe on a five-minute tick');
  }

  await clean();
  console.log(`\n${failures === 0 ? 'all passed' : `${failures} FAILED`}`);
  await db.pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('the suite itself threw:', e);
  try { await db.pool.end(); } catch (_) { /* going down either way */ }
  process.exit(1);
});
