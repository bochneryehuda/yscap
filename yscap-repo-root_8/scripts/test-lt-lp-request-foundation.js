#!/usr/bin/env node
'use strict';
/**
 * LT / Lender Price — THE REQUEST FOUNDATION.  (offline; no database, no network)
 *
 * WHAT THIS PROVES, AND WHY IT EXISTS.
 *
 * `GET /pricing/defaultSearch` returns the company's CONFIGURATION model. The browser never sends
 * it — it transforms it into a smaller, differently-shaped request before calling searchRaw.
 * `buildSearch` used to start from `clone(opts.base || BASE)`, so with a live foundation present
 * (production, always) it POSTED THE CONFIGURATION MODEL. Measured against the live tenant on one
 * DSCR scenario: the frontend's request is 6,808 bytes → HTTP 200 with 17 programs, while the
 * configuration-model request is 8,576 bytes, differs in 203 structures, and returns HTTP 500 —
 * every scenario, every time. A login that provably worked still produced no pricing.
 *
 * The 500 was bisected on the live tenant to ONE leaf: `criteria.mortgageTypes` arrives NULL on the
 * configuration model, and patching only that value turned the failing request into HTTP 200
 * (`companyId: null` and a missing county FIPS were each tested alone and are innocent). Fixing only
 * that leaf is REFUSED here on purpose, and section E is what refuses it: a request repaired that
 * narrowly starts succeeding while still carrying ~200 wrong structures, and such a body returns 411
 * priced leaves against the frontend's 439 and 16 programs against 17. A quietly smaller product set
 * is worse than a loud failure, because nobody goes looking for the lender that stopped appearing.
 *
 * So the rule under test is structural: the foundation is ALWAYS the canonical frontend request, and
 * a live model may only contribute VALUES through `mergeKnownRequestDefaults`.
 */
const path = require('path');
const sm = require(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'search-model.js'));
const { mergeKnownRequestDefaults, buildSearch, BASE } = sm;

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; } else { failed++; console.log('  FAIL: ' + what); } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const leaves = (o, p = '', out = {}) => {
  if (o && typeof o === 'object' && !Array.isArray(o)) { for (const k of Object.keys(o)) leaves(o[k], p ? p + '.' + k : k, out); }
  else out[p] = o;
  return out;
};

// A stand-in for the live configuration model: it carries the request's keys with DIFFERENT values,
// a null where the request needs a real value, and configuration-only keys the frontend strips.
function fakeLiveModel() {
  return {
    companyId: 'live-company-id',
    criteria: {
      mortgageTypes: null,          // ← the measured cause of the live 500
      loanYear: 15,                 // a real live default: must be allowed through
      pmiType: 'None',              // ditto
      fico: null,                   // "not configured" — must not blank the request
      storageOnlyToggle: true,      // configuration-only: must never reach the wire
    },
    property: { address: { zip: '90210', city: 'Beverly Hills' } },
    savedSearchName: 'my saved search',   // configuration-only, top level
    workspacePreferences: { theme: 'dark' },
  };
}

console.log('LT Lender Price — request foundation');

