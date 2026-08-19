#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE FREE PRE-FLIGHT DOOR, AND THE PRICED CENSUS ON IT
 * (`GET /rate-sheets/:id/preflight`; §2.75 + §2.115/§2.116).
 *
 * This door is what a rate-sheet writer presses BEFORE spending ~299 vendor calls. Until now no suite
 * drove it — `check-lt-ppe-route-tests.js` named it as untested — so everything below is new coverage,
 * not a re-run of somebody else's assertions.
 *
 * IT ANSWERS TWO DIFFERENT QUESTIONS AND THEY MUST NOT BE CONFUSED:
 *   the PRE-FLIGHT is a REFUSAL test — can our sheet price this battery AT ALL? It gates the paid run.
 *   the PRICED CENSUS answers what a paid run can TEACH us — WHICH scenarios it prices, by the
 *     battery's own axes. Every live run so far reported `agreedPriced 0` because the scenarios being
 *     paid for sat outside the frontier our sheet quotes, and a bare total ("262 of 305") hides that
 *     just as effectively as no number when the 43 it refuses are the whole of one axis.
 *
 * WHAT IS PROVEN HERE:
 *   A. The door answers, and it is FREE — the Lender Price client is stubbed so that touching it is
 *      DETECTABLE, and "it did not" is asserted rather than assumed.
 *   B. The census is a PARTITION of the battery, its candidate count is the priced set minus the
 *      scenarios the battery itself expects to be refused, and it reads in words.
 *   C. THE TWO HALVES AGREE. They share ONE verdict definition (`classifyOursQuote`), so a route that
 *      reported a census disagreeing with the pre-flight beside it would mean the definition had been
 *      forked. Asserted on the same response, both directions.
 *   D. A sheet that prices NOTHING is refused AND its census says 0 with reasons — the anti-vacuous
 *      half: a census that reports the same thing on a healthy and a broken sheet is worth nothing.
 *   E. The census can NEVER break the door. Proven by making the probe throw, not by reading the
 *      try/catch.
 *   F. The ordinary refusals still hold.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-preflight-route-db.js
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
// A handler that THROWS is a defect to REPORT, not to die on — `wrap()` turns a throw into a 500 in
// production, so the stub does the same. Without it one bad path kills the run and every assertion
// after it silently never executes, which reads exactly like a passing suite that stopped early.
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign(
  { params: {}, body: {}, query: {}, actor: { id: null, email: 'preflight@ys' } }, over,
);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE preflight route skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  const LP = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
  const lpStub = { calls: 0, configured() { return true; }, async price() { lpStub.calls += 1; return { ok: true, raw: {} }; }, parseFull() { return { programs: [] }; } };
  require.cache[LP] = { id: LP, filename: LP, loaded: true, exports: lpStub };

  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const db = require('../src/longterm/db');

  const SCOPE = I.SCOPE;
  const stamp = `F${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2', [SCOPE, `${INV_CODE}%`]).catch(() => {});
  };

  // A sheet with a WIDE base ladder, so the battery's scenarios are priceable and the census has
  // something to say. `investorName` decides whose prepayment layer is asked (§2.116), so it is named
  // rather than left to chance.
  const buildSheet = async (label, opts = {}) => {
    const inv = await store.createInvestor(db, SCOPE, { code: `${INV_CODE}${label}`.slice(0, 20), name: opts.investorName || `Preflight ${label}` });
    const prg = await store.createProgram(db, SCOPE, { investorId: inv.id, code: `P${label}${stamp}`.slice(0, 20), name: `DSCR ${label}` });
    const ver = await store.createRateSheetVersion(db, SCOPE, { programId: prg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(db, SCOPE, ver.id, opts.basePrices || [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
      { noteRateMilliPct: 72500, lockDays: 30, priceMilli: 103900 },
    ]);
    if (opts.adjustments) await store.replaceAdjustments(db, SCOPE, ver.id, opts.adjustments);
    return { programId: prg.id, versionId: ver.id, investorId: inv.id };
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '576_lt_ppe_ratesheet_agreement_gate.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // =========================================================================
    console.log('\nA. the door answers, and it costs nothing\n');
    // =========================================================================
    const sheet = await buildSheet('A');
    lpStub.calls = 0;
    let res = await call(H.rateSheetPreflightRoute, REQ({ params: { id: sheet.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, `A1 the pre-flight answers — got ${res.statusCode}`);
    ok(typeof res.body.wouldRun === 'boolean', 'A2 …saying plainly whether the PAID run would start');
    ok(res.body.scenarios > 0, `A3 …over the real battery — ${res.body.scenarios} scenario(s)`);
    ok(lpStub.calls === 0 && res.body.upstreamCalls === 0,
      `A4 the Lender Price upstream was never called — this door is free (calls ${lpStub.calls})`);
    ok(res.body.pppLayer && typeof res.body.pppLayer.asked === 'boolean',
      'A5 …and it says whether the investor prepayment layer was asked (§2.116) — never silent about it');

    // =========================================================================
    console.log('\nB. the priced census — a partition, and it reads in words\n');
    // =========================================================================
    const c = res.body.pricedCensus;
    ok(!!c, 'B1 the census is present');
    if (c) {
  ok(c.priced + c.declined + c.incomplete + c.noRungs + c.errors === c.scenarios,
      `B2 its buckets PARTITION the battery — ${c.priced}+${c.declined}+${c.incomplete}+${c.noRungs}+${c.errors} vs ${c.scenarios}`);
    ok(c.scenarios === res.body.scenarios, 'B3 …over the same battery the pre-flight measured, not a different one');
    ok(c.candidates <= c.priced && c.priced <= c.scenarios,
      `B4 candidates ⊆ priced ⊆ battery — ${c.candidates} / ${c.priced} / ${c.scenarios}`);
    ok(c.candidates === c.priced - (c.pricedLabelledIneligible || []).length,
      'B5 …the candidates are the priced set MINUS the scenarios the battery expects to be refused');
    const groups = Object.keys(c.byGroup || {});
    ok(groups.length >= 5, `B6 the census is broken down by the battery's own axes — ${groups.length} group(s)`);
    ok(Object.values(c.byGroup).reduce((s, v) => s + v.total, 0) === c.scenarios,
      'B7 …and the per-axis totals add back up to the battery — no scenario is in no group');
    ok(Array.isArray(c.lines) && c.lines.length > 0 && /prices \d+ of \d+/.test(c.lines.join('\n')),
      'B8 …with the census in plain words, so a screen never has to compose it');

    // =========================================================================
    console.log('\nC. the two halves of this response agree — ONE verdict definition\n');
    // =========================================================================
    const o = res.body.preflight.ours;
    ok(o.priced === c.priced, `C1 the pre-flight and the census report the SAME priced count — ${o.priced} vs ${c.priced}`);
    ok(o.declined === c.declined + c.errors,
      `C2 …and the pre-flight's declines reconcile (it folds an unreadable answer in; the census calls it an error) — ${o.declined} vs ${c.declined}+${c.errors}`);
    ok(o.unpriced === c.incomplete + c.noRungs,
      `C3 …and its one unpriceable bucket reconciles with the census's two — ${o.unpriced} vs ${c.incomplete}+${c.noRungs}`);
    ok(o.total === c.scenarios, 'C4 …over the same battery');
  }

    // =========================================================================
    console.log('\nD. a sheet that prices NOTHING — both halves say so\n');
    // =========================================================================
    // A program-level ELIGIBILITY rule that no loan can satisfy — written straight into `lt_ppe_rule`,
    // the table `rule-store.rulesForProgram` hands the engine, because that is the only way to make our
    // own leg decline a battery it would otherwise price. This is the ANTI-VACUOUS half: a census that
    // reports the same thing on a healthy sheet and on one that prices nothing is worth less than none.
    const dead = await buildSheet('D');
    await db.query(
      `INSERT INTO lt_ppe_rule (scope, program_id, code, kind, source, predicate, decline_reason, priority, description, origin)
       VALUES ($1, $2, $3, 'eligibility', 'overlay', $4::jsonb, $5, 0, 'test-only: refuses everything', 'manual')`,
      [SCOPE, dead.programId, `refuse_all_${stamp}`.slice(0, 40),
        JSON.stringify({ fact: 'fico', op: 'lt', value: 999 }), 'Nothing qualifies on this sheet'],
    );
    const deadRes = await call(H.rateSheetPreflightRoute, REQ({ params: { id: dead.versionId } }));
    ok(deadRes.statusCode === 200, `D1 the sheet is measured — got ${deadRes.statusCode}`);
    const dc = deadRes.body.pricedCensus;
    ok(deadRes.body.wouldRun === false, 'D2 the paid run would be REFUSED — our own engine priced nothing');
    ok(dc && dc.priced === 0 && dc.candidates === 0,
      `D3 …and the census says 0 priced rather than staying silent — got ${dc && dc.priced}`);
    ok(dc && dc.declined === dc.scenarios,
      `D4 …with every scenario in the DECLINED bucket, not lost — ${dc && dc.declined} of ${dc && dc.scenarios}`);
    ok(dc && dc.declineReasons['Nothing qualifies on this sheet'] === dc.scenarios,
      'D5 …naming WHY the sheet refuses, in the rule\'s own words');
    ok(/prices 0 of/.test(((dc && dc.lines) || []).join('\n')), 'D6 …and saying so in plain words');
    // The healthy sheet from section A priced everything, so the two answers genuinely differ — which
    // is the only thing that makes either of them evidence.
    ok(!!c && !!dc && c.priced > 0 && dc.priced === 0,
      `D7 the census DISTINGUISHES the two sheets — ${c && c.priced} vs ${dc && dc.priced}`);

    // =========================================================================
    console.log('\nE. the census can never break the door\n');
    // =========================================================================
    {
      // Make the probe THROW and re-require the route on top of it. Proving the failure path by
      // reading the try/catch would prove only that a try/catch is written there.
      const PROBE = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'agreement-priced-probe.js'));
      const ROUTE = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'));
      const realProbe = require.cache[PROBE];
      const realRoute = require.cache[ROUTE];
      require.cache[PROBE] = {
        id: PROBE,
        filename: PROBE,
        loaded: true,
        exports: { selectPricedProbe() { throw new Error('probe exploded'); }, describeProbe() { return []; } },
      };
      delete require.cache[ROUTE];
      const broken = require('../src/longterm/routes/ppe');
      const bRes = await call(broken.handlers.rateSheetPreflightRoute, REQ({ params: { id: sheet.versionId } }));
      ok(bRes.statusCode === 200 && bRes.body.ok === true,
        `E1 a census that throws does NOT break the pre-flight — got ${bRes.statusCode}`);
      ok(bRes.body.pricedCensus === null && /probe exploded/.test(bRes.body.censusError || ''),
        'E2 …it is reported ABSENT with the reason, never a silently empty census');
      ok(bRes.body.preflight && typeof bRes.body.wouldRun === 'boolean',
        'E3 …and the refusal test this door exists for still answered');
      require.cache[PROBE] = realProbe;
      require.cache[ROUTE] = realRoute;
    }

    // =========================================================================
    console.log('\nF. the ordinary refusals\n');
    // =========================================================================
    const missing = await call(H.rateSheetPreflightRoute, REQ({ params: { id: '00000000-0000-0000-0000-000000000000' } }));
    ok(missing.statusCode >= 400 && missing.statusCode < 500,
      `F1 an unknown rate-sheet version is refused, not measured — got ${missing.statusCode}`);
    ok(!missing.body.pricedCensus, 'F2 …with no census attached to a sheet that does not exist');

    await cleanup();
  } catch (e) {
    console.log(` FAIL  the suite threw: ${(e && e.stack) || e}`);
    failures += 1;
    await cleanup().catch(() => {});
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  await db.pool.end().catch(() => {});
  process.exit(failures ? 1 : 0);
})();

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied on its own, unmutated control green either side.
 *   M1  the route stops returning the census                → B fails (6 named assertions, no crash —
 *                                                             the guard above is what keeps a missing
 *                                                             census reading as failures rather than a
 *                                                             stack trace that looks like a short pass)
 *   M2  the census's try/catch removed                      → E fails (a census failure 500s the door
 *                                                             this door exists to answer)
 *   M3  candidates stop excluding the labelled-ineligible   → B5 fails (a paid run handed a loan the
 *                                                             battery itself expects to be refused)
 * ------------------------------------------------------------------------------------------- */
