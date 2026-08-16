#!/usr/bin/env node
'use strict';
/**
 * LT PPE shadow RUN-RECORD store (db/565) — the durable series bridge.
 *   PURE section (always): the row -> runRecord mapping (bigint/numeric/jsonb coercion).
 *   DB section (DATABASE_URL): a real round-trip against lt_ppe_shadow_run — persist a series,
 *     list it back in scoreboard shape (oldest first), prove assembleScoreboard(persisted) DEEP-EQUALS
 *     scoreboard.assemble(the same runs in memory) [the bridge adds NO second aggregation], a same-run
 *     re-persist UPSERTs (freshest wins, no duplicate), scope + investor isolation, and no-dayMs fails
 *     closed. The deep-equal assertion is proven to have TEETH by an in-test corrupted control.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-run-store-db.js
 *
 * LT-only. No RTL imports.
 */
const runStore = require('../src/longterm/ppe/run-store');
const scoreboard = require('../src/longterm/ppe/scoreboard');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Postgres JSONB does NOT preserve object key order, so a round-tripped `summary` blob is deep-equal
// but not byte-equal under JSON.stringify. Canonicalize (recursively sort object keys) before the
// round-trip comparison. Arrays keep their order (order is meaningful for a run series / finding keys).
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  }
  return v;
}
const eqDeep = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ---- PURE: DB row -> the scoreboard runRecord contract ---------------------
{
  const rec = runStore.rowToRunRecord({
    day_ms: '1700000000000',                 // BIGINT comes back from pg as a string
    agreement_rate: '0.975',                 // NUMERIC comes back as a string
    finding_keys: ['b', 'a', 'x'],
    summary: { comparable: 10, incomparable: 1, agreementRate: 0.975 },
  });
  ok(rec.dayMs === 1700000000000 && typeof rec.dayMs === 'number', 'row -> record parses day_ms bigint-string to a number');
  ok(rec.agreementRate === 0.975 && typeof rec.agreementRate === 'number', 'row -> record parses agreement_rate numeric-string to a number');
  ok(eq(rec.findingKeys, ['b', 'a', 'x']) && rec.summary.comparable === 10, 'row -> record carries finding_keys + summary');
  const nullRec = runStore.rowToRunRecord({ day_ms: '1700000000000', agreement_rate: null, finding_keys: null, summary: null });
  ok(nullRec.agreementRate === null && eq(nullRec.findingKeys, []) && nullRec.summary === null,
    'row -> record: null agreement_rate -> null, null finding_keys -> [], null summary -> null');
}

