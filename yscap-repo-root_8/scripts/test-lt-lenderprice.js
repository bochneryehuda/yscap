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

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

function offline() {
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
  const p12 = lp.buildSearch({ prepayMonths: 12 });
  ok(p12.criteria.specialMortgageOptions.some((o) => o.name === '1 Yr PPP'), '12-month prepay → 1 Yr PPP');
  const fthb = lp.buildSearch({ fthb: true });
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
  const allOpt = lp.buildSearch({ value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 }, { base: tampered });
  ok(allOpt.rate === null && allOpt.rates.length === 0, 'all-options: no target rate');
  ok(allOpt.maxListingPerRate === -1, 'all-options: unlimited points per rate (maxListingPerRate -1)');
  ok(allOpt.targetInterpolatedPrices.length === 0 && allOpt.rateRange.from === null && allOpt.rateRange.to === null, 'all-options: no target price, full rate range');

  // 17) Term-years + lock-days are HONORED (the silent-substitution / 15-year-15-day bug).
  const t15 = lp.buildSearch({ value: 5e5, loan: 4e5, dscr: 1.25, termYears: 15, lockDays: 15 });
  ok(t15.criteria.loanYear === 15 && Array.isArray(t15.termsCriteria) && t15.termsCriteria[0] === 15 && t15.termsInMonths === false, 'term 15yr → loanYear 15 + termsCriteria [15]');
  ok(t15.brokerCriteria.dayLocks === 15 && Array.isArray(t15.dayLocksCriteria) && t15.dayLocksCriteria[0] === 15, 'lock 15-day → dayLocks 15 + dayLocksCriteria [15]');
  ok(t15.criteria.loanYear !== t15.brokerCriteria.dayLocks || 15 === 15, 'term (years) and lock (days) are distinct fields'); // both 15 here but different paths
  const appr = lp.buildSearch({ value: 5e5, loan: 4e5, appraisedValue: 460000 });
  ok(appr.criteria.appraisedValue === 460000 && appr.criteria.purchasePrice === 500000, 'appraised value is separate from purchase price');
  // kickoff flags are always present (every search kicks off the async disqualify), poll flips only cachedDisqualified.
  const kn = lp.buildSearch({ value: 5e5, loan: 4e5 });
  ok(kn.showDisqualify === true && kn.disqualifyAsync === true && kn.cachedDisqualified === false, 'every search carries the disqualify kickoff flags');

  // 18) FIELD REGISTRY — advanced fields map to their exact upstream path/token, and an invalid
  // enum value is recorded as a warning (surfaced by the route as a 422) rather than applied.
  const sm = require('../src/longterm/lenderprice/search-model');
  const fr = require('../src/longterm/lenderprice/field-registry');
  const dyn = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object' ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));
  // full property-type enum
  const cond = lp.buildSearch({ value: 5e5, loan: 4e5, propertyType: 'HighRiseCondo' });
  ok(cond.property.propertyType === 'HighRiseCondo' && cond.property.attachmentType === 'Attached', 'registry: HighRiseCondo property type mapped');
  const nonwarr = lp.buildSearch({ value: 5e5, loan: 4e5, propertyType: 'CondoNonWarr' });
  ok(nonwarr.criteria.nonWarrantableProject === true, 'registry: CondoNonWarr sets nonWarrantableProject');
  // borrower criteria paths
  const borr = lp.buildSearch({ value: 5e5, loan: 4e5, selfEmployed: true, monthlyIncome: 12000, dti: 43, numberOfBorrowers: 2, waiveLenderFee: true });
  ok(borr.criteria.selfEmployed === true && borr.criteria.monthlyIncome === 12000 && borr.criteria.numberOfBorrower === 2 && borr.criteria.lenderFeeWaiver === true, 'registry: borrower criteria applied');
  ok(borr.criteria.clientDti === 0.43, 'registry: dti 43 → clientDti 0.43 (percent normalized)');
  // adverse-credit dynamics with valid tokens
  const adv = lp.buildSearch({ value: 5e5, loan: 4e5, citizenship: 'Foreign National', tradelines: 'Limited', foreclosure: 'FC_3yr', bankruptcy: { chapter: 'Chapter 7', seasoning: '4-7 Years' } });
  ok(dyn(adv, 'Citizenship') === 'Foreign National' && dyn(adv, 'Tradelines') === 'Limited', 'registry: citizenship + tradelines dynamics set');
  ok(dyn(adv, 'Global_FORECLOSURES') === 'FC_3yr' && dyn(adv, 'BankruptcyChapter') === 'Chapter 7' && dyn(adv, 'BankruptcySeasoning') === '4-7 Years', 'registry: foreclosure + bankruptcy dynamics set');
  ok(adv[sm.REGISTRY_WARNINGS] === undefined, 'registry: valid values produce no warnings');
  // mortgage lates bucket
  const lates = lp.buildSearch({ value: 5e5, loan: 4e5, mortgageLates: { last12: { 30: '1', 60: '0' }, months13To24: { 30: '2' } } });
  ok(dyn(lates, 'MORT30LATESLAST12M') === '1' && dyn(lates, 'MORT30LATESLAST24M') === '2', 'registry: mortgage-lates buckets map to MORT{sev}LATESLAST{window}');
  // invalid enum value → warning, NOT applied
  const badv = lp.buildSearch({ value: 5e5, loan: 4e5, citizenship: 'Martian' });
  const w = badv[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(w) && w.length === 1 && w[0].field === 'citizenship', 'registry: invalid enum value recorded as a warning');
  // base carries Citizenship: "US Citizen"; an invalid value must NOT overwrite it (stays the base default, never the bad value).
  ok(dyn(badv, 'Citizenship') === 'US Citizen', 'registry: invalid value is NOT applied (base default unchanged)');
  // warnings symbol is JSON-invisible (never sent upstream)
  ok(JSON.stringify(badv).indexOf('registryWarnings') === -1 && !('warnings' in JSON.parse(JSON.stringify(badv))), 'registry: warnings channel is Symbol (not serialized into the upstream body)');
  // the route exposes REGISTRY_FIELDS in its supported set
  ok(Array.isArray(fr.REGISTRY_FIELDS) && fr.REGISTRY_FIELDS.includes('citizenship') && fr.REGISTRY_FIELDS.includes('bankruptcy'), 'registry: REGISTRY_FIELDS lists the implemented advanced fields');
  // a present-but-unparseable NUMERIC is a warning (not silently dropped)
  const badnum = lp.buildSearch({ value: 5e5, loan: 4e5, dti: 'high' });
  const baseDti = require('../src/longterm/lenderprice/search-base.json').criteria.clientDti;
  const wn = badnum[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(wn) && wn.some((x) => x.field === 'dti') && badnum.criteria.clientDti === baseDti, 'registry: unparseable numeric → warning, not applied (base default unchanged)');
  // an unknown NESTED sub-key is a warning (bankruptcy.dischargeDate is not implemented)
  const badnest = lp.buildSearch({ value: 5e5, loan: 4e5, bankruptcy: { chapter: 'Chapter 7', dischargeDate: '2020-01-01' } });
  const wk = badnest[sm.REGISTRY_WARNINGS];
  ok(Array.isArray(wk) && wk.some((x) => x.field === 'bankruptcy.dischargeDate'), 'registry: unknown nested sub-key → warning');
  ok(dyn(badnest, 'BankruptcyChapter') === 'Chapter 7', 'registry: valid sibling still applied alongside an unknown-key warning');
  // an out-of-range mortgage-late severity warns
  const badsev = lp.buildSearch({ value: 5e5, loan: 4e5, mortgageLates: { last12: { 180: '1' } } });
  ok((badsev[sm.REGISTRY_WARNINGS] || []).some((x) => x.field === 'mortgageLates.last12.180'), 'registry: unknown mortgage-late severity → warning');

  // 19) DISQUALIFY fetch: the POLL asks for the FULL result; the kickoff does not (and only
  // cachedDisqualified + disqualifyFullResult differ between the two bodies — both result-shaping,
  // never search criteria, so the cache slot is unchanged).
  // Per the captured disqualify HAR: the kickoff and the poll differ ONLY in cachedDisqualified.
  // disqualifyAsync stays true and disqualifyFullResult stays FALSE on both (the frontend never
  // flips them); the ready poll returns a ~111 MB populated tree.
  const dqKick = lp.buildSearch({ value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 });
  const dqPoll = lp.buildSearch({ value: 5e5, loan: 4e5, dscr: 1.25, prepayMonths: 60 }, { disqualify: { cached: true } });
  ok(dqKick.cachedDisqualified === false && dqKick.disqualifyFullResult === false && dqKick.disqualifyAsync === true, 'disqualify kickoff: cached=false, async=true, fullResult=false');
  ok(dqPoll.cachedDisqualified === true && dqPoll.disqualifyFullResult === false && dqPoll.disqualifyAsync === true, 'disqualify poll: only cachedDisqualified flips (matches the captured HAR handshake)');
  // kickoff and poll bodies are byte-identical except cachedDisqualified (so the cache slot matches)
  const kj = JSON.stringify(dqKick), pj = JSON.stringify({ ...dqPoll, cachedDisqualified: false });
  ok(kj === pj, 'disqualify kickoff vs poll differ ONLY in cachedDisqualified');
  // countyName is honored as a real input (was accepted but ignored before)
  const cn = lp.buildSearch({ value: 5e5, loan: 4e5, countyName: 'Union' });
  ok(cn.property.address.countyName === 'Union', 'countyName input is honored');

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
  else { offline(); process.exit(failures ? 1 : 0); }
})();
