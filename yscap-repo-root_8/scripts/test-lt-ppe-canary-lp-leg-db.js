#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE CANARY'S LENDER PRICE LEG, AND WHAT A RUN THAT COMPARED NOTHING IS ALLOWED TO REPORT.
 *
 * THE DEFECT THIS EXISTS FOR. The canary battery (`routes/ppe.js runBattery`) wired its Lender Price
 * leg as `theirs: (sc) => lp.price(sc)` — the RAW VENDOR ENVELOPE (`{ ok, raw, request, searchKey,
 * provenance }`), not a comparable ladder. An envelope carries no `eligible` flag and no rungs, so
 * `parity.isComparable` correctly read it as "this engine produced no result" and EVERY scenario came
 * back `incomparable`. Measured here on the canonical battery
 * (`agreement-scenarios.buildAgreementScenarios`, 299 scenarios): 299 incomparable, 0 comparable,
 * `agreementRate` NULL — and the run was still persisted into the series the go-live gate reads, and
 * the endpoint still answered 200. A green canary that compared nothing.
 *
 * IT READ AS CORRECT because `lp.price` is a scenario-taking async function returning an object, which
 * is exactly what the leg's signature asks for. And the ROUTE SUITE'S OWN STUB HID IT, backwards: it
 * answered `price()` with `{ rungs:[…] }` — a shape the real client has never produced — so the
 * mis-wiring passed, and CORRECTING the wiring would have turned that suite red. That stub now fakes
 * only the network call and takes every reading function from the real client; section A2 below is the
 * standing guard that it can never go back.
 *
 * WHAT IS PROVEN HERE
 *   A  the defect, on the real battery — the control that pins the shape the fix prevents
 *   B  `buildCanaryLpLeg` refuses what it cannot honestly answer, BY NAME
 *   C  the scope is really applied — the drifted second copy of the program matcher
 *   D  `canary.verdictOf` — did this run compare anything at all
 *   E  the fixed leg on the real battery — comparable, and a measured rate
 *   F  (DB) the route, end to end on a real Postgres: a real run is persisted and says it is proven
 *   G  (DB) a run that compared NOTHING is refused, is NOT in the run series, and its diagnosis IS kept
 *   H  (DB) a sheet with no Lender Price scope is refused before anything is priced
 *
 * The DB sections need DATABASE_URL; without one they SKIP and the pure sections still run.
 *
 * DELIBERATELY NOT COVERED HERE, AND WHY — so the next person does not read a gap as a guarantee:
 *
 *   · THE CANARY ROUTE'S **OUR** LEG DOES NOT CONVERT LENDER PRICE-SHAPED SCENARIOS. `runBattery`
 *     prices `quote.quoteProgram({ scenario: sc, … })` with the scenario object it was handed, while
 *     the AGREEMENT route bridges the two vocabularies with `buildOursLeg({ factsFromLp: true })`.
 *     The canary's documented battery is `scenario-matrix.buildMatrix`, which already emits engine
 *     facts, so the two agree on the shape /canary is contractually given — but nothing REFUSES an
 *     LP-shaped scenario array posted to it, and our leg would silently misread one (section F feeds
 *     exactly that, which is why its agreement rate is 0 and why F4 asserts only that a NUMBER was
 *     measured). Which shape `POST /canary { scenarios: [...] }` is meant to accept is not stated
 *     anywhere in the code, and picking one would change what an existing caller's battery means.
 *     RAISE IT rather than guessing.
 *
 *   · THE LENDER PRICE SCOPE IS NOT INFERRED, EVER. Which of Lender Price's programs one of OUR rate
 *     sheets corresponds to is a fact about somebody else's product catalogue; `lp-scope.js` says it
 *     is stated by a human on the program row (db/574) and this change keeps it that way — an
 *     unscoped sheet is REFUSED, never defaulted. The consequence, stated plainly: a program row that
 *     has no `lp_*` columns cannot run a canary until somebody names its scope, and the refusal says
 *     so and how.
 *
 * LT-only. No RTL imports.
 */

