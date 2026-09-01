'use strict';
/**
 * LONG-TERM — THE DAILY PRICE SNAPSHOT AND ITS LADDER MATHS, offline.
 *
 * The rate-movement reports the owner asked for (2026-08-30: *"it should
 * calculate by price, not by rate … how much more expensive every single
 * program is"*) rest on three pure modules — `pricing/ladder.js`,
 * `pricing/benchmark.js` and the shaping half of `pricing/snapshot.js` — and
 * every rule in them is a decision that can be wrong in a way nobody would see
 * in a rendered email. A movement report that reports movement which did not
 * happen is worse than no report: it is a number an officer will quote.
 *
 * ⛔ THE SIGN CONVENTION IS THE ONE TRAP IN THE WHOLE FEATURE, and it is
 * asserted rather than commented. This codebase prices as `points = 100 −
 * price`, so a programme getting MORE EXPENSIVE means its PRICE WENT DOWN. Every
 * figure here is a signed price delta the engine's way; the wording ("0.500 more
 * expensive") belongs to whatever draws the email, and section F pins the
 * direction on a worked example so a future rewrite cannot quietly invert it.
 *
 * PURE: no database, no network, no clock beyond the ones injected. It is safe
 * in the head of `npm test` and needs nothing to run.
 */

const fs = require('fs');
const path = require('path');
const ladder = require('../src/longterm/pricing/ladder');
const benchmark = require('../src/longterm/pricing/benchmark');
const snapshot = require('../src/longterm/pricing/snapshot');

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${label}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`}`);

// ── A. milli integers ───────────────────────────────────────────────────────
console.log('\nA. a rate and a price are integers, and unreadable is NULL — never zero');
ok(ladder.milli(7.125) === 7125, 'A1 7.125% is 7125');
ok(ladder.milli(99.875) === 99875, 'A2 99.875 is 99875');
ok(ladder.milli('7.125') === 7125, 'A3 a numeric string reads as the number it is');
ok(ladder.milli(null) === null && ladder.milli(undefined) === null && ladder.milli('') === null,
  'A4 nothing readable answers null');
ok(ladder.milli('n/a') === null && ladder.milli(NaN) === null && ladder.milli(Infinity) === null,
  'A5 …and so does junk, an actual NaN and an infinity — a zero here would be the best price on any board');
ok(ladder.milli(0) === 0, 'A6 a real zero is still a zero, so the null is about READABILITY and not about falsiness');
ok(ladder.fromMilli(7125) === 7.125 && ladder.fromMilli('x') === null, 'A7 and it comes back');

// ── B. one row per rate, at its best price ──────────────────────────────────
console.log('\nB. a ladder is one row per rate, at the BEST price that rate is offered at');
{
  // Two lock periods on one programme quote 7.125% twice. Keeping both would
  // make "the price at 7.125%" ambiguous, and a comparison between two ambiguous
  // figures is not a comparison.
  const rungs = [
    { rate: 7.375, price: 100.5 },
    { rate: 7.125, price: 99.25 },
    { rate: 7.125, price: 99.875 },   // the cheaper of the two — highest price wins
    { rate: 6.875, price: 98.0 },
  ];
  const L = ladder.ladderOf(rungs);
  eq(L.map((r) => r.rateMilli), [6875, 7125, 7375], 'B1 one row per rate, sorted by rate ascending');
  ok(ladder.priceAt(L, 7125) === 99875,
    'B2 THE ONE THAT MATTERS: the duplicated rate keeps its HIGHEST price — the cheapest rung, which is the one an officer would quote');
  const dropped = ladder.ladderOf([
    { rate: 7.125, price: 99.875 },
    { rate: null, price: 100 },        // no rate
    { rate: 7.25 },                    // no price
    { rate: 7.5, price: 'n/a' },       // unreadable price
  ]);
  eq(dropped.map((r) => r.rateMilli), [7125],
    'B3 a rung with no readable rate or price is DROPPED, never defaulted — a rung priced at zero would top every report');
  eq(ladder.ladderOf(null), [], 'B4 nothing in, nothing out');
  eq(ladder.ladderOf('rungs'), [], 'B5 …and junk in, nothing out');
}

