#!/usr/bin/env node
'use strict';
/**
 * LT PPE findings store (db/561) — the durable ledger bridge.
 *   PURE section (always): the row<->record mapping.
 *   DB section (DATABASE_URL): a real reconcile lifecycle against lt_ppe_finding — new -> recurred ->
 *     a human fix -> a regression carried (never reopened) -> a disappeared finding auto-resolved.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-finding-store-db.js
 */
const store = require('../src/longterm/ppe/finding-store');
const finding = require('../src/longterm/ppe/finding');
const parity = require('../src/longterm/ppe/parity');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// ---- PURE: row -> record ----------------------------------------------------
{
  const rec = store.rowToRecord({
    finding_key: 'k', investor: 'DHVN', program: 'DSCR30', scenario: 'ltv=70', kind: 'price_mismatch',
    diff: { deltaMilli: 50 }, status: 'open', regressed: false, recurrence: 2,
    first_seen_at: new Date(1700000000000), last_seen_at: new Date(1700000100000),
  });
  ok(rec.key === 'k' && rec.firstSeenMs === 1700000000000, 'row -> record maps key + first_seen_at epoch');
  ok(rec.recurrence === 2 && rec.diff.deltaMilli === 50, 'row -> record carries recurrence + diff');
}

// Build a run's incoming records from two parity comparisons (two disagreeing scenarios).
function incomingRun(bumpA, bumpB) {
  const mk = (scenario, bump) => finding.recordsFromComparison(
    parity.compareScenario(
      { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 + bump }] },
      { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] },
      { priceToleranceMilli: 0, scenario },
    ),
    { scenario, investor: 'DHVN', program: 'DSCR30', nowMs: 1700000000000 },
  );
  return [...mk('ltv=70', bumpA), ...mk('ltv=75', bumpB)];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(failures ? `\n${failures} FAILED` : '\nall passed (pure)');
    process.exit(failures ? 1 : 0);
  }
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = `test_finding_${Date.now()}`;
  try {
    await db.query('DELETE FROM lt_ppe_finding WHERE scope = $1', [scope]);

    // run 1 — two fresh disagreements
    const r1 = await store.persistRun(scope, incomingRun(50, 80), { db, nowMs: 1700000000000 });
    ok(r1.summary.new === 2 && r1.summary.recurred === 0, 'run 1: two new findings');
    let rows = await store.listFindings(scope, {}, db);
    ok(rows.length === 2 && rows.every((x) => x.status === 'open' && x.recurrence === 1), 'run 1: both open, recurrence 1');

    // run 2 — same disagreements recur
    const r2 = await store.persistRun(scope, incomingRun(50, 80), { db, nowMs: 1700000200000 });
    ok(r2.summary.recurred === 2 && r2.summary.new === 0, 'run 2: both recurred');
    const kFlip = 'dhvn|dscr30|ltv=70|price_mismatch|7000';
    let f = await store.getFinding(scope, kFlip, db);
    ok(f && f.recurrence === 2, 'run 2: recurrence bumped to 2');

    // a human fixes one
    const decided = await store.decideFinding(scope, kFlip, { status: 'fixed', decidedBy: null, reason: 'engine patched' }, db);
    ok(decided, 'decideFinding marked it fixed');
    f = await store.getFinding(scope, kFlip, db);
    ok(f.status === 'fixed' && f.decision_reason === 'engine patched', 'the fix is recorded');

    // run 3 — the fixed one reappears: carried forward, NEVER reopened, flagged regressed
    const r3 = await store.persistRun(scope, incomingRun(50, 80), { db, nowMs: 1700000400000 });
    ok(r3.summary.carried === 1 && r3.summary.regressed === 1, 'run 3: the fixed finding is carried + regressed');
    f = await store.getFinding(scope, kFlip, db);
    ok(f.status === 'fixed', 'run 3: still FIXED — a settled finding never re-opens itself');
    ok(f.regressed === true, 'run 3: flagged regressed (the fix did not hold)');
    ok(f.recurrence === 3, 'run 3: recurrence still counts');

    // run 4 — both scenarios now agree (nothing disagrees this run), closeDisappeared on.
    // ltv=75 is still OPEN, so it disappears and is auto-closed; ltv=70 is FIXED (settled),
    // so it is never reported as disappeared and is left completely untouched.
    const kHold = 'dhvn|dscr30|ltv=75|price_mismatch|7000';
    const r4 = await store.persistRun(scope, [], { db, nowMs: 1700000600000, closeDisappeared: true });
    ok(r4.summary.disappeared >= 1, 'run 4: an open finding that no longer reproduces is reported disappeared');
    ok(r4.closed.includes(kHold), 'run 4: the disappeared open finding is auto-closed');
    const held = await store.getFinding(scope, kHold, db);
    ok(held.status === 'verified' && /no longer reproduced/i.test(held.decision_reason || ''),
      'run 4: it is resolved to verified with an auto-resolve reason');
    // the fixed ltv=70 was NOT open, so closeDisappeared must not touch it
    f = await store.getFinding(scope, kFlip, db);
    ok(f.status === 'fixed', 'run 4: closeDisappeared never reopens/rewrites a settled finding');

    // ---- §2.126 — WHICH ENGINE WIRING MEASURED THE ROW -------------------------------------------
    // The probe that started this measured, on a real Postgres, that a finding filed by a leg which has
    // since been corrected was auto-closed `verified — no longer reproduced` and then, on reappearing,
    // flagged `regressed`. Both are confident sentences about a measurement nobody made. Everything
    // below is that same lifecycle, with the stamp in place.
    const prov = require('../src/longterm/ppe/agreement-provenance');
    // A FRESH LEDGER, because runs 1-4 above left both keys settled and this section is about what
    // happens to rows that are still OPEN when the engine wiring underneath them changes.
    const scope2 = `${scope}_leg`;
    await db.query('DELETE FROM lt_ppe_finding WHERE scope = $1', [scope2]);

    // run 5 — the stamp is on the row, and it round-trips.
    const r5 = await store.persistRun(scope2, incomingRun(50, 80), { db, nowMs: 1700001000000 });
    ok(r5.summary.new === 2, 'run 5: two fresh findings again');
    const fresh = await store.getFinding(scope2, 'dhvn|dscr30|ltv=70|price_mismatch|7000', db);
    ok(fresh.leg_version === prov.LEG_VERSION, 'run 5: the row records the engine wiring that measured it');
    ok(store.rowToRecord(fresh).legVersion === prov.LEG_VERSION, 'run 5: and it round-trips back to a record');

    // run 6 — age one row's stamp by hand, exactly as history did: it was written by the old leg.
    const kOld = 'dhvn|dscr30|ltv=70|price_mismatch|7000';
    const kNew = 'dhvn|dscr30|ltv=75|price_mismatch|7000';
    await db.query('UPDATE lt_ppe_finding SET leg_version = $3 WHERE scope = $1 AND finding_key = $2',
      [scope2, kOld, '2026-08-19/2.122']);
    // …and one row with NO stamp at all — every row that existed before db/582 looks like this.
    await db.query('UPDATE lt_ppe_finding SET leg_version = NULL WHERE scope = $1 AND finding_key = $2',
      [scope2, kNew]);

    const r6 = await store.persistRun(scope2, [], { db, nowMs: 1700001100000, closeDisappeared: true });
    ok(r6.summary.disappeared === 0, 'run 6: neither row counts as "gone" — this run never looked for them');
    ok(r6.summary.unreadable === 2, 'run 6: both are reported UNREADABLE instead');
    ok(r6.closed.length === 0, 'run 6: and NOTHING is auto-closed');
    ok((r6.unreadable || []).every((u) => typeof u.reason === 'string' && u.reason.length > 10),
      'run 6: each one comes back with a plain-language reason');
    ok(/unknown/.test((r6.unreadable.find((u) => u.key === kNew) || {}).reason || ''),
      'run 6: the unstamped row says what measured it is UNKNOWN — not that it was wrong');
    const stillOpen = await store.getFinding(scope2, kOld, db);
    ok(stillOpen.status === 'open',
      'run 6: it stays OPEN — it still blocks go-live, because a doubt must never loosen the gate');

    // run 7 — the remedy. A human decides the row; that decision was made against TODAY'S engine, so
    // the stamp moves and the row stops being unreadable. Without this the block would have no way out.
    ok(await store.decideFinding(scope2, kOld, { status: 'triaged', reason: 'looked at it' }, db),
      'run 7: a human decision lands');
    const restamped = await store.getFinding(scope2, kOld, db);
    ok(restamped.leg_version === prov.LEG_VERSION,
      'run 7: deciding it writes today\'s engine-wiring stamp — that IS the remedy');

    const r7 = await store.persistRun(scope2, [], { db, nowMs: 1700001200000, closeDisappeared: true });
    ok(r7.closed.includes(kOld), 'run 7: now that it is readable, a run that does not reproduce it may close it');
    ok(!r7.closed.includes(kNew), 'run 7: the still-unstamped row is still left alone');

    await db.query('DELETE FROM lt_ppe_finding WHERE scope = ANY($1::text[])', [[scope, scope2]]);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    await db.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main();