// A deterministic synthetic 3-day series (distinct day_ms buckets so a round-trip is byte-faithful).
const D = 1_700_000_000_000; // fixed base ms (no Date.now — deterministic)
const DAY = scoreboard.DAY_MS;
const NOW = D + 3 * DAY;
function series() {
  return [
    { dayMs: D + 0 * DAY, agreementRate: 0.90, findingKeys: ['f:a', 'f:b'], summary: { comparable: 20, incomparable: 0, agreementRate: 0.90, disagreed: 2, errors: 0 } },
    { dayMs: D + 1 * DAY, agreementRate: 0.95, findingKeys: ['f:a'],        summary: { comparable: 20, incomparable: 1, agreementRate: 0.95, disagreed: 1, errors: 0 } },
    { dayMs: D + 2 * DAY, agreementRate: 1.00, findingKeys: [],             summary: { comparable: 21, incomparable: 0, agreementRate: 1.00, disagreed: 0, errors: 0 } },
  ];
}
const ASSEMBLE_OPTS = { findings: [], settings: {}, nowMs: NOW, trendWindow: 7 };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(failures ? `\n${failures} FAILED` : '\nall passed (pure)');
    process.exit(failures ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = `test_run_${Date.now()}`;
  const other = `test_run_other_${Date.now()}`;
  try {
    await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = ANY($1)', [[scope, other]]);

    // persist the series (company-wide: no investor/program)
    for (const r of series()) {
      const res = await runStore.persistRun(scope, r, { db });
      ok(res.persisted === true && res.dayMs === r.dayMs, `persistRun stored day ${r.dayMs}`);
    }

    // list back — oldest first, exact scoreboard shape
    const loaded = await runStore.listRuns(scope, { db });
    ok(loaded.length === 3, 'listRuns returns all three runs');
    ok(loaded[0].dayMs === D && loaded[2].dayMs === D + 2 * DAY, 'listRuns is ordered oldest-first');
    // dayMs / agreementRate / findingKeys round-trip EXACTLY (these are the scoreboard-critical fields
    // and array order is meaningful). The summary blob round-trips deep-equal but not byte-equal
    // (JSONB reorders keys), so it is compared order-insensitively.
    ok(loaded.every((r, i) => r.dayMs === series()[i].dayMs && r.agreementRate === series()[i].agreementRate && eq(r.findingKeys, series()[i].findingKeys)),
      'listRuns round-trips dayMs / agreementRate / findingKeys exactly');
    ok(eqDeep(loaded, series()), 'listRuns round-trips the full runRecord contract (summary deep-equal, key-order-insensitive)');

    // THE CORE PROOF: assembleScoreboard(persisted) === scoreboard.assemble(the same runs in memory)
    const fromDb = await runStore.assembleScoreboard(scope, { db, ...ASSEMBLE_OPTS });
    const inMem = scoreboard.assemble(series(), [], ASSEMBLE_OPTS);
    ok(eq(fromDb, inMem), 'assembleScoreboard(persisted) DEEP-EQUALS scoreboard.assemble(in-memory) — the bridge adds no second aggregation');

    // TEETH: a bridge that dropped finding_keys on read would match this corrupted control, which is
    // a DIFFERENT scoreboard — so the deep-equal above is a real proof, not a tautology.
    const corrupted = scoreboard.assemble(series().map((r) => ({ ...r, findingKeys: [] })), [], ASSEMBLE_OPTS);
    ok(!eq(inMem, corrupted), 'CONTROL dropping finding_keys yields a DIFFERENT scoreboard (the deep-equal has teeth)');
    ok(eq(fromDb, inMem) && !eq(fromDb, corrupted), 'the persisted assembly matches the correct scoreboard, not the corrupted one');

    // UPSERT: re-persist the SAME run (same day_ms) with a fresher measure -> one row, freshest wins
    await runStore.persistRun(scope, { dayMs: D, agreementRate: 0.99, findingKeys: ['f:z'], summary: { comparable: 22, incomparable: 0, agreementRate: 0.99 } }, { db });
    const after = await runStore.listRuns(scope, { db });
    ok(after.length === 3, 'a same-run re-persist UPSERTs — no duplicate row');
    ok(after[0].dayMs === D && after[0].agreementRate === 0.99 && eq(after[0].findingKeys, ['f:z']),
      'the re-persisted run carries the freshest agreement_rate + finding_keys');

    // SCOPE isolation
    await runStore.persistRun(other, { dayMs: D, agreementRate: 0.5, findingKeys: ['x'] }, { db });
    ok((await runStore.listRuns(scope, { db })).length === 3, 'another scope\'s run is not returned (scope isolation)');

    // INVESTOR isolation: an investor-specific run is not part of the company-wide ('') series
    await runStore.persistRun(scope, { dayMs: D + 5 * DAY, agreementRate: 0.7, findingKeys: [] }, { db, investor: 'DHVN', program: 'DSCR30' });
    ok((await runStore.listRuns(scope, { db })).length === 3, 'an investor-specific run is not returned by the company-wide query');
    const inv = await runStore.listRuns(scope, { db, investor: 'DHVN', program: 'DSCR30' });
    ok(inv.length === 1 && inv[0].dayMs === D + 5 * DAY, 'the investor-specific series returns exactly its own run');

    // sinceMs window
    const windowed = await runStore.listRuns(scope, { db, sinceMs: D + 1 * DAY });
    ok(windowed.length === 2 && windowed[0].dayMs === D + 1 * DAY, 'sinceMs bounds the window (inclusive)');

    // FAIL-CLOSED: a run with no finite dayMs is not storable in a time series
    const noDay = await runStore.persistRun(scope, { dayMs: null, agreementRate: 1 }, { db });
    ok(noDay.persisted === false && noDay.reason === 'no_day_ms', 'a run with no dayMs fails closed (not persisted)');
    ok((await runStore.listRuns(scope, { db })).length === 3, 'the no-dayMs run wrote no row');

    await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = ANY($1)', [[scope, other]]);
  } finally {
    await db.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