// ── C. par is interpolated, and NEVER extrapolated ──────────────────────────
console.log('\nC. the par rate is interpolated between the rungs that straddle it, and never run off the end');
{
  const exact = [{ rateMilli: 7000, bestPriceMilli: 99000 }, { rateMilli: 7250, bestPriceMilli: 100000 }];
  ok(ladder.parRateMilli(exact) === 7250, 'C1 a rung priced at exactly 100.000 IS the par rate');
  const straddle = [{ rateMilli: 7000, bestPriceMilli: 99000 }, { rateMilli: 7500, bestPriceMilli: 101000 }];
  ok(ladder.parRateMilli(straddle) === 7250, 'C2 …and otherwise it is interpolated between the pair that straddles par');
  ok(ladder.parRateMilli([{ rateMilli: 7000, bestPriceMilli: 98000 }, { rateMilli: 7500, bestPriceMilli: 99000 }]) === null,
    'C3 THE ONE THAT MATTERS: a ladder entirely BELOW par has no par rate — inventing one states a rate the vendor never quoted');
  ok(ladder.parRateMilli([{ rateMilli: 7000, bestPriceMilli: 101000 }, { rateMilli: 7500, bestPriceMilli: 102000 }]) === null,
    'C4 …and neither does one entirely above it');
  ok(ladder.parRateMilli([{ rateMilli: 7000, bestPriceMilli: 100000 }, { rateMilli: 7500, bestPriceMilli: 100000 }]) === 7000,
    'C5 a pair both AT par answers the first of them rather than dividing by a zero span');
  ok(ladder.parRateMilli([{ rateMilli: 7000, bestPriceMilli: 99000 }]) === null,
    'C6 one rung cannot straddle anything');
  // Direction-agnostic: nothing here may assume price falls as the rate falls.
  const inverted = [{ rateMilli: 7000, bestPriceMilli: 101000 }, { rateMilli: 7500, bestPriceMilli: 99000 }];
  ok(ladder.parRateMilli(inverted) === 7250, 'C7 …and it walks the pair whichever way the ladder runs');
}

// ── D. the anchor is deterministic ──────────────────────────────────────────
console.log('\nD. the anchor rung is the one closest to par, chosen once and held');
{
  const L = [
    { rateMilli: 6875, bestPriceMilli: 98000 },
    { rateMilli: 7125, bestPriceMilli: 99900 },
    { rateMilli: 7375, bestPriceMilli: 101500 },
  ];
  ok(ladder.anchorRateMilli(L) === 7125, 'D1 the rung nearest 100.000 is the anchor — where a real quote sits');
  const tie = [
    { rateMilli: 7375, bestPriceMilli: 100500 },
    { rateMilli: 7125, bestPriceMilli: 99500 },
  ];
  ok(ladder.anchorRateMilli(tie) === 7125,
    'D2 a tie breaks to the LOWER rate, so two runs over one board cannot disagree about what was measured');
  ok(ladder.anchorRateMilli([]) === null && ladder.anchorRateMilli(null) === null,
    'D3 an empty ladder has no anchor');
  ok(ladder.priceAt(L, 7125) === 99900 && ladder.priceAt(L, 7000) === null,
    'D4 a price is read at an EXACT rate or not at all — a made-up price at a rate nobody quoted is not a comparison');
}