// ---- A. the normalizer's own rules -----------------------------------------------------------
console.log('\nA. mergeKnownRequestDefaults');
{
  const out = mergeKnownRequestDefaults(clone(BASE), fakeLiveModel());

  ok(!('savedSearchName' in out), 'a configuration-only TOP-LEVEL key is never copied into the request');
  ok(!('workspacePreferences' in out), 'a configuration-only top-level OBJECT is never copied');
  ok(out.criteria && !('storageOnlyToggle' in out.criteria), 'a configuration-only NESTED key is never copied');

  // The rule that fixes the measured 500 — stated generally, not as a special case.
  ok(Array.isArray(out.criteria.mortgageTypes) && out.criteria.mortgageTypes.length > 0,
    'a NULL from the live model never overwrites a proven request value (this is the measured 500)');
  ok(out.criteria.fico !== null, 'a null live scalar leaves the canonical value in place');

  // Live defaults still reach the wire — that is the whole point of fetching them.
  ok(out.criteria.loanYear === 15, 'a real live default of the right type IS adopted');
  ok(out.criteria.pmiType === 'None', 'a real live string default IS adopted');

  // Type discipline.
  const typed = mergeKnownRequestDefaults(clone(BASE), { criteria: { loanAmount: { nested: 'object' }, fico: 'seven hundred' } });
  ok(typeof typed.criteria.loanAmount === 'number' || typed.criteria.loanAmount === null,
    'an object offered where the request wants a number is refused');
  ok(typeof typed.criteria.fico !== 'string' || BASE.criteria.fico === null,
    'a string offered where the request wants a number is refused');

  const arr = mergeKnownRequestDefaults(clone(BASE), { criteria: { mortgageTypes: ['FHA', 'VA'] } });
  ok(JSON.stringify(arr.criteria.mortgageTypes) === JSON.stringify(['FHA', 'VA']),
    'an array of the right shape is taken WHOLE');
  const arrBad = mergeKnownRequestDefaults(clone(BASE), { criteria: { mortgageTypes: 'Conventional' } });
  ok(Array.isArray(arrBad.criteria.mortgageTypes), 'a scalar offered where the request wants an array is refused');

  // It must never mutate the caller's live model, and must survive junk.
  const live = fakeLiveModel();
  const before = JSON.stringify(live);
  mergeKnownRequestDefaults(clone(BASE), live);
  ok(JSON.stringify(live) === before, 'the live model is never mutated');
  for (const junk of [null, undefined, 42, 'x', [], () => {}]) {
    let threw = false;
    try { mergeKnownRequestDefaults(clone(BASE), junk); } catch { threw = true; }
    ok(!threw, 'junk live model ' + JSON.stringify(String(junk)) + ' does not throw');
  }
}

// ---- B. the request SHAPE is the canonical one, whatever the live model looks like -------------
console.log('\nB. buildSearch keeps the canonical request shape');
{
  const SCEN = { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
    state: 'NY', zip: '11211', county: 'Kings', countyFps: '36047',
    propertyType: 'SingleFamily', units: 1, borrowerType: 'LLC', incomeDocType: 'DSCR', termYears: 30 };

  const withLive = buildSearch(SCEN, { base: fakeLiveModel() });
  const without = buildSearch(SCEN, {});

  const kL = Object.keys(leaves(withLive)).sort();
  const kN = Object.keys(leaves(without)).sort();
  ok(JSON.stringify(kL) === JSON.stringify(kN),
    'the live foundation changes VALUES only — the request carries exactly the same leaves either way');

  ok(!JSON.stringify(withLive).includes('savedSearchName'), 'no configuration-only key reaches the built request');
  ok(!JSON.stringify(withLive).includes('workspacePreferences'), 'no configuration-only block reaches the built request');
  ok(!JSON.stringify(withLive).includes('storageOnlyToggle'), 'no nested configuration-only key reaches the built request');

  ok(Array.isArray(withLive.criteria.mortgageTypes) && withLive.criteria.mortgageTypes.length > 0,
    'a live model whose mortgageTypes is null still builds a request that carries them');

  // The stale-address rule (§31.6) still holds through the new foundation.
  const addr = withLive.property.address;
  ok(addr.zip === '11211' && addr.state === 'NY', 'the scenario owns the address');
  ok(addr.city !== 'Beverly Hills', 'a live model\'s stale city never reaches the wire');
}

// ---- C. the structures the frontend request carries are present ------------------------------
console.log('\nC. required frontend scaffolding survives');
{
  const built = buildSearch({ purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
    state: 'NY', zip: '11211', countyFps: '36047', propertyType: 'SingleFamily', units: 1 }, { base: fakeLiveModel() });
  // Each of these was measured ABSENT from the configuration-model request and PRESENT in the
  // frontend's, so their presence is the difference between a request that prices and one that 500s.
  for (const p of ['groupConfig', 'miDataWrapper', 'brokerCriteria.dayLocksList', 'brokerCriteria.rangeComplan',
    'accessCriteria.mkSearchAllLenders', 'criteria.mortgageLimitForLatestYear', 'criteria.calculatedFeeByMortgageType']) {
    const v = p.split('.').reduce((c, k) => (c == null ? undefined : c[k]), built);
    ok(v !== undefined, 'the request carries ' + p);
  }
}

// ---- D. no live model at all is unchanged behaviour -------------------------------------------
console.log('\nD. absent foundation');
{
  const SCEN = { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
    state: 'NY', zip: '11211', countyFps: '36047', propertyType: 'SingleFamily', units: 1 };
  const a = buildSearch(SCEN, {});
  const b = buildSearch(SCEN, { base: null });
  const c = buildSearch(SCEN, { base: undefined });
  ok(JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
    'no base / null base / undefined base all build the identical request');
}

