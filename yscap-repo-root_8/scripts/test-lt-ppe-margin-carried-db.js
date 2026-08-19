#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE PER-INVESTOR MARGIN, RESOLVED ONCE AND CARRIED INTO EVERY PRODUCTION QUOTE.
 *
 * WHAT WAS MEASURED BEFORE THIS EXISTED. `store.resolveMarginHoldbackForInvestor` was built,
 * tested and called by nothing. `quote.quoteProgram` already accepted `{ marginHoldback }` and
 * already preferred it over the settings margin. And EVERY production call passed only
 * `{ scenario, program, settings }` — `grep -rn "marginHoldback:" src/longterm/routes/` came back
 * empty. So the decision that our markup is PER INVESTOR was settled in the plan and inert in the
 * engine. `routes/ppe.js loadProgram` is the seam that joins the two ends: one resolution at the
 * one place a program is loaded, carried into all five pricing call sites.
 *
 * THE HEADLINE ASSERTION IS THE BYTE-IDENTICAL CONTROL (section C). With no per-investor override
 * set, the WHOLE priced result — every rung's rate, base price, itemized adjustments, final price
 * AND the pricingBasis record — must be EXACTLY what it is today, over the full 299-scenario
 * agreement battery, priced twice (the agreement leg's LP-shaped path and the canary/coverage
 * engine-facts path): 598 whole-result comparisons. A change that only shows up once a value is
 * SET is safe to merge; one that moves a price today is not.
 *
 * AND THE CONTROL IS PROVEN NOT TO BE VACUOUS (section D): the identical comparison, run against a
 * CONFIGURED investor, must FAIL. A byte-identical claim from a comparison that cannot tell two
 * different prices apart is worth nothing.
 *
 *   node scripts/test-lt-ppe-margin-carried-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-margin-carried-db.js
 *
 * LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/longterm/ppe/store');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const agreementScenarios = require('../src/longterm/ppe/agreement-scenarios');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// ---------------------------------------------------------------------------
// A fake db that answers the override table from an in-memory map, so the pure
// section exercises the REAL resolver with no database in reach.
// ---------------------------------------------------------------------------
function fakeDb(byScope) {
  return {
    query: async (_text, params) => ({ rows: (byScope[params[0]] || []).map((r) => ({ key: r[0], value: r[1] })) }),
  };
}
const throwingDb = { query: async () => { throw new Error('relation "lt_ppe_setting_value" does not exist'); } };
// Fails on the INVESTOR scope only — the company read succeeds, so this proves the second read is
// guarded too rather than riding on the first one's failure.
function investorOnlyThrowingDb(companyScope) {
  return { query: async (_t, p) => { if (p[0] !== companyScope) throw new Error('permission denied'); return { rows: [] }; } };
}

const SETTINGS = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none' };

