#!/usr/bin/env node
'use strict';
/**
 * §29.1/§29.7 — DSCR PROFILE ENFORCEMENT against a LIVE foundation (pure, offline).
 *
 * The audit's rule (§29.1): after cloning the live Lender Price defaultSearch, the connector applies
 * ONLY the company-selected DSCR defaults and preserves every other live default. §29.7 found that an
 * EARLIER build failed to enforce 30-year / 30-day / Reserves_24 on the active `buildSearch` path, and
 * flagged that "the active path needs its own assertion" — the existing reserves test exercised the old
 * `buildSearchPayload` helper (or the static base, which already carries the right defaults, so it can
 * never prove ENFORCEMENT).
 *
 * This suite closes that gap. It passes a MUTATED live foundation — wrong on every DSCR-profile axis the
 * audit §29.1 lists — and asserts `buildSearch` overrides each one to the confirmed profile. A future
 * change that makes omitted fields "inherit the base" (repair-order item 3) can no longer silently drop
 * the profile. Two classes are covered:
 *   • ALWAYS forced (no scenario override): occupancy, comp, income doc, rental term, reserves;
 *   • forced WHEN OMITTED, explicit caller value wins: loan term, rate-lock, borrower type.
 *
 * PROVEN TO FAIL: revert any of the profile-forcing lines in buildSearch (e.g. drop the `c.propertyUse
 * = 'Investment'` assertion, or the `effTermYears ?? 30`), and the matching FORCE-* assertion goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const dynOf = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object'
  ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));

// A live foundation left by a NON-DSCR session: every profile axis carries the wrong value, so if
// buildSearch merely inherited the clone, the DSCR product would be priced wrong.
function nonDscrBase() {
  const b = JSON.parse(JSON.stringify(sm.BASE));
  b.criteria.propertyUse = 'PrimaryResidence';
  b.criteria.compensationType = 'LenderCompPlan';
  b.criteria.loanYear = 15;
  b.termsCriteria = [15];
  b.termsInMonths = true;                 // months, not years — the wrong shape too
  b.brokerCriteria = b.brokerCriteria || {};
  b.brokerCriteria.dayLocks = 45;
  b.dayLocksCriteria = [45];
  b.dynamicPropertiesMap = b.dynamicPropertiesMap || {};
  b.dynamicPropertiesMap.IncomeDocType = { fieldId: 'IncomeDocType', value: 'FullDoc' };
  b.dynamicPropertiesMap.AddlOccupancyType = { fieldId: 'AddlOccupancyType', value: 'Short_Term_Rental_Property' };
  b.dynamicPropertiesMap.GLOBAL_RESERVES = { fieldId: 'GLOBAL_RESERVES', value: 'Reserves_6' };
  b.dynamicPropertiesMap.GLOBAL_BorrowerType = { fieldId: 'GLOBAL_BorrowerType', value: 'Individual' };
  return b;
}

console.log('§29.1 DSCR profile enforcement against a mutated live foundation');

// A scenario that OMITS every profile-controlled field — the profile must FORCE each one regardless of
// the wrong base value.
const forced = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 1.25 }, { base: nonDscrBase() });

// ---- ALWAYS forced (no scenario override path) ----------------------------
ok(forced.criteria.propertyUse === 'Investment', 'FORCE-1 occupancy → Investment (over base PrimaryResidence)');
ok(forced.criteria.compensationType === 'BorrowerCompPlan', 'FORCE-2 compensation → BorrowerCompPlan (over base LenderCompPlan)');
ok(dynOf(forced, 'IncomeDocType') === 'DSCR', 'FORCE-3 income doc → DSCR (over base FullDoc)');
ok(dynOf(forced, 'AddlOccupancyType') === 'Long_Term_Rental_Property', 'FORCE-4 rental term → long-term (over base short-term)');
ok(dynOf(forced, 'GLOBAL_RESERVES') === 'Reserves_24', 'FORCE-5 reserves → Reserves_24 (over base Reserves_6)');

// ---- forced WHEN OMITTED (explicit caller value wins) ---------------------
ok(forced.criteria.loanYear === 30 && Array.isArray(forced.termsCriteria) && forced.termsCriteria[0] === 30 && forced.termsInMonths === false,
  'FORCE-6 term → 30yr + termsCriteria [30] + termsInMonths false (over base 15/months)');
ok(forced.brokerCriteria.dayLocks === 30 && Array.isArray(forced.dayLocksCriteria) && forced.dayLocksCriteria[0] === 30,
  'FORCE-7 lock → 30 days + dayLocksCriteria [30] (over base 45)');
ok(dynOf(forced, 'GLOBAL_BorrowerType') === 'LLC', 'FORCE-8 borrower type → LLC default (over base Individual)');

// ---- an EXPLICIT caller value wins over BOTH the base and the profile default ----
const explicit = sm.buildSearch(
  { purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 1.25, termYears: 20, lockDays: 45, borrowerType: 'Trust' },
  { base: nonDscrBase() });
ok(explicit.criteria.loanYear === 30 && explicit.termsCriteria[0] === 20, 'EXPLICIT-1 caller termYears 20 rides termsCriteria [20]; loanYear STAYS 30 (amortization — §2.2 parity)');
ok(explicit.brokerCriteria.dayLocks === 45 && explicit.dayLocksCriteria[0] === 45, 'EXPLICIT-2 caller lockDays 45 wins over the 30 default');
ok(dynOf(explicit, 'GLOBAL_BorrowerType') === 'Trust', 'EXPLICIT-3 caller borrowerType Trust wins over the LLC default');
// but the ALWAYS-forced axes still stand even with an explicit scenario
ok(explicit.criteria.propertyUse === 'Investment' && dynOf(explicit, 'IncomeDocType') === 'DSCR' && dynOf(explicit, 'GLOBAL_RESERVES') === 'Reserves_24',
  'EXPLICIT-4 the always-forced axes stay enforced alongside explicit term/lock/borrowerType');

// ---- reserves token honors the per-company env override, still forced over the base ----
const savedReserves = process.env.LP_RESERVES_TOKEN;
process.env.LP_RESERVES_TOKEN = 'Reserves_12';
const envReserves = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 }, { base: nonDscrBase() });
ok(dynOf(envReserves, 'GLOBAL_RESERVES') === 'Reserves_12', 'ENV-1 LP_RESERVES_TOKEN overrides the default, still forced over the base Reserves_6');
if (savedReserves === undefined) delete process.env.LP_RESERVES_TOKEN; else process.env.LP_RESERVES_TOKEN = savedReserves;

// ---- §32.6 DSCR RATIO is a forced profile default (1.5) when omitted -------
// Measured live: `criteria.dscr: null` collapses 439 pricing rows to 28 from one lender; adding only
// dscr:1.5 restored the full 439. So an omitted/null dscr must be FORCED to 1.5, nullish (0 preserved).
const noDscr = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760 }, { base: nonDscrBase() });
ok(noDscr.criteria.dscr === 1.5, 'FORCE-9 omitted dscr → criteria.dscr 1.5 (never null — null collapses 439 rows to 28)');
const nullDscr = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: null }, { base: nonDscrBase() });
ok(nullDscr.criteria.dscr === 1.5, 'FORCE-9b explicit null dscr → criteria.dscr 1.5 (the exact PILOT bug)');
const zeroDscr = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 0 }, { base: nonDscrBase() });
ok(zeroDscr.criteria.dscr === 0, 'PRESERVE-0 explicit dscr 0 stays 0 (No-DSCR is a real value; nullish, not truthy)');
const explicitDscr = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 1.25 }, { base: nonDscrBase() });
ok(explicitDscr.criteria.dscr === 1.25, 'EXPLICIT-5 caller dscr 1.25 wins over the 1.5 default');

// ---- the reporter's exact minimal request → normalized output -------------
// A minimal request (purpose, value, loan amount, FICO, ZIP) must produce every DSCR-profile default,
// with dscr defaulted to 1.5. This is the regression that pins the PILOT `dscr: null` fix.
const minimal = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, zip: '07001' });
ok(minimal.criteria.propertyUse === 'Investment', 'MIN propertyUse === "Investment"');
ok(dynOf(minimal, 'GLOBAL_BorrowerType') === 'LLC', 'MIN borrowerType === "LLC"');
ok(dynOf(minimal, 'GLOBAL_RESERVES') === 'Reserves_24', 'MIN reserves === "Reserves_24"');
ok(dynOf(minimal, 'IncomeDocType') === 'DSCR', 'MIN incomeDocType === "DSCR"');
ok(minimal.criteria.dscr === 1.5, 'MIN dscr === 1.5');
ok(dynOf(minimal, 'PrepayTerm') === '60 Months', 'MIN prepayTerm === "60 Months"');
ok(dynOf(minimal, 'PrePayment_Plan_Type') === 'Standard', 'MIN prepayStructure === "Standard"');
ok(Array.isArray(minimal.termsCriteria) && minimal.termsCriteria.length === 1 && minimal.termsCriteria[0] === 30, 'MIN termsCriteria === [30]');
ok(Array.isArray(minimal.dayLocksCriteria) && minimal.dayLocksCriteria.length === 1 && minimal.dayLocksCriteria[0] === 30, 'MIN dayLocksCriteria === [30]');

// ---- the DSCR SMO pair is always present (the product selector) -----------
const smoNames = (forced.criteria.specialMortgageOptions || []).map((o) => o && o.name);
ok(smoNames.includes('Debt Service Coverage Ratio') && smoNames.includes('DSCR'),
  'SMO-1 the DSCR special-mortgage-option pair is always sent (product stays DSCR)');

// ---- §2.1 frontend-parity forces over a WRONG (production-like) foundation ---
// A live foundation carrying the config-model values (pmiType None, showUnmatchCompPlan false,
// fractional monthlyIncome) must NOT diverge from the frontend — buildSearch forces the frontend's.
const wrongBase = nonDscrBase();
wrongBase.criteria.pmiType = 'None';
wrongBase.showUnmatchCompPlan = false;
wrongBase.criteria.monthlyIncome = 16666.6666667;
const fp = sm.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 1.25 }, { base: wrongBase });
ok(fp.criteria.pmiType === 'BPMI', 'PARITY-1 pmiType forced to "BPMI" (over a foundation carrying "None")');
ok(fp.showUnmatchCompPlan === true, 'PARITY-2 showUnmatchCompPlan forced true (over a foundation carrying false)');
ok(fp.criteria.monthlyIncome === 16667, 'PARITY-3 monthlyIncome rounded to a whole dollar 16667 (over 16666.666…)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