// ── E. what moved, and the three facts a zero would flatten ─────────────────
console.log('\nE. two days of one programme — and NEW, GONE and DID-NOT-MOVE stay three different facts');
{
  const before = [
    { rateMilli: 6875, bestPriceMilli: 98000 },
    { rateMilli: 7125, bestPriceMilli: 99900 },
    { rateMilli: 7375, bestPriceMilli: 101500 },
  ];
  // The whole sheet 0.250 cheaper to buy (price UP), evenly.
  const evenly = before.map((p) => ({ ...p, bestPriceMilli: p.bestPriceMilli + 250 }));
  const flat = ladder.compareLadders(before, evenly);
  ok(flat.anchorRateMilli === 7125 && flat.anchorDeltaMilli === 250 && flat.sheetDeltaMilli === 250,
    'E1 an even move reads the same on the anchor and across the sheet');
  ok(flat.rungsCompared === 3, 'E2 …over every rung present on both days');
  ok(flat.disagree === false, 'E3 …and the two metrics do not disagree');

  // One CORNER re-prices: the anchor is untouched while the sheet moves. This is
  // the shape an average hides, and the reason both figures travel.
  const corner = [
    before[0],
    before[1],
    { rateMilli: 7375, bestPriceMilli: 101500 - 1000 },
  ];
  const c = ladder.compareLadders(before, corner);
  ok(c.anchorDeltaMilli === 0 && c.sheetDeltaMilli === -333,
    `E4 THE ONE THAT MATTERS: one corner re-pricing leaves the anchor still and moves the sheet (anchor ${c.anchorDeltaMilli}, sheet ${c.sheetDeltaMilli})`);
  ok(c.disagree === true, 'E5 …and the pair is reported as disagreeing, which is what an officer wants told');

  const newToday = ladder.compareLadders([], before);
  ok(newToday.anchorDeltaMilli === null && newToday.sheetDeltaMilli === null && newToday.rungsCompared === 0,
    'E6 a programme that is NEW today measures nothing — null, never a zero that reads as "it did not move"');
  const anchorGone = ladder.compareLadders(before, [{ rateMilli: 7375, bestPriceMilli: 101500 }]);
  ok(anchorGone.anchorBeforeMilli === 99900 && anchorGone.anchorAfterMilli === null
    && anchorGone.anchorDeltaMilli === null,
  'E7 …and so does one whose anchor rung has GONE, while the rungs that survived are still compared');
  ok(anchorGone.rungsCompared === 1, 'E8 …exactly the rungs on both days, never the ones on only one');

  const still = ladder.compareLadders(before, before);
  ok(still.anchorDeltaMilli === 0 && still.sheetDeltaMilli === 0,
    'E9 and a programme that genuinely did not move reads ZERO — the third fact, told apart from the other two');

  const parMoved = ladder.compareLadders(
    [{ rateMilli: 7000, bestPriceMilli: 99000 }, { rateMilli: 7500, bestPriceMilli: 101000 }],
    [{ rateMilli: 7000, bestPriceMilli: 98000 }, { rateMilli: 7500, bestPriceMilli: 100000 }],
  );
  ok(parMoved.parBeforeMilli === 7250 && parMoved.parAfterMilli === 7500 && parMoved.parDeltaMilli === 250,
    'E10 the par rate moves with the sheet, and the report can say by how much');
  ok(ladder.compareLadders(before, corner, { disagreeThresholdMilli: 1000 }).disagree === false,
    'E11 the disagreement threshold is the caller\'s, so a report can be as fussy as it needs to be');
}

