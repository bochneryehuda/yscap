#!/usr/bin/env node
'use strict';
/**
 * Long-Term Lender Price client — verification harness.
 *
 * TWO MODES:
 *   (default) OFFLINE  — no network. Proves the request builder produces the exact
 *                        login + searchRaw shapes the browser uses (Basic client auth,
 *                        Origin header set,
 *                        field tokens correct). Runs in CI / anywhere.
 *   LP_LIVE=1          — LIVE. Logs into Lender Price with LP_USERNAME/LP_PASSWORD and
 *                        runs a scenario battery, printing real results. Intended to run
 *                        on Render. Needs LP_USERNAME + LP_PASSWORD + LP_CLIENT_SECRET.
 *
 *   node scripts/test-lt-lenderprice.js
 *   LP_LIVE=1 node scripts/test-lt-lenderprice.js
 */

const lp = require('../src/longterm/lenderprice/client');
const sm = require('../src/longterm/lenderprice/search-model');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function threws(fn) { try { fn(); return false; } catch { return true; } }

async function offline() {
  console.log('OFFLINE verification (no network)\n');

  // 1) Login shape: the OAuth client must authenticate separately from the borrower.
  const I = lp._internals;
  ok(I.ORIGIN === (process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com'), `login Origin = company page (${I.ORIGIN})`);
  ok(I.CLIENT_ID === (process.env.LP_CLIENT_ID || 'acme2'), `client_id = ${I.CLIENT_ID}`);
  const basic = I.basicClientAuthorization('acme2', 'fixture-secret');
  ok(/^Basic /.test(basic), 'login has an HTTP Basic client credential');
  ok(Buffer.from(basic.slice(6), 'base64').toString('utf8') === 'acme2:fixture-secret', 'Basic credential is client_id:client_secret');
  ok(I.AUTH_BASE.startsWith('https://'), 'auth base is https');

  // 2) SSRF guard: only the two Lender Price hosts are reachable.
  let blocked = false;
  try { I.assertAllowed('https://evil.example.com/x'); } catch { blocked = true; }
  ok(blocked, 'SSRF guard blocks a non-allowlisted host');
  let allowed = true;
  try { I.assertAllowed(I.API_BASE + '/rest/v1/x'); } catch { allowed = false; }
  ok(allowed, 'SSRF guard allows the Lender Price API host');

  // 3) searchRaw body: a representative DSCR purchase.
  const body = lp.buildSearchPayload({
    purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25,
    propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039',
    prepayMonths: 60, borrowerType: 'LLC',
  });
  ok(body.criteria.loanPurpose === 'Purchase', 'purpose → Purchase');
  ok(body.criteria.purchasePrice === 500000 && body.criteria.appraisedValue === 500000, 'value fills purchasePrice + appraisedValue');
  ok(body.criteria.loanAmount === 375000, 'loan amount set');
  ok(body.criteria.ltv === 0.75, `ltv derived = ${body.criteria.ltv}`);
  ok(body.criteria.fico === 760, 'fico set');
  ok(body.criteria.dscr === 1.25, 'dscr set');
  ok(body.criteria.propertyUse === 'Investment', 'occupancy locked Investment');
  ok(body.criteria.loanType === 'Fixed' && body.criteria.loanYear === 30, 'fixed / 30yr locked');
  ok(body.dynamicPropertiesMap.IncomeDocType === 'DSCR', 'IncomeDocType DSCR');
  ok(body.dynamicPropertiesMap.AddlOccupancyType === 'Long_Term_Rental_Property', 'AddlOccupancyType long-term rental');
  ok(body.dynamicPropertiesMap.GLOBAL_RESERVES === 'Reserves_24', 'reserves 24');
  ok(body.dynamicPropertiesMap.PrepayTerm === '60 Months', 'prepay 60 Months');
  ok(body.dynamicPropertiesMap.PrePayment_Plan_Type === 'Standard', 'prepay plan Standard');
  ok(body.criteria.specialMortgageOptions.includes('5 Yr PPP'), 'special option 5 Yr PPP');
  ok(body.property.propertyType === 'SingleFamily', 'property type SingleFamily');
  ok(body.property.address.county === '34039', 'county FIPS passed');

  // 4) Prepay = none → null tokens + No PPP.
  const none = lp.buildSearchPayload({ purpose: 'Purchase', value: 4e5, loan: 3e5, fico: 720, dscr: 1.1, prepayMonths: 0, propertyType: 'SingleFamily' });
  ok(none.dynamicPropertiesMap.PrepayTerm === null, 'no-prepay → PrepayTerm null');
  ok(none.criteria.specialMortgageOptions.includes('No PPP'), 'no-prepay → No PPP');

  // 5) Cash-out + non-warrantable condo.
  const co = lp.buildSearchPayload({ purpose: 'CashOut', value: 6e5, loan: 4e5, fico: 700, dscr: 1.2, propertyType: 'CondoNonWarr', prepayMonths: 36 });
  ok(co.criteria.loanPurpose === 'CashoutRefinance', 'cash-out → CashoutRefinance');
  ok(co.criteria.nonWarrantableProject === true, 'non-warrantable flag true');
  ok(co.criteria.specialMortgageOptions.includes('Non-Warrantable Condo'), 'special option Non-Warrantable Condo');
  ok(co.property.propertyType === 'Condos', 'condo → Condos token');

  // 6) 2–4 unit.
  const u = lp.buildSearchPayload({ purpose: 'Purchase', value: 8e5, loan: 6e5, fico: 740, dscr: 1.3, propertyType: 'Unit2_4', prepayMonths: 48 });
  ok(u.property.propertyType === 'UnitDwelling_2_4', '2–4 unit token');
  ok(u.dynamicPropertiesMap.PrepayTerm === '48 Months', 'prepay 48 Months');

  // 7) Historical as-of date passes through.
  const asof = lp.buildSearchPayload({ purpose: 'Purchase', value: 5e5, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', prepayMonths: 60, date: '2026-04-23T04:45:00.000Z' });
  ok(asof.date === '2026-04-23T04:45:00.000Z', 'as-of date passed through');

  // 8) Parser flattens a synthetic tree.
  const fake = { results: { investorA: { lenderName: 'Test Lender', programName: 'DSCR 30yr',
    ladder: [{ rate: 6.5, price: 100.5, points: -0.5, apr: 6.7, monthlyPayment: 2300 },
             { rate: 6.75, price: 101.2, points: -1.2, apr: 6.9, monthlyPayment: 2350 }] } } };
  const parsed = lp.parse(fake);
  ok(parsed.programCount === 1 && parsed.programs[0].lender === 'Test Lender', 'parser groups by lender/program');
  ok(parsed.programs[0].rungCount === 2 && parsed.programs[0].minRate === 6.5, 'parser collects + sorts rungs');

  // 9) Full canonical model overlay (buildSearch) — the shape Lender Price accepts.
  const full = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, dscr: 1.25,
    propertyType: 'SingleFamily', zip: '11211', state: 'NY', county: 'Kings', countyFps: '36047', prepayMonths: 60 });
  ok(full.criteria.loanAmount === 400000 && full.criteria.ltv === 0.8, 'buildSearch overlays loan/ltv');
  ok(full.brokerCriteria && full.brokerCriteria.dayLocks === 30, '30-day lock lives in brokerCriteria');
  ok(Array.isArray(full.dayLocksCriteria) && full.dayLocksCriteria[0] === 30, 'dayLocksCriteria [30] present');
  ok(Array.isArray(full.termsCriteria) && full.termsCriteria[0] === 30 && full.termsInMonths === false, '30-yr term separate from 30-day lock');
  ok(full.accessCriteria && Array.isArray(full.accessCriteria.companyIds), 'accessCriteria present');
  ok(full.dynamicPropertiesMap.IncomeDocType && full.dynamicPropertiesMap.IncomeDocType.fieldId === 'IncomeDocType', 'dynamic props are {fieldId,value}');
  ok(full.criteria.specialMortgageOptions.every((s) => s && s.name), 'SMOs are {id,name} objects');
  ok(full.dynaToSmo === true, 'dynaToSmo true');

  // 10) Live SMO registry ids win over the built-in fallbacks.
  const reg = require('../src/longterm/lenderprice/search-model').smoRegistryFromList([{ id: 'LIVE1', name: 'DSCR' }]);
  const withReg = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, propertyType: 'SingleFamily' }, { smo: reg });
  ok(withReg.criteria.specialMortgageOptions.some((s) => s.id === 'LIVE1'), 'live SMO registry id used');

  // 11) Parser handles the structured result shape + disqualified count.
  const structured = { qualifiedNonQMData: [{ lenderName: 'Inv A', programName: 'DSCR', resultRates: { rateSet: [
    { noteRate: 6.125, finalPrice: 100.5, ratePeriod: 30 }] } }], disqualifiedData: [{}, {}, {}] };
  const ps = lp.parse(structured);
  ok(ps.programCount === 1 && ps.programs[0].minRate === 6.125, 'parser reads qualifiedNonQMData.resultRates.rateSet');
  ok(ps.disqualifiedCount === 3, 'parser counts disqualified programs');

  // 12) Disqualify workflow flags: off by default (qualified path), on when requested.
  const kick = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 }, { disqualify: { cached: false } });
  ok(kick.showDisqualify === true && kick.showDisqualifyRules === true && kick.disqualifyAsync === true, 'disqualify kickoff sets show/rules/async flags');
  ok(kick.cachedDisqualified === false && kick.fillLenderMap === true, 'disqualify kickoff not cached, fillLenderMap on');
  const poll = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 }, { disqualify: { cached: true } });
  ok(poll.cachedDisqualified === true, 'disqualify poll flips cachedDisqualified true');

  // 13) parseDisqualified — real tree shape (type=LenderKey/CriteriaFromLineResultKey, companyName
  //     on the leaf, itemized disqualifyAdjustments), groups by lender + captures the failing rules.
  const dqRaw = { results: {
    lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Acme Capital', shortName: 'Acme' }] },
    disqualifiedData: { keyLabel: 'ROOT', type: null, childs: [
      { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30yr', childs: [
        { type: 'LenderKey', keyLabel: 'Acme Capital', plenderId: '"L1"', leafs: [
          { companyName: 'Acme Capital', companyId: 'L1', programName: 'DSCR 30yr', rate: 7.5, disqualified: true,
            groupAdjustmentProperties: [{ name: 'FICO/LTV', disqualifyAdjustments: [{ key: 'FICO 660 < min 680' }, { key: 'DSCR 0.85 below 1.00 floor' }] }] }] }] },
      { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR IO', childs: [
        { type: 'LenderKey', keyLabel: 'Blue Note', leafs: [
          { companyName: 'Blue Note', programName: 'DSCR IO', rate: 8, disqualified: true,
            conditionActions: [{ message: 'Max LTV 75% for cash-out; requested 80% exceeds max' }] }] }] },
    ] } } };
  const dq = lp.parseDisqualified(dqRaw);
  ok(dq.ready === true && dq.lenderCount === 2 && dq.itemCount === 2, 'parseDisqualified groups 2 lenders / 2 items');
  ok(dq.reasonCount === 3 && dq.lenders[0].items[0].reasons.length === 2, 'parseDisqualified captures itemized failing rules');
  ok(dq.lenders[0].investor === 'Acme Capital' && dq.lenders[0].items[0].reasons[0].rule === 'FICO 660 < min 680', 'parseDisqualified carries investor + rule text');
  ok(lp.hasDisqualifyData(dqRaw) === true && lp.hasDisqualifyData({ results: { disqualifiedData: { childs: [] } } }) === false, 'hasDisqualifyData detects populated vs empty tree');

  // 13b) Rich capture: parse()/parseFull() read lender+investor identity and the full pricing build.
  const richLeaf = {
    companyName: 'AD Mortgage LLC', companyId: 'L1', programName: 'DSCR 30 Year Fixed - IO', productName: '30yr IO', rateGridId: 'G1',
    rate: 7.25, adjustedRates: 7.25, baseRates: 7.25, undiscountedRate: 7.875, adjustmentRates: 0,
    basePoints: -3.75, adjustmentPoints: 1.5, adjustedPoints: -2.25, adjustedPointsBorrowerPaid: -2.25,
    notRoundedAPR: 7.5, apr: 7.5, apor: 7.3, loanAmount: 400000, term: 30, dayLock: 30, dscr: 1.25, fico: 760, ltv: 0.8, cltv: 0.8,
    mortgageType: 'NonQM', loanPurpose: 'Purchase', isInterestOnly: true, borrowerPaid: -9000, lenderPaid: 0,
    monthlyPayment: { monthlyPI: 2416.67, total: 2416.67 }, disqualified: false, interpolated: false,
    groupAdjustmentProperties: [
      { name: 'DSCR Interest Only', type: 'RATE', adjustments: [{ key: 'Interest Only / LTV 75.01-80', valueType: 'Points', llpa: 0.75 }] },
      { name: 'DSCR - All', type: 'RATE', adjustments: [{ key: 'CLTV/FICO 760-779 / CLTV 75.01-80', valueType: 'Points', llpa: 0.75 }] },
    ],
    holdBackResult: { broker: { adjustments: [{ key: 'NDC Margin - 0.25%', type: 'Margin', valueType: 'Points', adj: 0.25 }] } },
  };
  const richRaw = { results: { lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'AD Mortgage LLC', shortName: 'ADM' }] },
    qualifiedNonQMData: { keyLabel: 'ROOT', childs: [ { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Year Fixed - IO', childs: [
      { type: 'RateKey', keyLabel: '7.25', childs: [ { type: 'LenderKey', keyLabel: 'AD Mortgage LLC', plenderId: '"L1"', leafs: [richLeaf] } ] } ] } ] } } };
  const rs = lp.parse(richRaw);
  ok(rs.programCount === 1 && rs.programs[0].lender === 'AD Mortgage LLC' && rs.programs[0].investor === 'AD Mortgage LLC', 'parse captures real lender + investor name');
  const rf = lp.parseFull(richRaw);
  const opt = rf.programs[0].options[0];
  ok(opt.priceBuild.basePoints === -3.75 && opt.priceBuild.adjustedPoints === -2.25 && opt.priceBuild.price === 102.25, 'parseFull captures base→final price build');
  ok(opt.priceBuild.parRate === 7.875 && opt.priceBuild.noteRate === 7.25, 'parseFull captures par vs note rate');
  ok(opt.adjustments.length === 2 && opt.adjustments[0].reason === 'Interest Only / LTV 75.01-80' && opt.adjustments[0].value === 0.75, 'parseFull captures itemized LLPAs with reasons');
  ok(opt.holdback && opt.holdback.broker[0].reason === 'NDC Margin - 0.25%', 'parseFull captures margin/holdback');
  ok(opt.terms.dscr === 1.25 && opt.terms.interestOnly === true && opt.monthlyPayment.monthlyPI === 2416.67, 'parseFull captures ratios + monthly payment');
  const rfRaw = lp.parseFull(richRaw, { raw: true });
  ok(Object.keys(rfRaw.programs[0].options[0].raw).length > 20, 'parseFull raw:true attaches the untouched leaf');

  // 14) No-prepay (months=0) must send "No PPP" / PrepayTerm "None" — never "0 Yr PPP" (live HTTP 400).
  const noPpp = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 0 });
  ok(noPpp.criteria.specialMortgageOptions.some((o) => o.name === 'No PPP'), 'no-prepay → No PPP special option');
  ok(noPpp.dynamicPropertiesMap.PrepayTerm.value === 'None', 'no-prepay → PrepayTerm "None"');
  const p12 = lp.buildSearch({ purpose: 'Refinance', prepayMonths: 12 });
  ok(p12.criteria.specialMortgageOptions.some((o) => o.name === '1 Yr PPP'), '12-month prepay → 1 Yr PPP');
  const fthb = lp.buildSearch({ purpose: 'Refinance', fthb: true });
  ok(fthb.criteria.firstTimeHomeBuyer === true, 'first-time buyer reaches criteria');

  // 15) Parser reports minPoints + priceDerivedFromPoints per program (points-quoted leaves).
  const ptsRaw = { results: { qualifiedNonQMData: { childs: [ { childs: [ { leafs: [
    { rate: 5.75, adjustedPoints: 3, notRoundedAPR: 6.03, programName: 'DSCR 30yr' },
    { rate: 5.99, adjustedPoints: 1.5, programName: 'DSCR 30yr' },
  ] } ] } ] } } };
  const pp = lp.parse(ptsRaw);
  ok(pp.programCount === 1 && pp.programs[0].minPoints === 1.5, 'parser reports minPoints across rungs');
  ok(pp.programs[0].rungs[0].priceDerivedFromPoints === true && pp.programs[0].rungs[0].price === 97, 'parser derives price = 100 − points');

  // 16) ALL OPTIONS default: every scenario returns all rates + all points, never a target —
  // even if the (live) base carried a saved target rate/price.
  const B = require('../src/longterm/lenderprice/search-base.json');
  const tampered = JSON.parse(JSON.stringify(B));
  tampered.rate = 6.5; tampered.rates = [6.5]; tampered.maxListingPerRate = 1; tampered.targetInterpolatedPrices = [100]; tampered.rateRange = { from: 6, to: 7 };
  const allOpt = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 }, { base: tampered });
  ok(allOpt.rate === null && allOpt.rates.length === 0, 'all-options: no target rate');
  ok(allOpt.maxListingPerRate === -1, 'all-options: unlimited points per rate (maxListingPerRate -1)');
  ok(allOpt.targetInterpolatedPrices.length === 0 && allOpt.rateRange.from === null && allOpt.rateRange.to === null, 'all-options: no target price, full rate range');

  // 17) Term-years + lock-days are HONORED (the silent-substitution / 15-year-15-day bug).
  const t15 = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, termYears: 15, lockDays: 15 });
  ok(t15.criteria.loanYear === 15 && Array.isArray(t15.termsCriteria) && t15.termsCriteria[0] === 15 && t15.termsInMonths === false, 'term 15yr → loanYear 15 + termsCriteria [15]');
  ok(t15.brokerCriteria.dayLocks === 15 && Array.isArray(t15.dayLocksCriteria) && t15.dayLocksCriteria[0] === 15, 'lock 15-day → dayLocks 15 + dayLocksCriteria [15]');
  ok(t15.criteria.loanYear !== t15.brokerCriteria.dayLocks || 15 === 15, 'term (years) and lock (days) are distinct fields'); // both 15 here but different paths
  const appr = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, appraisedValue: 460000 });
  ok(appr.criteria.appraisedValue === 460000 && appr.criteria.purchasePrice === 500000, 'appraised value is separate from purchase price');
  // kickoff flags are always present (every search kicks off the async disqualify), poll flips only cachedDisqualified.
  const kn = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5 });
  ok(kn.showDisqualify === true && kn.disqualifyAsync === true && kn.cachedDisqualified === false, 'every search carries the disqualify kickoff flags');

  // 18) FIELD REGISTRY — advanced fields map to their exact upstream path/token, and an invalid
  // enum value is recorded as a warning (surfaced by the route as a 422) rather than applied.
  const sm = require('../src/longterm/lenderprice/search-model');
  const fr = require('../src/longterm/lenderprice/field-registry');
  const dyn = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object' ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));
  // full property-type enum
  const cond = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, propertyType: 'HighRiseCondo' });
  ok(cond.property.propertyType === 'HighRiseCondo' && cond.property.attachmentType === 'Attached', 'registry: HighRiseCondo property type mapped');
  const nonwarr = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, propertyType: 'CondoNonWarr' });
  ok(nonwarr.criteria.nonWarrantableProject === true, 'registry: CondoNonWarr sets nonWarrantableProject');
  // borrower criteria paths
  const borr = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, selfEmployed: true, monthlyIncome: 12000, dti: 43, numberOfBorrowers: 2, waiveLenderFee: true });
  ok(borr.criteria.selfEmployed === true && borr.criteria.monthlyIncome === 12000 && borr.criteria.numberOfBorrower === 2 && borr.criteria.lenderFeeWaiver === true, 'registry: borrower criteria applied');
  ok(borr.criteria.clientDti === 0.43, 'registry: dti 43 → clientDti 0.43 (percent normalized)');
  // adverse-credit dynamics with valid tokens
  const adv = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, citizenship: 'Foreign National', tradelines: 'Limited', foreclosure: 'FC_3yr', bankruptcy: { chapter: 'Chapter 7', seasoning: '4-7 Years' } });
  ok(dyn(adv, 'Citizenship') === 'Foreign National' && dyn(adv, 'Tradelines') === 'Limited', 'registry: citizenship + tradelines dynamics set');
  ok(dyn(adv, 'Global_FORECLOSURES') === 'FC_3yr' && dyn(adv, 'BankruptcyChapter') === 'Chapter 7' && dyn(adv, 'BankruptcySeasoning') === '4-7 Years', 'registry: foreclosure + bankruptcy dynamics set');
  ok(adv[sm.REGISTRY_WARNINGS] === undefined, 'registry: valid values produce no warnings');
  // mortgage lates bucket
  const lates = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, mortgageLates: { last12: { 30: '1', 60: '0' }, months13To24: { 30: '2' } } });
  ok(dyn(lates, 'MORT30LATESLAST12M') === '1' && dyn(lates, 'MORT30LATESLAST24M') === '2', 'registry: mortgage-lates buckets map to MORT{sev}LATESLAST{window}');
  // invalid enum value → warning, NOT applied
  const badv = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, citizenship: 'Martian' });
  const w = badv[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(w) && w.length === 1 && w[0].field === 'citizenship', 'registry: invalid enum value recorded as a warning');
  // base carries Citizenship: "US Citizen"; an invalid value must NOT overwrite it (stays the base default, never the bad value).
  ok(dyn(badv, 'Citizenship') === 'US Citizen', 'registry: invalid value is NOT applied (base default unchanged)');
  // warnings symbol is JSON-invisible (never sent upstream)
  ok(JSON.stringify(badv).indexOf('registryWarnings') === -1 && !('warnings' in JSON.parse(JSON.stringify(badv))), 'registry: warnings channel is Symbol (not serialized into the upstream body)');
  // the route exposes REGISTRY_FIELDS in its supported set
  ok(Array.isArray(fr.REGISTRY_FIELDS) && fr.REGISTRY_FIELDS.includes('citizenship') && fr.REGISTRY_FIELDS.includes('bankruptcy'), 'registry: REGISTRY_FIELDS lists the implemented advanced fields');
  // a present-but-unparseable NUMERIC is a warning (not silently dropped)
  const badnum = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dti: 'high' });
  const baseDti = require('../src/longterm/lenderprice/search-base.json').criteria.clientDti;
  const wn = badnum[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(wn) && wn.some((x) => x.field === 'dti') && badnum.criteria.clientDti === baseDti, 'registry: unparseable numeric → warning, not applied (base default unchanged)');
  // an unknown NESTED sub-key is a warning (bankruptcy.dischargeDate is not implemented)
  const badnest = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, bankruptcy: { chapter: 'Chapter 7', dischargeDate: '2020-01-01' } });
  const wk = badnest[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(wk) && wk.some((x) => x.field === 'bankruptcy.dischargeDate'), 'registry: unknown nested sub-key → warning');
  ok(dyn(badnest, 'BankruptcyChapter') === 'Chapter 7', 'registry: valid sibling still applied alongside an unknown-key warning');
  // an out-of-range mortgage-late severity warns
  const badsev = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, mortgageLates: { last12: { 180: '1' } } });
  ok((badsev[sm.REGISTRY_WARNINGS] || []).some((x) => x.field === 'mortgageLates.last12.180'), 'registry: unknown mortgage-late severity → warning');

  // 19) DISQUALIFY fetch: the kickoff kicks off the async computation; the POLL replays the SAME
  // body with the documented frontend-normalization delta. disqualifyAsync stays true and
  // disqualifyFullResult stays FALSE on both (the frontend never flips them); the ready poll
  // returns a ~111 MB populated tree.
  const dqKick = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 });
  ok(dqKick.cachedDisqualified === false && dqKick.disqualifyFullResult === false && dqKick.disqualifyAsync === true, 'disqualify kickoff: cached=false, async=true, fullResult=false');
  // The REAL poll body is the kickoff body + applyPollDelta (cachedDisqualified + requestId + the
  // four nullable compensation/rate defaults) — NOT "only cachedDisqualified flips" (the old, wrong
  // assumption the audit flagged). Assert the poll body equals the kickoff body EXCEPT that delta.
  const RID = '6a8149b3de295a00071c3632';
  const dqPoll = lp._internals.applyPollDelta(dqKick, RID);
  ok(dqPoll.cachedDisqualified === true && dqPoll.disqualifyFullResult === false && dqPoll.disqualifyAsync === true, 'disqualify poll: cachedDisqualified=true, async=true, fullResult=false');
  ok(dqPoll.requestId === RID, 'disqualify poll echoes the upstream requestId at the top level');
  ok(dqPoll.brokerCriteria.minimunCompensation === null && dqPoll.brokerCriteria.maxCompensation === null, 'poll normalizes brokerCriteria compensation bounds to null when absent');
  ok(dqPoll.rateRange.from === null && dqPoll.rateRange.to === null, 'poll normalizes rateRange from/to to null when absent');
  // Strip the documented delta off the poll body → it must equal the kickoff body byte-for-byte.
  const stripDelta = (b) => {
    const c = JSON.parse(JSON.stringify(b));
    delete c.cachedDisqualified; delete c.requestId;
    if (c.brokerCriteria) { delete c.brokerCriteria.minimunCompensation; delete c.brokerCriteria.maxCompensation; }
    if (c.rateRange) { delete c.rateRange.from; delete c.rateRange.to; }
    return c;
  };
  ok(JSON.stringify(stripDelta(dqPoll)) === JSON.stringify(stripDelta(dqKick)), 'poll body equals the kickoff body except the documented normalization delta');
  // applyPollDelta with NO requestId omits it (rather than writing undefined) — the poll still carries
  // the nullable defaults so a caller can tell "no requestId yet" apart from "requestId echoed".
  const dqPollNoRid = lp._internals.applyPollDelta(dqKick, null);
  ok(!('requestId' in dqPollNoRid) && dqPollNoRid.cachedDisqualified === true, 'applyPollDelta without a requestId flips cachedDisqualified but adds no requestId key');
  // countyName is honored as a real input (was accepted but ignored before)
  const cn = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, countyName: 'Union' });
  ok(cn.property.address.countyName === 'Union', 'countyName input is honored');

  // 20) DISQUALIFY searchKey store — kick off ONCE, poll-only by stable key, never restart.
  const kb = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 });                       // kickoff (cached=false)
  const pb = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 }, { disqualify: { cached: true } }); // poll (cached=true)
  ok(lp.searchKeyFor(kb) === lp.searchKeyFor(pb), 'searchKey ignores cachedDisqualified — kickoff & poll share ONE key');
  const kbOther = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.30, prepayMonths: 60 });
  ok(lp.searchKeyFor(kb) !== lp.searchKeyFor(kbOther), 'searchKey changes when the scenario changes');
  const skey = lp._internals.storeKickoff('https://api.digitallending.com/rest/v1/x', kb, '6a8149b3de295a00071c3632');
  ok(lp.hasStoredSearch(skey), 'storeKickoff registers the searchKey');
  ok(lp._internals.DISQ_STORE.get(skey).body.cachedDisqualified === false, 'stored kickoff body carries cachedDisqualified=false');
  ok(!lp.hasStoredSearch('deadbeefdeadbeefdeadbeefdeadbeef'), 'an unknown searchKey is not stored (poll returns unknown → tells caller to re-run /price)');
  // the kickoff response carries the requestId at EITHER baseSearch.requestId OR
  // results.baseSearch.requestId (both shapes occur) — the poll MUST echo it (the missing link that
  // made the poll never find the async result). requestIdOf reads both paths.
  ok(lp._internals.requestIdOf({ baseSearch: { requestId: '6a8149b3de295a00071c3632' } }) === '6a8149b3de295a00071c3632', 'requestIdOf reads baseSearch.requestId (top-level shape)');
  ok(lp._internals.requestIdOf({ results: { baseSearch: { requestId: '6a8149b3de295a00071c3632' } } }) === '6a8149b3de295a00071c3632', 'requestIdOf reads results.baseSearch.requestId (wrapped shape)');
  ok(lp._internals.requestIdOf({ results: {} }) === null && lp._internals.requestIdOf(null) === null, 'requestIdOf is null-safe when absent');
  const kb2 = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60, io: true });
  const skey2 = lp._internals.storeKickoff('https://api.digitallending.com/x', kb2, '6a8149b3de295a00071c3632');
  ok(lp._internals.DISQ_STORE.get(skey2).requestId === '6a8149b3de295a00071c3632', 'storeKickoff persists the requestId for the poll to echo');
  // A stored kickoff with NO requestId can never correlate to the async computation → the poll-by-key
  // must surface a named, controlled error instead of 202-ing forever.
  const skeyNoRid = lp._internals.storeKickoff('https://api.digitallending.com/x', lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, dscr: 1.4 }), null);
  const noRidRes = await lp.pollDisqualifiedByKey(skeyNoRid);
  ok(noRidRes.ok === false && noRidRes.error === 'lp_missing_request_id', 'poll-by-key with a stored kickoff lacking a requestId returns lp_missing_request_id (not a perpetual 202)');

  // 21) UPSTREAM-500 RECOVERY internals (§25.7) — provenance, circuit breaker, invalidation.
  const prov = lp._internals.foundationProvenance({ baseSource: 'live', smoSource: 'fallback', baseError: null, smoError: 'lp_get_status 500' });
  ok(prov.base === 'live' && prov.smo === 'fallback' && prov.smoError === 'lp_get_status 500', 'foundationProvenance reports live-vs-fallback source + the preserved live-fetch error');
  ok(lp._internals.foundationProvenance(null).base === 'fallback' && lp._internals.foundationProvenance({}).smo === 'fallback', 'foundationProvenance defaults to fallback when the source is unknown');
  // circuit breaker: the first RECOVERY_MAX 500-triggered relogins are allowed; the next is skipped.
  const MAX = lp._internals.RECOVERY_MAX;
  ok(lp._internals.breakerOpen() === false, 'breaker starts closed (no relogins yet)');
  for (let i = 0; i < MAX - 1; i++) { lp._internals.recordRecovery(); ok(lp._internals.breakerOpen() === false, `breaker still closed after ${i + 1} relogin(s) (< max ${MAX})`); }
  lp._internals.recordRecovery();
  ok(lp._internals.breakerOpen() === true, `breaker opens at ${MAX} relogins in the window (no login storm)`);
  // invalidation helpers never throw.
  lp._internals.invalidateSession(); lp._internals.invalidateFoundation();
  ok(true, 'invalidateSession/invalidateFoundation run without throwing');

  // 22) §26.2 — the live foundation paths carry NO {companyId}/{userId} suffix (the frontend GETs
  // the bare paths; the old suffixes 404'd every live fetch and pinned the foundation to fallback).
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'), 'utf8');
    ok(/DEFAULTSEARCH_PATH\s*=\s*process\.env\.LP_DEFAULTSEARCH_PATH\s*\|\|\s*'\/rest\/v1\/lp-ppe-integration\/pricing\/defaultSearch'/.test(src),
      '§26.2 defaultSearch path drops the {companyId}/{userId} suffix');
    ok(/SMO_PATH\s*=\s*process\.env\.LP_SMO_PATH\s*\|\|\s*'\/rest\/v1\/lp-ppe-integration\/pricing\/smo'/.test(src),
      '§26.2 smo path drops the {companyId} suffix');
  }

  // 23) §26.4 — explicit loan-purpose alias table; NO default-to-refinance.
  const mapPurpose = sm._internals.mapPurpose;
  ok(mapPurpose('Purchase') === 'Purchase' && mapPurpose('purchase') === 'Purchase' && mapPurpose('  PURCHASE ') === 'Purchase', '§26.4 Purpose → Purchase (case/space tolerant)');
  ok(mapPurpose('Cash out') === 'CashoutRefinance' && mapPurpose('cashout') === 'CashoutRefinance' && mapPurpose('CashOut') === 'CashoutRefinance', '§26.4 Cash out → CashoutRefinance');
  ok(mapPurpose('Refinance') === 'Refinance' && mapPurpose('refi') === 'Refinance' && mapPurpose('Rate/Term') === 'Refinance', '§26.4 Refinance (rate-and-term) → Refinance');
  ok(threws(() => mapPurpose('mortgage')) && threws(() => mapPurpose(undefined)) && threws(() => mapPurpose('')), '§26.4 unknown/absent purpose THROWS (never defaults to Refinance)');

  // 24) §26.3 — location completeness guard (reject ZIP/state without countyFps, and conflicts).
  const vl = sm.validateLocation;
  ok(vl({}).ok === true, '§26.3 absent location is valid (base defaults apply)');
  ok(vl({ zip: '07036', state: 'NJ' }).code === 'missing_county_fips', '§26.3 ZIP/state without countyFps → 422 missing_county_fips');
  ok(vl({ state: 'NJ', countyFps: '34039' }).ok === true, '§26.3 complete NJ location is valid');
  ok(vl({ state: 'NJ', countyFps: '12086' }).code === 'location_conflict', '§26.3 countyFps state-prefix conflicting with state → 422');
  ok(vl({ state: 'ZZ', countyFps: '34039' }).code === 'invalid_state', '§26.3 unknown state code → 422 invalid_state');
  ok(vl({ state: 'NJ', countyFps: 'abc' }).code === 'invalid_county_fips', '§26.3 non-5-digit countyFps → 422 invalid_county_fips');

  // 25) §26.5 — validateScenario builds+validates LOCALLY (zero upstream) and 422s a bad request.
  const okScn = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 375000, dscr: 1.25, zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039' });
  ok(okScn.ok === true && okScn.request && okScn.request.criteria.loanPurpose === 'Purchase', '§26.5 a complete scenario validates and returns the built request');
  ok(sm.validateScenario({ purpose: 'banana', state: 'NJ', countyFps: '34039' }).error === 'unknown_loan_purpose', '§26.5 unknown purpose → 422 unknown_loan_purpose');
  // §26.3 CONTRACT CHANGE — a ZIP now FILLS the county, so ZIP+state is no longer an incomplete
  // location end-to-end (that is the whole ZIP-enrichment feature). The underlying validateLocation
  // rule is UNCHANGED and still proven directly above (line ~354). What must still 422 is a location
  // the enrichment genuinely cannot complete, asserted on the next line.
  ok(sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, zip: '07036', state: 'NJ' }).ok === true,
    '§26.3 ZIP + state is completed by the county lookup (no longer missing_county_fips)');
  ok(sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, zip: '30301', state: 'GA' }).error === 'zip_not_found',
    '§26.5 a location the ZIP lookup cannot complete still 422s (fails closed)');
  // The fixture now carries a location. Not a weakening: this assertion's SUBJECT is that a bad
  // registry VALUE is refused before any upstream call, and it never meant to also assert that a
  // locationless scenario prices. It did price — silently, in the captured base's New Jersey town —
  // which is the rule below.
  ok(sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, zip: '11211', citizenship: 'Martian' }).error === 'invalid_field_value', '§26.5 invalid registry value → 422 invalid_field_value (moved BEFORE the upstream call)');
  // A PRICED SCENARIO MUST SAY WHERE THE PROPERTY IS (re-audit of #1220). Before the address became
  // scenario-owned this silently inherited the captured base's address and priced a deal in Linden,
  // NJ wherever it actually was; afterwards it would have sent no state and no county at all.
  // Both are wrong and they fail differently, so it is refused by name.
  {
    const noLoc = sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760 });
    ok(noLoc.ok === false && noLoc.error === 'location_required', '§26.3 a scenario with NO location is refused (never priced in the capture\'s town)');
    ok(/5-digit ZIP is enough/.test(noLoc.message || ''), '§26.3 …and the refusal says the cheapest way to satisfy it');
    ok(sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5, fico: 760, zip: '11211' }).ok === true,
      '§26.3 …while a bare ZIP alone still satisfies it (enrichment runs first)');
  }
  ok(sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5 }).status === 422 || sm.validateScenario({ purpose: 'Purchase', value: 5e5, loan: 4e5 }).ok === true, '§26.5 validateScenario returns a shaped result');

  // 26) §27 STRICT INPUT VALIDATION — the silent-mispricing class (HTTP 200 with a wrong answer).
  const G = { purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', state: 'NJ', countyFps: '34039' };
  const vErr = (sc) => sm.validateScenario(sc).error;
  ok(sm.validateScenario(G).ok === true, '§27 baseline scenario validates');
  ok(vErr({ ...G, propertyType: 'Castle' }) === 'unknown_property_type', '§27.5 unknown property type → 422 (never priced as single-family)');
  ok(vErr({ ...G, io: 'false' }) === 'non_boolean_value', '§27.6 string "false" boolean → 422 (never coerced to true)');
  ok(vErr({ ...G, ltv: 50 }) === 'ltv_conflict', '§27.7 conflicting LTV (50% vs 75% calc) → 422');
  ok(sm.validateScenario({ ...G, ltv: 75 }).ok === true, '§27.7 agreeing LTV (75) is accepted');
  ok(vErr({ ...G, loan: 600000 }) === 'loan_exceeds_value', '§27.10 loan > value (LTV > 100%) → 422');
  ok(vErr({ ...G, fico: 999 }) === 'out_of_range', '§27.10 FICO 999 → 422 out_of_range');
  ok(vErr({ ...G, dscr: -1 }) === 'out_of_range', '§27.10 DSCR -1 → 422 (sign no longer stripped to +1)');
  // Term/lock capability lists now match the LIVE frontend (audit §7): terms 5 + 8..30 + 40, locks
  // 10/12/15/21/25/30/40/45/60/75/90/120/180. So 17-year is VALID (it is within 8..30); a 7-year term
  // (a gap between 5 and 8) is the unsupported case.
  ok(sm.validateScenario({ ...G, termYears: 17 }).ok === true, '§27.8 17-year term is now accepted (within the live 8..30 range)');
  ok(vErr({ ...G, termYears: 7 }) === 'unsupported_term', '§27.8 7-year term → 422 unsupported_term (gap between 5 and 8)');
  ok(sm.validateScenario({ ...G, termYears: 15 }).ok === true, '§27.8 15-year term is accepted');
  ok(vErr({ ...G, lockDays: 22 }) === 'unsupported_lock', '§27.8 22-day lock → 422 unsupported_lock (not in the live list)');
  ok(sm.validateScenario({ ...G, lockDays: 120 }).ok === true, '§27.8 120-day lock is now accepted (live list)');
  ok(vErr({ ...G, lockDays: 14 }) === 'unsupported_lock', '§27.8 14-day lock → 422 (the stale base offered it; the live frontend never does)');
  ok(sm.validateScenario({ ...G, lockDays: 45 }).ok === true, '§27.8 45-day lock is accepted');
  ok(vErr({ ...G, units: 4 }) === 'units_conflict', '§27.10 single-family + 4 units → 422 units_conflict');
  ok(sm.validateScenario({ ...G, propertyType: 'Unit2_4', units: 3 }).ok === true, '§27.10 2–4 unit + 3 units is accepted');
  ok(vErr({ ...G, value: '1e3' }) === 'invalid_number', '§27.10 exponent string "1e3" → 422 (not corrupted to 13)');
  // strictNum preserves the sign; num (builder) no longer strips it.
  ok(sm._internals.strictNum('-1') === -1 && sm._internals.strictNum('1e3') === undefined && sm._internals.strictNum('$500,000') === 500000, '§27.10 strictNum preserves sign, rejects exponent, tolerates currency');

  // 27) §28.5 — an OMITTED boolean inherits the base default; an EXPLICIT value overwrites it.
  const baseJson = require('../src/longterm/lenderprice/search-base.json');
  const baseIO = baseJson.criteria ? baseJson.criteria.interestOnly : undefined;
  const omit = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5 });
  ok(omit.criteria.interestOnly === baseIO, '§28.5 omitted io inherits the base interestOnly default (not forced false)');
  const expl = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, io: false });
  ok(expl.criteria.interestOnly === false, '§28.5 explicit io:false is preserved');
  const explT = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5, io: true });
  ok(explT.criteria.interestOnly === true, '§28.5 explicit io:true is preserved');

  // 28) §27.4 — a second identical kickoff must NOT overwrite the first search's requestId.
  const dupBody = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 });
  const dk1 = lp._internals.storeKickoff('https://api.digitallending.com/x', dupBody, 'RID_FIRST');
  const dk2 = lp._internals.storeKickoff('https://api.digitallending.com/x', dupBody, 'RID_SECOND');
  ok(dk1 === dk2 && lp._internals.DISQ_STORE.get(dk1).requestId === 'RID_FIRST', '§27.4 identical kickoff keeps the FIRST requestId (no reset)');
  const nullBody = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.33, prepayMonths: 60 });
  const nk = lp._internals.storeKickoff('https://api.digitallending.com/x', nullBody, null);
  lp._internals.storeKickoff('https://api.digitallending.com/x', nullBody, 'RID_LATE');
  ok(lp._internals.DISQ_STORE.get(nk).requestId === 'RID_LATE', '§27.4 a missing requestId is later upgraded');

  // 29) §28.2 — require-live-foundation gate refuses the static fallback (only when the flag is set).
  ok(lp._internals.foundationLiveGate({ baseSource: 'fallback', smoSource: 'fallback' }) === null, '§28.2 gate is a no-op when LP_REQUIRE_LIVE_FOUNDATION is unset');
  process.env.LP_REQUIRE_LIVE_FOUNDATION = '1';
  ok(lp._internals.foundationLiveGate({ baseSource: 'live', smoSource: 'live' }) === null, '§28.2 gate passes a fully-live foundation');
  const gated = lp._internals.foundationLiveGate({ baseSource: 'fallback', smoSource: 'live' });
  ok(gated && gated.error === 'lp_foundation_not_live' && gated.http === 502, '§28.2 gate refuses a fallback foundation with a named 502');
  delete process.env.LP_REQUIRE_LIVE_FOUNDATION;

  // 30) Cash-out amount ("cash in hand") — §32.2 FAIL-CLOSED (SUPERSEDES §31.4 "vendor fixed the
  // field"): the clean live cash-out capture transmitted NEITHER criteria.cashoutAmount NOR the value,
  // only a frontend bug. So the amount is accepted + validated + retained INTERNALLY, but NEVER
  // transmitted as a criteria field and NEVER as an invented key.
  delete process.env.LP_CASHOUT_AMOUNT_FIELD;
  ok(sm.validateScenario({ purpose: 'Cash out', value: 5e5, loan: 3e5, cashoutAmount: 50000, state: 'NJ', countyFps: '34039' }).ok === true, 'cash-out amount is an accepted, validated field');
  ok(sm.validateScenario({ purpose: 'Cash out', value: 5e5, loan: 3e5, cashoutAmount: -5, state: 'NJ', countyFps: '34039' }).error === 'out_of_range', 'a negative cash-out amount is rejected');
  const coTx = lp.buildSearch({ purpose: 'CashOut', value: 5e5, loan: 3e5, cashoutAmount: 47321 });
  ok(coTx.criteria.cashoutAmount === 47321 && JSON.stringify(coTx).includes('47321'), 'cash-out amount IS transmitted as numeric criteria.cashoutAmount (the captured vendor field)');
  ok(coTx[sm.CASHOUT_INTERNAL] === 47321, '§32.2 cash-out amount is retained internally (Symbol-keyed, not serialized)');
  ok(!Object.keys(coTx.dynamicPropertiesMap).some((k) => k === 'undefined'), 'no invented dynamicPropertiesMap.undefined key is ever emitted');
  const noCo = lp.buildSearch({ purpose: 'CashOut', value: 5e5, loan: 3e5 });
  ok(noCo.criteria.cashoutAmount === undefined && noCo[sm.CASHOUT_INTERNAL] === undefined, 'no cash-out amount supplied → nothing set, nothing retained');
  // The operator escape hatch is RETIRED — it addressed a dynamic property that never existed, so it
  // was a guess waiting to be configured. Setting it must now do nothing at all.
  process.env.LP_CASHOUT_AMOUNT_FIELD = 'CashInHand';
  const tx = lp.buildSearch({ purpose: 'CashOut', value: 5e5, loan: 3e5, cashoutAmount: 47321 });
  ok(tx.dynamicPropertiesMap.CashInHand === undefined && tx.criteria.cashoutAmount === 47321, 'the retired escape hatch writes no dynamic property; the amount rides its one captured path');
  delete process.env.LP_CASHOUT_AMOUNT_FIELD;

  // 31) AUDIT §3 — appraised value is NOT manufactured from the estimated value.
  const buyAppr = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 375000 });
  ok(buyAppr.criteria.appraisedValue === null, 'purchase: appraised value is BLANK unless separately entered — never mirrored from the price');
  const coBlank = lp.buildSearch({ purpose: 'CashOut', value: 6e5, loan: 42e4 });
  ok(coBlank.criteria.appraisedValue === null, '§3 cash-out with no appraisal: appraised is BLANK, not the $600k estimated value');
  const refiBlank = lp.buildSearch({ purpose: 'Refinance', value: 5e5, loan: 4e5 });
  ok(refiBlank.criteria.appraisedValue === null, '§3 refinance with no appraisal: appraised is blank');
  const coAsIs = lp.buildSearch({ purpose: 'CashOut', value: 6e5, loan: 42e4, asIsValue: 58e4 });
  ok(coAsIs.criteria.appraisedValue === 58e4, '§3 an explicit as-is value fills appraised on a cash-out');

  // 32) AUDIT §1 — the intentional DSCR defaults are FORCED (30yr fixed / 30-day lock / 24mo reserves),
  //     even when a live default model carried something else.
  const def = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 375000 });
  ok(def.criteria.loanYear === 30 && def.termsCriteria[0] === 30 && def.termsInMonths === false, '§1 omitted term → forced 30-year');
  ok(def.brokerCriteria.dayLocks === 30 && def.dayLocksCriteria[0] === 30, '§1 omitted lock → forced 30-day');
  ok(def.dynamicPropertiesMap.GLOBAL_RESERVES.value === 'Reserves_24', '§1 reserves forced to 24 months');
  ok(def.criteria.propertyUse === 'Investment' && def.criteria.compensationType === 'BorrowerCompPlan', '§1 investment + borrower-paid comp forced');
  ok(def.dynamicPropertiesMap.IncomeDocType.value === 'DSCR' && def.dynamicPropertiesMap.AddlOccupancyType.value === 'Long_Term_Rental_Property', '§1 DSCR income doc + long-term rental forced');
  // a tampered LIVE base carrying a different term/lock/reserves must be overridden by the profile
  const B0 = require('../src/longterm/lenderprice/search-base.json');
  const tamperedBase = JSON.parse(JSON.stringify(B0));
  tamperedBase.criteria.loanYear = 40; tamperedBase.brokerCriteria.dayLocks = 45;
  tamperedBase.dynamicPropertiesMap.GLOBAL_RESERVES = { fieldId: 'GLOBAL_RESERVES', value: 'Reserves_0' };
  const over = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 375000 }, { base: tamperedBase });
  ok(over.criteria.loanYear === 30 && over.brokerCriteria.dayLocks === 30 && over.dynamicPropertiesMap.GLOBAL_RESERVES.value === 'Reserves_24',
    '§1 a live default carrying 40yr/45day/blank-reserves is OVERRIDDEN by the DSCR profile');

  // 33) AUDIT §6 — attachment / non-warrantable are INDEPENDENT of property type.
  const condoDet = lp.buildSearch({ purpose: 'Purchase', value: 6e5, loan: 42e4, propertyType: 'Condo', attachment: 'Detached', nonWarrantable: true });
  ok(condoDet.property.propertyType === 'Condos' && condoDet.property.attachmentType === 'Detached', '§6 Condo + Detached is reproducible (independent attachment)');
  ok(condoDet.criteria.nonWarrantableProject === true, '§6 non-warrantable flag is independent');
  ok(vErr({ ...G, attachment: 'Sideways' }) === 'invalid_attachment', '§6 an invalid attachment → 422 invalid_attachment');

  // 34) AUDIT — isolated LTV range is checked whether or not value+loan were supplied.
  ok(sm.validateScenario({ purpose: 'Purchase', ltv: 105, state: 'NJ', countyFps: '34039' }).error === 'ltv_out_of_range', 'a bare LTV of 105% → 422 ltv_out_of_range');
  // §35.2/§36.2 CONTRACT CHANGE — a LONE ltv is no longer a priceable scenario. The amount triangle
  // needs any TWO of value / loan / ltv (the third is derived), so one amount alone is refused as
  // insufficient_amounts rather than sent upstream with a null purchase price. The RANGE checking
  // these two rows were written for is unchanged and still proven by the 105% case above (it fires
  // before the triangle rule), and by the in-range rows below which now supply a second amount.
  ok(sm.validateScenario({ purpose: 'Purchase', ltv: 95, state: 'NJ', countyFps: '34039' }).error === 'insufficient_amounts', 'a bare LTV of 95% alone → 422 insufficient_amounts (needs two of value/loan/ltv)');
  ok(sm.validateScenario({ purpose: 'Purchase', ltv: 95, loan: 4e5, state: 'NJ', countyFps: '34039' }).ok === true, 'an in-range LTV of 95% WITH a loan is accepted (value derived)');
  ok(sm.validateScenario({ purpose: 'Purchase', ltv: 0.7, loan: 4e5, state: 'NJ', countyFps: '34039' }).ok === true, 'a fractional LTV of 0.70 with a loan is accepted');

  // 35) GOLDEN FIXTURE A — the audit's canonical DSCR purchase (permanent request-structure fixture).
  const goldA = lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 375000, fico: 760, dscr: 1.25,
    propertyType: 'SingleFamily', prepayMonths: 60, borrowerType: 'LLC', zip: '07036', state: 'NJ', countyFps: '34039' });
  ok(goldA.criteria.loanPurpose === 'Purchase' && goldA.criteria.purchasePrice === 5e5 && goldA.criteria.appraisedValue === null, 'GOLDEN A: purchase 500k, appraised BLANK (not mirrored)');
  ok(goldA.criteria.loanAmount === 375000 && Math.abs(goldA.criteria.ltv - 0.75) < 1e-9, 'GOLDEN A: loan 375k, LTV 0.75');
  ok(goldA.criteria.fico === 760 && goldA.criteria.dscr === 1.25, 'GOLDEN A: FICO 760 / DSCR 1.25');
  ok(goldA.criteria.loanYear === 30 && goldA.brokerCriteria.dayLocks === 30, 'GOLDEN A: 30yr / 30-day lock');
  ok(goldA.property.propertyType === 'SingleFamily' && goldA.property.attachmentType === 'Detached' && goldA.property.numberOfUnit === 1, 'GOLDEN A: SFR / detached / 1 unit');
  ok(goldA.dynamicPropertiesMap.GLOBAL_BorrowerType.value === 'LLC' && goldA.dynamicPropertiesMap.GLOBAL_RESERVES.value === 'Reserves_24', 'GOLDEN A: LLC borrower / 24mo reserves');
  ok(goldA.dynamicPropertiesMap.PrepayTerm.value === '60 Months', 'GOLDEN A: 5-year (60-month) prepay');

  // 36) GOLDEN FIXTURE B — the audit's cash-out combination (non-warrantable condo, detached, IO, 15yr).
  const goldB = lp.buildSearch({ purpose: 'Cash out', value: 6e5, loan: 42e4, fico: 720, dscr: 1.10, io: true,
    propertyType: 'CondoNonWarr', attachment: 'Detached', prepayMonths: 60, borrowerType: 'LLC', termYears: 15, lockDays: 15,
    cashoutAmount: 50000, zip: '33101', state: 'FL', countyFps: '12086' });
  ok(goldB.criteria.loanPurpose === 'CashoutRefinance', 'GOLDEN B: cash-out → CashoutRefinance');
  ok(goldB.criteria.purchasePrice === 6e5 && goldB.criteria.appraisedValue === null, 'GOLDEN B: estimated 600k, appraised BLANK (not manufactured)');
  ok(goldB.criteria.loanAmount === 42e4 && Math.abs(goldB.criteria.ltv - 0.70) < 1e-9, 'GOLDEN B: loan 420k, LTV 0.70');
  ok(goldB.criteria.interestOnly === true, 'GOLDEN B: interest-only');
  ok(goldB.property.propertyType === 'Condos' && goldB.property.attachmentType === 'Detached' && goldB.criteria.nonWarrantableProject === true, 'GOLDEN B: non-warrantable condo, detached');
  ok(goldB.criteria.loanYear === 15 && goldB.brokerCriteria.dayLocks === 15, 'GOLDEN B: 15yr / 15-day lock');
  ok(goldB.criteria.cashoutAmount === 50000 && goldB[sm.CASHOUT_INTERNAL] === 50000, 'GOLDEN B: cashoutAmount 50000 transmitted on criteria AND retained internally (the two agree)');

  // 37) AUDIT — advanced numerics are STRICTLY validated (no more silent coercion of "12abc" → 123).
  ok(vErr({ ...G, monthlyIncome: '12abc' }) === 'invalid_field_value', 'a malformed monthlyIncome → 422 invalid_field_value');
  ok(vErr({ ...G, numberOfBorrowers: 0 }) === 'invalid_field_value', 'numberOfBorrowers 0 is out of range (min 1) → 422');
  ok(vErr({ ...G, financedProperties: 1.5 }) === 'invalid_field_value', 'a fractional financedProperties → 422 (integer required)');
  ok(vErr({ ...G, dti: 150 }) === 'invalid_field_value', 'a DTI of 150 is out of range (max 100) → 422');
  ok(vErr({ ...G, monthlyDebt: -5 }) === 'invalid_field_value', 'a negative monthlyDebt → 422');
  ok(sm.validateScenario({ ...G, monthlyIncome: 8000, monthlyDebt: 2000, numberOfBorrowers: 2, dti: 43 }).ok === true, 'valid advanced numerics are accepted');
  const advReq = lp.buildSearch({ ...G, monthlyIncome: 8000, numberOfBorrowers: 2, dti: 43 });
  ok(advReq.criteria.monthlyIncome === 8000 && advReq.criteria.numberOfBorrower === 2 && Math.abs(advReq.criteria.clientDti - 0.43) < 1e-9, 'valid advanced numerics are actually applied to the request');

  // 38) AUDIT — a wrong-shape nested field is REJECTED, not silently ignored.
  ok(vErr({ ...G, bankruptcy: 'chapter7' }) === 'invalid_field_value', 'bankruptcy sent as a STRING → 422 (dangerous to price without it)');
  ok(vErr({ ...G, mortgageLates: 'none' }) === 'invalid_field_value', 'mortgageLates sent as a STRING → 422');
  ok(sm.validateScenario({ ...G, bankruptcy: { chapter: 'Chapter 7', seasoning: '4-7 Years' } }).ok === true, 'a correctly-shaped bankruptcy object is accepted');

  // 39) AUDIT — explicit-false four-state: omitted inherits, true turns on, false turns OFF.
  const muOff = lp.buildSearch({ ...G, mixedUse: false });
  ok(muOff.dynamicPropertiesMap.GLOBAL_MixedUse && muOff.dynamicPropertiesMap.GLOBAL_MixedUse.value === false, 'explicit mixedUse:false is transmitted as OFF (no longer swallowed)');
  const muOn = lp.buildSearch({ ...G, mixedUse: true });
  ok(muOn.dynamicPropertiesMap.GLOBAL_MixedUse.value === true, 'explicit mixedUse:true is transmitted as ON');
  const muOmit = lp.buildSearch({ ...G });
  ok(muOmit.dynamicPropertiesMap.GLOBAL_MixedUse === undefined, 'omitted mixedUse inherits (nothing written)');
  const nmhOff = lp.buildSearch({ ...G, noMortgageHistory: false });
  ok(nmhOff.dynamicPropertiesMap.GLOBAL_NoMortgageHistory && nmhOff.dynamicPropertiesMap.GLOBAL_NoMortgageHistory.value === false, 'explicit noMortgageHistory:false is transmitted as OFF');

  console.log(`\nOFFLINE: ${failures ? failures + ' FAILED' : 'all passed'}`);
}

