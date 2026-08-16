#!/usr/bin/env node
'use strict';
/**
 * LT PPE findings store (db/557) — the durable ledger bridge.
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

    await db.query('DELETE FROM lt_ppe_finding WHERE scope = $1', [scope]);
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
