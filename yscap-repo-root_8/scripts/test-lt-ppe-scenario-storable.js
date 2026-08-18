#!/usr/bin/env node
'use strict';
/**
 * LT PPE — a battery scenario must be STORABLE, and a stated lock must REACH the engine.
 *
 * Two defects in the battery→engine path, both found by measurement and both silent:
 *
 * A. THE SENTINELS WERE BUILT FROM A NUL BYTE. `agreement-scenario-generator`'s `distinctFrom` and
 *    `notIn` mint a value nothing real can collide with, and used `\0` to do it. A sentinel is
 *    assigned into a scenario's FACTS, the facts become its `_label`, and that label travels all the
 *    way into `agreement-store.recordRun`, which stores the run summary as **jsonb**. Postgres refuses
 *    a NUL in jsonb (22P05). So a paid ≥200-scenario run that generated one and then disagreed on it
 *    would finish and be unable to record its verdict. `lib/nul-strip` cannot help — it scrubs inbound
 *    request bodies, and this value is minted by our own code long past that boundary.
 *
 *    LATENT, NOT LIVE, AND THE DIFFERENCE MATTERS: this generator is NOT the producer of the canonical
 *    299-scenario battery (that is `agreement-scenarios.js`, a different function of the same name).
 *    Its only caller today is the rate-sheet coverage check, which stores nothing — so no run has lost
 *    a verdict to this. It is a landmine on the path every future generated scenario takes, and it also
 *    made the file read as BINARY to git and grep, so no text-based guard could ever see inside it.
 *
 * B. A STATED LOCK NEVER REACHED THE ENGINE. The LP scenario vocabulary names the lock `lockDays`, and
 *    `lpScenarioToFacts` read neither that nor anything like it, so a scenario asking Lender Price for a
 *    45-day lock was priced here as the 30-day default — two different loans. Same class as §2.14.
 *
 *    THE OBVIOUS FIX WOULD HAVE BEEN WORSE. `lock_days` is the RUNG-SELECTION key (`quote.selectRungs`
 *    filters the single 30-day base ladder by it); `lock_term_days` is the PRICING key the 45/60-day
 *    adjustment reads. `deephaven-dscr-prepay-maxprice`'s header states the split deliberately. Setting
 *    `lock_days: 45` matches no rung and returns `eligible: true` with an EMPTY ladder — a priced loan
 *    with no price. The requested period therefore rides on `lock_term_days`, which additionally makes
 *    `dhvn_lock_45` / `dhvn_lock_60` reachable: they were measured as never firing for exactly this
 *    reason — nothing emitted the fact they key on.
 *
 * WHAT IS PROVEN: that the sentinels still SEPARATE (through the real predicate evaluator, not by
 * eyeballing the string), that nothing the generator emits can carry a control character, that a whole
 * generated battery survives a round trip through jsonb, and that a lock stated either way arrives.
 * The Postgres half runs only with DATABASE_URL — it is the only thing that can prove the refusal is
 * real rather than remembered.
 *
 *   node scripts/test-lt-ppe-scenario-storable.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-scenario-storable.js
 *
 * LT-only. No RTL imports.
 */
const assert = require('assert');
const G = require('../src/longterm/ppe/agreement-scenario-generator');
const { evalPredicate } = require('../src/longterm/ppe/rules');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

// A control character is anything a text column or jsonb can choke on; NUL is the one Postgres refuses
// outright, and it is invisible in every log, diff and screenshot, which is what let it survive.
const CONTROL = /[\u0000-\u001F\u007F]/;
const hasControl = (s) => typeof s === 'string' && CONTROL.test(s);