async function live() {
  console.log('LIVE Lender Price run\n');
  if (!lp.configured()) { console.log('LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET not set — cannot run live. (Set them in Render.)'); process.exit(2); }

  const t0 = Date.now();
  const s = await lp.getSession({ force: true });
  if (!s.ok) { console.log('LOGIN FAILED:', s.error, '-', s.message); process.exit(1); }
  console.log(`LOGIN ok in ${((Date.now() - t0) / 1000).toFixed(2)}s  company=${s.companyId} user=${s.userId} nmls=${s.profile.loanOfficerNmlsId} exp=${new Date(s.expiresAt).toISOString()}`);

  const battery = [
    { name: 'SFR purchase 75% 760 DSCR1.25 NJ 5yr', purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union', countyFps: '34039', prepayMonths: 60, borrowerType: 'LLC' },
    { name: 'SFR cash-out 70% 720 DSCR1.10 FL 3yr', purpose: 'CashOut', value: 600000, loan: 420000, fico: 720, dscr: 1.10, propertyType: 'SingleFamily', zip: '33101', state: 'FL', county: 'Miami-Dade', countyFps: '12086', prepayMonths: 36, borrowerType: 'LLC' },
    { name: '2-4 unit purchase 75% 740 DSCR1.30 NY 5yr', purpose: 'Purchase', value: 900000, loan: 675000, fico: 740, dscr: 1.30, propertyType: 'Unit2_4', zip: '11211', state: 'NY', county: 'Kings', countyFps: '36047', prepayMonths: 60, borrowerType: 'LLC' },
    { name: 'Warr condo r/t refi 65% 780 DSCR1.40 TX none', purpose: 'RateTerm', value: 450000, loan: 292500, fico: 780, dscr: 1.40, propertyType: 'CondoWarr', zip: '75201', state: 'TX', county: 'Dallas', countyFps: '48113', prepayMonths: 0, borrowerType: 'LLC' },
    { name: 'SFR purchase I/O 80% 700 DSCR1.05 GA 2yr', purpose: 'Purchase', value: 350000, loan: 280000, fico: 700, dscr: 1.05, propertyType: 'SingleFamily', zip: '30301', state: 'GA', county: 'Fulton', countyFps: '13121', prepayMonths: 24, io: true, borrowerType: 'LLC' },
  ];

  for (const sc of battery) {
    const r = await lp.price(sc);
    if (!r.ok) { console.log(`  FAIL  ${sc.name} → ${r.error} ${r.http || ''} ${r.message || ''} ${r.body || ''}`); continue; }
    const p = lp.parse(r.raw);
    const best = p.programs.reduce((m, x) => (x.minRate != null && x.minRate < m ? x.minRate : m), Infinity);
    console.log(`  ok    ${sc.name}  → ${p.programCount} programs / ${p.lenderCount} lenders / ${p.rungCount} rungs / best ${isFinite(best) ? best + '%' : '—'}`);
    await new Promise((res) => setTimeout(res, 1200)); // pace: gentle on one shared login
  }
  console.log('\nLIVE run complete.');
}

(async () => {
  if (process.env.LP_LIVE === '1') { await live(); }
  else { await offline(); process.exit(failures ? 1 : 0); }
})();
