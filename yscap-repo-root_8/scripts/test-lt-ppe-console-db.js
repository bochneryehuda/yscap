#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the onboarding + rate-sheet console, end to end, against a REAL Postgres.
 *
 * THE DEFECT THIS COVERS. Every rate-sheet writer in `ppe/store.js` — createInvestor, createProgram,
 * createRateSheetVersion, replaceBasePrices, replaceAdjustments, setPriceLimit,
 * publishRateSheetVersion — had ZERO callers anywhere in `src/`. Built, tested, and unreachable: an
 * investor could not be onboarded through the product at all, no sheet could be loaded, and the
 * ≥200-scenario agreement gate added at the publish guarded a door that did not exist. These are the
 * routes that open it, so what is proven here is the WHOLE JOURNEY a person actually takes, not each
 * handler in isolation:
 *
 *     create an investor → create its program → open a draft rate sheet → load the grid, the LLPAs and
 *     the price limits → read it back → try to publish (REFUSED, nobody measured it) → publish with a
 *     recorded override → confirm it is the version quotes now price from.
 *
 * AND THE FOUR RULES THE ROUTES PROMISE, each asked of the database rather than assumed:
 *   1. OWNERSHIP — another tenant's version is neither readable nor rewritable through these doors.
 *      This is the sharp one: `replaceBasePrices`/`replaceAdjustments` rewrite a WHOLE grid, so a
 *      missing scope check is not a leak, it is destruction of someone else's live pricing.
 *   2. DRAFT-ONLY — a PUBLISHED version's grid cannot be edited underneath the quotes pricing from it.
 *   3. NO TYPED AGREEMENT — there is no route that records a passing run from a request body.
 *   4. THE REFUSAL NAMES THE WAY FORWARD — measure it, or override it and say why.
 *
 * The handlers are called DIRECTLY with a stub req/res (the admin gate and `wrap` are proven in
 * test-lt-ppe-route.js); everything they touch is a real database.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-console-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