// ── F. the sign convention ──────────────────────────────────────────────────
console.log('\nF. more expensive means the PRICE went DOWN — the one trap in the feature');
{
  const before = [{ rateMilli: 7125, bestPriceMilli: 100000 }];
  const dearer = [{ rateMilli: 7125, bestPriceMilli: 99500 }];   // half a point more to buy
  const d = ladder.compareLadders(before, dearer);
  ok(d.anchorDeltaMilli === -500,
    'F1 THE ONE THAT MATTERS: half a point MORE EXPENSIVE is a delta of −500, because points = 100 − price');
  ok(ladder.compareLadders(before, [{ rateMilli: 7125, bestPriceMilli: 100250 }]).anchorDeltaMilli === 250,
    'F2 …and a quarter point CHEAPER is +250');
  // Nothing in this module may render a signed price — the wording belongs to
  // whatever draws the email, and a raw signed price must never reach a reader.
  const src = fs.readFileSync(path.join(__dirname, '../src/longterm/pricing/ladder.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/more expensive|cheaper|bps\b/i.test(src),
    'F3 …and the module words none of it — a raw signed price must never reach a reader');
}

// ── G. the benchmark, and the series it keys ────────────────────────────────
console.log('\nG. a series is keyed on the scenario, so a report can never compare apples to oranges');
{
  const h = benchmark.scenarioHash(benchmark.DEFAULT_BENCHMARK);
  ok(/^[0-9a-f]{32}$/.test(h), 'G1 the key is a 32-character hash');
  const reordered = {};
  for (const k of Object.keys(benchmark.DEFAULT_BENCHMARK).reverse()) reordered[k] = benchmark.DEFAULT_BENCHMARK[k];
  ok(benchmark.scenarioHash(reordered) === h, 'G2 …stable across key order');
  ok(benchmark.scenarioHash({ ...benchmark.DEFAULT_BENCHMARK, fico: '760' }) === h,
    'G3 …and across number-versus-string, so the form and a stored benchmark are one series');
  ok(benchmark.scenarioHash({ ...benchmark.DEFAULT_BENCHMARK, county: '' }) === h,
    'G4 …and a field that is present but empty is the same fact as one that is absent');
  ok(benchmark.scenarioHash({ ...benchmark.DEFAULT_BENCHMARK, escrowWaive: false }) === h,
    'G5 …and a false flag is not stated, exactly as the form omits it');
  ok(benchmark.scenarioHash({ ...benchmark.DEFAULT_BENCHMARK, fico: 720 }) !== h,
    'G6 THE ONE THAT MATTERS: a real edit starts a NEW series rather than silently comparing two scenarios');
  ok(/Purchase/.test(benchmark.describeBenchmark(benchmark.DEFAULT_BENCHMARK))
    && /75% LTV/.test(benchmark.describeBenchmark(benchmark.DEFAULT_BENCHMARK))
    && /760 FICO/.test(benchmark.describeBenchmark(benchmark.DEFAULT_BENCHMARK)),
  'G7 and every report can name what it measured, in the words an officer would use');
  const empty = benchmark.describeBenchmark(null);
  ok(typeof empty === 'string' && /—/.test(empty) && !/undefined|NaN|null/.test(empty),
    'G8 …with nothing to describe it says so with an em dash rather than throwing or printing "undefined"');
}

/* ⛔ THE BENCHMARK IS A COPY OF THE PRICER'S OWN STARTING SCENARIO, AND THE
   DRIFT IS GUARDED RATHER THAN HOPED FOR (the owner: *"the report runs based on
   the details that we have already in our system, which is always the default
   that populates"*). It cannot IMPORT that file — this is server code and that
   is a browser component — and it must not be re-derived from it either,
   because an officer may set a benchmark of their own and the default has to
   stay a stated thing rather than whatever the form opens on this week.

   ⛔ SO A FAILURE HERE IS A DECISION, NOT A BUG. A benchmark that no longer
   matches the deal shape the desk actually quotes is a report nobody trusts;
   one that silently follows a UI tweak restarts every series without anybody
   choosing to. Read the message, then decide which of the two moves. */
console.log('\nH. …and the benchmark still matches the pricer\'s own starting scenario');
{
  const jsx = fs.readFileSync(path.join(__dirname, '../app-v2/src/longterm/LtScenarioFields.jsx'), 'utf8');
  const start = jsx.slice(jsx.indexOf('export const START = {'));
  const consts = fs.readFileSync(path.join(__dirname, '../app-v2/src/longterm/scenarioFields.js'), 'utf8');
  const termDefault = (consts.match(/export const DEFAULT_TERM_YEARS = '([^']*)'/) || [])[1];
  ok(!!termDefault, 'H0 the pricer\'s own default term was found to read — a parser that found nothing would make every check below pass by finding nothing');
  /* A value out of the form, as the form holds it: a quoted literal, a bare
     number, or the one named constant. Commas are the form's own thousands
     separators and are stripped exactly as `toNumber` strips them. */
  const startValue = (key) => {
    /* A QUOTED LITERAL FIRST, and only then a bare token — the form writes its
       money with thousands separators ('500,000'), so a pattern that stopped at
       the first comma would read "'500" and report a drift that is not one. */
    const m = start.match(new RegExp(`\\n  ${key}:\\s*('[^']*'|[^,\\n]+)`));
    if (!m) return undefined;
    let raw = m[1].trim();
    if (raw === 'DEFAULT_TERM_YEARS') raw = `'${termDefault}'`;
    const q = raw.match(/^'([^']*)'$/);
    return q ? q[1] : raw;
  };
  /* ⛔ COMPARED IN THE TYPE THE BENCHMARK HOLDS, never coerced blindly. The form
     keeps every field as text; the benchmark keeps money as numbers and the ZIP
     as a STRING, because '06001' is not 6001 and a leading zero is the whole of
     a Connecticut post code. Coercing everything to a number reported a drift
     that was not one. */
  const drifted = [];
  for (const [k, want] of Object.entries(benchmark.DEFAULT_BENCHMARK)) {
    const text = startValue(k);
    if (text === undefined) { drifted.push(`${k}: the form no longer has this field`); continue; }
    const got = typeof want === 'number' ? Number(String(text).replace(/,/g, '')) : String(text);
    if (got !== want) drifted.push(`${k}: the benchmark says ${JSON.stringify(want)}, the pricer starts on ${JSON.stringify(got)}`);
  }
  ok(drifted.length === 0,
    `H1 THE ONE THAT MATTERS: the pricer's starting scenario and the benchmark agree${drifted.length ? ` — they do NOT, and this is a DECISION rather than a bug: ${drifted.join('; ')}. Decide whether the benchmark moves with the form (which restarts every series) or stays where it is.` : ''}`);
  ok(startValue('purpose') === 'Purchase' && startValue('value') === '500,000' && startValue('zip') === '06001',
    'H2 …and the reader really did read the form, separators and leading zeros intact — the control, without which H1 passes by finding nothing');
}