// ---- E. the guard that refuses the narrow fix -------------------------------------------------
console.log('\nE. the source must not have gone back to cloning the live model');
{
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'search-model.js'), 'utf8');
  // The exact shape of the defect: the live model used as the request itself.
  ok(!/const\s+m\s*=\s*clone\(\s*opts\.base\s*\|\|\s*BASE\s*\)/.test(src),
    'buildSearch does not clone the live default search as the outgoing request');
  ok(/mergeKnownRequestDefaults\(\s*clone\(BASE\)/.test(src),
    'buildSearch builds from the canonical request and admits the live model through the normalizer');
}

// ---- G. the profile identity cannot be moved by a saved company preference -------------------
console.log('\nG. wireDiscipline — the DSCR profile constants are FORCED, not inherited');
{
  const SCEN = { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
    state: 'NY', zip: '11211', countyFps: '36047', propertyType: 'SingleFamily', units: 1 };
  // A live model that would turn a DSCR investor search into something else. Every one of these was
  // MEASURED winning against the merge before this guard existed.
  const hostile = { criteria: { loanType: 'ARM', mortgageTypes: ['FHA'], propertyUse: 'PrimaryResidence',
    compensationType: 'LenderPaid', lienPriorityType: 'SecondLien' } };
  const b = buildSearch(SCEN, { base: hostile });
  ok(b.criteria.loanType === 'Fixed', 'a live ARM default cannot make a DSCR search adjustable');
  ok(JSON.stringify(b.criteria.mortgageTypes) === JSON.stringify(['Conventional']), 'a live FHA default cannot change the mortgage type');
  ok(b.criteria.propertyUse === 'Investment', 'property use stays Investment');
  ok(b.criteria.compensationType === 'BorrowerCompPlan', 'compensation stays borrower-paid');
  ok(b.criteria.lienPriorityType === 'FirstLien', 'lien priority stays first');
  ok(JSON.stringify(b.loanTypeCriteria) === JSON.stringify(['Fixed']),
    'loanTypeCriteria AGREES with criteria.loanType — the body never contradicts itself');

  // An empty array is not a null, so it survived the merge; on the one leaf whose null is a proven
  // 500 that is the obvious sibling.
  const empty = buildSearch(SCEN, { base: { criteria: { mortgageTypes: [] } } });
  ok(empty.criteria.mortgageTypes.length > 0, 'an EMPTY mortgageTypes from a live model is repaired, not sent');

  // The address is typed the way the capture types it.
  const loose = buildSearch({ ...SCEN, state: 'ny', countyFps: 1001, countyName: { nope: 1 }, city: 42 }, {});
  const a = loose.property.address;
  ok(a.state === 'NY', 'a lowercase state is transmitted uppercased, not merely validated uppercased');
  ok(a.county === '01001' && a.censustract === '01001',
    'a numeric county FIPS becomes a 5-character string — a leading zero is preserved, not lost');
  ok(a.countyName === undefined, 'an object offered as a county NAME is dropped rather than serialized onto the wire');
  ok(a.city === '42', 'a numeric city is coerced to the string the capture uses');

  // And the scenario-ownership property this must not undo.
  // §2.1/TASK-31 — the blank form of these is the frontend's own empty string, not absence (all seven
  // captures send ""). The leak property this assertion exists for is UNCHANGED: what matters is that
  // the stale value is GONE, and an empty string overwrites it exactly as deletion did.
  const stale = buildSearch(SCEN, { base: { property: { address: { street: '12 Somewhere Else', zipExt: '9999' } } } });
  ok(stale.property.address.street === '' && stale.property.address.zipExt === '',
    'a prior session\'s street/ZIP+4 still cannot ride along — it is replaced by the frontend\'s own blank ""');
}