const path = require('path');
const assert = require('assert');

let failures = 0;
let checks = 0;
function ok(c, label) { checks += 1; console.log(`${c ? '  ok  ' : ' FAIL '} ${label}`); if (!c) failures += 1; }
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }

// ---------------------------------------------------------------------------
// A stubbed Lender Price CLIENT whose only fake part is the network call.
// ---------------------------------------------------------------------------
//
// Every reading function is the REAL client's, so a leg that skips the parse cannot be handed a shape
// it happens to understand. `price()` resolves with the real envelope, and reports a refusal IN BAND
// (`{ ok:false, reason }`) exactly as the real one does rather than throwing.
const P = (rel) => require.resolve(path.join(__dirname, '..', 'src', 'longterm', rel));
const realLp = require('../src/longterm/lenderprice/client');

function lpLeaf(rate, price, programName) {
  return {
    rate, adjustedPoints: Math.round((100 - price) * 1000) / 1000,
    basePoints: 0, adjustmentPoints: 0, apr: rate + 0.2,
    programName, productName: 'DSCR30', companyName: 'Deephaven',
    dayLock: 30, term: 360, loanAmount: 400000,
    ratePeriod: { validAsOf: '2026-08-01', expired: false, name: 'Sheet A', id: 'rp1' },
  };
}
// One searchRaw body carrying one program group per entry of `groups`.
function lpRaw(groups) {
  return {
    search: { date: '2026-08-17T12:00:00Z' },
    results: {
      lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Deephaven', shortName: 'DHVN' }] },
      qualifiedNonQMData: {
        childs: groups.map(([programName, rungs]) => ({
          type: 'CriteriaFromLineResultKey', keyLabel: programName,
          childs: [{
            type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"',
            leafs: rungs.map(([rate, price]) => lpLeaf(rate, price, programName)),
          }],
        })),
      },
    },
  };
}

const IN_SCOPE = 'DSCR  >= 1.25  - 30 Yr Fixed';     // matches /DSCR .* 30 Yr Fixed/i
const OUT_OF_SCOPE = 'Expanded Prime 40 Yr IO';       // does not
const SCOPE = { programLike: 'DSCR .* 30 Yr Fixed' };

// The sheet under test prices ONE rung; the capture states the SAME deal, so a correctly-wired leg
// AGREES and a wrongly-wired one is incomparable — the two outcomes are never both noise.
const RUNGS = [[7.0, 101.5], [7.125, 102.85], [7.25, 104.0]];

function makeLpStub(opts = {}) {
  const stub = {
    ...realLp,
    calls: [],
    ok: opts.ok !== false,
    raw: opts.raw || lpRaw([[IN_SCOPE, RUNGS]]),
    refusal: opts.refusal || { ok: false, reason: 'lp_scenario_invalid', message: 'county is required' },
  };
  stub.price = async (sc) => {
    stub.calls.push(sc);
    if (!stub.ok) return stub.refusal;
    return { ok: true, raw: stub.raw, request: { url: 'x', body: {} }, searchKey: 'k', provenance: {}, recovered: false };
  };
  return stub;
}

const canary = require('../src/longterm/ppe/canary');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const agreementScenarios = require('../src/longterm/ppe/agreement-scenarios');
const lpNormalize = require('../src/longterm/ppe/lp-normalize');

// OUR side: a real program priced by the real pricer. Milli-percent rates (7.125% -> 7125), milli-point
// prices (102.850 -> 102850) — the canonical units lp-normalize converts Lender Price's into.
const PROGRAM = {
  code: 'v-canary-leg', name: 'DSCR 30yr',
  baseGrid: [
    { rate: 7000, lockDays: 30, basePriceMilli: 101500 },
    { rate: 7125, lockDays: 30, basePriceMilli: 102850 },
    { rate: 7250, lockDays: 30, basePriceMilli: 104000 },
  ],
  rules: [],
};
const SETTINGS = { 'pricing.rounding_mode': 'none', 'pricing.correspondent_margin_milli': 0 };

