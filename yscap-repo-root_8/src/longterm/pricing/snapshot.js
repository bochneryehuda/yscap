'use strict';
/**
 * LONG-TERM — TAKE ONE DAY'S PRICE SNAPSHOT (db/659, owner-directed 2026-08-30;
 * research `docs/longterm/PRICING-RATE-MOVEMENT-REPORTS.md` §4 and §8).
 *
 * ⛔ ONE VENDOR CALL BUYS THE WHOLE BOOK, and that measured fact is what makes
 * this feature cheap enough to run every day. A single Lender Price search
 * returns every investor and every programme at once — the live capture of
 * 2026-08-23 recorded 17 lenders / 32 programmes / 1,055 priced rungs from ONE
 * call in 12.1 seconds. So a daily snapshot of "all our investors and all our
 * programmes" is one call per BENCHMARK per day: not one per programme, and not
 * one per officer. Never loop this over programmes or over subscribers.
 *
 * ⛔ IT ONLY EVER WRITES lt_price_snapshot. It sends nothing, tells nobody, and
 * decides nothing about a loan; the reports are a separate thing built on top.
 * That is deliberate staging: the snapshot ships first and starts collecting
 * immediately, because a report has nothing to say on its first day by
 * construction, and building it the other way round produces a first email that
 * says nothing and looks broken.
 *
 * ⛔ IT NEVER THROWS INTO THE WORKER. Every failure is a reported outcome —
 * a vendor refusal, an unusable answer, a lock somebody else holds — because
 * this runs on the same tick as everything else Long-Term schedules.
 *
 * SEPARATION: reads and writes `lt_price_snapshot` only, and calls Long-Term's
 * own Lender Price client. No RTL table, no RTL import.
 */

const lazy = {
  get db() { return require('../db'); },
  get lp() { return require('../lenderprice/client'); },
  get investorPrograms() { return require('../lenderprice/investor-programs'); },
};

const ladderLib = require('./ladder');
const benchmarkLib = require('./benchmark');
const tenantTime = require('../sync/tenant-time');

/** The New York calendar day an instant falls on, as 'YYYY-MM-DD'.
 *  The report compares DAYS an officer means, not UTC windows — 1:00 PM Eastern
 *  is the previous UTC day for nobody, but a snapshot taken at 8:00 PM Eastern
 *  would be tomorrow in UTC and would compare against itself. */
