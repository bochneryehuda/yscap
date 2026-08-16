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
const registry = require('./field-registry');

// Symbol channel for registry validation warnings (invalid enum values). Symbol-keyed properties
// are skipped by JSON.stringify, so attaching this to the built payload never pollutes the body
// posted upstream; the route reads it to 422 an invalid value rather than silently ignoring it.
const REGISTRY_WARNINGS = Symbol.for('lp.registryWarnings');

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
// 0 = No PPP: a no-prepay scenario MUST resolve to "No PPP" / PrepayTerm "None" — sending
// "0 Yr PPP" / PrepayTerm 0 makes Lender Price reject the search with HTTP 400.
const SMO_PPP = {
  0: { id: '592868b74cedfd00015bdd64', name: 'No PPP' },
  12: { id: '592868b74cedfd00015bdd61', name: '1 Yr PPP' },
  24: { id: '592868b74cedfd00015bdd62', name: '2 Yr PPP' },
  36: { id: '592868b74cedfd00015bdd63', name: '3 Yr PPP' },
  48: { id: '583608ece4b075381a196a57', name: '4 Yr PPP' },
  60: { id: '58263ae7e4b0e7f399741293', name: '5 Yr PPP' },
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
  // Prefer the full registry enum (audit §17.1 — every upstream property.propertyType token).
  const r = registry.resolvePropertyType(t);
  if (r) return { propertyType: r.propertyType, nonWarrantableProject: !!r.nonWarrantableProject, attachmentType: r.attachmentType, units: r.units };
  // Fallback for legacy scenario spellings the registry map does not carry; default SingleFamily.
  switch (t) {
    case 'Condominium': return { propertyType: 'Condos', nonWarrantableProject: false, attachmentType: 'Attached', units: 1 };
    default: return { propertyType: 'SingleFamily', nonWarrantableProject: false, attachmentType: 'Detached', units: 1 };
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
  // Appraised (as-is) value is SEPARATE from the purchase price — do not always mirror it.
  if (num(sc.appraisedValue != null ? sc.appraisedValue : sc.asIsValue) != null) c.appraisedValue = num(sc.appraisedValue != null ? sc.appraisedValue : sc.asIsValue);
  if (loan != null) c.loanAmount = loan;
  if (ltv != null) c.ltv = ltv;
  if (num(sc.fico) != null) c.fico = num(sc.fico);
  if (num(sc.dscr) != null) c.dscr = num(sc.dscr);
  // Loan TERM (years) — honor it instead of silently sending the base's 30. loanYear +
  // termsCriteria must agree; termsInMonths=false means the number is years, NOT a day-lock.
  const termYears = num(sc.termYears != null ? sc.termYears : sc.term);
  if (termYears != null) { c.loanYear = termYears; m.termsCriteria = [termYears]; m.termsInMonths = false; }
  // Rate-LOCK days — honor it instead of the base's 30. Lives in brokerCriteria.dayLocks +
  // dayLocksCriteria; this is a LOCK period (days), NOT the loan term (years).
  const lockDays = num(sc.lockDays);
  if (lockDays != null) { const bc = m.brokerCriteria || (m.brokerCriteria = {}); bc.dayLocks = lockDays; m.dayLocksCriteria = [lockDays]; }
  c.loanPurpose = purpose;
  c.propertyUse = 'Investment';
  c.compensationType = 'BorrowerCompPlan';
  c.interestOnly = !!sc.io;
  c.escrowWaiver = !!sc.escrowWaive;
  c.firstTimeHomeBuyer = !!sc.fthb;
  c.nonWarrantableProject = pm.nonWarrantableProject;

  // Special mortgage options: DSCR pair (+ PPP), resolved to the company's CURRENT {id,name}
  // via the live registry when present, else the captured built-in ids. months===0 → "No PPP".
  const smo = SMO_DSCR.map((d) => resolveSmo(d.name, smoReg, d));
  if (months != null) {
    const fb = SMO_PPP[months] || null;
    const pppName = months === 0 ? 'No PPP'
      : (months % 12 === 0) ? `${months / 12} Yr PPP` : `${months} Months PPP`;
    smo.unshift(resolveSmo(fb ? fb.name : pppName, smoReg, fb));
  }
  c.specialMortgageOptions = smo;

  // Top-level criteria echoes the frontend keeps in sync.
  m.loanPurposeCriteria = [purpose];
  m.date = sc.date || null;
  if (Array.isArray(m.loanTypeCriteria) && !m.loanTypeCriteria.length) m.loanTypeCriteria = ['Fixed'];

  // Property. numberOfUnit MUST match the property type (the captured base is a 2–4 unit, so
  // its stale numberOfUnit would otherwise contradict a SingleFamily scenario and disqualify
  // every program). Always set it: the scenario's explicit unit count, else the type default.
  const prop = m.property || (m.property = { address: {} });
  prop.propertyType = pm.propertyType;
  prop.numberOfUnit = num(sc.units) != null ? num(sc.units) : pm.units;
  prop.attachmentType = pm.attachmentType;
  const a = prop.address || (prop.address = {});
  if (sc.zip != null) a.zip = String(sc.zip);
  if (sc.state != null) a.state = sc.state;
  if (sc.city != null) a.city = sc.city;
  if (sc.countyFps != null) { a.county = sc.countyFps; a.censustract = sc.countyFps; }
  if (sc.countyName != null) a.countyName = sc.countyName;
  else if (sc.county != null) a.countyName = sc.county;

  // Dynamic properties are {fieldId, value} objects — set values in place.
  const dp = m.dynamicPropertiesMap || (m.dynamicPropertiesMap = {});
  const setDyn = (k, v) => { if (dp[k]) dp[k].value = v; else dp[k] = { fieldId: k, value: v }; };
  setDyn('IncomeDocType', 'DSCR');
  setDyn('AddlOccupancyType', 'Long_Term_Rental_Property');
  setDyn('GLOBAL_BorrowerType', sc.borrowerType || 'LLC');
  // months===0 is an EXPLICIT "no prepay" (PrepayTerm "None"), NOT "unset" — sending 0/"0 Months"
  // is what triggered the live HTTP 400. A missing prepayMonths leaves it null.
  setDyn('PrepayTerm', months === 0 ? 'None' : (months ? `${months} Months` : null));
  setDyn('PrePayment_Plan_Type', months ? 'Standard' : null);
  m.dynaToSmo = true;

  // ALL OPTIONS — the default the web app always searches with (confirmed byte-for-byte from the
  // HAR): return EVERY rate and ALL of its points, never a targeted rate or price. We assert these
  // knobs explicitly (rather than trusting the base) so a live /pricing/defaultSearch that happens
  // to carry a saved target rate/price/favorite can never narrow a scenario's results.
  m.rate = null;                          // no single target rate
  m.rates = [];                           // no specific rate list
  m.maxListingPerRate = -1;               // unlimited listings (all points) per rate
  m.targetInterpolatedPrices = [];        // no target price
  m.skipAdjustments = false;              // include all pricing adjustments
  // Full rate range (no floor/ceiling), preserving the base's typed range shape when present.
  if (m.rateRange && typeof m.rateRange === 'object') { m.rateRange.from = null; m.rateRange.to = null; }
  else m.rateRange = { from: null, to: null };

  // Disqualify workflow (mirrors the web app): a normal search is ALSO the async KICKOFF — it
  // carries showDisqualify + disqualifyAsync so Lender Price starts computing the disqualify
  // reasons in the background. A later POLL re-sends the byte-identical body with ONLY
  // cachedDisqualified flipped to true, so its cache key matches the kickoff and the ready result
  // comes back quickly (the frontend does exactly this — kick off on search, poll on the
  // "ineligible" click). We set these flags EXPLICITLY (not inherited from the base) so the
  // kickoff and poll bodies can differ ONLY in cachedDisqualified.
  // The captured disqualify HAR (the real Quick Pricer flow) shows the EXACT handshake: the kickoff
  // (cachedDisqualified=false) returns an empty disqualify tree at ~0s and only STARTS the async
  // computation; ~16s later a POLL with ONLY cachedDisqualified flipped to true returns the fully
  // populated tree (a ~111 MB response). disqualifyAsync stays true and disqualifyFullResult stays
  // FALSE on BOTH the kickoff and the poll — the frontend never flips them — so the poll body
  // differs from the kickoff ONLY in cachedDisqualified and the cache slot (keyed on the scenario)
  // is unchanged. The large response is handled by a longer fetch timeout on the disqualify poll.
  m.showDisqualify = true;
  m.showDisqualifyRules = true;     // include the actual failing RULE text, not just a flag
  m.disqualifyAsync = true;
  m.disqualifyFullResult = false;
  m.fillLenderMap = true;
  m.cachedDisqualified = !!(opts.disqualify && opts.disqualify.cached); // false = kick off; true = poll

  // Registry-backed advanced fields (borrower criteria + adverse-credit dynamics). This runs AFTER
  // the core overlay so it only ADDS the extensions; invalid enum values are collected as warnings
  // (surfaced by the route as a 422 invalid_field_value — never applied, never silently ignored).
  const reg = registry.applyRegistry(m, sc);
  if (reg && reg.warnings && reg.warnings.length) m[REGISTRY_WARNINGS] = reg.warnings;

  return m;
}

module.exports = { BASE, buildSearch, smoRegistryFromList, REGISTRY_WARNINGS, _internals: { SMO_DSCR, SMO_PPP, resolveSmo, mapPurpose, mapProp } };
