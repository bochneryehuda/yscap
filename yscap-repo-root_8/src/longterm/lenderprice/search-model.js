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
// Numeric parse used to BUILD the payload. Tolerates currency formatting ($ , %) but — unlike the
// old `replace(/[^0-9.]/g,'')` — it PRESERVES the sign and REJECTS exponent/garbage instead of
// corrupting them (the §27.10 bug: "-1" became 1, "1e3" became 13). Returns a finite number or null.
function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^-?\d*\.?\d+$/.test(s)) return parseFloat(s);
  const cleaned = s.replace(/[$,%\s]/g, '');            // strip only currency formatting, never a sign
  if (/^-?\d*\.?\d+$/.test(cleaned)) return parseFloat(cleaned);
  return null;                                          // exponent notation, letters, multiple dots → not a number
}
// Strict numeric parse used for VALIDATION only: distinguishes ABSENT (null) from PRESENT-BUT-INVALID
// (undefined), so the validator can 422 a garbage value instead of silently treating it as absent.
function strictNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  const s = String(v).trim();
  if (/^-?\d*\.?\d+$/.test(s)) return parseFloat(s);
  const cleaned = s.replace(/[$,%\s]/g, '');
  if (/^-?\d*\.?\d+$/.test(cleaned)) return parseFloat(cleaned);
  return undefined;
}

// §26.4 — EXPLICIT loan-purpose alias table. The old exact-match version defaulted EVERYTHING it
// did not recognize to 'Refinance', so a lowercase `purchase`/`cashout` (or any typo) was silently
// re-priced as a rate-and-term refinance. There is NO default-to-refinance now: an unknown purpose is
// REJECTED (422 upstream, via LpValidationError) rather than mis-priced. The table is case-, space-
// and punctuation-tolerant (purposeKey strips to letters). Explicit contract the owner set:
//   Purchase                          → Purchase
//   Cash out (cash-out refinance)     → CashoutRefinance
//   Refinance (rate-and-term)         → Refinance
class LpValidationError extends Error {
  constructor(code, field, message) { super(message); this.name = 'LpValidationError'; this.lpValidation = true; this.code = code; this.field = field; }
}
const PURPOSE_ALIASES = {
  purchase: 'Purchase',
  // Cash-out refinance
  cashout: 'CashoutRefinance',
  cashoutrefinance: 'CashoutRefinance',
  cashoutrefi: 'CashoutRefinance',
  cashoutrefinancing: 'CashoutRefinance',
  // Rate-and-term refinance (the plain "refinance")
  refinance: 'Refinance',
  refi: 'Refinance',
  rateterm: 'Refinance',
  rateandterm: 'Refinance',
  ratetermrefinance: 'Refinance',
  rateandtermrefinance: 'Refinance',
  ratetermrefi: 'Refinance',
};
function purposeKey(p) { return String(p == null ? '' : p).toLowerCase().replace(/[^a-z]/g, ''); }
function mapPurpose(p) {
  const mapped = PURPOSE_ALIASES[purposeKey(p)];
  if (!mapped) {
    throw new LpValidationError('unknown_loan_purpose', 'purpose',
      `Unknown loan purpose ${JSON.stringify(p == null ? null : String(p))}. Supported: "Purchase", "Cash out" (cash-out refinance), "Refinance" (rate-and-term). The request is rejected rather than defaulted to a refinance.`);
  }
  return mapped;
}
const SFR_PROP = { propertyType: 'SingleFamily', nonWarrantableProject: false, attachmentType: 'Detached', units: 1 };
function mapProp(t) {
  // No property type on the scenario → default single-family (a DEFAULT, not a silent SUBSTITUTION
  // of a value the caller supplied).
  if (t == null || t === '') return { ...SFR_PROP };
  // Prefer the full registry enum (audit §17.1 — every upstream property.propertyType token).
  const r = registry.resolvePropertyType(t);
  if (r) return { propertyType: r.propertyType, nonWarrantableProject: !!r.nonWarrantableProject, attachmentType: r.attachmentType, units: r.units };
  if (t === 'Condominium') return { propertyType: 'Condos', nonWarrantableProject: false, attachmentType: 'Attached', units: 1 };
  // §27.5 — a property type we do not recognize is REJECTED (422), never silently priced as
  // single-family. Falling through to SingleFamily returned plausible pricing for a "Castle".
  throw new LpValidationError('unknown_property_type', 'propertyType',
    `Unknown property type ${JSON.stringify(String(t))}. The request is rejected rather than defaulted to single-family.`);
}