// ── I. what one vendor answer becomes ───────────────────────────────────────
console.log('\nI. one board becomes rows, and what could not be read is COUNTED rather than dropped quietly');
{
  const { rowsFromPrograms } = snapshot._internals;
  const out = rowsFromPrograms([
    { investorKey: 'deephaven', lender: 'Deephaven', program: 'DSCR 30 Yr', rateSheetName: 'Wholesale',
      rungs: [{ rate: 7.125, price: 99.875 }, { rate: 7.375, price: 100.5 }] },
    { investorKey: null, lender: 'Somebody New', program: 'DSCR 30 Yr', rungs: [{ rate: 7.0, price: 100 }] },
    { investorKey: 'x', lender: 'X', program: 'Unreadable', rungs: [{ rate: null, price: null }] },
    { investorKey: 'y', lender: 'Y', program: '   ', rungs: [{ rate: 7.0, price: 100 }] },
  ]);
  ok(out.rows.length === 2, 'I1 the two readable, named programmes become rows');
  ok(out.unusable === 2,
    'I2 THE ONE THAT MATTERS: the unreadable one AND the nameless one are counted — recording less than we were sent, silently, is a statement about the market made out of our own failure');
  ok(out.rows[0].rungCount === 2 && out.rows[0].parRateMilli === 7175,
    'I3 a row carries its rung count and the par rate interpolated off its own ladder');
  ok(rowsFromPrograms([{ program: 'Below par', rungs: [{ rate: 7, price: 98 }, { rate: 7.25, price: 99 }] }])
    .rows[0].parRateMilli === null,
  'I3b …and no par rate at all when the ladder never reaches par — never one run off the end of the data');
  ok(out.rows[1].investorKey === null && out.rows[1].lender === 'Somebody New',
    'I4 an investor we cannot key yet is still RECORDED — the vendor\'s own words are kept rather than the row being dropped');
  eq(rowsFromPrograms(null), { rows: [], unusable: 0 }, 'I5 nothing in, nothing out');
}

console.log('\nJ. the day a snapshot belongs to is the NEW YORK day, not the UTC one');
{
  const { dayInZone } = snapshot._internals;
  // 8:00 PM Eastern on 30 August is already the 31st in UTC. A series keyed on
  // the UTC day would compare that snapshot against itself.
  const evening = Date.UTC(2026, 7, 31, 0, 0, 0);       // 2026-08-31T00:00Z = 20:00 ET on the 30th
  ok(dayInZone(evening, 'America/New_York') === '2026-08-30',
    'J1 THE ONE THAT MATTERS: an evening snapshot belongs to the day an officer means, not to tomorrow in UTC');
  ok(dayInZone(Date.UTC(2026, 7, 30, 17, 0, 0), 'America/New_York') === '2026-08-30',
    'J2 …and the 1:00 PM Eastern run the job actually makes lands on its own day');
  ok(dayInZone(NaN, 'America/New_York') === null, 'J3 an unreadable instant answers null rather than a wrong day');
}

/* ⛔ A COLLECTOR NOTHING EVER CALLS IS THE SAME FAILURE AS NO COLLECTOR — and
   worse, because the reports built on it will report nothing and look broken
   rather than absent. No unit test of the pass can see whether anything runs it,
   so the wiring is asserted on the worker's own source. */
