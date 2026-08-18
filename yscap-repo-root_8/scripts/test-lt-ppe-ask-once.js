#!/usr/bin/env node
'use strict';
/**
 * LT PPE — ASK LENDER PRICE EACH DISTINCT QUESTION ONCE (§2.95).
 *
 * ⛔ MEASURED ON THE CANONICAL BATTERY: **32 of 305 scenarios build a BYTE-IDENTICAL request.** The
 * FICO×CLTV sweep and the DSCR×CLTV sweep overlap at FICO 760, and `ppp 5yr` matches `state CA`
 * because 60 months IS the profile default. The two groups ask different QUESTIONS of the same request
 * — so Lender Price's answer is identical and the second call learns nothing. At the owner's six
 * scheduled runs a day that is **192 paid vendor calls daily**, spent on answers already in hand.
 *
 * ⛔ THE SCENARIOS ARE NOT DROPPED, AND THAT IS THE WHOLE DESIGN. Each is attributed to its own group
 * in the report; collapsing them would change what each group claims to cover — the coverage a reader
 * trusts. Both are still compared, still scored, still counted. **Only the paid call is shared: money
 * is saved, measurement is not.**
 *
 * ⛔ OFF BY DEFAULT, AND ASSERTED SO. `runRatesheetAgreement` is engine-agnostic — `lp` is an injected
 * leg and it does not know how that leg builds a request — so the KEY is the caller's. With no
 * `dedupeKey` the leg is used exactly as passed and behaviour is byte-identical to before. That is
 * what makes this safe to ship on a paid path.
 *
 * The key is the REQUEST, not the scenario: two different scenario objects can build the same body,
 * and that is most of the 32.
 *
 *   node scripts/test-lt-ppe-ask-once.js
 *
 * PURE — no DB, no network. LT-only.
 */
const path = require('path');
const fs = require('fs');
const { runRatesheetAgreement, memoizeLeg } = require('../src/longterm/ppe/ratesheet-agreement');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const { buildSearch } = require('../src/longterm/lenderprice/search-model');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const strip = (s) => { const o = { ...s }; delete o._label; delete o._group; delete o._ineligible; return o; };
const bodyKey = (sc) => JSON.stringify(buildSearch(strip(sc))).replace(/"date":"[^"]*"/, '');

// ---- A: the saving is real, and it is the REQUEST that repeats -----------------------------------
console.log('-- A: what the battery actually asks --');
{
  const all = buildAgreementScenarios().scenarios;
  const keys = new Set(all.map(bodyKey));
  ok(all.length === 305, `the battery is ${all.length} scenarios`);
  // ⛔ THIS NUMBER MOVES WHENEVER A DROPPED FIELD IS BRIDGED, and that movement is the point — it is
  // the two lists staying in step rather than one quietly going stale. 32 -> 29 when §2.96 bridged
  // `rural_property`, `first_time_investor` and `first_time_homebuyer`; 29 -> 28 when §2.97 bridged
  // `foreign_national`. Each of those advanced scenarios was a duplicate BECAUSE its field was
  // dropped: it sent a request byte-identical to the plain baseline, so we paid for a call that could
  // not measure the thing it named. Bridging turns a wasted call into a real measurement.
  //
  // The remaining three advanced duplicates are exactly the fields still recorded as not-transmitted
  // in `test-lt-ppe-field-reaches-wire.js` — `occupancy vacant` (a DECISION: the fact is retained on an
  // internal channel rather than guessed onto the wire), `declining market` (MEASURED INERT: five
  // candidate tokens probed live, none moved a single rung) and `renovation cash-out` (an OPEN GAP with
  // no vendor field to bridge to). None of them will stop being a duplicate by being bridged, so the
  // count is now expected to hold until a new field is added.
  ok(keys.size === 277, `…asking ${keys.size} distinct requests`);
  ok(all.length - keys.size === 28, `…so ${all.length - keys.size} paid calls per run are duplicates`);
  // The pinned count and the not-transmitted record must move together, or one will quietly go stale.
  const advDup = all.filter((s2) => /^(occupancy vacant|declining market|renovation cash-out)$/.test(s2._label || ''));
  ok(advDup.length === 3, 'the three advanced scenarios whose fields are still not transmitted are present');
  ok(advDup.every((s2) => keys.has(bodyKey(s2))), '…and each still sends a request identical to another scenario\'s');
  // The key must be the REQUEST. A scenario-object key would miss the ones that differ in their fields
  // and agree on the wire — `ppp 5yr` states a 60-month prepay and `state CA` states none, and 60 IS
  // the default, so they send the same body. Asserted, because it is the reason for the design.
  const byScenario = new Set(all.map((s) => JSON.stringify(strip(s))));
  ok(byScenario.size > keys.size,
    `keying on the SCENARIO would find only ${all.length - byScenario.size} of them — the request is what repeats`);
  const ppp = all.find((s) => s._label === 'ppp 5yr');
  const ca = all.find((s) => s._label === 'state CA');
  ok(!!ppp && !!ca && bodyKey(ppp) === bodyKey(ca),
    'and the clearest case: `ppp 5yr` and `state CA` send the SAME body — 60 months is the default');
  ok(JSON.stringify(strip(ppp)) !== JSON.stringify(strip(ca)), '…while their scenario objects differ');
}

// ---- B: off by default -----------------------------------------------------------------------
console.log('\n-- B: nothing changes unless asked --');
const ours = async () => ({ eligible: false, ladder: [], declines: [] });
function counting() {
  let calls = 0;
  const lp = async () => { calls += 1; return { full: { programs: [] }, disqualified: { ready: true, lenders: [] } }; };
  return { lp, calls: () => calls };
}
const SCS = [{ _label: 'a', fico: 760 }, { _label: 'b', fico: 760 }, { _label: 'c', fico: 700 }];