// A program shaped like the real ones: it is the ENUM leaves (state, purpose) that drive the sentinels.
// A numeric leaf never reaches them, which is why this went unnoticed for so long.
const PROGRAM = {
  code: 'STORABLE', name: 'storable probe', investorCode: 'DHVN',
  baseGrid: [{ rate: 70000, lockDays: 30, basePriceMilli: 101000 }],
  rules: [
    { code: 'elig_state_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'no NY', dimension: 'state' },
    { code: 'elig_state_in', kind: 'eligibility', when: { fact: 'state', op: 'nin', value: ['TX', 'FL'] }, declineReason: 'state', dimension: 'state' },
    { code: 'llpa_purpose', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { dimension: 'purpose', adjMilli: 500, unit: 'points', reason: 'cash-out' } },
    { code: 'llpa_fico', kind: 'pricing', when: { fact: 'fico', op: 'between', value: [740, 760] }, adjustment: { dimension: 'fico', adjMilli: 250, unit: 'points', reason: 'fico' } },
  ],
};
const AXES = { purpose: ['purchase', 'refinance', 'cashout'], occupancy: ['investment', 'primary'] };
const BASE = { term: 30, lock_days: 30, product: '30yr' };

// ---- A1. the sentinels themselves ---------------------------------------------------------------
{
  const ne = G._internals.distinctFrom('purchase', 1);
  const nin = G._internals.notIn(['NY', 'CA'], 1);
  ok(!hasControl(ne), `A1 distinctFrom carries no control character (${JSON.stringify(ne)})`);
  ok(!hasControl(nin), `A2 notIn carries no control character (${JSON.stringify(nin)})`);

  // THE PROPERTY THEY EXIST FOR, proven through the REAL evaluator rather than by reading the string:
  // a sentinel is worthless if it happens to satisfy the leaf it was minted to falsify.
  // `evalPredicate` answers { value, unknown } — a bare boolean compare would be true of the OBJECT
  // and would pass no matter what the predicate decided.
  ok(evalPredicate({ fact: 'purpose', op: 'eq', value: 'purchase' }, { purpose: ne }).value === false,
    'A3 the distinct sentinel really does FALSIFY the leaf it was built from');
  ok(evalPredicate({ fact: 'state', op: 'in', value: ['NY', 'CA'] }, { state: nin }).value === false,
    'A4 the not-in sentinel really is outside the list');
  ok(evalPredicate({ fact: 'state', op: 'nin', value: ['NY', 'CA'] }, { state: nin }).value === true,
    'A5 …and therefore SATISFIES the nin leaf, which is what it is generated for');

  // A numeric leaf must be untouched — the sentinels are the non-numeric branch only.
  ok(G._internals.distinctFrom(700, 1) === 701 && G._internals.notIn([10, 20], 1) === 21,
    'A6 numeric values still separate by epsilon, not by a sentinel');
}

// ---- A2. a whole generated battery is storable ---------------------------------------------------
{
  const built = G.buildProgramAgreementScenarios({ program: PROGRAM, axes: AXES, base: BASE, opts: { maxScenarios: 400 } });
  const list = built.scenarios || [];
  ok(list.length > 0, `A7 the probe program generates a battery (${list.length} scenarios)`);

  let controlFacts = 0; let controlLabels = 0;
  for (const s of list) {
    if (hasControl(String(s._label || ''))) controlLabels += 1;
    for (const k of Object.keys(s)) if (hasControl(s[k])) controlFacts += 1;
  }
  ok(controlFacts === 0, 'A8 no generated FACT carries a control character');
  ok(controlLabels === 0, 'A9 no scenario LABEL carries one either — the label is what reaches the database');

  // The whole battery, serialized the way recordRun serializes the summary.
  const json = JSON.stringify(list);
  ok(!json.includes('\\u0000'), 'A10 the serialized battery contains no escaped NUL');

  // A sentinel IS present — otherwise A8/A10 would be passing over a battery that never exercised the
  // branch under test, which is this workstream's most-repeated defect.
  const sentinelled = list.filter((s) => Object.keys(s).some(
    (k) => typeof s[k] === 'string' && /__ppe_(ne|not_in)__/.test(s[k])));
  ok(sentinelled.length > 0,
    `A11 and the battery DOES use a sentinel (${sentinelled.length} scenarios) — so A8–A10 are not vacuous`);
}

// ---- B. a stated lock reaches the engine ---------------------------------------------------------
{
  const base = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'CA' };
  const f45 = lpScenarioToFacts({ ...base, lockDays: 45 });
  ok(f45.lock_term_days === 45, 'B1 a stated lockDays reaches the engine as the PRICING key');
  ok(f45.lock_days === 30,
    'B2 …and the RUNG key stays at the base ladder\'s 30 — otherwise selectRungs matches nothing '
    + 'and the quote is eligible with an EMPTY ladder');
  ok(lpScenarioToFacts(base).lock_term_days === 30 && lpScenarioToFacts(base).lock_days === 30,
    'B3 an unstated lock is still 30 on both');
  ok(lpScenarioToFacts({ ...base, lock_days: 45 }).lock_days === 45,
    'B4 an engine-facts caller stating lock_days directly still gets it — no caller moves');
  ok(lpScenarioToFacts({ ...base, lock_term_days: 60 }).lock_term_days === 60,
    'B5 and one stating lock_term_days directly gets that');

  // THE POINT, not the plumbing: two different locks must be two different loans on our side.
  ok(lpScenarioToFacts({ ...base, lockDays: 30 }).lock_term_days
    !== lpScenarioToFacts({ ...base, lockDays: 45 }).lock_term_days,
  'B6 two stated locks no longer collapse to the same loan');
}