// §29.10/§31.3 — RENTAL TERM. The dynamic AddlOccupancyType selects long- vs short-term rental. The
// DSCR profile default is LONG-term (audit §29.1), so an OMITTED rentalTerm forces long-term exactly
// as before; an EXPLICIT rentalTerm overrides it. BOTH upstream tokens are confirmed from live
// captures — Long_Term_Rental_Property (§30.6) and Short_Term_Rental_Property (§31.3) — so this is not
// a guessed mapping. An unrecognized value is REJECTED (422 via LpValidationError), never priced as
// long-term. The alias key strips to letters (case/space/underscore tolerant).
const RENTAL_TERM_ALIASES = {
  long: 'Long_Term_Rental_Property',
  longterm: 'Long_Term_Rental_Property',
  longtermrental: 'Long_Term_Rental_Property',
  longtermrentalproperty: 'Long_Term_Rental_Property',
  short: 'Short_Term_Rental_Property',
  shortterm: 'Short_Term_Rental_Property',
  shorttermrental: 'Short_Term_Rental_Property',
  shorttermrentalproperty: 'Short_Term_Rental_Property',
};
function rentalKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, ''); }
function mapRentalTerm(v) {
  const k = rentalKey(v);
  if (k === '') return 'Long_Term_Rental_Property';       // omitted → DSCR profile default (long-term)
  const t = RENTAL_TERM_ALIASES[k];
  if (!t) {
    throw new LpValidationError('unknown_rental_term', 'rentalTerm',
      `Unknown rental term ${JSON.stringify(String(v))}. Supported: "long" (long-term rental) or "short" (short-term rental).`);
  }
  return t;
}