(async () => {
  console.log('LT PPE — per-investor margin carried into pricing (pure)\n');

  // ---- A. the resolver: what is configured, what may reach the price -------
  {
    const prep = await store.prepareMarginHoldbackForInvestor(fakeDb({}), 'AAA', 'company');
    ok(prep.ok === true, 'A1 nothing stored anywhere → the layer resolves');
    ok(prep.configured === false, 'A2 …and reports NOTHING configured');
    ok(prep.forScenario({}) === null, 'A3 …so the pricer is handed NOTHING — today\'s quote is untouched');
    ok(prep.investorScope === 'investor:AAA', 'A4 the investor scope is named');
  }
  {
    // This investor's OWN margin — the owner's "set up for each and every Investor separately".
    const db = fakeDb({ 'investor:AAA': [['pricing.margin_milli', 400]] });
    const prep = await store.prepareMarginHoldbackForInvestor(db, 'AAA', 'company');
    const mh = prep.forScenario({ state: 'NY' });
    ok(prep.configured === true, 'A5 an investor override is configuration');
    ok(mh.marginMilli === 400 && mh.marginApplied === true, 'A6 …and it REACHES the price');
    ok(mh.marginSource === 'investor', 'A7 …reported as coming from the investor');
    // The shipped 0.250 pre-fill is RESOLVED and deliberately NOT handed to the pricer: it is a
    // pre-fill, not a decision, and subtracting it here would take a quarter point off every quote
    // for this investor because somebody set a MARGIN. A holdback a human sets does reach the price
    // (section G proves it). See store.js and §2.55(c).
    ok(mh.holdbackMilli === null && mh.holdbackSource === 'product_default_not_applied',
      'A8 the shipped holdback pre-fill is NOT applied to the price — only a holdback somebody set is');
    ok(mh.holdbackResolvedMilli === 250, 'A8b …while the resolved pre-fill is still reported, so the layer can be reconstructed');
  }
  {
    // The COMPANY's pricing.margin_milli is NOT applied — which of the two company margin knobs
    // governs is a MONEY question for the owner, recorded in LENDER-PRICE-PARITY-STATUS.md §2.
    const db = fakeDb({ company: [['pricing.margin_milli', 900]] });
    const prep = await store.prepareMarginHoldbackForInvestor(db, 'AAA', 'company');
    const mh = prep.forScenario({});
    ok(mh.marginMilli === null && mh.marginApplied === false, 'A9 a COMPANY margin_milli does NOT reach the price');
    ok(mh.marginSource === 'settings', 'A10 …and the record still says the settings margin priced it');
    ok(mh.resolved.marginMilli === 900 && mh.marginResolvedSource === 'company_margin_milli_not_applied',
      'A11 …while what it RESOLVED to, and why it was not used, is still reported');
  }
  {
    // A per-scenario RULE is an explicit instruction about THIS deal, so it applies.
    const rules = [{ code: 'ny_margin', when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }] }, marginMilli: 600 }];
    const db = fakeDb({ 'investor:AAA': [['pricing.margin_holdback_rules', rules]] });
    const prep = await store.prepareMarginHoldbackForInvestor(db, 'AAA', 'company');
    const ny = prep.forScenario({ state: 'NY' });
    const fl = prep.forScenario({ state: 'FL' });
    ok(ny.marginMilli === 600 && ny.marginSource === 'rule:ny_margin', 'A12 a matching rule sets the margin and NAMES itself');
    ok(fl.marginMilli === null && fl.marginSource === 'settings', 'A13 …and a scenario it does not match keeps today\'s margin');
  }
  {
    // ONE RESOLUTION, CARRIED: the database is read exactly twice (the company layer and the
    // investor layer), however many scenarios are then priced from it.
    let reads = 0;
    const counting = { query: async () => { reads += 1; return { rows: [] }; } };
    const prep = await store.prepareMarginHoldbackForInvestor(counting, 'AAA', 'company');
    for (let i = 0; i < 500; i += 1) prep.forScenario({ state: 'NY', loan_amount: i });
    ok(reads === 2, `A14 500 scenarios priced from ${reads} database reads — the layer is read once and CARRIED`);
  }
  {
    // Holdback-only configuration: carried for the record, never applied.
    const db = fakeDb({ 'investor:AAA': [['pricing.holdback_milli', 500]] });
    const prep = await store.prepareMarginHoldbackForInvestor(db, 'AAA', 'company');
    const mh = prep.forScenario({});
    ok(mh.holdbackMilli === 500, 'A15 a holdback override is carried into the reconstruction record');
    ok(mh.marginMilli === null, 'A16 …and it may NEVER become a margin');
  }

  // ---- B. FAIL CLOSED, and SAY SO -----------------------------------------
  {
    const bad = await store.prepareMarginHoldbackForInvestor(throwingDb, 'AAA', 'company');
    ok(bad.ok === false, 'B1 an unreadable override table FAILS CLOSED — never a silent company-margin fallback');
    ok(/company scope "company"/.test(bad.error) && /does not exist/.test(bad.error), 'B2 …and says which scope failed, in the database\'s own words');
    const bad2 = await store.prepareMarginHoldbackForInvestor(investorOnlyThrowingDb('company'), 'AAA', 'company');
    ok(bad2.ok === false && /investor scope "investor:AAA"/.test(bad2.error), 'B3 an unreadable INVESTOR scope fails closed on its own');
    ok(typeof bad.forScenario !== 'function', 'B4 a failed resolution offers NO resolver to price with');
    // The legacy reporting read keeps its documented degrade-safely contract — it is an admin read,
    // not a pricing decision, and other callers depend on it.
    const legacy = await store.resolveMarginHoldbackForInvestor(throwingDb, 'AAA', {});
    ok(legacy.marginMilli === 250, 'B5 the legacy reporting resolver still degrades to the pre-fill (unchanged contract)');
  }

  if (!process.env.DATABASE_URL) {
    console.log('\n(the battery + the live route seam need DATABASE_URL — skipped.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  // =========================================================================
  console.log('\nLT PPE — per-investor margin, against a real Postgres\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const scope = 'test_mc_' + Math.abs(process.pid || 1);
  const CODE_A = 'MCA' + Math.abs(process.pid || 1);
  const CODE_B = 'MCB' + Math.abs(process.pid || 1);
  const invScopes = [`investor:${CODE_A}`, `investor:${CODE_B}`];
  const routes = require('../src/longterm/routes/ppe');
  const { loadProgram } = routes._internals;

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = ANY($1) OR scope = $2', [invScopes, scope]);
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql', '560_lt_ppe_ratesheet.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // Two investors with IDENTICAL sheets, so any difference between them is the margin and
    // nothing else.
    const mkSheet = async (invCode, invName) => {
      const inv = await store.createInvestor(db, scope, { code: invCode, name: invName });
      const prog = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30yr' });
      const ver = await store.createRateSheetVersion(db, scope, { programId: prog.id, versionNo: 1, channel: 'correspondent' });
      await store.replaceBasePrices(db, scope, ver.id, [
        { noteRateMilliPct: 70000, lockDays: 30, priceMilli: 101500 },
        { noteRateMilliPct: 71250, lockDays: 30, priceMilli: 102850 },
      ]);
      await store.replaceAdjustments(db, scope, ver.id, [
        { code: 'dscr_115', dimension: 'dscr', dscrMin: 1000, dscrMax: 1250, adjMilli: 250, priority: 0 },
      ]);
      await store.setPriceLimit(db, scope, ver.id, { minPriceMilli: 98000, roundingMode: 'none', roundingIncrementMilli: 0, capTiers: [] });
      return ver.id;
    };
    const verA = await mkSheet(CODE_A, 'Margin Carry A');
    const verB = await mkSheet(CODE_B, 'Margin Carry B');
    ok(!!verA && !!verB, 'DB-0 two investors with byte-identical rate sheets are stored');

    const BATTERY = agreementScenarios.buildAgreementScenarios().scenarios;
    ok(BATTERY.length >= 200, `DB-1 the agreement battery is ${BATTERY.length} scenarios`);
    const FACTS = BATTERY.map((s) => legs.lpScenarioToFacts(s));

    // The two ways production prices a battery, from ONE loaded program:
    //   • the agreement leg (LP-shaped scenarios, converted inside buildOursLeg)
    //   • the canary / rule-coverage path (engine facts straight into quoteProgram)
    // `marginFor` is what loadProgram resolved ONCE; `null` is what production did BEFORE.
    const priceBattery = (program, marginFor) => {
      const leg = legs.buildOursLeg(program, SETTINGS, { factsFromLp: true, marginHoldback: marginFor || undefined });
      const out = [];
      for (let i = 0; i < BATTERY.length; i += 1) {
        out.push(leg(BATTERY[i]));
        out.push(quoteProgram({
          scenario: FACTS[i], program, settings: SETTINGS,
          marginHoldback: marginFor ? marginFor(FACTS[i]) : undefined,
        }));
      }
      return out;
    };
    // The WHOLE priced result — every rung's rate, base price, itemized adjustments and final
    // price, plus the pricingBasis record. Not the loan size, not a summary.
    const asJson = (rows) => rows.map((r) => JSON.stringify(r));
    const firstDiff = (a, b) => { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return i; return -1; };

    // ---- C. THE BYTE-IDENTICAL CONTROL (the headline) --------------------
    const loadedA = await loadProgram(scope, verA);
    ok(!!loadedA.program && typeof loadedA.marginFor === 'function', 'C1 loadProgram returns the program AND the carried margin resolver');
    ok(loadedA.margin && loadedA.margin.investorCode === CODE_A, 'C2 …resolved for THIS sheet\'s investor');
    ok(loadedA.margin.configured === false, 'C3 …and reports that nothing per-investor is configured yet');

    const before = asJson(priceBattery(loadedA.program, null));      // production as it was
    const after = asJson(priceBattery(loadedA.program, loadedA.marginFor)); // production as it is now
    const d = firstDiff(before, after);
    ok(before.length === BATTERY.length * 2, `C4 the control priced ${before.length} whole results (${BATTERY.length} scenarios × 2 production paths)`);
    ok(d === -1, `C5 UNCONFIGURED: every one of the ${before.length} whole priced results is BYTE-IDENTICAL${d === -1 ? '' : ` (first difference at #${d})`}`);
    ok(after.every((s) => JSON.parse(s).pricingBasis.marginMilli === 250), 'C6 …priced at the company settings margin, as today');
    ok(after.every((s) => JSON.parse(s).pricingBasis.marginSource === 'settings'), 'C7 …and the record SAYS it was the settings margin');
    ok(after.every((s) => JSON.parse(s).pricingBasis.holdbackMilli === null), 'C8 …with no holdback anywhere near the record');

    // ---- D. the control is SENSITIVE ------------------------------------
    await store.setSetting(db, `investor:${CODE_A}`, 'pricing.margin_milli', 400, null);
    const loadedA2 = await loadProgram(scope, verA);
    ok(loadedA2.margin.configured === true && loadedA2.margin.defaults.margin.source === 'tenant',
      'D1 the stored per-investor margin is read back from the SERVER, from the investor layer');
    const configured = asJson(priceBattery(loadedA2.program, loadedA2.marginFor));
    const dConf = firstDiff(before, configured);
    ok(dConf !== -1, 'D2 CONTROL ON THE CONTROL: the same comparison now DIFFERS — it can tell two prices apart');
    ok(configured.every((s) => JSON.parse(s).pricingBasis.marginMilli === 400), 'D3 every rung prices at the investor\'s 400');
    ok(configured.every((s) => JSON.parse(s).pricingBasis.marginSource === 'investor'), 'D4 …and the answer SAYS it came from the investor, not the company default');
    // A bigger margin is a bigger cost: price falls by exactly the extra 150 milli-points.
    const oneBefore = JSON.parse(before[0]);
    const oneAfter = JSON.parse(configured[0]);
    ok(oneBefore.ladder.every((r, i) => oneAfter.ladder[i].finalPriceMilli === r.finalPriceMilli - 150),
      'D5 …and every rung moves by EXACTLY the 150 milli-points of extra margin');

    // ---- E. one investor's margin touches NO other investor --------------
    const loadedB = await loadProgram(scope, verB);
    ok(loadedB.margin.investorCode === CODE_B && loadedB.margin.configured === false, 'E1 the other investor has no override of its own');
    // Compared against ITS OWN baseline: the two sheets are byte-identical but they are different
    // rate-sheet VERSIONS, and a quote names the version it priced from, so B's control has to be
    // B's own or the assertion would be about the program id rather than about the margin.
    const beforeB = asJson(priceBattery(loadedB.program, null));
    const otherInvestor = asJson(priceBattery(loadedB.program, loadedB.marginFor));
    ok(firstDiff(beforeB, otherInvestor) === -1, `E2 …so all ${otherInvestor.length} of its whole priced results are still BYTE-IDENTICAL`);
    ok(otherInvestor.every((s) => JSON.parse(s).pricingBasis.marginMilli === 250 && JSON.parse(s).pricingBasis.marginSource === 'settings'),
      'E3 …still priced at the company default, and the record still SAYS so — one investor\'s markup reaches no other investor');

    // ---- F. a per-scenario rule ------------------------------------------
    await store.setSetting(db, `investor:${CODE_A}`, 'pricing.margin_holdback_rules', [
      { code: 'ny_margin', when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }] }, marginMilli: 600 },
    ], null);
    const loadedA3 = await loadProgram(scope, verA);
    const ny = FACTS.findIndex((f) => f.state === 'NY');
    const notNy = FACTS.findIndex((f) => f.state && f.state !== 'NY');
    ok(ny >= 0 && notNy >= 0, 'F1 the battery carries both an NY scenario and a non-NY one');
    const qNy = quoteProgram({ scenario: FACTS[ny], program: loadedA3.program, settings: SETTINGS, marginHoldback: loadedA3.marginFor(FACTS[ny]) });
    const qOther = quoteProgram({ scenario: FACTS[notNy], program: loadedA3.program, settings: SETTINGS, marginHoldback: loadedA3.marginFor(FACTS[notNy]) });
    ok(qNy.pricingBasis.marginMilli === 600 && qNy.pricingBasis.marginSource === 'rule:ny_margin',
      'F2 the NY scenario prices at the RULE\'s margin, and the record names the rule');
    ok(qOther.pricingBasis.marginMilli === 400 && qOther.pricingBasis.marginSource === 'investor',
      'F3 …while a scenario the rule does not match keeps the investor default — resolved PER SCENARIO from ONE database read');

    // ---- G. THE HOLDBACK REACHES THE PRICE, AND ONLY THROUGH ITS OWN LINE ---
    //
    // This section used to assert the OPPOSITE — that a configured holdback moved no price — because
    // how the holdback combines into the borrower's rate was an open money rule nobody was allowed to
    // guess. The owner answered it on 2026-08-18 in their own words ("instead of offering the
    // investor's raw pricing, like a 102, we're only gonna offer him a 101.75"), so what is pinned
    // here is the answer. Two things this section still uniquely proves, which the holdback suite
    // cannot: that a holdback set on an INVESTOR SCOPE travels the whole database → loadProgram →
    // marginFor → quote path, and that it lands as a holdback rather than being folded into margin.
    await store.setSetting(db, `investor:${CODE_B}`, 'pricing.holdback_milli', 500, null);
    const loadedB2 = await loadProgram(scope, verB);
    const withHoldback = priceBattery(loadedB2.program, loadedB2.marginFor);
    const beforeParsed = beforeB.map((s) => JSON.parse(s));
    const movedByExactly = withHoldback.every((q, i) => {
      const was = beforeParsed[i].ladder; const now = q.ladder;
      if (!Array.isArray(was) || !Array.isArray(now) || was.length !== now.length) return false;
      return now.every((r, j) => r.finalPriceMilli === was[j].finalPriceMilli - 500);
    });
    ok(movedByExactly, `G1 a holdback set on the INVESTOR moves every one of ${withHoldback.length} ladders DOWN by exactly its own 0.500`);
    ok(withHoldback.every((q) => q.pricingBasis.holdbackMilli === 500), 'G2 …and is recorded as the holdback that did it');
    ok(withHoldback.every((q) => q.pricingBasis.marginMilli === 250 && q.pricingBasis.marginSource === 'settings'),
      'G3 …on its OWN line: the margin is untouched, so the record can still say which of the two moved the price');

    // ---- H. a COMPANY margin_milli still moves no price ------------------
    await store.setSetting(db, scope, 'pricing.margin_milli', 900, null);
    const loadedB3 = await loadProgram(scope, verB);
    const companyOnly = priceBattery(loadedB3.program, loadedB3.marginFor);
    // Compared against the section-G result, NOT the original baseline: G set a real 0.500 holdback
    // on this investor and that correctly still prices. What H asks is whether adding a COMPANY
    // margin_milli on top moves anything — and it must not.
    ok(!companyOnly.some((q, i) => JSON.stringify(q.ladder) !== JSON.stringify(withHoldback[i].ladder)),
      'H1 a COMPANY-level margin_milli moves no price — which of the two company margin knobs governs is an OWNER question (§2.55), never a guess');
    ok(loadedB3.marginFor(FACTS[0]).marginResolvedSource === 'company_margin_milli_not_applied',
      'H2 …and the resolver says exactly that, rather than going quiet about it');
    await store.clearSetting(db, scope, 'pricing.margin_milli');

    // ---- I. THE ROUTE SEAM FAILS CLOSED ---------------------------------
    // The route's own db is the module pool, so the failure is injected at the ONE call the seam
    // makes. What is being proven is the ROUTE's behaviour: no program, a stated reason, and no
    // quote priced at a margin nobody confirmed.
    const realPrepare = store.prepareMarginHoldbackForInvestor;
    store.prepareMarginHoldbackForInvestor = async () => ({ ok: false, error: 'company scope "company": connection terminated' });
    let broken;
    try { broken = await loadProgram(scope, verA); } finally { store.prepareMarginHoldbackForInvestor = realPrepare; }
    ok(broken.program === null, 'I1 an unreadable margin yields NO program — the shadow is skipped, never priced at the company margin');
    ok(/^margin_unreadable: /.test(broken.reason), 'I2 …and the caller is TOLD why, in a reason it can print');
    ok(/connection terminated/.test(broken.reason), 'I3 …carrying the underlying failure');
    ok(typeof broken.marginFor === 'function' && broken.marginFor({}) === null, 'I4 …and its resolver answers nothing rather than being undefined');
    ok((await loadProgram(scope, verA)).program !== null, 'I5 (control) the same load succeeds again once the read works');

    // ---- J. the wiring itself -------------------------------------------
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
    const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const quoteCalls = routeCode.match(/quote\.quoteProgram\(\{[^}]*\}/g) || [];
    // WAS 4, IS 3 — and the drop is a STRENGTHENING, accounted for by J3 rather than waved through.
    // §2.122 replaced the canary's direct `quoteProgram(raw scenario)` with `buildOursLeg`, which was
    // fixing a much larger defect (the raw Lender Price scenario reached our engine, so 305 of 305
    // scenarios declined) and carries the margin resolver as one of its arguments. So one call site
    // left this count and reappeared in the one below. If this number drops again, find where the
    // pricing went before changing it.
    ok(quoteCalls.length === 2, `J1 the route makes ${quoteCalls.length} direct quoteProgram calls — /breakdown and the coverage profiler, both of which are handed ENGINE FACTS by their own callers (§2.123). /quote used to be the third and is now a buildOursLeg leg.`);
    ok(quoteCalls.every((c) => /marginHoldback:/.test(c)), 'J2 …and EVERY one of them carries the per-investor margin');
    // Indentation differs between the two call sites, so the window is taken by offset rather than by
    // a closing-brace pattern — a shape guard that depends on how a call happens to be formatted is the
    // kind that goes green for the wrong reason.
    const legOffsets = [];
    for (let i = routeCode.indexOf('buildOursLeg('); i !== -1; i = routeCode.indexOf('buildOursLeg(', i + 1)) legOffsets.push(i);
    ok(legOffsets.length === 5,
      `J3 …plus ${legOffsets.length} legs built from buildOursLeg — the agreement run, the pre-flight, the review sweep, the canary (§2.122) and the live /quote shadow (§2.123)`);
    ok(legOffsets.every((i) => /marginHoldback: marginFor/.test(routeCode.slice(i, i + 700))),
      'J3b …and every one of THOSE carries the per-investor margin too, so nothing prices at a margin nobody confirmed');
    ok(legOffsets.every((i) => /factsFromLp: true/.test(routeCode.slice(i, i + 700))),
      'J3c …and every one converts the Lender Price scenario into engine facts (§2.122 — the raw form priced 0 of 305)');
    ok((routeCode.match(/prepareMarginHoldbackForInvestor\(/g) || []).length === 1,
      'J4 the margin is resolved ONCE, at the one place a program is loaded — not four times at four call sites');
  } finally {
    await cleanup();
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
