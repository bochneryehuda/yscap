'use strict';
/**
 * LENDER PRICE searchRaw MODEL BUILDER.
 *
 * WHY: Lender Price's pricing endpoint rejects a hand-built payload (500) — it wants the
 * FULL canonical search model (brokerCriteria / accessCriteria / filter / loanPurposeCriteria /
 * closing-cost defaults / {fieldId,value} dynamics / {id,name} SMOs). Instead of reconstructing
 * all of that, we start from a REAL captured search that Lender Price accepted (search-base.json,
 * which returned 27 programs) and overlay ONLY the scenario fields — preserving every default
 * structure exactly as Lender Price expects. This mirrors the frontend's "clone the default
 * model, change a few fields" behavior.
 *
 * Pure + offline — safe to unit-test with no network. LT-only; no RTL imports.
 */
const BASE = require('./search-base.json');

// SMO ids observed in real captures. The DSCR pair selects the DSCR product; it is always sent.
const SMO_DSCR = [
  { id: '57f2f4cae4b071ea7b978407', name: 'Debt Service Coverage Ratio' },
  { id: '5f37104ace8ad000014c7abe', name: 'DSCR' },
];
// Prepay-term SMOs by months. Terms without a known id fall back to dynaToSmo + the dynamic
// PrepayTerm value (Lender Price derives the SMO because the request carries dynaToSmo:true).
const SMO_PPP = {
  60: { id: '58263ae7e4b0e7f399741293', name: '5 Yr PPP' },
  36: { id: '592868b74cedfd00015bdd63', name: '3 Yr PPP' },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function num(v) { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : null; }

function mapPurpose(p) {
  return p === 'Purchase' ? 'Purchase'
    : (p === 'CashOut' || p === 'CashoutRefinance') ? 'CashoutRefinance'
    : 'Refinance';
}
function mapProp(t) {
  switch (t) {
    case 'Unit2_4': case 'UnitDwelling_2_4': return { propertyType: 'UnitDwelling_2_4', nonWarrantableProject: false };
    case 'CondoWarr': case 'Condos': case 'Condominium': return { propertyType: 'Condos', nonWarrantableProject: false };
    case 'CondoNonWarr': return { propertyType: 'Condos', nonWarrantableProject: true };
    default: return { propertyType: 'SingleFamily', nonWarrantableProject: false };
  }
}

/**
 * Build a complete searchRaw body for a scenario by overlaying it onto the canonical base model.
 * @param sc scenario { purpose,value,loan,ltv,fico,dscr,propertyType,units,zip,state,county,countyFps,city,borrowerType,prepayMonths,io,escrowWaive,date }
 * @param opts { base } optional alternate base model (e.g. a live /pricing/defaultSearch)
 */
function buildSearch(sc = {}, opts = {}) {
  const m = clone(opts.base || BASE);
  const value = num(sc.value);
  const loan = num(sc.loan);
  const ltv = (value && loan) ? Math.round((loan / value) * 1e6) / 1e6
    : (num(sc.ltv) != null ? (num(sc.ltv) > 1 ? num(sc.ltv) / 100 : num(sc.ltv)) : (m.criteria ? m.criteria.ltv : null));
  const purpose = mapPurpose(sc.purpose);
  const pm = mapProp(sc.propertyType);
  const months = num(sc.prepayMonths);

  const c = m.criteria || (m.criteria = {});
  if (value != null) { c.purchasePrice = value; c.appraisedValue = value; }
  if (loan != null) c.loanAmount = loan;
  if (ltv != null) c.ltv = ltv;
  if (num(sc.fico) != null) c.fico = num(sc.fico);
  if (num(sc.dscr) != null) c.dscr = num(sc.dscr);
  c.loanPurpose = purpose;
  c.propertyUse = 'Investment';
  c.compensationType = 'BorrowerCompPlan';
  c.interestOnly = !!sc.io;
  c.escrowWaiver = !!sc.escrowWaive;
  c.nonWarrantableProject = pm.nonWarrantableProject;

  // Special mortgage options: DSCR pair (+ PPP when we have a known id).
  const smo = clone(SMO_DSCR);
  const ppp = months != null ? SMO_PPP[months] : null;
  if (ppp) smo.unshift(clone(ppp));
  c.specialMortgageOptions = smo;

  // Top-level criteria echoes the frontend keeps in sync.
  m.loanPurposeCriteria = [purpose];
  m.date = sc.date || null;
  if (Array.isArray(m.loanTypeCriteria) && !m.loanTypeCriteria.length) m.loanTypeCriteria = ['Fixed'];

  // Property.
  const prop = m.property || (m.property = { address: {} });
  prop.propertyType = pm.propertyType;
  if (num(sc.units) != null) prop.numberOfUnit = num(sc.units);
  const a = prop.address || (prop.address = {});
  if (sc.zip != null) a.zip = String(sc.zip);
  if (sc.state != null) a.state = sc.state;
  if (sc.city != null) a.city = sc.city;
  if (sc.countyFps != null) { a.county = sc.countyFps; a.censustract = sc.countyFps; }
  if (sc.county != null) a.countyName = sc.county;

  // Dynamic properties are {fieldId, value} objects — set values in place.
  const dp = m.dynamicPropertiesMap || (m.dynamicPropertiesMap = {});
  const setDyn = (k, v) => { if (dp[k]) dp[k].value = v; else dp[k] = { fieldId: k, value: v }; };
  setDyn('IncomeDocType', 'DSCR');
  setDyn('AddlOccupancyType', 'Long_Term_Rental_Property');
  setDyn('GLOBAL_BorrowerType', sc.borrowerType || 'LLC');
  setDyn('PrepayTerm', months ? `${months} Months` : null);
  setDyn('PrePayment_Plan_Type', months ? 'Standard' : null);
  m.dynaToSmo = true;

  return m;
}

module.exports = { BASE, buildSearch, _internals: { SMO_DSCR, SMO_PPP, mapPurpose, mapProp } };