// ---- §31.6/§31.8 SCENARIO-OWNERSHIP CLEARING LAYER --------------------------
// A live /pricing/defaultSearch foundation is a SNAPSHOT of the pricing model as some earlier
// session last left it. Cloning it (buildSearch, below) inherits every default — which is CORRECT
// for STRUCTURAL defaults (closing-cost tables, the {fieldId,value} scaffolding, the filter shape,
// the flag inherits documented at "OMITTED flag inherits the cloned default") but WRONG for
// SCENARIO-OWNED fields: a prior session's second-lien amount, rehab budget, comp override, or core
// economics ride along and silently price the NEW scenario as if it carried them. buildSearch
// overlays the fields it knows about, but a scenario-owned field it NEVER writes back
// (subordinateLoanAmount) or writes only WHEN THE CALLER SUPPLIES IT (loanAmount, fico, dscr) leaks
// the stale value on omission.
//
// The audit's algorithm (§31.6): after cloning, CLEAR every scenario-owned field to a documented
// neutral state, BEFORE the DSCR profile + caller overlay — so an omitted field FAILS CLOSED to
// neutral instead of leaking, and a supplied one is re-applied on top exactly as before. This is a
// TARGETED clear driven by a REGISTRY, never a broad deletion: a field OUTSIDE the registry inherits
// unchanged (property type, prepay-when-omitted, the io/escrow/fthb flags, and every structural
// default). Each entry documents WHY the field is scenario-owned and its neutral value. Two neutral
// shapes, both safe:
//   • per-deal AMOUNTS + the comp override → the captured base's OWN default (0 / absent / false), so
//     clearing only ever REMOVES a stale value the engine already accepts, never introduces a new one;
//   • core ECONOMICS (purchasePrice/loanAmount/ltv/fico/dscr) → null, which is NOT the base default —
//     it FAILS CLOSED on omission. buildSearch re-applies each from the caller, so clearing changes
//     behavior only when the caller omits the field, and a null removes the value rather than leaking
//     the foundation's; a null can never over-lend.
// Adding a field is one registry line, so the clearing stays intentional and testable — never
// re-derived per call site.
const DELETE = Symbol('scenario-owned-delete');
const SCENARIO_OWNED = [
  // Core deal economics — buildSearch RE-APPLIES each from the caller below, so clearing changes
  // behavior ONLY on OMISSION: the field then fails closed to neutral instead of inheriting the
  // foundation's value. (appraisedValue + loanYear are ALWAYS forced by buildSearch, so they cannot
  // leak and are deliberately NOT listed here.)
  { path: 'criteria.purchasePrice', neutral: null, why: 'per-deal purchase/estimated price' },
  { path: 'criteria.loanAmount',    neutral: null, why: 'per-deal loan amount' },
  { path: 'criteria.ltv',           neutral: null, why: 'per-deal LTV (buildSearch falls back to criteria.ltv when value/loan/ltv are all absent)' },
  { path: 'criteria.fico',          neutral: null, why: 'per-borrower credit score' },
  { path: 'criteria.dscr',          neutral: null, why: 'per-deal DSCR ratio' },
  // Per-deal amounts buildSearch NEVER writes back — the audit's leak class. Neutral is the captured
  // base default (0), so a stale non-zero from a prior session is reset and no value the engine has
  // not already accepted is ever introduced. A real value would only reach these through a wired
  // caller field (none today), so on every current DSCR scenario they are correctly 0.
  // FOOTGUN: unlike cashoutAmount (re-applied in buildSearch when supplied), these have NO re-apply
  // path — so if you ever add a caller field for one, you MUST add its re-apply AFTER this clear runs,
  // or the caller's value will be silently zeroed.
  { path: 'criteria.subordinateLoanAmount', neutral: 0, why: 'second-lien amount — audit §31.6 leak example' },
  { path: 'criteria.lineAmount',            neutral: 0, why: 'line-of-credit amount' },
  { path: 'criteria.rehabBudget',           neutral: 0, why: 'rehab budget' },
  { path: 'criteria.drawAmount',            neutral: 0, why: 'construction draw amount' },
  { path: 'criteria.downPaymentAmount',     neutral: 0, why: 'down-payment amount' },
  // Cash-out "cash in hand": buildSearch adds it ONLY on a cash-out that supplies it, so its neutral
  // is ABSENT (delete the key), never a null — a non-cash-out scenario must carry no cashoutAmount at
  // all, and a stale one inherited from the foundation is removed.
  { path: 'criteria.cashoutAmount', neutral: DELETE, why: 'cash-out amount; absent unless the caller supplies it' },
  // Broker COMP-PLAN override — the audit's compPlan leak. Neutral is the base default false ("do not
  // override; the standard comp plan governs"), which neutralizes any per-session comp override
  // (rangeComplan only applies while this flag is true, so clearing the flag is sufficient and no
  // comp value we cannot document is touched).
  { path: 'brokerCriteria.overrideExistingComplan', neutral: false, why: 'per-session comp override — audit §31.6 compPlan example' },
];
// Clear every registered scenario-owned field to its neutral state, IN PLACE. Operates on the
// already-cloned model (buildSearch clones first), so it never mutates the shared BASE or a caller's
// base object. A DELETE neutral removes the key (and skips a path whose parent is absent — there is
// nothing to clear); every other neutral is written, creating a missing parent object only when the
// neutral is a real value to set.
function clearScenarioOwnedFields(search) {
  for (const e of SCENARIO_OWNED) {
    const parts = e.path.split('.');
    let o = search;
    let reachable = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (o[k] == null || typeof o[k] !== 'object') {
        if (e.neutral === DELETE) { reachable = false; break; } // nothing to delete
        o[k] = {};
      }
      o = o[k];
    }
    if (!reachable) continue;
    const leaf = parts[parts.length - 1];
    if (e.neutral === DELETE) delete o[leaf];
    else o[leaf] = e.neutral;
  }
  return search;
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
  // §31.6 — clear scenario-owned fields to neutral BEFORE the DSCR profile + caller overlay, so a
  // stale value inherited from a live foundation can never leak into this scenario. Runs on the
  // clone, immediately after it, so every read below (e.g. the criteria.ltv fallback) sees neutral.
  clearScenarioOwnedFields(m);
  const smoReg = opts.smo || null;
  const value = num(sc.value);
  const loan = num(sc.loan);
  const ltv = (value && loan) ? Math.round((loan / value) * 1e6) / 1e6
    : (num(sc.ltv) != null ? (num(sc.ltv) > 1 ? num(sc.ltv) / 100 : num(sc.ltv)) : (m.criteria ? m.criteria.ltv : null));
  const purpose = mapPurpose(sc.purpose);
  const pm = mapProp(sc.propertyType);
  // Attachment type is INDEPENDENT of property type (audit §6): the live frontend can send e.g.
  // Condo + Detached. An explicit `attachment` overrides the type's default attachment; an explicit
  // `nonWarrantable` overrides the type's warrantability. Unit count stays independent (set below).
  if (sc.attachment != null && sc.attachment !== '') pm.attachmentType = sc.attachment;
  if (sc.nonWarrantable !== undefined) pm.nonWarrantableProject = !!sc.nonWarrantable;
  const months = num(sc.prepayMonths);

  const c = m.criteria || (m.criteria = {});
  if (value != null) c.purchasePrice = value;
  // Appraised (as-is) value is SEPARATE from the estimated/purchase price (audit §3). We do NOT
  // manufacture it from the estimated value. On a PURCHASE the appraisal comes in at contract price
  // and the frontend mirrors it, so appraised = value. On a REFINANCE / CASH-OUT the frontend leaves
  // it BLANK unless the user supplies an appraisal (asIsValue / appraisedValue); manufacturing the
  // estimated value into it was the "$600k appraised the user never entered" bug. An explicit value
  // always wins.
  const apprSupplied = num(sc.appraisedValue != null ? sc.appraisedValue : sc.asIsValue);
  if (apprSupplied != null) c.appraisedValue = apprSupplied;
  else if (purpose === 'Purchase' && value != null) c.appraisedValue = value;
  else c.appraisedValue = null; // refi/cash-out with no appraisal → blank, matching the frontend
  if (loan != null) c.loanAmount = loan;
  if (ltv != null) c.ltv = ltv;
  if (num(sc.fico) != null) c.fico = num(sc.fico);
  if (num(sc.dscr) != null) c.dscr = num(sc.dscr);
  // Loan TERM (years). The intentional DSCR profile default is 30-year FIXED (audit §1): when the
  // scenario omits the term we FORCE 30 rather than inherit whatever a live default model carried
  // (the "some DSCR defaults are not enforced" finding). loanYear + termsCriteria must agree;
  // termsInMonths=false means the number is years, NOT a day-lock.
  const termYears = num(sc.termYears != null ? sc.termYears : sc.term);
  const effTermYears = termYears != null ? termYears : 30;
  c.loanYear = effTermYears; m.termsCriteria = [effTermYears]; m.termsInMonths = false;
  // Rate-LOCK days. The intentional DSCR profile default is a 30-day lock; forced when omitted so a
  // live default carrying a different lock can never change the profile. This is a LOCK period
  // (days), NOT the loan term (years).
  const lockDays = num(sc.lockDays);
  const effLockDays = lockDays != null ? lockDays : 30;
  { const bc = m.brokerCriteria || (m.brokerCriteria = {}); bc.dayLocks = effLockDays; m.dayLocksCriteria = [effLockDays]; }
  c.loanPurpose = purpose;
  // DSCR product profile — INTENTIONAL (investment occupancy, DSCR income doc, borrower-comp) and
  // asserted explicitly so a live base carrying a different saved default never changes the product.
  c.propertyUse = 'Investment';
  c.compensationType = 'BorrowerCompPlan';
  // §28.5 — an OMITTED flag inherits the cloned (live) default; only an EXPLICITLY supplied value
  // overwrites it. Previously `!!sc.io` wrote `false` even when io was absent, silently clobbering
  // the live default. A provided value is already a real boolean (strict validation), so 0/false is
  // preserved and a string can never sneak through.
  if (sc.io !== undefined) c.interestOnly = !!sc.io;
  if (sc.escrowWaive !== undefined) c.escrowWaiver = !!sc.escrowWaive;
  if (sc.fthb !== undefined) c.firstTimeHomeBuyer = !!sc.fthb;
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
  setDyn('AddlOccupancyType', mapRentalTerm(sc.rentalTerm));
  setDyn('GLOBAL_BorrowerType', sc.borrowerType || 'LLC');
  // Reserves — the intentional DSCR profile default is 24 MONTHS (audit §1). Forced (the
  // GLOBAL_RESERVES token is confirmed from the captured base) so a live default carrying blank or
  // different reserves cannot silently override the profile. Env-overridable per company.
  setDyn('GLOBAL_RESERVES', process.env.LP_RESERVES_TOKEN || 'Reserves_24');
  // Prepay term / structure. An OMITTED prepay INHERITS the live default (audit §2 — the backend used
  // to CLEAR PrepayTerm/PrePayment_Plan_Type to null on omission, changing the model the user left
  // alone). months===0 is an EXPLICIT "no prepay" (PrepayTerm "None"); a positive months sets the
  // term. Only write these when the caller actually supplied a prepay.
  if (months != null) {
    setDyn('PrepayTerm', months === 0 ? 'None' : `${months} Months`);
    setDyn('PrePayment_Plan_Type', months === 0 ? null : 'Standard');
  }
  // Cash-out amount ("cash in hand"). THE VENDOR FIXED THE FIELD: as of the post-repair capture
  // (2026-08-16) the live frontend now sends a NUMERIC `criteria.cashoutAmount` (its request was
  // `{criteria:{loanPurpose:'CashoutRefinance', cashoutAmount:50000}}`, HTTP 200). So we transmit it
  // as a real criteria field — the previous "store but do not transmit / wait for a dynamic-property
  // code" behavior is now OUTDATED and retired. LP_CASHOUT_AMOUNT_FIELD remains only as an optional
  // override in case the vendor ever moves it back to a dynamic property.
  const cashoutAmt = num(sc.cashoutAmount);
  if (cashoutAmt != null) {
    c.cashoutAmount = cashoutAmt;
    const cashoutField = process.env.LP_CASHOUT_AMOUNT_FIELD;
    if (cashoutField) setDyn(cashoutField, cashoutAmt); // optional legacy dynamic-property override
  }
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