// ---- H. a credit score is REQUIRED, and refused LOCALLY ---------------------------------------
console.log('\nH. fico is required — measured: null AND absent both return HTTP 500');
{
  const base = { purpose: 'Purchase', value: 500000, loan: 400000, dscr: 1.5,
    state: 'NY', zip: '11211', countyFps: '36047', propertyType: 'SingleFamily', units: 1 };

  const noFico = sm.validateScenario({ ...base });
  ok(noFico.ok === false, 'a scenario with no credit score is REFUSED, not sent');
  ok(noFico.error === 'fico_required' && noFico.field === 'fico',
    'the refusal names the field, which the vendor\'s bare 500 never does');
  ok(/500/.test(String(noFico.message || '')),
    'and says WHY, so nobody re-discovers this by watching a request fail');

  const withFico = sm.validateScenario({ ...base, fico: 760 });
  ok(withFico.ok === true, 'the same scenario WITH a score validates');
  ok(withFico.request.criteria.fico === 760, 'and the score reaches the wire as a number');

  // The value must never be invented — this is the fix that was tried, measured wrong, and removed.
  ok(noFico.request === undefined, 'a refused scenario builds NO request — nothing is substituted');

  // It must run LAST: a more specific complaint must not be masked by the missing score.
  const alsoBadPurpose = sm.validateScenario({ ...base, purpose: 'Not A Real Purpose' });
  ok(alsoBadPurpose.ok === false && alsoBadPurpose.error !== 'fico_required',
    'a scenario with a worse problem hears about THAT problem, not the missing score');

  // dscr is deliberately NOT required — the sweep measured null/absent/blank all returning 200.
  const noDscr = sm.validateScenario({ ...base, fico: 760 });
  ok(noDscr.ok === true, 'dscr is NOT required — measured harmless, so requiring it would refuse deals the vendor prices');
}

