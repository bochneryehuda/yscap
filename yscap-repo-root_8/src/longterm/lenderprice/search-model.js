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
// These are FALLBACKS: when a live /pricing/smo registry is passed via opts.smo, the current
// company ids win (an SMO id can be re-issued per company/config); the built-ins below keep the
// backend pricing even when that registry endpoint is unavailable.
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
function normName(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
// Resolve one special-mortgage-option name → {id,name} against a live registry (opts.smo:
// name→{id,name} map OR the raw /pricing/smo array), preferring the current company id and
// falling back to a known built-in id, else name-only (dynaToSmo lets Lender Price still map it).
function resolveSmo(name, registry, fallback) {
  const key = normName(name);
  let id = null;
  if (registry) {
    if (typeof registry.get === 'function') { const hit = registry.get(key); if (hit) id = hit.id || hit; }
    else if (Array.isArray(registry)) { const hit = registry.find((o) => normName(o && o.name) === key); if (hit) id = hit.id; }
    else if (registry[key]) { id = registry[key].id || registry[key]; }
  }
  if (!id && fallback && fallback.id) id = fallback.id;
  return id ? { id, name: fallback && fallback.name ? fallback.name : name } : { name: fallback && fallback.name ? fallback.name : name };
}
// Turn a raw /pricing/smo list into a name→{id,name} lookup (lowercased names).
function smoRegistryFromList(list) {
  const map = new Map();
  if (Array.isArray(list)) for (const o of list) { if (o && o.name && o.id) map.set(normName(o.name), { id: o.id, name: o.name }); }
  return map;
}
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
 * @param opts { base, smo } — base = a live /pricing/defaultSearch to overlay (falls back to the
 *   captured BASE); smo = a live /pricing/smo registry (Map or raw array) so option ids are the
 *   company's current ones. Both are optional; without them the proven captured defaults are used.
 */
function buildSearch(sc = {}, opts = {}) {
  const m = clone(opts.base || BASE);
  const smoReg = opts.smo || null;
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

  // Special mortgage options: DSCR pair (+ PPP), resolved to the company's CURRENT {id,name}
  // via the live registry when present, else the captured built-in ids.
  const smo = SMO_DSCR.map((d) => resolveSmo(d.name, smoReg, d));
  if (months != null) {
    const fb = SMO_PPP[months] || null;
    const pppName = (months % 12 === 0) ? `${months / 12} Yr PPP` : `${months} Months PPP`;
    smo.unshift(resolveSmo(fb ? fb.name : pppName, smoReg, fb));
  }
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

module.exports = { BASE, buildSearch, smoRegistryFromList, _internals: { SMO_DSCR, SMO_PPP, resolveSmo, mapPurpose, mapProp } };