// ---- §26.3 location completeness ------------------------------------------
// Upstream searchRaw returns a raw HTTP 500 (not a helpful validation error) when a location carries
// a ZIP/state but no county FIPS code — the frontend always enriches a ZIP into
// state/city/countyName/countyFps before pricing. So we DETERMINISTICALLY reject an incomplete or
// conflicting location with 422 BEFORE any upstream call, instead of letting it 500. STATE_FIPS lets
// us also catch a countyFps whose 2-digit state prefix contradicts the stated state.
const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
  PR: '72', VI: '78', GU: '66', AS: '60', MP: '69',
};
// Returns { ok:true } when the location is absent or complete, else { ok:false, code, field, message }.
function validateLocation(sc = {}) {
  const hasLoc = sc.zip != null || sc.state != null || sc.city != null || sc.county != null || sc.countyName != null || sc.countyFps != null;
  if (!hasLoc) return { ok: true }; // no location fields — nothing to validate (base defaults apply)
  const state = sc.state != null && String(sc.state).trim() !== '' ? String(sc.state).trim().toUpperCase() : null;
  const fps = sc.countyFps != null && String(sc.countyFps).trim() !== '' ? String(sc.countyFps).trim() : null;
  if (state && !STATE_FIPS[state]) {
    return { ok: false, code: 'invalid_state', field: 'state',
      message: `Unrecognized state code ${JSON.stringify(sc.state)}. Use a 2-letter US state/territory code (e.g. NJ, NY, CA).` };
  }
  if (!fps) {
    return { ok: false, code: 'missing_county_fips', field: 'countyFps',
      message: 'This location has a ZIP/state but no county FIPS code. Lender Price needs the 5-digit county FIPS (frontend enriches ZIP → state/city/countyName/countyFps); supply countyFps so the search is not rejected upstream.' };
  }
  if (!/^\d{5}$/.test(fps)) {
    return { ok: false, code: 'invalid_county_fips', field: 'countyFps',
      message: `County FIPS must be a 5-digit code; got ${JSON.stringify(sc.countyFps)}.` };
  }
  if (state && fps.slice(0, 2) !== STATE_FIPS[state]) {
    return { ok: false, code: 'location_conflict', field: 'countyFps',
      message: `County FIPS ${fps} (state prefix ${fps.slice(0, 2)}) does not belong to state ${state} (prefix ${STATE_FIPS[state]}). Fix the conflicting location.` };
  }
  return { ok: true };
}