function dayInZone(ms, tz) {
  /* ⛔ THE FIELD NAMES ARE `wallClockOf`'S OWN — `{y, mo, d}`, not
     `{year, month, day}`. It answered the second set here, which is not a name
     that function has ever used, so every day came out
     "undefined-undefined-undefined"; `$4::date` refuses that, the insert threw
     into `takeSnapshot`'s own catch, and the feature would have recorded NOTHING
     while reporting a reason nobody was reading. The phantom-field class, inside
     a swallowing catch — found by the first test that ever called it. */
  const w = tenantTime.wallClockOf(ms, tz || tenantTime.tzName());
  if (!w) return null;
  const p = (v) => String(v).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}`;
}

/**
 * THE ROWS ONE ANSWER PRODUCES — pure, so the whole shaping is testable against
 * a captured board with no network.
 *
 * ⛔ A PROGRAMME WITH NO USABLE LADDER IS DROPPED, AND COUNTED. An empty row
 * would compare as "this programme did not move" tomorrow, which is a statement
 * about the market made out of our own failure to read an answer. The count
 * travels so a caller can say how much of the board it could not read rather
 * than quietly recording less than it was sent.
 */
function rowsFromPrograms(programs) {
  const rows = [];
  let unusable = 0;
  for (const p of (Array.isArray(programs) ? programs : [])) {
    const ladder = ladderLib.ladderOf(p && p.rungs);
    if (!ladder.length) { unusable += 1; continue; }
    rows.push({
      investorKey: p.investorKey || null,
      lender: p.lender || null,
      program: String(p.program || '').trim() || null,
      rateSheet: p.rateSheetName || null,
      ladder,
      parRateMilli: ladderLib.parRateMilli(ladder),
      rungCount: ladder.length,
    });
  }
  // A programme the vendor sent with no NAME cannot be keyed, so it cannot be
  // compared tomorrow — dropped for the same reason, and counted the same way.
  const named = rows.filter((r) => r.program);
  unusable += rows.length - named.length;
  return { rows: named, unusable };
}

/**
 * Take one snapshot for one benchmark. Answers a shaped outcome and NEVER
 * throws; `ok:false` always carries a `reason` a person could act on.
 *
 * The vendor client, the clock and the database are all injectable, so the whole
 * path is provable with no network and no waiting until 1 PM.
 */
async function takeSnapshot(opts = {}) {
  const scenario = opts.scenario || benchmarkLib.DEFAULT_BENCHMARK;
  const hash = benchmarkLib.scenarioHash(scenario);
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const day = opts.day || dayInZone(now, opts.tz);
  const db = opts.db || lazy.db;
  const lp = opts.lp || lazy.lp;
  const out = { ok: false, scenarioHash: hash, day, stored: 0, unusable: 0, reason: null };
  if (!day) { out.reason = 'the New York calendar day could not be worked out'; return out; }

  // ⛔ A LOCK PER SERIES PER DAY, on its own connection so it is held for the
  // whole pass. Render runs more than one web instance; without this, N
  // instances take N snapshots of one day and the upsert would have them
  // fighting over one row. It FAILS CLOSED — unlike the conditions engine's,
  // which fails open — because a missed snapshot costs one day of one series
  // and a duplicated one costs a wasted vendor call and a contended write.
  let lockClient = null;
  try {
    lockClient = await db.getClient();
    const got = await lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [`lt-price-snapshot:${hash}:${day}`]);
    if (!got.rows[0] || got.rows[0].ok !== true) {
      out.reason = 'another instance is taking this snapshot';
      out.skipped = 'locked';
      return out;
    }
  } catch (e) {
    if (lockClient) { try { lockClient.release(); } catch (_) { /* nothing to do */ } }
    out.reason = `could not take the snapshot lock: ${(e && e.message) || e}`;
    return out;
  }

  try {
    const r = await lp.price(scenario);
    if (!r || !r.ok) {
      out.reason = `Lender Price refused the benchmark: ${(r && r.error) || 'no answer'}`;
      return out;
    }
    const parsed = lp.parse(r.raw);
    // The canonical investor key, resolved by the SAME registry the board uses —
    // 151 spellings of one investor is not a problem this file may solve twice.
    const deco = (opts.investorPrograms || lazy.investorPrograms).decorate(parsed.programs || []);
    const shaped = rowsFromPrograms(deco.programs);
    out.unusable = shaped.unusable;
    if (!shaped.rows.length) {
      out.reason = 'the answer carried no priced programme we could read';
      return out;
    }
    for (const row of shaped.rows) {
      // UPSERT on the day key: a job that runs twice on one day REPLACES rather
      // than doubles, so a retry after a partial pass is safe and the later
      // reading — closer to the hour the series is meant to represent — wins.
      await db.query(
        `INSERT INTO lt_price_snapshot
           (scenario_hash, scenario, taken_at, taken_for_day, investor_key, lender, program,
            rate_sheet, ladder, par_rate_milli, rung_count)
         VALUES ($1, $2::jsonb, to_timestamp($3 / 1000.0), $4::date, $5, $6, $7, $8,
                 $9::jsonb, $10, $11)
         ON CONFLICT (scenario_hash, taken_for_day, COALESCE(investor_key, ''), program, COALESCE(rate_sheet, ''))
         DO UPDATE SET taken_at = EXCLUDED.taken_at, scenario = EXCLUDED.scenario,
                       lender = EXCLUDED.lender, ladder = EXCLUDED.ladder,
                       par_rate_milli = EXCLUDED.par_rate_milli, rung_count = EXCLUDED.rung_count`,
        [hash, JSON.stringify(scenario), now, day, row.investorKey, row.lender, row.program,
          row.rateSheet, JSON.stringify(row.ladder), row.parRateMilli, row.rungCount],
      );
      out.stored += 1;
    }
    out.ok = true;
    return out;
  } catch (e) {
    out.reason = (e && e.message) || String(e);
    return out;
  } finally {
    if (lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`lt-price-snapshot:${hash}:${day}`]); }
      catch (_) { /* the connection is going back to the pool either way */ }
      try { lockClient.release(); } catch (_) { /* nothing to do */ }
    }
  }
}

/** Has this series already been recorded for this day? The tick's own question,
 *  asked before anything is spent. */
async function alreadyTaken(scenarioHash, day, dbc = null) {
  const db = dbc || lazy.db;
  const { rows } = await db.query(
    `SELECT 1 FROM lt_price_snapshot WHERE scenario_hash = $1 AND taken_for_day = $2::date LIMIT 1`,
    [String(scenarioHash), String(day)],
  );
  return rows.length > 0;
}

/** One day of one series, as a report reads it. */
async function loadDay(scenarioHash, day, dbc = null) {
  const db = dbc || lazy.db;
  const { rows } = await db.query(
    `SELECT investor_key, lender, program, rate_sheet, ladder, par_rate_milli, rung_count, taken_at
       FROM lt_price_snapshot
      WHERE scenario_hash = $1 AND taken_for_day = $2::date
      ORDER BY COALESCE(investor_key, ''), program, COALESCE(rate_sheet, '')`,
    [String(scenarioHash), String(day)],
  );
  return rows.map((r) => ({
    investorKey: r.investor_key, lender: r.lender, program: r.program, rateSheet: r.rate_sheet,
    ladder: Array.isArray(r.ladder) ? r.ladder : [],
    parRateMilli: r.par_rate_milli, rungCount: r.rung_count, takenAt: r.taken_at,
  }));
}

/** The most recent day of a series BEFORE the one given — "the previous business
 *  day" without a holiday calendar to maintain, which is what the research asked
 *  for: whatever day we last managed to record is the honest thing to compare
 *  against, and a report that names it can never be wrong about which. */
async function previousDay(scenarioHash, day, dbc = null) {
  const db = dbc || lazy.db;
  const { rows } = await db.query(
    `SELECT taken_for_day FROM lt_price_snapshot
      WHERE scenario_hash = $1 AND taken_for_day < $2::date
      ORDER BY taken_for_day DESC LIMIT 1`,
    [String(scenarioHash), String(day)],
  );
  if (!rows.length) return null;
  const d = rows[0].taken_for_day;
  return typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
}

module.exports = {
  takeSnapshot, alreadyTaken, loadDay, previousDay,
  _internals: { rowsFromPrograms, dayInZone },
};
