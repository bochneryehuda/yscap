#!/usr/bin/env node
'use strict';
/**
 * LT PPE — WHAT ON THIS RATE SHEET CAN NOTHING EVER REACH? (`GET /rate-sheets/:id/coverage`)
 *
 * THE DEFECT CLASS. A rate sheet is loaded by a human from a vendor's PDF, cell by cell, and a cell
 * nobody can land in is invisible in every other way: the sheet publishes, quotes price, and the LLPA
 * simply never applies. `agreement-scenario-generator` has always been able to answer this — it
 * derives a battery from the sheet's OWN compiled rules and reports the ones it cannot satisfy, with a
 * reason — and nothing called it. This is the door, and it is free: no vendor call, no writes, no
 * ledger row, so it is the check to run BEFORE spending a paid agreement battery on a sheet that has a
 * transposed band in it.
 *
 * WHAT IS PROVEN HERE:
 *   A. A HEALTHY SHEET READS AS HEALTHY — every encoded cell reached AND applied, nothing invented.
 *   B. A TRANSPOSED BAND (a minimum above its maximum — the single most likely loading mistake) is
 *      found, named, and given a reason, while its healthy neighbours stay reachable. This is the
 *      anti-vacuous half: a checker that reports nothing on a healthy sheet and also nothing on a
 *      broken one is worth less than no checker, so the same suite asks it both questions.
 *   C. IT DOES NOT TRUST THE GENERATOR. "Reachable" means the sheet was PRICED at that scenario and
 *      the rule's own trace entry shows it CONTRIBUTED — a rule the generator satisfies and the pricer
 *      then does not apply is reported as a DISAGREEMENT, which is a different fix and a different
 *      person, not quietly counted as covered.
 *   D. IT IS FREE AND READ-ONLY — no agreement row, no version status change, and the Lender Price
 *      client is never touched (asserted, not assumed: the stub counts its own calls).
 *   E. Ownership and the ordinary refusals hold, as on every other door in this router.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-ratesheet-coverage-db.js
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
// A handler that THROWS is a defect this suite must REPORT, not die on: `wrap()` turns a throw into a
// 500 in production, so the stub does the same here. Without it one bad path kills the run and every
// assertion after it silently never executes — which reads exactly like a passing suite that stopped.
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign(
  { params: {}, body: {}, query: {}, actor: { id: null, email: 'coverage@ys' } }, over,
);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE rate-sheet coverage skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  // The Lender Price client is stubbed ONLY so that touching it is detectable: this route must never
  // reach an upstream, and "it did not" is worth asserting rather than assuming.
  const LP = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
  const lpStub = { calls: 0, configured() { return true; }, async price() { lpStub.calls += 1; return { ok: true, raw: {} }; }, parseFull() { return { programs: [] }; } };
  require.cache[LP] = { id: LP, filename: LP, loaded: true, exports: lpStub };

  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const agreementStore = require('../src/longterm/ppe/agreement-store');
  const db = require('../src/longterm/db');

  const SCOPE = I.SCOPE;
  const stamp = `C${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const OTHER_SCOPE = `other_${stamp}`;

  const cleanup = async () => {
    for (const s of [SCOPE, OTHER_SCOPE]) {
      await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2', [s, `${INV_CODE}%`]).catch(() => {});
    }
  };

  const buildSheet = async (label, scope = SCOPE) => {
    const inv = await store.createInvestor(db, scope, { code: `${INV_CODE}${label}`.slice(0, 20), name: `Coverage ${label}` });
    const prg = await store.createProgram(db, scope, { investorId: inv.id, code: `P${label}${stamp}`.slice(0, 20), name: `DSCR ${label}` });
    const ver = await store.createRateSheetVersion(db, scope, { programId: prg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(db, scope, ver.id, [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
    ]);
    return { programId: prg.id, versionId: ver.id };
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '576_lt_ppe_ratesheet_agreement_gate.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // =========================================================================
    // A. A HEALTHY SHEET
    // =========================================================================
    console.log('\nA. a sheet whose every cell can be reached\n');

    const good = await buildSheet('G');
    await store.replaceAdjustments(db, SCOPE, good.versionId, [
      { code: 'ltv_65_80', dimension: 'ltv', ltvMin: 65000, ltvMax: 80000, adjMilli: -500, priority: 0 },
      { code: 'fico_700_739', dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -250, priority: 0 },
      { code: 'dscr_100_114', dimension: 'dscr', dscrMin: 1000, dscrMax: 1149, adjMilli: -375, priority: 0 },
    ]);

    lpStub.calls = 0;
    let res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: good.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'A1 the sheet is checked');
    ok(res.body.rules.total === 3 && res.body.rules.reachable === 3,
      // The label used to say "reachable AND applied". It is the same overstatement §2.125 removed from
      // the endpoint's own note, and a test label repeating a false claim is its own defect.
      `A2 all three encoded cells are REACHED — a generated scenario made each one fire (${res.body.rules.reachable} of ${res.body.rules.total})`);
    // §2.125 — REACHED and MOVES A PRICE are two different facts and were one number. `reachable` is
    // read off the rule EVALUATION trace, built before any rung is priced, so a cell counts as reached
    // the moment its predicate fires. MEASURED on the real Deephaven sheet: 174 of 192 cells reach,
    // and 133 of those 174 were read off a quote the engine REFUSED to price. The split says which.
    ok(res.body.rules.pricedFired + res.body.rules.firedUnpriced === res.body.rules.reachable,
      `A2a the reachable count splits and reconciles: ${res.body.rules.reachable} reached `
      + `= ${res.body.rules.pricedFired} seen to move a price + ${res.body.rules.firedUnpriced} reached but untested on price`);
    ok(res.body.rules.firedUnpriced === res.body.rules.reachable && res.body.rules.pricedFired === 0,
      'A2b on this fixture EVERY reached cell was read off a quote the engine could not price — so none of '
      + 'them is yet known to move a number, and the report says so instead of calling them all applied');
    ok(!/applied by the pricer/.test(res.body.note || ''),
      'A2c …and the note does not claim the pricer applied them');
    ok(res.body.rules.unreachable.length === 0 && res.body.rules.disagreed.length === 0,
      'A3 …with nothing reported against a healthy sheet');
    ok(res.body.scenarios.generated > 0 && res.body.scenarios.answered === res.body.scenarios.generated,
      `A4 every generated scenario was ANSWERED by our own engine (${res.body.scenarios.answered}/${res.body.scenarios.generated})`);
    // §2.124a — the census is three-valued and MUST reconcile. `answered` is not "priced": since
    // §2.124 the engine has a third answer, and folding it into either of the other two would report
    // scenarios nobody measured as measured. The arithmetic is the guard.
    ok(res.body.scenarios.answered
       === res.body.scenarios.eligible + res.body.scenarios.ineligible + res.body.scenarios.undetermined,
      `A4a the census reconciles: ${res.body.scenarios.answered} answered = ${res.body.scenarios.eligible} priced `
      + `+ ${res.body.scenarios.ineligible} declined + ${res.body.scenarios.undetermined} undetermined`);
    ok(res.body.scenarios.priced === res.body.scenarios.answered,
      'A4b …and the historic `priced` name still answers, so no existing reader breaks');
    // A4c CORRECTED, and the correction is the finding. The first cut asserted a healthy sheet leaves
    // NOTHING undetermined; it fails, and it SHOULD. A targeting scenario is built to make ONE rule
    // fire, so it carries that rule's facts and leaves the rest absent — measured on the real
    // Deephaven sheet, 209 of 261 come back `missing_price_bearing_fact`. So undetermined is the
    // NORMAL state of this census, not an alarm. What must never happen is it being folded into
    // `eligible` or `ineligible`, which is what §2.124 fixed and what A4a pins.
    // A4c IS FIXTURE-SPECIFIC ON PURPOSE, and the first version of it could not bite. Asserting only
    // that the arithmetic reconciles (A4a) is satisfied just as well by FOLDING the undetermined into
    // `ineligible` — which is precisely the §2.124 defect — because the sum is unchanged. Proven: that
    // mutation passed. On THIS fixture the engine can decide nothing, so the census must say exactly
    // that, and a fold now shows up as a declined count that was never a decline.
    ok(res.body.scenarios.undetermined === res.body.scenarios.answered
       && res.body.scenarios.ineligible === 0 && res.body.scenarios.eligible === 0,
      `A4c every scenario is reported as UNDETERMINED, never folded into declined (${res.body.scenarios.eligible} priced, `
      + `${res.body.scenarios.ineligible} declined, ${res.body.scenarios.undetermined} undetermined) — a targeting `
      + `scenario carries only its own rule's facts, so the engine refuses to price it rather than guess`);
    ok(!/applied by the pricer/.test(res.body.note || ''),
      'A4d …and the note no longer claims the PRICER applied every cell — reachability is read off the rule '
      + 'evaluation trace, which is built before any rung is priced');
    ok(res.body.scenarios.errorCount === 0, 'A5 …and none of them threw — a sheet the engine cannot price is a defect too');
    ok(/every encoded cell/i.test(res.body.note || ''), 'A6 …and it says so in words');

    // =========================================================================
    // B. THE TRANSPOSED BAND — the one this exists to catch
    // =========================================================================
    console.log('\nB. a cell no loan can ever land in\n');

    const bad = await buildSheet('B');
    await store.replaceAdjustments(db, SCOPE, bad.versionId, [
      { code: 'fico_ok', dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -250, priority: 0 },
      // Transposed: a minimum ABOVE its maximum. Loaded from a vendor sheet this looks entirely
      // ordinary in the row, and no loan can ever satisfy it.
      { code: 'fico_transposed', dimension: 'fico', ficoMin: 900, ficoMax: 800, adjMilli: -100, priority: 0 },
    ]);

    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: bad.versionId } }));
    ok(res.statusCode === 200, 'B1 the sheet is checked');
    ok(res.body.rules.unreachable.length === 1 && res.body.rules.unreachable[0].code === 'fico_transposed',
      'B2 the transposed cell is found and NAMED');
    ok(!!(res.body.rules.unreachable[0] || {}).reason, 'B3 …carrying a reason rather than a bare code');
    ok(res.body.rules.reachable === 1,
      'B4 …and its healthy neighbour is still reported reachable — the check is per cell, not per sheet');
    ok(/no loan can ever land/i.test(res.body.note || ''),
      'B5 …and the note says what an unreachable cell MEANS, in words a person can act on');

    // =========================================================================
    // C. IT DOES NOT TRUST THE GENERATOR
    // =========================================================================
    console.log('\nC. reachable means PRICED and APPLIED\n');

    // The rule is satisfiable on its face, so the generator targets it — but the pricer never applies
    // it, because a rule with no adjustment code cannot be found in the trace by code. Whatever the
    // cause, the honest report is a DISAGREEMENT between the two readings, not "covered".
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/t\.matched && t\.contribution/.test(src),
      'C1 the route counts a cell reachable only when the priced TRACE shows it matched and contributed');
    ok(/disagreed\.push/.test(src) && /disagreed/.test(JSON.stringify(res.body.rules)),
      'C2 …and a generator/pricer disagreement has its own bucket, separate from "unreachable"');

    // =========================================================================
    // D. FREE AND READ-ONLY
    // =========================================================================
    console.log('\nD. it costs nothing and changes nothing\n');

    ok(lpStub.calls === 0, 'D1 the Lender Price upstream was never called — this check is free');
    ok((await agreementStore.listForVersion(SCOPE, good.versionId, { db })).length === 0,
      'D2 …no agreement row was written: a coverage check is not a measurement against Lender Price');
    const still = (await db.query('SELECT status FROM lt_ppe_rate_sheet_version WHERE id = $1', [good.versionId])).rows[0];
    ok(still.status === 'draft', 'D3 …and the version is untouched');

    // A sheet with a grid and no rules at all is a legitimate sheet, and must not read as a failure.
    const bare = await buildSheet('N');
    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: bare.versionId } }));
    ok(res.statusCode === 200 && res.body.rules.total === 0 && /nothing whose reachability/i.test(res.body.note || ''),
      'D4 a sheet with no adjustment rules answers plainly rather than reporting an empty failure');

    // =========================================================================
    // E. THE ORDINARY REFUSALS
    // =========================================================================
    console.log('\nE. ownership and the refusals\n');

    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: '00000000-0000-0000-0000-000000000000' } }));
    ok(res.statusCode === 404, 'E1 an unknown version is a 404');

    const other = await buildSheet('O', OTHER_SCOPE);
    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: other.versionId } }));
    ok(res.statusCode === 404, 'E2 another tenant\'s sheet is not readable through this door');

    const noGrid = await store.createRateSheetVersion(db, SCOPE, { programId: good.programId, versionNo: 2, channel: 'correspondent' });
    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: noGrid.id } }));
    ok(res.statusCode === 422 && res.body.reason === 'program_has_no_base_grid',
      'E3 a sheet with no grid is refused, naming why');

    // =========================================================================
    // F. A SHEET OUR OWN ENGINE CANNOT PRICE
    // =========================================================================
    console.log('\nF. when the scenarios cannot be priced at all\n');

    // The exact shape this repo has already been bitten by: a price limit whose rounding mode the
    // pricer does not accept makes `quoteProgram` THROW on every scenario, which the shadow façade
    // then records as an engine_error finding on every quote. A coverage report that counted those
    // cells "reachable" — the generator said so, after all — would send somebody to publish a sheet
    // that cannot be priced at all.
    const unpriceable = await buildSheet('X');
    await store.replaceAdjustments(db, SCOPE, unpriceable.versionId, [
      { code: 'fico_700_739', dimension: 'fico', ficoMin: 700, ficoMax: 739, adjMilli: -250, priority: 0 },
    ]);
    await store.setPriceLimit(db, SCOPE, unpriceable.versionId, {
      minPriceMilli: 98000, roundingMode: 'bananas', roundingIncrementMilli: 125, capTiers: [],
    });

    res = await call(H.rateSheetCoverageRoute, REQ({ params: { id: unpriceable.versionId } }));
    ok(res.statusCode === 200, 'F1 the check still answers rather than throwing');
    ok(res.body.scenarios.errorCount > 0 && /rounding/i.test((res.body.scenarios.errors[0] || {}).error || ''),
      'F2 every failed pricing is REPORTED with its reason — never swallowed into a clean-looking report');
    ok(res.body.rules.reachable === 0 && res.body.rules.disagreed.length === 1,
      'F3 …and no cell is called reachable on a sheet the engine cannot price');
    ok(/could not be priced/i.test((res.body.rules.disagreed[0] || {}).reason || ''),
      'F4 …the reason naming the pricing failure, not a phantom coverage gap');
    // §2.125 — a THREW and an UNDETERMINED scenario both "could not be priced", and telling them apart
    // is the point: one is the engine falling over on this sheet (a defect in the sheet), the other is
    // it refusing on a fact the targeting scenario never carried (not a defect at all).
    ok((res.body.rules.disagreed[0] || {}).threw === true && /THREW/.test((res.body.rules.disagreed[0] || {}).reason || ''),
      'F5 …and it is marked as a THROW, so it is never confused with a scenario the engine declined to price');
  } finally {
    await cleanup();
    if (typeof db.end === 'function') await db.end().catch(() => {});
  }


    // =========================================================================
    // G. THE REASON A REACHED CELL DID NOT LAND — three states, never one (§2.125)
    // =========================================================================
    // The healthy fixture reports no disagreements at all, so nothing in this suite could ever see
    // this wording — which is why reverting it to the old single sentence failed ZERO assertions when
    // it was mutated. The rule is pure and is asserted directly.
    console.log('\nG. why a reached cell did not land\n');
    {
      const reasonOf = route._internals.coverageCellReason;
      ok(/UNTESTED/.test(reasonOf(true, false)) && /could not be priced/.test(reasonOf(true, false)),
        'G1 a cell on a scenario the engine could NOT PRICE is reported as UNTESTED — the pricer was never asked, '
        + 'so it cannot have skipped anything');
      ok(!/pricer did not apply/.test(reasonOf(true, false)),
        'G2 …and it never blames the pricer for a run that never happened — MEASURED: 10 of the 18 such cells on '
        + 'the real Deephaven sheet are exactly this case');
      ok(/not a defect in the cell/.test(reasonOf(true, false)),
        'G3 …and says plainly that it is not a fault in the cell, so nobody edits a rule that is fine');
      ok(/pricer did not apply/.test(reasonOf(true, true)),
        'G4 a cell the pricer DID run on and skipped is still reported as the real disagreement it is');
      ok(/not in the priced trace at all/.test(reasonOf(false, true)),
        'G5 …and a rule absent from the trace is its own third state');
      ok(reasonOf(true, false) !== reasonOf(true, true) && reasonOf(true, true) !== reasonOf(false, true),
        'G6 the three states are three different sentences — collapsing any two is the conflation this closes');
    }

  console.log(`\n${failures ? `${failures} FAILED` : 'ok - lt ppe rate-sheet coverage (all passed)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