// ---- §27 strict input validation (reject silent substitutions) --------------
// Every one of these was a live HTTP-200-with-a-wrong-answer defect: a string "false" turned a
// flag ON, a sign-stripped "-1" DSCR became +1, an unknown property type priced as single-family,
// a conflicting LTV was silently replaced, and an unsupported term/lock was accepted. We reject
// them (422) BEFORE any upstream call rather than mis-price.
// Boolean scenario fields that must be a real JSON boolean (never a truthy string).
const BOOLEAN_FIELDS = ['io', 'escrowWaive', 'fthb', 'selfEmployed', 'rural', 'mixedUse', 'waiveLenderFee', 'noMortgageHistory', 'nonWarrantable', 'crossCollateral', 'firstTimeInvestor', 'livingRentFree'];
// Attachment types the frontend exposes independently of property type (audit §6).
// Attachment types the frontend exposes independently of property type (audit §6). SemiDetached is the
// confirmed live upstream token (§31.3) — added so the validator stops rejecting a legitimate choice.
const ATTACHMENT_TYPES = ['Detached', 'Attached', 'SemiDetached'];
// Allowed rate-lock days — the LIVE frontend capability list (audit §7), env-overridable per company.
// The captured base's dayLocksList ([14,15,21,30,45,60,90]) was STALE: it rejected legitimate visible
// locks (10/12/25/40/75/120/180) and accepted a 14-day lock the frontend never offers. This is the
// current live set; ideally derived from live company config (a follow-up), captured verbatim for now.
const LIVE_LOCKS = [10, 12, 15, 21, 25, 30, 40, 45, 60, 75, 90, 120, 180];
const ALLOWED_LOCKS = (process.env.LP_ALLOWED_LOCKS
  ? process.env.LP_ALLOWED_LOCKS.split(',').map((x) => Number(x.trim())).filter((n) => isFinite(n))
  : LIVE_LOCKS);
