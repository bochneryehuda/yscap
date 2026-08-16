#!/usr/bin/env node
'use strict';
/**
 * LT PPE rate-sheet store (db/560) + the sheet→engine→quote chain.
 *   PURE section (always): the ratesheet.js mapper + a full fake-sheet → quoteProgram price.
 *   DB section (DATABASE_URL): store a version + grid + LLPAs + limits, load it back, map it, and
 *     price a scenario — proving a DB rate sheet prices identically to the in-memory one, plus the
 *     publish/current effective-dating lifecycle.
 *
 *   node scripts/test-lt-ppe-ratesheet-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-ratesheet-db.js
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/longterm/ppe/store');
const { rateSheetToProgram, bandPredicate, adjustmentToRule } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// A sheet shaped exactly like store.loadRateSheet returns (snake_case DB rows).
const FAKE_SHEET = {
  version: { id: 'v1' },
  basePrices: [
    { note_rate_milli_pct: 70000, lock_days: 30, product: '', price_milli: 101500 },
    { note_rate_milli_pct: 71250, lock_days: 30, product: '', price_milli: 102850 },
  ],
  adjustments: [
    { code: 'dscr_115', dimension: 'dscr', dscr_min: 1000, dscr_max: 1250, adj_milli: 250, unit: 'points', priority: 0 },
    { code: 'fico_hi', dimension: 'fico_ltv', fico_min: 780, fico_max: 850, adj_milli: -125, unit: 'points', priority: 1 },
  ],
  priceLimit: { min_price_milli: 98000, rounding_mode: 'none', rounding_increment_milli: 0, cap_tiers: [] },
};
const SETTINGS = { 'pricing.correspondent_margin_milli': 250 };
const SCENARIO = { fico: 800, ltv: 70000, dscr: 1100, loan_amount: 400000, lock_days: 30 };

function assertPricedChain(program, label) {
  const q = quoteProgram({ scenario: SCENARIO, program, settings: SETTINGS });
  ok(q.eligible === true && q.ladder.length === 2, `${label}: eligible, 2-rung ladder`);
  // 102.850 − 0.250 (dscr) + 0.125 (fico credit) − 0.250 (margin) = 102.475
  ok(q.ladder[1].finalPriceMilli === 102475, `${label}: the 102.850 rung prices to 102.475`);
  ok(q.ladder[0].finalPriceMilli === 101125, `${label}: the 101.500 rung prices to 101.125`);
  ok(q.ladder[1].adjustments.some((a) => a.code === 'dscr_115') && q.ladder[1].adjustments.some((a) => a.code === 'fico_hi'),
    `${label}: both LLPAs itemized on the rung`);
  return q;
}

(async () => {
  console.log('LT PPE rate-sheet — pure mapper + chain\n');

  // bandPredicate — half-open.
  ok(JSON.stringify(bandPredicate('fico', 740, 760)) === JSON.stringify({ fact: 'fico', op: 'between', value: [740, 760] }), 'a two-sided band → between [min,max)');
  ok(bandPredicate('ltv', 60000, null).op === 'gte', 'a min-only band → gte');
  ok(bandPredicate('dscr', null, 1000).op === 'lt', 'a max-only band → lt');
  ok(bandPredicate('x', null, null) === null, 'an empty band → no predicate');

  // adjustmentToRule — AND of present bands + the pricing adjustment.
  const rule = adjustmentToRule(FAKE_SHEET.adjustments[0]);
  ok(rule.kind === 'pricing' && rule.when.op === 'between' && rule.adjustment.adjMilli === 250, 'a single-band adjustment → one between leaf + the signed adjustment');

  // The whole chain, purely: fake sheet → program → priced ladder.
  const prog = rateSheetToProgram(FAKE_SHEET, { code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN' });
  ok(prog.baseGrid.length === 2 && prog.rules.length === 2 && prog.priceLimit.floorMilli === 98000, 'rateSheetToProgram builds grid + rules + limits');
  assertPricedChain(prog, 'PURE');

  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  console.log('\nLT PPE rate-sheet — DB round-trip\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    ok(true, 'db/558 + db/560 applied (idempotent)');

    const scope = 'test_rs_' + Math.abs(process.pid || 1);
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);

    const inv = await store.createInvestor(db, scope, { code: 'DHVN', name: 'Deephaven Mortgage' });
    const program = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30yr' });
    const ver = await store.createRateSheetVersion(db, scope, { programId: program.id, versionNo: 1, channel: 'correspondent', sourceFormat: 'excel' });
    ok(ver && ver.id && ver.status === 'draft', 'createRateSheetVersion returns a draft version');

    ok((await store.replaceBasePrices(db, scope, ver.id, [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
    ])) === 2, 'replaceBasePrices writes the grid');
    ok((await store.replaceAdjustments(db, scope, ver.id, [
      { code: 'dscr_115', dimension: 'dscr', dscrMin: 1000, dscrMax: 1250, adjMilli: 250, priority: 0 },
      { code: 'fico_hi', dimension: 'fico_ltv', ficoMin: 780, ficoMax: 850, adjMilli: -125, priority: 1 },
    ])) === 2, 'replaceAdjustments writes the LLPAs');
    await store.setPriceLimit(db, scope, ver.id, { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0, capTiers: [] });

    const loaded = await store.loadRateSheet(db, ver.id);
    ok(loaded && loaded.basePrices.length === 2 && loaded.adjustments.length === 2 && loaded.priceLimit, 'loadRateSheet returns the full sheet');
    const dbProgram = rateSheetToProgram(loaded, { code: 'DHVN_DSCR30', investorCode: 'DHVN' });
    assertPricedChain(dbProgram, 'DB'); // the stored sheet prices IDENTICALLY to the in-memory one

    // publish/current effective-dating lifecycle.
    const published = await store.publishRateSheetVersion(db, scope, ver.id);
    ok(published && published.status === 'published' && published.effective_from, 'publish marks it published + effective from now');
    const current = await store.currentRateSheetVersion(db, scope, program.id, 'correspondent');
    ok(current && current.id === ver.id, 'currentRateSheetVersion returns the published version');
    // publishing a v2 supersedes v1.
    const ver2 = await store.createRateSheetVersion(db, scope, { programId: program.id, versionNo: 2, channel: 'correspondent' });
    await store.publishRateSheetVersion(db, scope, ver2.id);
    const current2 = await store.currentRateSheetVersion(db, scope, program.id, 'correspondent');
    ok(current2 && current2.id === ver2.id, 'publishing v2 becomes current');
    const v1now = (await db.query('SELECT status, effective_to FROM lt_ppe_rate_sheet_version WHERE id = $1', [ver.id])).rows[0];
    ok(v1now.status === 'superseded' && v1now.effective_to, 'v1 is superseded + closed (nothing deleted)');

    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
  } finally {
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