const BATTERY = agreementScenarios.buildAgreementScenarios().scenarios;
// The battery is LENDER PRICE scenarios; our engine speaks facts. `buildOursLeg({factsFromLp:true})` is
// the bridge the agreement route already uses — reused here so the LP leg is the ONLY variable.
const OURS = legs.buildOursLeg(PROGRAM, SETTINGS, { factsFromLp: true });
const RUN_OPTS = { investor: 'DHVN', program: PROGRAM, nowMs: 1_760_000_000_000, priceToleranceMilli: 1, rateToleranceMilli: 0, concurrency: 8 };

console.log('LT PPE — the canary\'s Lender Price leg');

(async () => {
  // =========================================================================
  // A) THE DEFECT, ON THE REAL BATTERY
  // =========================================================================
  console.log('\nA) the raw envelope as the LP leg — the defect this closes');
  {
    const lp = makeLpStub();
    const run = await canary.runCanary(BATTERY, { ours: OURS, theirs: (sc) => lp.price(sc) }, RUN_OPTS);

    ok(BATTERY.length >= 200, `A0 the canonical battery is the real one (${BATTERY.length} scenarios, the owner's >=200 rule)`);
    eq(run.summary.incomparable, BATTERY.length, 'A1 EVERY scenario is incomparable when the leg is the raw envelope');
    eq(run.summary.comparable, 0, 'A2 …so nothing at all was compared');
    eq(run.agreementRate, null, 'A3 …and the agreement rate is NULL, not a score');
    eq(run.runRecord.agreementRate, null, 'A4 …which is exactly what would be written into the run series');
    ok(run.findingKeys.length > 0 && run.records.every((r) => r.kind === 'incomparable'),
      'A5 …and every finding recorded is `incomparable` — a diagnosis, never a disagreement');
    eq(run.verdict.proven, false, 'A6 the run says PLAINLY that it proved nothing');
    ok(/compared NOTHING/.test(run.verdict.reason || ''), 'A7 …with a reason a human can act on');
  }
  {
    // THE STANDING GUARD ON THE ROUTE SUITE'S STUB. Its old `{ rungs:[…] }` answer is a shape the real
    // client has never produced, and it is what let the mis-wiring stay green. This reads that suite's
    // source rather than its behaviour, because behaviour is exactly what it faked.
    const src = require('fs').readFileSync(path.join(__dirname, 'test-lt-ppe-route.js'), 'utf8');
    ok(/lpStub\.price\s*=\s*async[\s\S]{0,400}?ok:\s*true,\s*raw:/.test(src),
      'A8 GUARD the route suite\'s stub answers price() with a real ENVELOPE ({ok, raw}), not a bare ladder');
    ok(/\.\.\.realLp/.test(src),
      'A9 GUARD …and takes its reading functions from the real client, so it cannot agree with a wrong shape');
  }

  // =========================================================================
  // B) THE LEG REFUSES WHAT IT CANNOT HONESTLY ANSWER
  // =========================================================================
  console.log('\nB) buildCanaryLpLeg refuses, by name');
  {
    const lp = makeLpStub();
    let msg = null;
    try { legs.buildCanaryLpLeg(lp, {}); } catch (e) { msg = e.message; }
    ok(/scope is required/.test(msg || ''),
      `B1 no Lender Price scope is REFUSED at wiring time (${msg})`);

    msg = null;
    try { legs.buildCanaryLpLeg(lp, { scope: {} }); } catch (e) { msg = e.message; }
    ok(/scope is required/.test(msg || ''), 'B2 …and an EMPTY scope is not a scope (it would match everything)');

    msg = null;
    try { legs.buildCanaryLpLeg({ price: async () => ({}) }, { scope: SCOPE }); } catch (e) { msg = e.message; }
    ok(/parse\(\)/.test(msg || ''), `B3 a client with no parse() is refused — the chain cannot be completed (${msg})`);

    // A vendor refusal arrives IN BAND on the real client, and it is NOT an answer.
    const refusing = makeLpStub({ ok: false });
    const leg = legs.buildCanaryLpLeg(refusing, { scope: SCOPE });
    msg = null;
    try { await leg({ fico: 760 }); } catch (e) { msg = e.message; }
    ok(/LP price failed/.test(msg || '') && /county is required/.test(msg || ''),
      `B4 an ok:false refusal THROWS carrying the vendor's own reason, so the ledger records WHY (${msg})`);

    // …and an ok:true with no body is not an answer either.
    const empty = makeLpStub();
    empty.price = async () => ({ ok: true });
    msg = null;
    try { await legs.buildCanaryLpLeg(empty, { scope: SCOPE })({ fico: 760 }); } catch (e) { msg = e.message; }
    ok(/no search body/.test(msg || ''), `B5 an ok answer carrying no capture is refused too (${msg})`);
  }

  // =========================================================================
  // C) THE SCOPE IS REALLY APPLIED
  // =========================================================================
  console.log('\nC) the scope actually filters — the second copy of the matcher that had drifted');
  {
    // Lender Price answers one request with every program it sells. The capture below holds the DSCR
    // family AND an unrelated product; a comparison scoped to the family must never see the other one.
    const twoPrograms = lpRaw([[IN_SCOPE, RUNGS], [OUT_OF_SCOPE, [[9.5, 95.0]]]]);
    const lp = makeLpStub({ raw: twoPrograms });
    const ladder = await legs.buildCanaryLpLeg(lp, { scope: SCOPE })({ fico: 760 });

    eq(ladder.programsMatched, 1, 'C1 a programLike scope matches ONE of the two programs in the capture');
    ok(ladder.rungs.every((r) => r.rate !== 9500),
      'C2 …so the out-of-scope product\'s coupon is NOT in the ladder we compare against');
    eq(ladder.rungs.length, RUNGS.length, 'C3 …and every in-scope coupon is');

    // The bug this pins: `lp-normalize` carried its own three-key matcher and IGNORED programLike, so a
    // scope that reads as stated built no filter at all and merged the whole capture.
    const merged = lpNormalize.normalizeLpParsed(lp.parse(twoPrograms), {});
    eq(merged.programsMatched, 2, 'C4 CONTROL with NO scope the same capture merges both programs');
    ok(merged.rungs.some((r) => r.rate === 9500), 'C5 …and the unrelated coupon does leak in — which is what a scope prevents');

    // The two normalizers read the SAME stored scope; they must not disagree about what it selects.
    const lpFull = require('../src/longterm/ppe/lp-normalize-full');
    ok(lpFull.programMatches({ program: IN_SCOPE }, SCOPE) === true
       && lpFull.programMatches({ program: OUT_OF_SCOPE }, SCOPE) === false,
      'C6 the shallow and deep normalizers share ONE matcher, so a scope cannot mean two things');
  }

  // =========================================================================
  // D) THE VERDICT
  // =========================================================================
  console.log('\nD) canary.verdictOf — did this run compare anything at all');
  {
    const v = canary.verdictOf;
    eq(v({ scenarios: 10, comparable: 10, agreed: 10, disagreed: 0, incomparable: 0, errors: 0 }).proven, true,
      'D1 a run that compared ten scenarios is proven');
    eq(v({ scenarios: 10, comparable: 0, incomparable: 10, errors: 0 }).proven, false,
      'D2 an all-incomparable run is NOT proven');
    eq(v({ scenarios: 10, comparable: 10, agreed: 0, disagreed: 10, incomparable: 0, errors: 10 }).proven, false,
      'D3 a run where every scenario ERRORED is not proven either — a throw is not a comparison');
    eq(v({ scenarios: 10, comparable: 5, agreed: 1, disagreed: 4, incomparable: 5, errors: 4 }).compared, 1,
      'D4 `compared` is what was really compared: comparable less the engine errors');
    eq(v({ scenarios: 10, comparable: 5, agreed: 1, disagreed: 4, incomparable: 5, errors: 4 }).proven, true,
      'D5 …and ONE real comparison is enough to have proven something');
    eq(v({ scenarios: 0 }).proven, false, 'D6 an empty run proves nothing');
    ok(/no scenario was priced/.test(v({ scenarios: 0 }).reason), 'D7 …and says why in plain words');
    eq(v(null).proven, false, 'D8 a missing summary is not a proven run (never throws)');
    ok(/could not be compared/.test(v({ scenarios: 3, comparable: 0, incomparable: 3, errors: 0 }).reason),
      'D9 the reason names WHICH way it failed — incomparable vs errored');
    ok(/engine error/.test(v({ scenarios: 3, comparable: 3, disagreed: 3, incomparable: 0, errors: 3 }).reason),
      'D10 …and the other way too');
  }

  // =========================================================================
  // E) THE FIXED LEG, ON THE REAL BATTERY
  // =========================================================================
  console.log('\nE) the fixed leg on the same 299-scenario battery');
  {
    const lp = makeLpStub();
    const run = await canary.runCanary(
      BATTERY, { ours: OURS, theirs: legs.buildCanaryLpLeg(lp, { scope: SCOPE }) }, RUN_OPTS,
    );
    eq(run.summary.incomparable, 0, 'E1 no scenario is incomparable any more');
    eq(run.summary.comparable, BATTERY.length, 'E2 …every scenario in the battery was actually compared');
    ok(typeof run.agreementRate === 'number', `E3 …so the agreement rate is a MEASURED number (${run.agreementRate})`);
    eq(run.verdict.proven, true, 'E4 …and the run reports itself as proven');
    eq(lp.calls.length, BATTERY.length, 'E5 Lender Price was asked once per scenario');
  }

  // =========================================================================
  // DB sections
  // =========================================================================
  if (!process.env.DATABASE_URL) {
    console.log('\n(F-H) DATABASE_URL is not set — the route sections are SKIPPED (the pure sections above ran).');
    return finish();
  }

  // The route reads the LIVE Lender Price client through require(); stub the NETWORK only, before the
  // route module is loaded, and leave the database REAL — this is the half a pure test cannot prove.
  const routeLp = makeLpStub();
  require.cache[P('lenderprice/client.js')] = {
    id: P('lenderprice/client.js'), filename: P('lenderprice/client.js'), loaded: true, exports: routeLp,
  };
  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const db = require('../src/longterm/db');

  function mkRes() {
    const res = { code: 200, body: null, headersSent: false };
    res.status = (c) => { res.code = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    return res;
  }
  // Called the way the ROUTER calls it: a throw becomes a 500 answer rather than crashing the suite.
  // A crashing test also "fails" and looks like proof while saying nothing about what a caller receives.
  const call = async (fn, req) => {
    const res = mkRes();
    try { await fn(req || {}, res); } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
    }
    return res;
  };

  const seeded = { investorId: null, programId: null, versionId: null };
  const INVESTOR_CODE = `CANLEG${Date.now() % 100000}`;

  async function seed(lpScopeCols) {
    const inv = await db.query(
      'INSERT INTO lt_ppe_investor (scope, code, name) VALUES ($1,$2,$3) RETURNING id',
      ['company', INVESTOR_CODE, 'Canary leg test investor'],
    );
    seeded.investorId = inv.rows[0].id;
    const prog = await db.query(
      `INSERT INTO lt_ppe_program (scope, investor_id, code, name, lp_program_like)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ['company', seeded.investorId, `${INVESTOR_CODE}-DSCR`, 'DSCR 30yr', lpScopeCols.lp_program_like || null],
    );
    seeded.programId = prog.rows[0].id;
    const ver = await db.query(
      `INSERT INTO lt_ppe_rate_sheet_version (scope, program_id, version_no, status)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      ['company', seeded.programId, 1, 'draft'],
    );
    seeded.versionId = ver.rows[0].id;
    for (const g of PROGRAM.baseGrid) {
      await db.query(
        `INSERT INTO lt_ppe_base_price (scope, version_id, note_rate_milli_pct, lock_days, product, price_milli)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ['company', seeded.versionId, g.rate, g.lockDays, 'DSCR30', g.basePriceMilli],
      );
    }
    return seeded.versionId;
  }
  async function cleanup() {
    // programLabel() collapses the loaded program to its CODE, which is the version id.
    if (seeded.versionId) {
      await db.query('DELETE FROM lt_ppe_shadow_run WHERE scope = $1 AND program = $2', ['company', seeded.versionId]);
      await db.query('DELETE FROM lt_ppe_base_price WHERE version_id = $1', [seeded.versionId]);
      await db.query('DELETE FROM lt_ppe_rate_sheet_version WHERE id = $1', [seeded.versionId]);
    }
    await db.query('DELETE FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', ['company', INVESTOR_CODE]);
    if (seeded.programId) await db.query('DELETE FROM lt_ppe_program WHERE id = $1', [seeded.programId]);
    if (seeded.investorId) await db.query('DELETE FROM lt_ppe_investor WHERE id = $1', [seeded.investorId]);
    seeded.versionId = null; seeded.programId = null; seeded.investorId = null;
  }
  const runRows = () => db.query(
    'SELECT agreement_rate, summary FROM lt_ppe_shadow_run WHERE scope = $1 AND program = $2',
    ['company', seeded.versionId],
  ).then((r) => r.rows);

  // A small battery: this section is about the ROUTE's behaviour, and 299 live calls prove nothing more
  // than 6 do about persistence. The 299-scenario proof is section E.
  const SMALL = BATTERY.slice(0, 6);

  try {
    // =======================================================================
    // F) THE ROUTE, END TO END, ON A REAL POSTGRES
    // =======================================================================
    console.log('\nF) the canary route on a real database — a run that really compared something');
    await seed({ lp_program_like: SCOPE.programLike });
    routeLp.ok = true; routeLp.calls = [];

    let r = await call(H.canaryRoute, {
      body: { investor: INVESTOR_CODE, rateSheetVersionId: seeded.versionId, scenarios: SMALL },
    });
    eq(r.code, 200, `F1 a scoped canary with a real sheet answers 200 (${(r.body && r.body.error) || 'ok'})`);
    eq(r.body.proven, true, 'F2 …and states that it proved something');
    eq(r.body.summary.incomparable, 0, 'F3 …with nothing left incomparable');
    // WHAT MATTERS HERE IS THAT IT IS A NUMBER, NOT WHAT THE NUMBER IS. The route's `ours` leg prices
    // the scenario object it is GIVEN, and this section feeds it Lender Price-shaped scenarios (the
    // canonical battery) rather than the engine-facts shape `scenario-matrix` produces — so the two
    // legs are describing the same deal in different vocabularies and disagree by construction. The
    // agreement rate itself is proven on the real battery in section E, with both legs bridged the way
    // the agreement route bridges them. Here the subject is PERSISTENCE: a measured rate reaches the
    // series, where a null one used to.
    ok(typeof r.body.agreementRate === 'number', `F4 …and a measured agreement rate (${r.body.agreementRate})`);
    ok(/DSCR/.test(r.body.lpScope || ''), `F5 …naming WHICH Lender Price board it compared against (${r.body.lpScope})`);
    eq(r.body.runPersisted, true, 'F6 …and the run reached the series the go-live gate reads');
    {
      const rows = await runRows();
      eq(rows.length, 1, 'F7 exactly one run row is in lt_ppe_shadow_run');
      // Indexed defensively ON PURPOSE. With the leg mis-wired there is no row at all, and a suite that
      // threw here would "fail" by CRASHING — which looks like proof of the same strength while saying
      // nothing about what the endpoint did. Every assertion in this file must report, not crash.
      const rate = rows.length ? rows[0].agreement_rate : undefined;
      ok(rows.length === 1 && rate != null, `F8 …carrying a REAL agreement rate, not NULL (${rate})`);
    }
    await cleanup();

    // =======================================================================
    // G) A RUN THAT COMPARED NOTHING IS REFUSED
    // =======================================================================
    console.log('\nG) a run that compared NOTHING may not report success');
    await seed({ lp_program_like: SCOPE.programLike });
    // Lender Price refuses every scenario — the vendor-outage shape. Every scenario becomes an
    // engine_error, so nothing at all was compared.
    routeLp.ok = false; routeLp.calls = [];

    r = await call(H.canaryRoute, {
      body: { investor: INVESTOR_CODE, rateSheetVersionId: seeded.versionId, scenarios: SMALL },
    });
    eq(r.code, 422, 'G1 the endpoint REFUSES rather than answering 200 with a measurement of nothing');
    eq(r.body.ok, false, 'G2 …and does not claim ok');
    eq(r.body.reason, 'canary_compared_nothing', 'G3 …with a machine-readable reason');
    ok(/compared NOTHING/.test(r.body.error || ''), `G4 …and a plain-language one (${String(r.body.error).slice(0, 80)}…)`);
    eq(r.body.proven, false, 'G5 …stated as not proven');
    eq(r.body.agreementRate, null, 'G6 …and the rate is null, never a fabricated score');
    eq(r.body.runPersisted, false, 'G7 the run record is NOT written');
    eq((await runRows()).length, 0, 'G8 …proven against the database: lt_ppe_shadow_run has no row for this sheet');
    eq(r.body.persisted, true, 'G9 the DIAGNOSIS is still kept — the findings ledger took the engine errors');
    {
      const f = await db.query('SELECT kind FROM lt_ppe_finding WHERE scope = $1 AND investor = $2', ['company', INVESTOR_CODE]);
      ok(f.rows.length > 0 && f.rows.every((x) => x.kind === 'engine_error'),
        `G10 …and they are engine_error records naming what failed (${f.rows.length} rows)`);
    }
    await cleanup();

    // =======================================================================
    // H) AN UNSCOPED SHEET IS REFUSED BEFORE ANYTHING IS PRICED
    // =======================================================================
    console.log('\nH) a sheet with no Lender Price scope is refused up front');
    await seed({ lp_program_like: null });
    routeLp.ok = true; routeLp.calls = [];

    r = await call(H.canaryRoute, {
      body: { investor: INVESTOR_CODE, rateSheetVersionId: seeded.versionId, scenarios: SMALL },
    });
    eq(r.code, 422, 'H1 an unscoped sheet is refused');
    eq(r.body.reason, 'no_lp_scope', 'H2 …with a reason naming the gap');
    ok(/scope/i.test(r.body.error || '') && /run it again/.test(r.body.error || ''),
      'H3 …and a message that says how to fix it, so the refusal is not a dead end');
    eq(routeLp.calls.length, 0, 'H4 …and the live upstream was never called — refused BEFORE anything was priced');
    eq((await runRows()).length, 0, 'H5 …with nothing written to the run series');
    await cleanup();
  } finally {
    try { await cleanup(); } catch (_) { /* the assertions above already reported */ }
    try { await db.pool.end(); } catch (_) { /* nothing left to close */ }
  }

  return finish();
})().catch((e) => {
  console.error('\nTHREW:', e && e.stack ? e.stack : e);
  process.exit(1);
});

function finish() {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) { console.log('all failed'); process.exit(1); }
  console.log('all passed');
  return assert.ok(true);
}