// Allowed loan terms (years) — the LIVE frontend list (audit §7): 5, then 8 through 30, then 40.
// env-overridable (LP_ALLOWED_TERMS). The old [5,10,15,20,25,30,40] rejected valid 8/9/11..29-year
// visible choices.
const LIVE_TERMS = [5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 40];
const ALLOWED_TERMS = (process.env.LP_ALLOWED_TERMS
  ? process.env.LP_ALLOWED_TERMS.split(',').map((x) => Number(x.trim())).filter((n) => isFinite(n))
  : LIVE_TERMS);

function validateInputs(sc = {}) {
  const bad = (code, field, message) => ({ ok: false, code, field, message });
  // Strict booleans — a JSON string "false" is TRUTHY and used to flip the flag on.
  for (const f of BOOLEAN_FIELDS) {
    if (sc[f] != null && typeof sc[f] !== 'boolean') {
      return bad('non_boolean_value', f, `Field "${f}" must be a JSON boolean (true/false); got ${JSON.stringify(sc[f])}. A string is rejected rather than coerced.`);
    }
  }
  // Strict numerics + ranges. Returns { v } (value or null) or { err }.
  const numField = (field, opts = {}) => {
    if (sc[field] == null || sc[field] === '') return { v: null };
    const v = strictNum(sc[field]);
    if (v === undefined) return { err: bad('invalid_number', field, `Field "${field}" must be a plain number; got ${JSON.stringify(sc[field])}.`) };
    if (opts.integer && !Number.isInteger(v)) return { err: bad('invalid_number', field, `Field "${field}" must be a whole number; got ${v}.`) };
    if (opts.min != null && v < opts.min) return { err: bad('out_of_range', field, `Field "${field}" must be at least ${opts.min}; got ${v}.`) };
    if (opts.max != null && v > opts.max) return { err: bad('out_of_range', field, `Field "${field}" must be at most ${opts.max}; got ${v}.`) };
    return { v };
  };
  const value = numField('value', { min: 1 }); if (value.err) return value.err;
  const appr = numField('appraisedValue', { min: 1 }); if (appr.err) return appr.err;
  const asIs = numField('asIsValue', { min: 1 }); if (asIs.err) return asIs.err;
  const loan = numField('loan', { min: 1 }); if (loan.err) return loan.err;
  const fico = numField('fico', { min: 300, max: 850, integer: true }); if (fico.err) return fico.err;
  const dscr = numField('dscr', { min: 0, max: 2 }); if (dscr.err) return dscr.err;
  const units = numField('units', { min: 1, max: 20, integer: true }); if (units.err) return units.err;
  const cashout = numField('cashoutAmount', { min: 0 }); if (cashout.err) return cashout.err; // "cash in hand"; stored, transmitted only when the vendor field is configured
  // Term / lock against the allowed capability sets (a 17-year term / 22-day lock does not exist).
  const t1 = numField('termYears', {}); if (t1.err) return t1.err;
  const t2 = numField('term', {}); if (t2.err) return t2.err;
  const termVal = t1.v != null ? t1.v : t2.v;
  if (termVal != null && !ALLOWED_TERMS.includes(termVal)) {
    return bad('unsupported_term', 'termYears', `Loan term ${termVal} years is not offered. Supported: ${ALLOWED_TERMS.join(', ')}.`);
  }
  const lock = numField('lockDays', {}); if (lock.err) return lock.err;
  if (lock.v != null && !ALLOWED_LOCKS.includes(lock.v)) {
    return bad('unsupported_lock', 'lockDays', `Rate-lock ${lock.v} days is not offered. Supported: ${ALLOWED_LOCKS.join(', ')}.`);
  }
  // Attachment must be one of the frontend's independent options when supplied (audit §6).
  if (sc.attachment != null && sc.attachment !== '' && !ATTACHMENT_TYPES.includes(sc.attachment)) {
    return bad('invalid_attachment', 'attachment', `Attachment must be one of: ${ATTACHMENT_TYPES.join(', ')}; got ${JSON.stringify(sc.attachment)}.`);
  }
  // LTV: loan must not exceed value (LTV > 100%), and a SUPPLIED ltv must not contradict loan/value.
  const ltvRaw = numField('ltv', { min: 0 }); if (ltvRaw.err) return ltvRaw.err;
  // A SUPPLIED ltv is range-checked on its OWN (audit — isolated LTV), whether or not value+loan were
  // both given: an ltv normalizing above 100% is invalid by itself and used to slip through when
  // value/loan were absent. Accept 75 or 0.75; ceiling env-overridable (LP_MAX_LTV, default 100%).
  if (ltvRaw.v != null) {
    const normLtv = ltvRaw.v > 1 ? ltvRaw.v / 100 : ltvRaw.v;
    const maxLtv = Number(process.env.LP_MAX_LTV || 1);
    if (normLtv > maxLtv) {
      return bad('ltv_out_of_range', 'ltv', `LTV ${(normLtv * 100).toFixed(2)}% exceeds the maximum ${(maxLtv * 100).toFixed(0)}%.`);
    }
  }
  if (value.v != null && loan.v != null) {
    if (loan.v > value.v) return bad('loan_exceeds_value', 'loan', `Loan amount (${loan.v}) exceeds property value (${value.v}) — LTV over 100%.`);
    if (ltvRaw.v != null) {
      const calc = loan.v / value.v;
      const supplied = ltvRaw.v > 1 ? ltvRaw.v / 100 : ltvRaw.v; // accept 75 or 0.75
      if (Math.abs(calc - supplied) > 0.01) {
        return bad('ltv_conflict', 'ltv', `Supplied LTV (${supplied}) conflicts with loan ÷ value (${calc.toFixed(4)}). Omit ltv or make it agree.`);
      }
    }
  }
  // Units must agree with the property type (a single-family "4-unit" is a contradiction).
  if (units.v != null && sc.propertyType != null && sc.propertyType !== '') {
    const pt = registry.resolvePropertyType(sc.propertyType);
    const canon = pt ? pt.propertyType : (sc.propertyType === 'Condominium' ? 'Condos' : null);
    if (canon === 'SingleFamily' && units.v !== 1) return bad('units_conflict', 'units', `A single-family property has 1 unit; got ${units.v}.`);
    if (canon === 'UnitDwelling_2_4' && (units.v < 2 || units.v > 4)) return bad('units_conflict', 'units', `A 2–4 unit property has 2–4 units; got ${units.v}.`);
    if (canon === 'MultiFamily' && units.v < 5) return bad('units_conflict', 'units', `A multifamily property has 5 or more units; got ${units.v}.`);
  }
  return { ok: true };
}

