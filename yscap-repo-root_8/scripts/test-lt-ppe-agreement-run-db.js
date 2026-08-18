#!/usr/bin/env node
'use strict';
/**
 * LT PPE — RUNNING the ≥200-scenario Lender Price agreement harness, against a REAL Postgres.
 *
 * WHAT THIS ROUTE IS FOR. db/576 made the owner's HARD RULE enforceable — a rate sheet may not be
 * published until it has been measured against Lender Price and agreed — but for a while NOTHING
 * called the harness, so no run could be recorded and the only way past the gate was the recorded
 * override. `POST /rate-sheets/:id/agreement/run` is the measuring half. What is proven here is not
 * the harness's arithmetic (its own suite owns that, and it is pure) but the ROUTE's promises, every
 * one of which is a way a sheet could go live on a verdict nobody should trust:
 *
 *   A. IT REFUSES BEFORE IT SPENDS. No program, no Lender Price scope, upstream not configured, or
 *      another tenant's sheet — each is a refusal taken BEFORE a single scenario is priced, and each
 *      leaves the ledger untouched. The upstream is paid per call and a battery of error verdicts
 *      would say nothing about agreement while costing real money.
 *   B. THE WHOLE BATTERY IS ACTUALLY PRICED, and the number reported is the number run.
 *   C. THE VERDICT REACHES THE LEDGER with its counts intact — the row is what the publish gate reads
 *      months later, so a count stored as 0 is a verdict that claims to have compared nothing.
 *   D. NO SILENT CAPS: a battery larger than the ceiling reports what was dropped.
 *   E. A MEASURED PASS OPENS THE GATE, with no override anywhere near it — the whole point.
 *   F. A RECORD THAT DID NOT LAND IS ANSWERED AS A FAILURE, never as a run that "worked".
 *
 *   G. BOTH LEGS ARE THE SHARED ONES. The battery is a list of LENDER PRICE scenarios and the client
 *      answers `{ ok, raw }`; a hand-rolled leg on either side produces a confident verdict about
 *      nothing, and only a stub shaped like the real vendor can catch it.
 *
 * FOUR REAL DEFECTS WERE FOUND BY WRITING IT, and each is pinned below:
 *   · `buildAgreementScenarios()` returns **{ scenarios, count, byGroup }**, not an array. The route
 *     read `.length` off that object (undefined), so nothing was capped and the OBJECT was handed to
 *     the harness — which reads a non-array as an EMPTY list. Every run measured ZERO scenarios,
 *     summarized them as a clean nothing, and recorded a verdict against a sheet it never compared.
 *   · `summarize()` names the battery size `total`; `recordRun` read `s.scenarios`. Every real run
 *     stored a scenario count of 0 beside comparable/agreed counts in the hundreds.
 *   · the run was UNSCOPED — the stored Lender Price scope was resolved and then dropped, so our one
 *     ladder would have been reconciled against a merge of the investor's whole catalogue.
 *   · BOTH LEGS were hand-rolled instead of `lp-agreement-legs`. Our engine was handed the raw Lender
 *     Price scenario (it reads FACTS — ltv in milli, loan_amount, a normalized purpose — so nearly
 *     every rule predicate read an absent key), and the harness was handed `client.price` itself,
 *     whose `{ ok, raw }` is not the `{ full, disqualified }` it consumes: against a real upstream
 *     every scenario would have come back INCOMPARABLE while the run looked perfectly healthy.
 *
 * The Lender Price client is stubbed through require.cache BEFORE the route loads (there is no
 * upstream here, and there must never be one in a test); the database is real.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-agreement-run-db.js
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
  { params: {}, body: {}, query: {}, actor: { id: null, email: 'harness@ys' } }, over,
);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('(LT PPE agreement run skipped — set DATABASE_URL to run it.)');
    process.exit(0);
  }

  // ---- the Lender Price stub, installed before the route is required --------------------------
  //
  // IT MIMICS THE REAL CLIENT'S CONTRACT, NOT THE HARNESS'S. `client.price` answers `{ ok, raw }` and
  // the raw payload is turned into the harness's `{ full, disqualified }` by `parseFull` /
  // `parseDisqualified`. A stub that skipped that and returned the parsed shape directly would pass
  // whatever the route did with the client — including handing `client.price` straight to the harness,
  // which against a REAL upstream makes every scenario incomparable while looking perfectly healthy
  // here. Test like you fly: the stub is the vendor's shape, and the route has to convert it.
  const LP = require.resolve(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
  const lpStub = {
    calls: 0,
    disqCalls: 0,
    isConfigured: true,
    // `answer(sc)` returns the already-parsed { full, disqualified } a scenario should produce; the
    // stub then hands it back through the client's own two-step shape.
    answer: () => ({}),
    configured() { return lpStub.isConfigured; },
    async price(sc) { lpStub.calls += 1; return { ok: true, raw: { _stub: lpStub.answer(sc) } }; },
    parseFull(raw) { return ((raw && raw._stub) || {}).full || { programs: [] }; },
    async priceDisqualified(sc) { lpStub.disqCalls += 1; return { ok: true, disqualified: { _stub: lpStub.answer(sc) } }; },
    parseDisqualified(raw) { return ((raw && raw._stub) || {}).disqualified || { ready: false, lenders: [] }; },
  };
  require.cache[LP] = { id: LP, filename: LP, loaded: true, exports: lpStub };

  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const agreementStore = require('../src/longterm/ppe/agreement-store');
  const agreementScenarios = require('../src/longterm/ppe/agreement-scenarios');
  const ratesheetAgreement = require('../src/longterm/ppe/ratesheet-agreement');
  const db = require('../src/longterm/db');

  const SCOPE = I.SCOPE;
  const stamp = `R${process.pid}${Date.now() % 100000}`;
  const INV_CODE = `ZZ${stamp}`.slice(0, 20);
  const OTHER_SCOPE = `other_${stamp}`;

  const cleanup = async () => {
    for (const s of [SCOPE, OTHER_SCOPE]) {
      await db.query(
        `DELETE FROM lt_ppe_investor WHERE scope = $1 AND code LIKE $2`, [s, `${INV_CODE}%`],
      ).catch(() => {});
    }
  };

  // A grid our engine can actually price from, and a scope so the comparison knows what to compare
  // against. `lpScope` is set through the STORE rather than the route so this suite is about the run.
  const buildSheet = async (label) => {
    const inv = await store.createInvestor(db, SCOPE, { code: `${INV_CODE}${label}`.slice(0, 20), name: `Harness ${label}` });
    const prg = await store.createProgram(db, SCOPE, { investorId: inv.id, code: `P${label}${stamp}`.slice(0, 20), name: `DSCR ${label}` });
    await db.query(
      `UPDATE lt_ppe_program SET lp_investor = $2, lp_program_like = $3 WHERE id = $1`,
      [prg.id, 'Deephaven', 'DSCR'],
    );
    const ver = await store.createRateSheetVersion(db, SCOPE, { programId: prg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(db, SCOPE, ver.id, [
      { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
      { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
      { noteRateMilliPct: 72500, lockDays: 30, priceMilli: 103900 },
    ]);
    return { investorId: inv.id, programId: prg.id, versionId: ver.id };
  };

  const ledger = (versionId, scope = SCOPE) => agreementStore.listForVersion(scope, versionId, { db });

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql', '576_lt_ppe_ratesheet_agreement_gate.sql',
      '581_lt_ppe_disqualifier_review_queue.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    const BUILT = agreementScenarios.buildAgreementScenarios().count;

    // =========================================================================
    // A. THE REFUSALS THAT COME BEFORE THE MONEY IS SPENT
    // =========================================================================
    console.log('\nA. refused before a single scenario is priced\n');

    const graded = await buildSheet('G');

    lpStub.calls = 0;
    let res = await call(H.runAgreementRoute, REQ({ params: { id: '00000000-0000-0000-0000-000000000000' } }));
    ok(res.statusCode === 404, 'A1 an unknown rate-sheet version is a 404');
    ok(lpStub.calls === 0, 'A1b …and nothing was priced');

    // Another tenant's sheet. This door prices a full battery against a paid vendor, so an ownership
    // hole here is not only a leak — it spends our money measuring somebody else's sheet and then
    // records the verdict where their publish gate will read it.
    const oInv = await store.createInvestor(db, OTHER_SCOPE, { code: `${INV_CODE}O`.slice(0, 20), name: 'Other tenant' });
    const oPrg = await store.createProgram(db, OTHER_SCOPE, { investorId: oInv.id, code: `PO${stamp}`.slice(0, 20), name: 'Other DSCR' });
    const oVer = await store.createRateSheetVersion(db, OTHER_SCOPE, { programId: oPrg.id, versionNo: 1, channel: 'correspondent' });
    await store.replaceBasePrices(db, OTHER_SCOPE, oVer.id, [{ noteRateMilliPct: 70000, lockDays: 30, priceMilli: 100000 }]);

    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: oVer.id } }));
    ok(res.statusCode === 404, 'A2 another tenant\'s rate sheet cannot be run through this door');
    ok(lpStub.calls === 0, 'A2b …and nothing was priced against it');
    ok((await ledger(oVer.id, OTHER_SCOPE)).length === 0, 'A2c …and their ledger is untouched');

    // A version with no grid: `quote.quoteProgram` throws without one, so every scenario would come
    // back an engine_error and the summary would read like a catastrophic disagreement.
    const bare = await store.createRateSheetVersion(db, SCOPE, { programId: graded.programId, versionNo: 2, channel: 'correspondent' });
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: bare.id } }));
    ok(res.statusCode === 422 && res.body.reason === 'program_has_no_base_grid',
      'A3 a sheet with no grid is refused, naming why rather than running a battery of error verdicts');
    ok(lpStub.calls === 0, 'A3b …before pricing anything');
    ok((await ledger(bare.id)).length === 0, 'A3c …and nothing was recorded');

    // No Lender Price scope: the harness would reconcile our ONE ladder against a merge of the
    // investor's whole catalogue, and a PASS from that run would open the publish gate on a
    // measurement of the wrong thing.
    const unscoped = await buildSheet('U');
    await db.query('UPDATE lt_ppe_program SET lp_investor = NULL, lp_program_like = NULL WHERE id = $1', [unscoped.programId]);
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: unscoped.versionId } }));
    ok(res.statusCode === 422 && res.body.reason === 'no_lp_scope',
      'A4 an UNSCOPED program is refused — an unscoped comparison answers the wrong question');
    ok(/lp-scope/.test(res.body.remedy || ''), 'A4b …and the refusal names how to fix it');
    ok(lpStub.calls === 0 && (await ledger(unscoped.versionId)).length === 0,
      'A4c …before spending anything, and with nothing recorded');

    // Upstream not configured — the state this sheet is in until the Lender Price login is rotated.
    lpStub.isConfigured = false;
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: graded.versionId } }));
    ok(res.statusCode === 503 && res.body.reason === 'upstream_not_configured',
      'A5 an unconfigured upstream is refused UP FRONT');
    ok(lpStub.calls === 0, 'A5b …so no scenario is priced into an error verdict');
    ok((await ledger(graded.versionId)).length === 0,
      'A5c …and no "measurement" of an unreachable vendor reaches the ledger');
    lpStub.isConfigured = true;

    // =========================================================================
    // B. A RUN MEASURES THE WHOLE BATTERY, AND THE VERDICT REACHES THE LEDGER
    // =========================================================================
    console.log('\nB. the run, and what it records\n');

    // Lender Price answers with nothing usable — the shape a degraded upstream returns.
    lpStub.answer = () => ({});
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: graded.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'B1 the run completes');

    // THE ARRAY DEFECT. Pre-fix the route read `.length` off `{scenarios,count,byGroup}` — undefined —
    // and handed the OBJECT to the harness, which reads a non-array as an empty list. Every one of
    // these three assertions failed: the count was 0, nothing was priced, and a verdict over nothing
    // was recorded as though the sheet had been measured.
    ok(res.body.scenarios === BUILT && BUILT > 200,
      `B2 the WHOLE canonical battery ran (${res.body.scenarios} of ${BUILT}), which is the ≥200 the gate asks for`);
    ok(lpStub.calls === BUILT,
      `B3 …and Lender Price was actually asked ${BUILT} times — the reported number is the number RUN`);
    ok(res.body.summary && res.body.summary.total === BUILT,
      'B4 …and the harness summarized that many scenarios');

    const hist = await ledger(graded.versionId);
    ok(hist.length === 1 && hist[0].kind === 'run', 'B5 exactly one run is on the ledger');
    // THE KEY-NAME DEFECT. summarize() calls the battery size `total`; recordRun read `s.scenarios`,
    // so every real run stored 0 here — a recorded verdict claiming it compared nothing.
    ok(hist[0].scenarios === BUILT,
      `B6 …and the STORED scenario count is ${BUILT}, not 0 — the row is what the gate reads months later`);
    ok(hist[0].gateMet === false, 'B7 …recorded as not meeting the gate');

    // THE THIRD ANSWER. Nothing was comparable, so this is neither "nobody measured it" nor "it
    // disagrees" — reporting it as a disagreement sends somebody to fix a sheet that may be correct.
    ok(res.body.gate.reason === 'nothing_comparable',
      'B8 a run where Lender Price gave no usable answer is reported as nothing_comparable');
    ok(res.body.gate.proven === false, 'B9 …and it is not proven either — a run that compared nothing proves nothing');
    ok(res.body.truncated === 0 && res.body.scenarios + res.body.truncated === BUILT,
      'B10 nothing was dropped, and what ran plus what was dropped is the whole battery');
    ok(res.body.recorded === true && res.body.recordError === null, 'B11 the run reports itself recorded');

    // =========================================================================
    // C. A DISAGREEING RUN IS A DIFFERENT ANSWER FROM AN UNMEASURED ONE
    // =========================================================================
    console.log('\nC. measured and disagreeing\n');

    // THE SCOPE IS APPLIED, and this is what proves it rather than the refusal in A4. Lender Price
    // answers with a decline belonging to a DIFFERENT investor's program. Scoped, that is no signal
    // about our sheet at all; unscoped, it would be read as Lender Price declining the loan and would
    // be reconciled against our ladder — a disagreement (or an agreement) manufactured out of somebody
    // else's product line.
    lpStub.answer = () => ({
      full: { programs: [] },
      disqualified: { ready: true, lenders: [{ lender: 'Somebody Else', investor: 'Somebody Else', items: [{ program: 'Bank Statement 30yr', reasons: [{ rule: 'state' }] }] }] },
    });
    res = await call(H.runAgreementRoute, REQ({ params: { id: graded.versionId } }));
    ok(res.body.summary.comparable === 0 && res.body.gate.reason === 'nothing_comparable',
      'C0 another investor\'s decline is FILTERED OUT by the stored scope — our ladder is never compared against somebody else\'s catalogue');

    // Lender Price declines every scenario while our sheet prices most of them: a real, measured
    // eligibility disagreement, not an absence of data.
    lpStub.answer = () => ({
      full: { programs: [] },
      disqualified: { ready: true, lenders: [{ lender: 'Deephaven', investor: 'Deephaven', items: [{ program: 'DSCR 30yr', reasons: [{ rule: 'state' }] }] }] },
    });
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: graded.versionId } }));
    ok(res.statusCode === 200 && res.body.summary.comparable > 0,
      `C1 with a real Lender Price answer the run is comparable (${res.body.summary.comparable} scenarios)`);
    ok(res.body.summary.disagreed > 0, 'C2 …and the disagreements are counted');
    ok(res.body.gate.reason === 'disagrees',
      'C3 …so the gate says it DISAGREES — a different answer from "nobody measured it", and a different fix');

    const hist2 = await ledger(graded.versionId);
    ok(hist2.length === 3 && hist2[0].disagreed === res.body.summary.disagreed,
      'C4 the ledger is append-only and the newest row carries the count');

    res = await call(H.publishRateSheetRoute, REQ({ params: { id: graded.versionId }, body: {} }));
    ok(res.statusCode === 409 && res.body.reason === 'disagrees',
      'C5 publishing is refused as DISAGREEING, not as unmeasured — nobody is sent to re-run a battery that already ran');
    const stillDraft = (await db.query('SELECT status FROM lt_ppe_rate_sheet_version WHERE id = $1', [graded.versionId])).rows[0];
    ok(stillDraft.status === 'draft', 'C6 …and the version is untouched');

    // =========================================================================
    // D. NO SILENT CAPS
    // =========================================================================
    console.log('\nD. a battery over the ceiling says what it dropped\n');

    const realBuild = agreementScenarios.buildAgreementScenarios;
    const OVER = I.MAX_AGREEMENT_SCENARIOS + 37;
    agreementScenarios.buildAgreementScenarios = () => {
      const one = realBuild().scenarios[0];
      const list = [];
      for (let i = 0; i < OVER; i += 1) list.push({ ...one, _label: `synthetic ${i}` });
      return { scenarios: list, count: list.length, byGroup: { synthetic: list.length } };
    };
    lpStub.answer = () => ({});
    lpStub.calls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: graded.versionId } }));
    agreementScenarios.buildAgreementScenarios = realBuild;

    ok(res.body.scenarios === I.MAX_AGREEMENT_SCENARIOS, `D1 the battery is capped at ${I.MAX_AGREEMENT_SCENARIOS}`);
    ok(res.body.truncated === 37, 'D2 …and the 37 that were dropped are REPORTED, never silently trimmed');
    ok(lpStub.calls === I.MAX_AGREEMENT_SCENARIOS, 'D3 …and exactly the capped number was priced');

    // =========================================================================
    // E. A MEASURED PASS OPENS THE GATE — WITH NO OVERRIDE ANYWHERE
    // =========================================================================
    console.log('\nE. the whole point: measured, therefore publishable\n');

    const passing = await buildSheet('P');
    // Built from the harness's OWN summarize() over agreeing verdicts, so the summary carries the real
    // key names a real run produces — which is what makes E2 a genuine test of the stored count rather
    // than of a shape this file invented.
    const verdicts = [];
    for (let i = 0; i < 240; i += 1) {
      // `lpDisqReady: true` because this fixture claims to be what a REAL passing run produces, and a
      // real passing run observed Lender Price's refusals — §2.93 makes the gate require it, since the
      // disqualify tree is the only place LP states a refusal and without it the expensive direction
      // (LP declines, we price) is undetectable. Omitting it here made E1/E3 go red on that change,
      // which is the fixture being incomplete rather than the rule being wrong.
      verdicts.push({ scenario: `s${i}`, agree: true, incomparable: false, ourEligible: true, lpEligible: true, lpDisqReady: true, coarse: { differences: [] }, rungReconciles: [], bounds: [], worstDeltaMilli: 0 });
    }
    const passSummary = ratesheetAgreement.summarize(verdicts);
    ok(passSummary.gateMet === true && passSummary.comparable === 240, 'E1 a fully-agreeing battery meets the harness gate');

    const rec = await agreementStore.recordRun(SCOPE, {
      db, versionId: passing.versionId, summary: passSummary, recordedBy: 'harness@ys', nowMs: Date.now(),
    });
    ok(rec.ok === true && rec.record.scenarios === 240,
      'E2 …and the stored row carries 240 scenarios — the harness names it `total`, and the store reads it');

    res = await call(H.publishRateSheetRoute, REQ({ params: { id: passing.versionId }, body: {} }));
    ok(res.statusCode === 200 && res.body.version.status === 'published',
      'E3 a MEASURED sheet publishes with no override — the gate is satisfiable the honest way');
    const passHist = await ledger(passing.versionId);
    ok(passHist.length === 1 && passHist[0].kind === 'run',
      'E4 …and the ledger holds only the RUN: nothing was overridden to get it live');

    // =========================================================================
    // F. A RECORD THAT DID NOT LAND IS ANSWERED AS A FAILURE
    // =========================================================================
    console.log('\nF. a verdict that never reached the ledger\n');

    const failing = await buildSheet('F');
    const realRecord = agreementStore.recordRun;
    agreementStore.recordRun = async () => ({ ok: false, reason: 'no_clock', message: 'No clock was supplied, so the run cannot be stamped.' });
    lpStub.answer = () => ({});
    res = await call(H.runAgreementRoute, REQ({ params: { id: failing.versionId } }));
    agreementStore.recordRun = realRecord;

    ok(res.statusCode === 500 && res.body.ok === false && res.body.reason === 'not_recorded',
      'F1 a run whose verdict could not be stored is answered as a FAILURE, never as a run that worked');
    ok(res.body.recorded === false && /clock/i.test(res.body.recordError || ''),
      'F2 …naming what went wrong');
    ok(res.body.summary && res.body.summary.total > 0,
      'F3 …and the measurement still rides along — the battery was already paid for');
    const gate = await agreementStore.gateStatus(SCOPE, failing.versionId, { db });
    ok(gate.reason === 'never_measured',
      'F4 …and the gate still reads never_measured, which is exactly why the 200 would have been a lie');

    // =========================================================================
    // G. BOTH LEGS ARE THE SHARED ONES — a hand-rolled leg measures nothing
    // =========================================================================
    console.log('\nG. the two legs\n');

    // The canonical battery is a list of LENDER PRICE scenarios (value/loan/fico/dscr/purpose/state).
    // Our engine reads FACTS — ltv in milli, loan_amount, a normalized purpose — so a sheet rule keyed
    // on LTV can only fire once the scenario has been converted. Pricing the raw LP object instead
    // reads an absent key on nearly every predicate and answers confidently about nothing.
    const legs = require('../src/longterm/ppe/lp-agreement-legs');
    const factSheet = await buildSheet('L');
    await store.replaceAdjustments(db, SCOPE, factSheet.versionId, [
      { code: 'ltv_70_80', dimension: 'ltv', ltvMin: 65000, ltvMax: 80000, adjMilli: -500, priority: 0 },
    ]);
    const { program: factProgram } = await I.loadProgram(SCOPE, factSheet.versionId);
    const lpScenario = agreementScenarios.buildAgreementScenarios().scenarios
      .find((s) => s.loan === 350000 && s.value === 500000);   // CLTV 70 — inside the band above

    const withFacts = legs.buildOursLeg(factProgram, {}, { factsFromLp: true })(lpScenario);
    const rawLp = legs.buildOursLeg(factProgram, {}, {})(lpScenario);
    const firedIn = (q) => !!(q && q.eligible && (q.ladder || []).some(
      (r) => (r.adjustments || []).some((a) => a.code === 'ltv_70_80'),
    ));
    ok(firedIn(withFacts),
      'G1 converted to engine facts, the sheet\'s LTV-keyed LLPA fires on a 70% CLTV scenario');
    ok(!firedIn(rawLp),
      'G2 …and on the RAW Lender Price scenario it does not — the fact its band reads is not there');

    // A source guard as well as the behaviour, because the run route can only be observed end to end
    // through a stub, and a stub cannot see WHICH leg builder was used.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Matched on the two things this assertion is ABOUT — the shared builder, and the conversion from
    // Lender Price scenarios — rather than on the exact argument literal. Pinning the literal made this
    // fail the day the run started passing the investor's prepayment descriptor as well, which is a
    // correct change to a different question (see test-lt-ppe-agreement-ppp-wired.js, which owns it).
    ok(/buildOursLeg\(program, settings, \{[^}]*factsFromLp: true/.test(routeSrc),
      'G3 the run route builds OUR leg through the shared builder, converting from Lender Price scenarios');
    ok(/buildLpLeg\(lpClient/.test(routeSrc) && !/lp:\s*\(sc\)\s*=>\s*lpClient\.price/.test(routeSrc),
      'G4 …and THEIR leg through the shared builder, never handing client.price straight to the harness');

    // =========================================================================
    // H. THE SAME BATTERY ANSWERS THE REVIEW QUESTION TOO — at no extra vendor call
    // =========================================================================
    console.log('\nH. the disqualifier review, off the battery already paid for\n');

    const reviewStore = require('../src/longterm/ppe/disqualifier-review-store');
    const queue = (programId, status = 'open') =>
      reviewStore.listQueue(db, SCOPE, { programId, status, limit: 500 });

    // Lender Price refuses every scenario over the DSCR; our bare grid says nothing about it.
    const reviewSheet = await buildSheet('V');
    lpStub.answer = () => ({
      disqualified: {
        ready: true,
        lenders: [{ lender: 'Deephaven', investor: 'Deephaven', items: [{ program: 'DSCR 30 Year Fixed', reasons: [{ rule: 'DSCR below 1.10', adjType: 'DscrRateAdjustment' }] }] }],
      },
    });
    lpStub.calls = 0; lpStub.disqCalls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'H1 the agreement run completes');
    ok(res.body.review && res.body.review.collected > 0,
      `H2 THE ONE THAT MATTERS: it also laid out the disqualifier questions (${res.body.review && res.body.review.collected})`);
    ok(lpStub.disqCalls === BUILT,
      `H3 …asking Lender Price for its refusal list exactly ONCE per scenario (${lpStub.disqCalls} of ${BUILT}) — no second battery`);

    const q = await queue(reviewSheet.programId);
    ok(q.length === res.body.review.inserted && q.length > 0,
      'H4 …and the questions are in the queue a reviewer opens');
    ok(q.length > 0 && q.every((r) => r.dimension === 'dscr'), 'H5 …naming what they are about');

    // A re-run refreshes rather than re-asking, exactly as the review-only run does.
    const firstCount = q.length;
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok(res.body.review.inserted === 0 && res.body.review.refreshed === firstCount,
      'H6 a second run refreshes the same questions — the queue does not grow');

    // AND IT CANNOT TOUCH THE MEASUREMENT. The agreement verdict on this sheet is computed from the
    // priced ladders; the review rides alongside. Proven by asserting the run still reports its own
    // scenario count and gate verdict with the review attached.
    ok(res.body.scenarios === BUILT && res.body.summary && res.body.summary.total === BUILT,
      'H7 …and the measurement itself is unchanged — the review is an observer, never a participant');

    // A REFUSAL LIST THAT NEVER ARRIVED READS NOTHING AND RETIRES NOTHING.
    lpStub.answer = () => ({ disqualified: { ready: false, lenders: [] } });
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok(res.body.review.scenariosRead === 0 && res.body.review.staled === undefined,
      'H8 a run whose refusal list never arrived reads nothing…');
    ok((await queue(reviewSheet.programId)).length === firstCount,
      'H9 …and retires nothing — a vendor outage is not "the disagreement went away"');

    // =========================================================================
    // I. THE SAME BATTERY ALSO MINES RULE SUGGESTIONS (P2's auto-wiring)
    // =========================================================================
    console.log('\nI. rule suggestions, mined from the refusals already paid for\n');

    // The defect this closes: `mineFromParsed` had ONE caller, the hand-fired POST /suggestions/mine,
    // so the daily run gathered Lender Price's refusal list 299 times and mined nothing from it. These
    // assertions are what make "the run mines" true rather than stated — the pure suite can prove the
    // accumulator's arithmetic but cannot prove the route reaches the store.
    const ruleStore = require('../src/longterm/ppe/rule-store');
    const sugg = (status = 'all') => ruleStore.listSuggestions(db, SCOPE, { status });

    // Start from a clean slate for this section so the counts below mean this run.
    await db.query('DELETE FROM lt_ppe_rule_suggestion WHERE scope = $1', [SCOPE]);

    lpStub.answer = () => ({
      disqualified: {
        ready: true,
        lenders: [{ lender: 'Deephaven', investor: 'Deephaven', items: [{ program: 'DSCR 30 Year Fixed', reasons: [{ rule: 'DSCR below 1.10', adjType: 'DscrRateAdjustment' }] }] }],
      },
    });
    // The stub's counters are CUMULATIVE across this file and section H has already driven the route
    // three times, so they must be zeroed here or I6 measures the whole suite rather than this run.
    lpStub.calls = 0; lpStub.disqCalls = 0;
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok(res.statusCode === 200 && res.body.ok === true, 'I1 the run completes with mining wired in');
    ok(res.body.mining && res.body.mining.ok === true,
      `I2 THE ONE THAT MATTERS: the run mined the refusals it had already paid for (${JSON.stringify(res.body.mining || null)})`);

    const after = await sugg();
    ok(after.length > 0, `I3 …and rule suggestions are in the store a reviewer opens (${after.length})`);
    ok(after.every((r) => r.investor_label === 'Deephaven'),
      'I4 …filed under the INVESTOR, which is how suggestions are keyed');

    // `occurrences` is the whole reason the run is merged before ONE mine call. Mining per scenario
    // would leave this at 1 (the store OVERWRITES the count), and it is the signal a reviewer uses to
    // decide which suggested rule matters most.
    const top = after[0];
    ok(Number(top.occurrences) === BUILT,
      `I5 …with occurrences counting the WHOLE run, not the last scenario (${top.occurrences} of ${BUILT})`);

    // No second battery: the refusal list is the same one the review read.
    ok(lpStub.disqCalls === BUILT,
      `I6 …asking Lender Price exactly once per scenario (${lpStub.disqCalls} of ${BUILT})`);

    // A RE-RUN MUST NOT GROW THE QUEUE. The store dedupes on (scope, investor, dedupeKey); without
    // that, six runs a day would file the same suggestion six times, every day, forever.
    const firstSugg = after.length;
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok((await sugg()).length === firstSugg,
      'I7 a second run refreshes the same suggestions — the queue does not grow');

    // A DECIDED SUGGESTION IS NEVER REOPENED by a later run. This is what makes an automatic miner
    // safe to point at a scheduler: dismissing something must be final, or the reviewer is asked the
    // same question six times a day for the rest of the sheet's life.
    await db.query("UPDATE lt_ppe_rule_suggestion SET status = 'dismissed' WHERE scope = $1", [SCOPE]);
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    const openAfterDismiss = await sugg('open');
    ok(openAfterDismiss.length === 0,
      'I8 …and a dismissed suggestion stays dismissed through the next run');
    ok((await sugg()).length === firstSugg,
      'I9 …without minting a duplicate beside it');

    // A FEED THAT NEVER ARRIVED SAYS SO, rather than reporting a clean zero. "No scenario carried a
    // refusal list" and "nothing was refused" are different facts and only one of them is good news.
    await db.query('DELETE FROM lt_ppe_rule_suggestion WHERE scope = $1', [SCOPE]);
    lpStub.answer = () => ({ disqualified: { ready: false, lenders: [] } });
    res = await call(H.runAgreementRoute, REQ({ params: { id: reviewSheet.versionId } }));
    ok(res.body.mining && res.body.mining.skipped === 'no_refusals_read',
      'I10 a run whose refusal list never arrived says so plainly…');
    ok((await sugg()).length === 0, 'I11 …and writes nothing');

    // AND MINING CANNOT TOUCH THE MEASUREMENT — the same guarantee the review carries.
    ok(res.body.scenarios === BUILT && res.body.summary && res.body.summary.total === BUILT,
      'I12 …with the agreement verdict itself unchanged — mining is an observer, never a participant');
  } finally {
    await cleanup();
    if (typeof db.end === 'function') await db.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'ok - lt ppe agreement run (all passed)'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