// ---- I. rate-sheet provenance and staleness ---------------------------------------------------
console.log('\nI. §37.12 a rate carries WHICH sheet it came from, and whether that sheet is still good');
{
  const lp = require(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'));
  // The vendor's real response shape, transcribed from a captured search: a four-level grouped tree
  // whose leaves carry `expired` and a `ratePeriod` stamping the sheet they were priced from.
  const mk = (over) => Object.assign({
    companyName: 'A Lender', companyId: 'L1', programName: 'DSCR 30 Yr Fixed',
    rate: 6.5, adjustedPoints: 1.0, basePoints: 1.0, adjustmentPoints: 0, apr: 6.6,
    dayLock: 30, term: 30, loanAmount: 400000,
  }, over);
  const board = { search: { date: '2026-08-16T05:25:15Z' }, results: { qualifiedNonQMData: {
    key: [], keyLabel: 'ROOT', type: null, leafs: [], childs: [{
      key: [], keyLabel: '30 Years Fixed', type: 'CriteriaFromLineResultKey', leafs: [], childs: [{
        key: ['6.5'], keyLabel: '6.5', type: 'RateKey', leafs: [], childs: [{
          key: ['A Lender', 'true'], keyLabel: 'A Lender', type: 'LenderKey', childs: [], leafs: [
            mk({ rate: 5.5, expired: false, ratePeriod: { id: 'rp-live', name: 'Live Sheet', validAsOf: '2026-08-15T04:00:00.000Z', expired: false } }),
            mk({ rate: 5.25, expired: true, companyName: 'Stale Lender', ratePeriod: { id: 'rp-old', name: 'Old Sheet', validAsOf: '2026-08-14T11:30:00.000Z', expired: true } }),
            mk({ rate: 6.0, expired: false, ratePeriod: { id: 'rp-live', name: 'Live Sheet', validAsOf: '2026-08-15T04:00:00.000Z', expired: false } }),
          ],
        }],
      }],
    }],
  } } };

  const p = lp.parse(board);
  ok(p.rateSheets && p.rateSheets.optionCount === 3, 'the board reports how many options it priced');
  ok(p.rateSheets.expiredCount === 1 && p.rateSheets.liveCount === 2,
    'and how many of them came off an EXPIRED sheet — measured at 37% and 61% on two real captures');
  ok(p.rateSheets.expiredPct === 33.3, 'as a percentage, so the scale of the staleness is legible');
  ok(JSON.stringify(p.rateSheets.expiredLenders) === JSON.stringify(['Stale Lender']),
    'and WHICH lenders are stale — on the real captures whole lenders expire at once');
  ok(p.pricedAt === '2026-08-16T05:25:15Z',
    'the quote carries the time it was priced — a parsed result used to carry no timestamp at all');
  ok(p.rateSheets.oldestSheet === '2026-08-14T11:30:00.000Z' && p.rateSheets.newestSheet === '2026-08-15T04:00:00.000Z',
    'and the age spread of the sheets behind it');

  // The display path is the one that matters: it is what an officer reads.
  const allRungs = p.programs.flatMap((pr) => pr.rungs);
  ok(allRungs.every((r) => 'expired' in r), 'EVERY rung says whether its sheet is expired');
  ok(allRungs.every((r) => 'rateSheetValidAsOf' in r), 'and when that sheet was published');
  const cheapest = allRungs.slice().sort((a, b) => a.rate - b.rate)[0];
  ok(cheapest.rate === 5.25 && cheapest.expired === true,
    'the CHEAPEST rate being the expired one is exactly the real case — and it is now visible');

  // Nothing is filtered: an expired sheet is not proof of a wrong price, and silently dropping a
  // third of the board would be its own silent-substitution bug.
  ok(p.rungCount === 3, 'expired options are still RETURNED — flagged, never silently dropped');

  const f = lp.parseFull(board);
  ok(f.rateSheets.expiredCount === 1, 'parseFull reports the same board summary');
  const opts = f.programs.flatMap((pr) => pr.options);
  ok(opts.every((o) => o.rateSheet && typeof o.rateSheet.expired === 'boolean'),
    'and every option carries its own sheet provenance');
  ok(opts.some((o) => o.rateSheet.name === 'Old Sheet' && o.rateSheet.validAsOf),
    'including the sheet NAME and date, which were dropped entirely before');
}

// ---- J. §2.1 frontend-parity forces survive a DIVERGENT live foundation AND a scenario value -----
// The §2.1 forces (pmiType BPMI, showUnmatchCompPlan true, the FULL AUS list, monthlyIncome rounded
// to a whole dollar) exist because a live foundation carries the CONFIG-model values instead, and
// production once diverged from the frontend request — the HTTP-500 class. Section A proves the
// foundation-merge ADOPTS a live pmiType 'None'; nothing proved buildSearch then FORCES it back. And
// monthlyIncome had a live gap: a scenario-supplied value is written by applyRegistry AFTER the §2.1
// force block, so rounding only there left it fractional (16666.666… vs the frontend's 16667).
console.log('\nJ. §2.1 frontend-parity forces beat a divergent live foundation');
{
  const SCEN = { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
    state: 'NY', zip: '11211', countyFps: '36047', propertyType: 'SingleFamily', units: 1 };

  // A live foundation carrying the frontend-divergent CONFIG-model values on every §2.1 field.
  const divergent = { criteria: { pmiType: 'None', monthlyIncome: 16666.6667 },
    showUnmatchCompPlan: false, brokerCriteria: { ausList: ['LP'] } };
  const b = buildSearch(SCEN, { base: divergent });
  ok(b.criteria.pmiType === 'BPMI', 'a live pmiType "None" is forced back to the frontend\'s "BPMI"');
  ok(b.showUnmatchCompPlan === true, 'a live showUnmatchCompPlan false is forced true');
  ok(JSON.stringify(b.brokerCriteria.ausList) === JSON.stringify(['DU', 'LP', 'GUS', 'MUW', 'None']),
    'a live SHORTENED AUS list is forced back to the full published set');
  ok(Number.isInteger(b.criteria.monthlyIncome),
    'a live fractional monthlyIncome is rounded to a whole dollar (frontend parity)');

  // The measured gap: a SCENARIO-supplied fractional monthlyIncome. applyRegistry writes it after the
  // §2.1 block, so it must be rounded LAST (wireDiscipline) — this asserts the final body matches the
  // frontend regardless of which source carried the value.
  const scn = buildSearch({ ...SCEN, monthlyIncome: 16666.6667 }, {});
  ok(Number.isInteger(scn.criteria.monthlyIncome) && scn.criteria.monthlyIncome === 16667,
    'a SCENARIO-supplied fractional monthlyIncome is rounded to 16667, not sent as 16666.666…');

  // A caller's EXPLICIT AUS engine choice is still honoured (the force only replaces a narrowed default).
  const chosen = buildSearch(SCEN, { base: divergent, /* no sc.aus */ });
  ok(chosen.brokerCriteria.ausList.length === 5, 'with no explicit AUS choice, the full set wins over a narrowed live list');
  const explicit = buildSearch({ ...SCEN, aus: ['DU'] }, { base: divergent });
  ok(JSON.stringify(explicit.brokerCriteria.ausList) === JSON.stringify(['DU']),
    'an explicit caller AUS choice is honoured verbatim over both the force and the live list');
}

console.log('\n' + (failed === 0 ? 'OFFLINE: all passed' : 'FAILURES') + ' (' + passed + ' passed, ' + failed + ' failed)');
process.exit(failed === 0 ? 0 : 1);