// ---- §26.5 build + validate LOCALLY (zero upstream requests) ----------------
// Build the payload from the STATIC base and run every DETERMINISTIC check that can reject a request,
// so a 422 is returned BEFORE any searchRaw call: §26.3 location completeness, §26.4 unknown loan
// purpose, and invalid registry enum VALUES (a supported field carrying a value the engine drops).
// The scenario alone drives all three, so validating against the static base is exact (a live
// foundation cannot change any of these verdicts). Returns { ok:true, request } or
// { ok:false, status:422, error, field?, warnings?, message }.
function validateScenario(sc = {}) {
  const loc = validateLocation(sc);
  if (!loc.ok) return { ok: false, status: 422, error: loc.code, field: loc.field, message: loc.message };
  const inp = validateInputs(sc); // §27 — strict booleans/numerics/ranges/ltv/term/lock/units
  if (!inp.ok) return { ok: false, status: 422, error: inp.code, field: inp.field, message: inp.message };
  let request;
  try {
    request = buildSearch(sc); // static base — no live foundation needed to validate the scenario
  } catch (e) {
    if (e && e.lpValidation) return { ok: false, status: 422, error: e.code, field: e.field, message: e.message };
    throw e;
  }
  const w = request[REGISTRY_WARNINGS];
  if (Array.isArray(w) && w.length) {
    return { ok: false, status: 422, error: 'invalid_field_value', warnings: w,
      message: `One or more fields carried a value the pricing engine does not recognize; the value would be silently dropped, so the request is rejected rather than mis-priced: ${w.map((x) => x.field).join(', ')}.` };
  }
  return { ok: true, request };
}

module.exports = { BASE, buildSearch, clearScenarioOwnedFields, smoRegistryFromList, REGISTRY_WARNINGS, validateScenario, validateLocation, validateInputs, LpValidationError,
  _internals: { SMO_DSCR, SMO_PPP, resolveSmo, mapPurpose, mapProp, mapRentalTerm, RENTAL_TERM_ALIASES, PURPOSE_ALIASES, purposeKey, STATE_FIPS, strictNum, ALLOWED_LOCKS, ALLOWED_TERMS, LIVE_LOCKS, LIVE_TERMS, ATTACHMENT_TYPES, BOOLEAN_FIELDS, SCENARIO_OWNED, clearScenarioOwnedFields, SCENARIO_OWNED_DELETE: DELETE } };
