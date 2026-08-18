#!/usr/bin/env node
'use strict';
/**
 * LT PPE — WHAT CHANGED between two versions of a rate sheet (`GET /rate-sheets/:id/diff`).
 *
 * A new version is loaded by pasting a vendor's grid over the previous one, and the question anybody
 * asks before publishing it is which cells actually moved. `ratesheet-diff.js` has always been able to
 * answer that — a keyed set-difference with per-cell deltas, plus §7.4's split of ordinary numeric
 * refreshes from RULE changes — and it had nothing to hand it: nothing turned a STORED sheet into the
 * flat map it consumes. `ratesheet-cells.sheetToCells` is that half, and this proves the pair.
 *
 * WHAT IS PROVEN:
 *   A. A REPRICED CELL IS ONE CHANGED CELL, not a removed one and an added one. Rows are deleted and
 *      re-inserted on every save (`replaceBasePrices`), so a key built from the row id would report
 *      every cell of every sheet as churn on every save — which is the same as reporting nothing.
 *   B. THE FOUR KINDS ARE TOLD APART: a price moved, a cell added, a cell removed, and a BAND moved
 *      while its amount stayed the same (keyed only on the amount that last one diffs as NO CHANGE,
 *      and a repriced band is exactly what a reviewer is looking for).
 *   C. THE §7.4 SPLIT IS REPORTED AND APPLIES NOTHING — a small numeric move reads as ordinary, a rule
 *      change reads as needing a human, and neither writes anything anywhere.
 *   D. TWO ROWS ADDRESSING ONE CELL ARE REPORTED, never silently merged — a map can hold only one of
 *      them, so an unreported duplicate is invisible in every diff from then on.
 *   E. The first version says so rather than reporting an empty diff, and ownership holds.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-ratesheet-diff-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
// A handler that THROWS is a defect to REPORT, not to die on — otherwise every assertion after it
// silently never runs and the output reads like a suite that finished.
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign(
  { params: {}, body: {}, query: {}, actor: { id: null, email: 'diff@ys' } }, over,
);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE rate-sheet diff skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const cells = require('../src/longterm/ppe/ratesheet-cells');
  const db = require('../src/longterm/db');

  const SCOPE = I.SCOPE;
  const stamp = `D${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const OTHER_SCOPE = `other_${stamp}`;

  const cleanup = async () => {
    for (const s of [SCOPE, OTHER_SCOPE]) {
      await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2', [s, `${INV_CODE}%`]).catch(() => {});
    }
  };

  const GRID_V1 = [
    { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
    { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
    { noteRateMilliPct: 72500, lockDays: 30, priceMilli: 103900 },
  ];
  const ADJ_V1 = [
    { code: 'fico_700_739', dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -250, priority: 0 },
    { code: 'ltv_65_80', dimension: 'ltv', ltvMin: 65000, ltvMax: 80000, adjMilli: -500, priority: 0 },
  ];

  const newProgram = async (label, scope = SCOPE) => {
    const inv = await store.createInvestor(db, scope, { code: `${INV_CODE}${label}`.slice(0, 20), name: `Diff ${label}` });
    const prg = await store.createProgram(db, scope, { investorId: inv.id, code: `P${label}${stamp}`.slice(0, 20), name: `DSCR ${label}` });
    return prg.id;
  };
  const newVersion = async (programId, versionNo, grid, adjustments, scope = SCOPE) => {
    const ver = await store.createRateSheetVersion(db, scope, { programId, versionNo, channel: 'correspondent' });
    await store.replaceBasePrices(db, scope, ver.id, grid);
    if (adjustments) await store.replaceAdjustments(db, scope, ver.id, adjustments);
    return ver.id;
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '576_lt_ppe_ratesheet_agreement_gate.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const prog = await newProgram('A');
    const v1 = await newVersion(prog, 1, GRID_V1, ADJ_V1);

    // Version 2: one price moved 0.150, one coupon retired, one coupon added, one LLPA band widened
    // with its AMOUNT unchanged, and one new LLPA.
    const v2 = await newVersion(prog, 2, [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 103000 },
      { noteRateMilliPct: 73750, lockDays: 30, priceMilli: 104400 },
    ], [
      { code: 'fico_700_739', dimension: 'fico', ficoMin: 700, ficoMax: 749, adjMilli: -250, priority: 0 },
      { code: 'ltv_65_80', dimension: 'ltv', ltvMin: 65000, ltvMax: 80000, adjMilli: -500, priority: 0 },
      { code: 'cashout', dimension: 'purpose', adjMilli: 750, priority: 0 },
    ]);

    // =========================================================================
    // A + B. one changed cell, and the four kinds told apart
    // =========================================================================
    console.log('\nA. what moved between version 1 and version 2\n');

    let res = await call(H.rateSheetDiffRoute, REQ({ params: { id: v2 } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'A1 the two versions are compared');
    ok(res.body.against && res.body.against.versionNo === 1,
      'A2 …against the PREVIOUS version of the same program, without being told which');

    const changedKeys = res.body.changed.map((c) => c.key);
    const priced = res.body.changed.find((c) => /^base\|rate=71250/.test(c.key));
    ok(!!priced && priced.before === 102850 && priced.after === 103000,
      'A3 the repriced coupon is ONE changed cell, carrying both numbers — not a removal and an addition');
    ok(!res.body.removed.some((k) => /^base\|rate=71250/.test(k)) && !res.body.added.some((k) => /^base\|rate=71250/.test(k)),
      'A4 …and it appears in neither the added nor the removed list (a row-id key would report every save as churn)');

    ok(res.body.removed.some((k) => /^base\|rate=72500/.test(k)), 'A5 a retired coupon is REMOVED');
    ok(res.body.added.some((k) => /^base\|rate=73750/.test(k)), 'A6 a new coupon is ADDED');
    ok(res.body.added.some((k) => /cashout/.test(k)), 'A7 a new LLPA is ADDED');

    // The one a diff keyed only on the amount would MISS entirely.
    const bandMove = res.body.changed.find((c) => c.key === 'llpa|code=fico_700_739|bands');
    ok(!!bandMove && /739/.test(String(bandMove.before)) && /749/.test(String(bandMove.after)),
      'A8 a BAND that moved while its amount stayed the same is reported, with the old and new bands');
    ok(!changedKeys.includes('llpa|code=ltv_65_80'), 'A9 …and an untouched LLPA is not reported at all');
    ok(res.body.unchanged > 0, 'A10 the untouched cells are counted rather than listed');

    // =========================================================================
    // C. the §7.4 split — reported, and applying nothing
    // =========================================================================
    console.log('\nB. ordinary refresh vs a change that needs reading\n');

    const ordinaryKeys = res.body.ordinary.map((c) => c.key);
    const readKeys = res.body.needsReading.map((c) => c.key);
    ok(ordinaryKeys.some((k) => /^base\|rate=71250/.test(k)),
      'B1 a small numeric price move reads as an ordinary refresh');
    ok(readKeys.includes('llpa|code=fico_700_739|bands'),
      'B2 …while a band change reads as needing a human — it is a RULE change, not a refresh');
    ok(readKeys.some((k) => /cashout/.test(k)) && readKeys.some((k) => /rate=72500/.test(k)),
      'B3 …and so do an added cell and a removed one');
    ok(/no cell is applied/i.test(res.body.note || ''),
      'B4 the answer says plainly that it applies nothing — "needs reading" is not a refusal');

    // Nothing was written by reading: the sheet is byte-for-byte what it was.
    const after = await store.loadRateSheet(db, v2);
    ok(after.basePrices.length === 3 && after.adjustments.length === 3,
      'B5 …and the sheet is untouched — a diff is a read');

    // =========================================================================
    // D. two rows addressing one cell
    // =========================================================================
    console.log('\nC. a duplicate cell is reported, never silently merged\n');

    // Two uncoded LLPAs on the same dimension with the same bands: one cell, addressed twice. A map
    // can hold only one, so an unreported duplicate is invisible in every diff from here on.
    const dupProg = await newProgram('B');
    const d1 = await newVersion(dupProg, 1, GRID_V1, []);
    const d2 = await newVersion(dupProg, 2, GRID_V1, [
      { dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -250, priority: 0 },
      { dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -375, priority: 1 },
    ]);
    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: d2 }, query: { against: d1 } }));
    ok(res.statusCode === 200 && res.body.duplicates.now.length === 1,
      'C1 the duplicate is REPORTED');
    ok((res.body.duplicates.now[0] || {}).kept === -250 && (res.body.duplicates.now[0] || {}).dropped === -375,
      'C2 …naming both amounts, so which one the sheet is actually pricing on is answerable');

    // The pure half, asserted directly: the FIRST value is kept, deterministically.
    const twice = cells.sheetToCells({
      basePrices: [], adjustments: [
        { dimension: 'fico', fico_min: 700, fico_max: 739, adj_milli: -250 },
        { dimension: 'fico', fico_min: 700, fico_max: 739, adj_milli: -375 },
      ],
    });
    ok(twice.cells['llpa|fico|fico=700..739,ltv=*..*,dscr=*..*'] === -250 && twice.duplicates.length === 1,
      'C3 the map keeps the FIRST of two colliding cells, so it is deterministic rather than order-dependent');

    // =========================================================================
    // E. the first version, and ownership
    // =========================================================================
    console.log('\nD. the first version, and the refusals\n');

    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: v1 } }));
    ok(res.statusCode === 200 && res.body.against === null && /first version/i.test(res.body.note || ''),
      'D1 the first version says there is nothing to compare against — never "no changes"');

    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: v2 }, query: { against: v2 } }));
    ok(res.statusCode === 400, 'D2 a version cannot be compared against itself');

    const otherProg = await newProgram('O', OTHER_SCOPE);
    const otherVer = await newVersion(otherProg, 1, GRID_V1, [], OTHER_SCOPE);
    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: v2 }, query: { against: otherVer } }));
    ok(res.statusCode === 404, 'D3 another tenant\'s version cannot be compared against');
    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: otherVer } }));
    ok(res.statusCode === 404, 'D4 …and their sheet cannot be read through this door at all');

    res = await call(H.rateSheetDiffRoute, REQ({ params: { id: v2 }, query: { against: 'not-a-uuid' } }));
    ok(res.statusCode === 400 && res.body.field === 'against', 'D5 a malformed id is refused, naming the field');
  } finally {
    await cleanup();
    if (typeof db.end === 'function') await db.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'ok - lt ppe rate-sheet diff (all passed)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