// ---- D. THE DEAD LLPA IS ALIVE — measured on the real composed sheet ------------------------------
// A fact reaching the engine is plumbing; a PRICE moving is the point. `dhvn_lock_45` / `dhvn_lock_60`
// were measured as never firing across the whole 299-scenario battery, for exactly one reason: nothing
// emitted `lock_term_days`. This prices the real Deephaven composed grid at all three locks.
{
  const { buildPrepayMaxPriceGrid } = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');
  const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
  const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
  const { quoteProgram } = require('../src/longterm/ppe/quote');
  const settings = require('../src/longterm/ppe/settings');

  const program = rateSheetToProgram(gridToRateSheet(buildPrepayMaxPriceGrid()), { code: 'DHVN_DSCR30' });
  const values = settings.resolveAll().values;
  const sc = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'CA', prepayMonths: 60 };
  const priceAt = (days) => {
    const q = quoteProgram({ scenario: lpScenarioToFacts({ ...sc, lockDays: days }), program, settings: values });
    const rung = (q.ladder || [])[0] || {};
    const lock = (rung.adjustments || []).filter((a) => /lock/i.test(a.code || ''));
    return { rungs: (q.ladder || []).length, lock };
  };
  const d30 = priceAt(30); const d45 = priceAt(45); const d60 = priceAt(60);

  ok(d30.lock.length === 0, 'D1 a 30-day lock is the base ladder and carries no lock adjustment');
  ok(d45.lock.length === 1 && d45.lock[0].code === 'dhvn_lock_45',
    `D2 a 45-day lock now FIRES dhvn_lock_45 (${d45.lock[0] && d45.lock[0].costMilli} milli) — measured as never firing before`);
  ok(d60.lock.length === 1 && d60.lock[0].code === 'dhvn_lock_60',
    `D3 …and a 60-day lock fires dhvn_lock_60 (${d60.lock[0] && d60.lock[0].costMilli} milli)`);

  // THE GUARD AGAINST THE FIX THAT WOULD HAVE BEEN WORSE: pinning lock_days to the requested period
  // matches no rung, and the loan comes back eligible with an empty ladder — priced, with no price.
  ok(d30.rungs === 28 && d45.rungs === 28 && d60.rungs === 28,
    `D4 and the ladder is intact at every lock (${d30.rungs}/${d45.rungs}/${d60.rungs} rungs) — the rung key never moved`);
}

// ---- C. Postgres itself, because a refusal remembered is not a refusal proven --------------------
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('  --   C section skipped — set DATABASE_URL to prove the jsonb refusal is real.');
  } else {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const built = G.buildProgramAgreementScenarios({ program: PROGRAM, axes: AXES, base: BASE, opts: { maxScenarios: 400 } });
      const summary = { disagreeing: (built.scenarios || []).map((s) => s._label) };
      await pool.query('SELECT $1::jsonb', [JSON.stringify(summary)]);
      ok(true, 'C1 a summary built from the real battery stores as jsonb');

      // THE CONTROL that gives C1 its meaning: the same summary with a NUL in one label is REFUSED.
      // Without this, C1 would pass just as happily against a database that accepted anything.
      let refused = null;
      try {
        await pool.query('SELECT $1::jsonb', [JSON.stringify({ disagreeing: [`state=${'\u0000'}notin`] })]);
      } catch (e) { refused = e.code; }
      ok(refused === '22P05',
        `C2 CONTROL — the same shape carrying a NUL is refused by Postgres (${refused || 'ACCEPTED'})`);
    } finally { await pool.end(); }
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe scenario storable (${n} assertions)`}`);
  assert.strictEqual(failures, 0);
})().catch((e) => { console.error(e); process.exit(1); });