console.log('\nL. …and something actually runs it');
{
  const worker = fs.readFileSync(path.join(__dirname, '../src/longterm/sync/worker.js'), 'utf8');
  const code = worker.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(/require\('\.\.\/pricing\/daily-pass'\)/.test(code), 'L1 the sync worker requires the pass');
  ok(/priceSnapshot\.dailyPass\(/.test(code),
    'L2 THE ONE THAT MATTERS: …and calls it on its own tick — a collector nothing calls collects nothing, silently');
  ok(/runLog\.record\('price_snapshot'/.test(code),
    'L3 …through the run log, so a pass that has stopped working is visible rather than absent');
}

/* Everything above is synchronous; the pass below is not, and a top-level await
   in a CommonJS file makes Node refuse the module outright. One async main. */
(async () => {
/* ⛔ THE PASS THAT DECIDES WHETHER TO SPEND A VENDOR CALL — every refusal
   asserted, because each one is a call NOT made and the whole reason this is
   safe on a five-minute tick. Everything is injected, so nothing here reaches a
   database, a clock or Lender Price. */
console.log('\nK. the daily pass does nothing 287 times a day, and says why');
{
  const daily = require('../src/longterm/pricing/daily-pass');
  const NY = 'America/New_York';
  // 1:30 PM Eastern on 30 August 2026 — after the hour the snapshot represents.
  const AFTER = Date.UTC(2026, 7, 30, 17, 30, 0);
  const BEFORE = Date.UTC(2026, 7, 30, 14, 30, 0);   // 10:30 AM Eastern
  const lpOff = { configured: () => false };
  const lpOn = { configured: () => true };
  const dbSaying = (has) => ({ query: async () => ({ rows: has ? [{ '?column?': 1 }] : [] }) });
  const run = (o) => daily.dailyPass({ lp: lpOn, tz: NY, now: AFTER, ...o });

  const was = process.env.LT_PRICE_SNAPSHOT_ENABLED;
  process.env.LT_PRICE_SNAPSHOT_ENABLED = '0';
  const off = await run({ db: dbSaying(false) });
  ok(off.skipped === 'off', 'K1 the switch stops it without a deploy, and it says which switch');
  process.env.LT_PRICE_SNAPSHOT_ENABLED = '1';
  ok(daily.enabled() === true, 'K2 …and anything else, including unset, is on — the collector has to start on day one to have anything to report on day thirty');
  if (was === undefined) delete process.env.LT_PRICE_SNAPSHOT_ENABLED; else process.env.LT_PRICE_SNAPSHOT_ENABLED = was;

  const unconfigured = await daily.dailyPass({ lp: lpOff, tz: NY, now: AFTER, db: dbSaying(false) });
  ok(unconfigured.skipped === 'not_configured',
    'K3 a deployment with no Lender Price costs nothing and reports itself rather than failing');

  const early = await run({ db: dbSaying(false) , now: BEFORE });
  ok(early.skipped === 'too_early' && early.day === '2026-08-30',
    'K4 before the hour it does nothing — and it is an HOUR rather than a cron, so an outage over it costs the day nothing');

  const already = await run({ db: dbSaying(true) });
  ok(already.skipped === 'already' && already.day === '2026-08-30',
    'K5 THE ONE THAT MATTERS: with today\'s row already recorded it spends no vendor call — one indexed SELECT is what makes this safe on a five-minute tick');

  const blind = await daily.dailyPass({
    lp: lpOn, tz: NY, now: AFTER,
    db: { query: async () => { throw new Error('the database is not answering'); } },
  });
  ok(blind.ok === false && /not answering/.test(blind.reason || ''),
    'K6 …and an unreadable "have we already?" does NOT spend one either — a database that cannot answer is not one to write a day of the market into');

  // The one path that DOES call the vendor, with the vendor refusing: it must
  // come back as a reported outcome and never as a throw into the worker.
  let called = 0;
  const refusing = { configured: () => true, price: async () => { called += 1; return { ok: false, error: 'vendor down' }; }, parse: () => ({ programs: [] }) };
  const client = { query: async () => ({ rows: [{ ok: true }] }), release() {} };
  const refused = await daily.dailyPass({
    lp: refusing, tz: NY, now: AFTER,
    db: { query: async () => ({ rows: [] }), getClient: async () => client },
  });
  ok(called === 1 && refused.ok === false && /vendor down/.test(refused.reason || ''),
    'K7 the day\'s own tick DOES call the vendor, once — and a refusal is a reported outcome, never a throw into the worker');

  // And a lock somebody else holds: two Render instances must not both snapshot.
  const locked = await daily.dailyPass({
    lp: refusing, tz: NY, now: AFTER,
    db: { query: async () => ({ rows: [] }), getClient: async () => ({ query: async () => ({ rows: [{ ok: false }] }), release() {} }) },
  });
  ok(locked.skipped === 'locked',
    'K8 …and it stands down when another instance holds the day\'s lock — N instances must not take N snapshots of one day');
}

console.log(`\n${bad === 0 ? 'all passed' : `${bad} FAILED`}`);
process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('the suite itself threw:', e); process.exit(1); });