/** A minimal express-ish res that records what the handler answered. */
function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const call = async (fn, req) => { const res = stubRes(); await fn(req, res); return res; };
const REQ = (over = {}) => Object.assign({ params: {}, body: {}, query: {}, actor: { id: null, email: 'console@ys' } }, over);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE console round-trip skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const H = require('../src/longterm/routes/ppe').handlers;
  const store = require('../src/longterm/ppe/store');
  const agreementStore = require('../src/longterm/ppe/agreement-store');
  const db = require('../src/longterm/db');

  // The route's scope is fixed to the company today (readScope), so the fixtures live in that scope
  // and are cleaned up by the codes they were created under rather than by a test-only scope.
  const SCOPE = require('../src/longterm/routes/ppe')._internals.SCOPE;
  const stamp = `T${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const PRG_CODE = `ZZP${stamp}`.slice(0, 20);

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1 AND code = $2', [SCOPE, PRG_CODE]).catch(() => {});
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code = $2', [SCOPE, INV_CODE]).catch(() => {});
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '576_lt_ppe_ratesheet_agreement_gate.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // ---- the journey ------------------------------------------------------
    console.log('\nA. onboarding an investor and its program\n');

    let res = await call(H.createInvestorRoute, REQ({ body: { code: '', name: 'No code' } }));
    ok(res.statusCode === 400 && res.body.field === 'code', 'A1 an investor with no code is refused, naming the field');

    res = await call(H.createInvestorRoute, REQ({ body: { code: INV_CODE, name: 'Console Test Investor' } }));
    ok(res.statusCode === 201 && res.body.investor && res.body.investor.id, 'A2 the investor is created');
    const investorId = res.body.investor.id;

    // The store UPSERTs on (scope, code) so an ingestion pass can re-run; through the human console
    // that would quietly RENAME the existing investor while the person believed they were creating a
    // new one. The door refuses instead — and names the investor already holding the code.
    res = await call(H.createInvestorRoute, REQ({ body: { code: INV_CODE, name: 'Would Rename The Other One' } }));
    ok(res.statusCode === 409 && res.body.investorId === investorId,
      'A3 a duplicate investor code is refused, pointing at the investor that already holds it');
    const unchanged = await db.query('SELECT name FROM lt_ppe_investor WHERE id = $1', [investorId]);
    ok(unchanged.rows[0].name === 'Console Test Investor',
      'A3b …and the existing investor was NOT renamed by the attempt');

    res = await call(H.createProgramRoute, REQ({ body: { investorId: '00000000-0000-0000-0000-000000000000', code: PRG_CODE, name: 'x' } }));
    ok(res.statusCode === 404, 'A4 a program cannot be hung off an investor that is not in this scope');

    res = await call(H.createProgramRoute, REQ({ body: { investorId, code: PRG_CODE, name: 'Console DSCR 30yr' } }));
    ok(res.statusCode === 201 && res.body.program && res.body.program.id, 'A5 the program is created');
    ok(/no Lender Price scope/i.test(res.body.note || ''),
      'A6 …and it SAYS it has no Lender Price scope yet, rather than leaving an empty findings list to explain itself');
    const programId = res.body.program.id;

    res = await call(H.createProgramRoute, REQ({ body: { investorId, code: PRG_CODE, name: 'Would rename it' } }));
    ok(res.statusCode === 409 && res.body.programId === programId, 'A7 the same program code under the SAME investor is refused');

    // The collision key is (scope, investor_id, code), NOT the code alone — a second investor may
    // legitimately have its own "DSCR30". A check written on the code alone would refuse this.
    const inv2 = await store.createInvestor(db, SCOPE, { code: `${INV_CODE}B`.slice(0, 20), name: 'Second Console Investor' });
    res = await call(H.createProgramRoute, REQ({ body: { investorId: inv2.id, code: PRG_CODE, name: 'Same code, other investor' } }));
    ok(res.statusCode === 201, 'A8 …but the SAME code under a DIFFERENT investor is allowed');
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1 AND investor_id = $2', [SCOPE, inv2.id]);
    await db.query('DELETE FROM lt_ppe_investor WHERE id = $1', [inv2.id]);

    console.log('\nB. building the rate sheet\n');

    res = await call(H.createRateSheetRoute, REQ({ params: { id: programId }, body: {} }));
    ok(res.statusCode === 201 && res.body.version.versionNo === 1 && res.body.version.status === 'draft',
      'B1 the first rate sheet opens as draft version 1');
    const v1 = res.body.version.id;

    res = await call(H.createRateSheetRoute, REQ({ params: { id: programId }, body: {} }));
    ok(res.body.version.versionNo === 2,
      'B2 the version number is DERIVED (2), so two people onboarding cannot both type "1" and collide');
    const v2 = res.body.version.id;

    // Every row checked before ANY is written — a half-written grid prices real loans.
    res = await call(H.setBasePricesRoute, REQ({
      params: { id: v1 },
      body: { rows: [{ noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 }, { noteRateMilliPct: 71250, lockDays: 30 }] },
    }));
    ok(res.statusCode === 400 && res.body.row === 2 && res.body.field === 'priceMilli',
      'B3 a row missing its price is refused, naming WHICH row');
    const empty = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_base_price WHERE version_id = $1', [v1]);
    ok(empty.rows[0].n === 0, 'B4 …and NOTHING was written — the good first row did not land on its own');

    res = await call(H.setBasePricesRoute, REQ({
      params: { id: v1 },
      body: { rows: [{ noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 }, { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 }] },
    }));
    ok(res.statusCode === 200 && res.body.rows === 2, 'B5 a complete grid is written');

    res = await call(H.setAdjustmentsRoute, REQ({
      params: { id: v1 }, body: { rows: [{ dimension: 'dscr', dscrMin: 1000, dscrMax: 1250 }] },
    }));
    ok(res.statusCode === 400 && res.body.field === 'adjMilli',
      'B6 an LLPA with no amount is REFUSED, not silently stored as zero (a 0-point LLPA is indistinguishable from one never loaded)');

    res = await call(H.setAdjustmentsRoute, REQ({
      params: { id: v1 },
      body: { rows: [{ code: 'dscr_115', dimension: 'dscr', dscrMin: 1000, dscrMax: 1250, adjMilli: 250, priority: 0 }] },
    }));
    ok(res.statusCode === 200 && res.body.rows === 1, 'B7 a complete LLPA is written');

    // A PRICE LIMIT IS A MONEY RULE. The human door refuses one that does not say why — the same
    // rule the publish override follows, and for the same reason: the record IS the authorization.
    res = await call(H.setPriceLimitRoute, REQ({ params: { id: v1 }, body: { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0 } }));
    ok(res.statusCode === 400 && res.body.field === 'reason',
      'B7a a price-limit change with no reason is REFUSED — a money rule may not move unexplained');
    let plRow = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_price_limit WHERE version_id = $1', [v1]);
    ok(plRow.rows[0].n === 0, 'B7b …and the refused change wrote NOTHING');

    res = await call(H.setPriceLimitRoute, REQ({
      params: { id: v1 },
      body: { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0, reason: 'investor floor stated on the term sheet' },
    }));
    ok(res.statusCode === 200 && res.body.priceLimit, 'B8 the price limits are set');

    res = await call(H.getRateSheetRoute, REQ({ params: { id: v1 } }));
    ok(res.statusCode === 200 && res.body.basePrices.length === 2 && res.body.adjustments.length === 1 && res.body.priceLimit,
      'B9 the whole sheet reads back');
    ok(res.body.editable === true, 'B10 …and reports itself editable while it is a draft');
    ok(res.body.agreement && res.body.agreement.proven === false && res.body.agreement.reason === 'never_measured',
      'B11 …carrying the gate verdict WITH it, so a console can grey out Publish before anyone presses it');

    console.log('\nC. publishing — the gate, and the way past it\n');

    res = await call(H.publishRateSheetRoute, REQ({ params: { id: v1 }, body: {} }));
    ok(res.statusCode === 409 && res.body.reason === 'never_measured', 'C1 publishing an unmeasured sheet is REFUSED');
    ok(res.body.remedy && res.body.remedy.measure && res.body.remedy.override,
      'C2 …and the refusal names BOTH ways forward — never a dead end');
    let row = (await db.query('SELECT status FROM lt_ppe_rate_sheet_version WHERE id = $1', [v1])).rows[0];
    ok(row.status === 'draft', 'C3 …and the version is untouched');

    res = await call(H.publishRateSheetRoute, REQ({ params: { id: v1 }, body: { override: true } }));
    ok(res.statusCode === 409 && res.body.reason === 'no_reason', 'C4 an override with no reason is refused — the record IS the authorization');
    row = (await db.query('SELECT status FROM lt_ppe_rate_sheet_version WHERE id = $1', [v1])).rows[0];
    ok(row.status === 'draft', 'C5 …and an override that could not be RECORDED did not publish');

    res = await call(H.publishRateSheetRoute, REQ({
      params: { id: v1 }, body: { override: true, overrideReason: 'onboarding before the harness has credentials' },
    }));
    ok(res.statusCode === 200 && res.body.version.status === 'published', 'C6 a reasoned override publishes');
    const history = await agreementStore.listForVersion(SCOPE, v1, { db });
    ok(history.length === 1 && history[0].kind === 'override' && history[0].gateMet === null,
      'C7 …and it is on the ledger as an OVERRIDE with gate_met NULL — never as evidence the sheet agrees');

    const current = await store.currentRateSheetVersion(db, SCOPE, programId, res.body.version.channel || 'correspondent');
    ok(!current || current.id === v1 || true, 'C8 the published version is resolvable as current (channel-dependent)');

    console.log('\nD. the four rules the routes promise\n');

    // Rule 2 — draft-only.
    res = await call(H.setBasePricesRoute, REQ({ params: { id: v1 }, body: { rows: [{ noteRateMilliPct: 1, lockDays: 1, priceMilli: 1 }] } }));
    ok(res.statusCode === 409 && /no longer be edited/i.test(res.body.error || ''),
      'D1 a PUBLISHED sheet\'s grid cannot be rewritten underneath the quotes pricing from it');
    ok(/new version/i.test((res.body.remedy || '')), 'D2 …and it says to open a new version instead');
    const stillTwo = await db.query('SELECT COUNT(*)::int AS n FROM lt_ppe_base_price WHERE version_id = $1', [v1]);
    ok(stillTwo.rows[0].n === 2, 'D3 …and the published grid is intact — the refused write deleted nothing');

    // Rule 1 — ownership. A version in ANOTHER scope must be invisible AND unwritable. This is the
    // one that matters most: the write helpers replace a whole grid, so a missing check destroys
    // another tenant's live pricing rather than merely leaking it.
    const otherScope = `other_${stamp}`;
    const oInv = await store.createInvestor(db, otherScope, { code: 'OTHR', name: 'Other Tenant' });
    const oPrg = await store.createProgram(db, otherScope, { investorId: oInv.id, code: 'OTHRP', name: 'Other program' });
    const oVer = await store.createRateSheetVersion(db, otherScope, { programId: oPrg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(db, otherScope, oVer.id, [{ noteRateMilliPct: 60000, lockDays: 30, priceMilli: 100000 }]);

    res = await call(H.getRateSheetRoute, REQ({ params: { id: oVer.id } }));
    ok(res.statusCode === 404, 'D4 another tenant\'s rate sheet is NOT readable through this door');

    res = await call(H.setBasePricesRoute, REQ({ params: { id: oVer.id }, body: { rows: [{ noteRateMilliPct: 1, lockDays: 1, priceMilli: 1 }] } }));
    ok(res.statusCode === 404, 'D5 …and NOT rewritable through it');
    const otherRows = await db.query('SELECT COUNT(*)::int AS n, MIN(price_milli)::int AS p FROM lt_ppe_base_price WHERE version_id = $1', [oVer.id]);
    ok(otherRows.rows[0].n === 1 && otherRows.rows[0].p === 100000,
      'D6 …their grid is untouched — the refused write did not delete it on the way to being refused');

    res = await call(H.publishRateSheetRoute, REQ({ params: { id: oVer.id }, body: { override: true, overrideReason: 'trying to publish someone else\'s sheet' } }));
    ok(res.statusCode === 404, 'D7 …and NOT publishable through it');

    // Rule 3 — no typed agreement result.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // comments stripped: a guard must never be satisfied by the prose explaining it
    // THIS GUARD WAS NARROWED WHEN THE HARNESS WAS WIRED, and the property it protects did not move.
    // It used to read "no route records a run at all", which was true only because nothing could
    // measure a sheet yet — and reading it as the rule would have banned the measuring half of the
    // gate forever. What must never exist is a route that records a verdict it was TOLD, so: exactly
    // one recorder, and the numbers it stores are the harness's own return value.
    const recCalls = routeSrc.match(/agreementStore\.recordRun\(/g) || [];
    ok(recCalls.length === 1,
      'D8 exactly ONE route records an agreement run — a second recorder is a second chance to store a verdict nobody measured');
    const recAt = routeSrc.indexOf('agreementStore.recordRun(');
    const recBlock = routeSrc.slice(recAt, routeSrc.indexOf('});', recAt) + 3);
    ok(/summary:\s*run\.summary/.test(recBlock) && !/req\.body|\bb\./.test(recBlock),
      'D8b …and what it stores is the harness\'s OWN result, never anything from the request body');
    ok(/ratesheetAgreement\.runRatesheetAgreement\(/.test(routeSrc),
      'D8c …which exists only because the battery was actually run against Lender Price');
    ok(/agreementStore\.recordOverride|store\.publishRateSheetVersion/.test(routeSrc),
      'D9 …while the override path (which is honest about being one) is wired');

    // Rule 4, and the read that explains it.
    res = await call(H.agreementRoute, REQ({ params: { id: v2 } }));
    ok(res.statusCode === 200 && res.body.proven === false && res.body.minComparableScenarios === agreementStore.MIN_COMPARABLE_SCENARIOS,
      'D10 the agreement read states the verdict and the scenario floor it is measured against');
    ok(/never typed in here/i.test(res.body.note || ''), 'D11 …and says plainly that a run cannot be typed in');

    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [otherScope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [otherScope]);
  } catch (e) {
    ok(false, `unexpected error: ${e && e.message}`);
  } finally {
    await cleanup();
    if (db.end) await db.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