(async () => {
  {
    const c = counting();
    const r = await runRatesheetAgreement(SCS, { ours, lp: c.lp }, {});
    ok(c.calls() === 3, `with no dedupeKey every scenario is asked (${c.calls()} calls for 3 scenarios)`);
    ok(r.summary.deduped === undefined, '…and the summary carries no dedupe counts at all');
    ok(r.results.length === 3, '…and every scenario still has a result');
  }

  // ---- C: on, and the coverage is untouched ------------------------------------------------------
  console.log('\n-- C: shared calls, whole coverage --');
  {
    const c = counting();
    const r = await runRatesheetAgreement(SCS, { ours, lp: c.lp }, { dedupeKey: (s) => `f${s.fico}` });
    ok(c.calls() === 2, `two distinct questions -> two paid calls (${c.calls()})`);
    ok(r.summary.deduped === 1 && r.summary.distinctRequests === 2,
      `…and the saving is REPORTED (${r.summary.deduped} shared, ${r.summary.distinctRequests} distinct)`);
    ok(r.results.length === 3, 'every scenario still has its own result — none was dropped');
    ok(r.results.map((x) => x.scenario).join(',') === 'a,b,c', '…in order, each under its own label');
    ok(r.summary.total === 3, '…and the battery still counts 3, not 2');
  }
  {
    // The duplicates must receive the SAME answer, not a re-derived one — that is what makes sharing
    // sound rather than merely cheap.
    let n = 0;
    const lp = async () => { n += 1; return { full: { programs: [{ lender: `L${n}`, investor: 'I', program: 'P', options: [] }] }, disqualified: { ready: true, lenders: [] } }; };
    const r = await runRatesheetAgreement(SCS, { ours, lp }, { dedupeKey: (s) => `f${s.fico}` });
    ok(n === 2, 'the leg really ran twice');
    ok(r.results[0].lpDisqReady === r.results[1].lpDisqReady, 'the two duplicates got the same answer object');
  }

  // ---- D: a key that cannot be computed never merges anything -------------------------------------
  console.log('\n-- D: an unkeyable scenario is always asked --');
  {
    const c = counting();
    await runRatesheetAgreement(SCS, { ours, lp: c.lp }, { dedupeKey: () => null });
    ok(c.calls() === 3, 'a null key merges nothing — guessing would answer a DIFFERENT question');
  }
  {
    const c = counting();
    await runRatesheetAgreement(SCS, { ours, lp: c.lp }, { dedupeKey: () => { throw new Error('boom'); } });
    ok(c.calls() === 3, 'a THROWING key merges nothing either, and does not break the run');
  }
  {
    const c = counting();
    await runRatesheetAgreement(SCS, { ours, lp: c.lp }, { dedupeKey: () => '' });
    ok(c.calls() === 3, 'an empty-string key merges nothing — it is absence, not a value');
  }

  // ---- E: concurrency shares ONE call, not N ------------------------------------------------------
  console.log('\n-- E: N workers, one call --');
  {
    let inflight = 0; let maxInflight = 0; let calls = 0;
    const lp = async () => {
      calls += 1; inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => { setTimeout(r, 5); });
      inflight -= 1;
      return { full: { programs: [] }, disqualified: { ready: true, lenders: [] } };
    };
    const many = Array.from({ length: 8 }, (_, i) => ({ _label: `s${i}`, fico: 760 }));
    const r = await runRatesheetAgreement(many, { ours, lp }, { concurrency: 8, dedupeKey: () => 'same' });
    ok(calls === 1, `eight concurrent workers on one question made ONE call (${calls}) — the PROMISE is cached, not the value`);
    ok(maxInflight === 1, '…so they never raced to start eight');
    ok(r.results.length === 8 && r.summary.total === 8, '…and all eight scenarios still have results');
  }

  // ---- F: a failure is shared too, deliberately ---------------------------------------------------
  console.log('\n-- F: an identical request that fails, fails identically --');
  {
    let calls = 0;
    const lp = async () => { calls += 1; throw new Error('vendor 500'); };
    const r = await runRatesheetAgreement(SCS, { ours, lp }, { dedupeKey: (s) => `f${s.fico}` });
    ok(calls === 2, `a rejected call is cached too (${calls} calls) — re-asking an identical failing request is the waste this closes`);
    ok(r.results.filter((x) => x.error).length === 3, '…and every scenario still reports its own error verdict');
    ok(r.summary.errors === 3, '…counted as three errors, not one');
  }

  // ---- G: the wiring and the claim ----------------------------------------------------------------
  console.log('\n-- G: the runner uses it, and says so --');
  {
    const cli = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
    ok(/dedupeKey:/.test(cli), 'the live runner passes a dedupeKey');
    ok(/buildSearch\(stripInternal\(sc\)\)/.test(cli), '…keyed on the REQUEST it would send, not the scenario');
    ok(/replace\(\/"date":"\[\^"\]\*"\/, ''\)/.test(cli), '…with the moving timestamp removed');
    ok(/catch \(_\) \{ return null; \}/.test(cli), '…and an unbuildable scenario keys to null rather than merging');
    ok(/paid calls/.test(cli), 'and the report STATES the saving — a run that quietly made fewer calls reads as a shrunken battery');
    ok(/distinctRequests/.test(cli), '…naming how many distinct requests the battery really asks');
    const src = fs.readFileSync(path.join(__dirname, '../src/longterm/ppe/ratesheet-agreement.js'), 'utf8');
    ok(/typeof opts\.dedupeKey === 'function' \? memoizeLeg/.test(src), 'the orchestrator only memoizes when asked');
    ok(typeof memoizeLeg === 'function', 'memoizeLeg is exported for this suite to drive directly');
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
