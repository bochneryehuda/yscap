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
const zipCounty = require('./zip-county');
// §33.2/§33.3 — confirmed-token resolvers for the two menu fields the builder used to hard-code
// (IncomeDocType was always "DSCR", PrePayment_Plan_Type always "Standard"). Bound locally so the
// builder reads the same way as the other mapX helpers in this file.
const { mapIncomeDocType, mapPrepayStructure, PREPAY_STRUCTURE_NULL } = registry;

// Symbol channel for registry validation warnings (invalid enum values). Symbol-keyed properties
// are skipped by JSON.stringify, so attaching this to the built payload never pollutes the body
// posted upstream; the route reads it to 422 an invalid value rather than silently ignoring it.
const REGISTRY_WARNINGS = Symbol.for('lp.registryWarnings');
// §32.2 — internal retention channel for the cash-out amount. Symbol-keyed (skipped by
// JSON.stringify) so the value is retained on the built payload for diagnostics/storage but is NEVER
// transmitted upstream. The live cash-out capture carried no legitimate vendor field, so we must not
// invent or transmit one; the route surfaces this in effectiveScenario as an internal-only value.
const CASHOUT_INTERNAL = Symbol.for('lp.cashoutInternal');

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

// The DSCR profile's prepay default (§35.3/§36.6): five-year Standard. Module-scope because BOTH the
// special-mortgage-option list and the dynamic PrepayTerm/PrePayment_Plan_Type pair must agree about
// which term is in force — resolving it in two places is how a request comes to carry a 5 Yr PPP
// option beside a 36-month term.
const DEFAULT_PREPAY_MONTHS = 60;

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
// §35.2/§36.2 — THE AMOUNT TRIANGLE. `value` (the purpose-appropriate property value), `loan` (first
// lien) and `ltv` are three views of two facts: any TWO determine the third. The owner quotes deals
// in the short form "$400,000 loan at 75% LTV", so the server must derive the value rather than
// demand it. PURE + total: it derives what it can and reports what it did; it never throws and never
// invents a number from ONE input (that would be a guess, and `known < 2` is refused upstream by
// validateInputs). LTV is accepted as either 75 or 0.75 and always normalized to the 0.75 decimal
// form the vendor expects. Money is rounded to cents and LTV to 6dp so a derived figure is stable.
function deriveAmounts(sc) {
  sc = sc || {}; // a `= {}` default only catches undefined; this module promises never to throw
  const money = (n) => Math.round(n * 100) / 100;
  const ratio = (n) => Math.round(n * 1e6) / 1e6;
  let value = num(sc.value);
  let loan = num(sc.loan);
  const ltvRaw = num(sc.ltv);
  // Accept a percentage (75) or a decimal (0.75). A value at or below 1 is already a decimal.
  // A SUPPLIED ltv is rounded to the same 6dp a DERIVED one gets, so 33.333333 cannot transmit as
  // 0.33333333000000004 — the wire form must not depend on which way the figure arrived.
  let ltv = ltvRaw != null ? ratio(ltvRaw > 1 ? ltvRaw / 100 : ltvRaw) : null;
  const supplied = { value: value != null, loan: loan != null, ltv: ltv != null };
  const derived = [];
  // A zero value or a zero LTV cannot participate in a derivation (division by zero / a meaningless
  // ratio), so only positive figures derive. The range checks live in validateInputs.
  if (value != null && loan != null) {
    // Both amounts present: the LTV they imply is authoritative (a conflicting supplied ltv is
    // rejected by validateInputs, so we never silently overwrite a caller's disagreeing figure).
    if (value > 0) { const calc = ratio(loan / value); if (ltv == null) derived.push('ltv'); ltv = calc; }
  } else if (loan != null && ltv != null && ltv > 0) {
    value = money(loan / ltv); derived.push('value');
  } else if (value != null && ltv != null && value > 0) {
    loan = money(value * ltv); derived.push('loan');
  }
  // A DERIVED figure that lands at or below zero is not an answer — it is the arithmetic telling us
  // the inputs cannot describe a loan (a $4 property at a 0.1% LTV rounds to a $0 loan). Drop it so
  // `known` cannot count it, which turns the scenario into the honest "not enough to price" refusal
  // instead of putting a $0 loan on the wire. Same reasoning as `usable` below, applied to the
  // OUTCOME rather than the input.
  for (const k of derived.slice()) {
    const v = k === 'value' ? value : k === 'loan' ? loan : ltv;
    if (!(v > 0)) {
      if (k === 'value') value = null; else if (k === 'loan') loan = null; else ltv = null;
      derived.splice(derived.indexOf(k), 1);
    }
  }
  // `known` counts only figures that can actually PARTICIPATE in the triangle — a zero or negative
  // value/loan/ltv is not a usable amount. Counting a bare `!= null` let `ltv: 0` masquerade as one
  // of the two required figures while deriving nothing, so a null purchase price reached upstream.
  // validateInputs also floors the LTV, but this belongs here too: deriveAmounts is exported and
  // read by the route's derivedScenario echo, which must never report a usable triangle it does not
  // have. NaN/Infinity are already excluded by num().
  const usable = (x) => x != null && x > 0;
  const known = [value, loan, ltv].filter(usable).length;
  return { value, loan, ltv, supplied, derived, known };
}

// §31.5 — the broker comp-percent SIGN INVERSION, isolated in one named conversion. The live capture
// is unambiguous: a visible Comp Percent of 2.5 leaves the frontend as `brokerCriteria.compPlan:
// -2.5` (a JSON number). Our public input is the number a human reads off the screen (positive), so
// this is the ONLY place the sign flips. Kept as a function rather than an inline negation so the
// rule is greppable and testable, and so a future capture that changes the convention has one edit
// site. -0 is normalized to 0 (JSON.stringify would otherwise emit "-0" for a 0% comp).
function compPlanValue(pct) { return pct === 0 ? 0 : -pct; }

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

// ---- §32.3 DSCR THRESHOLD TABLE -------------------------------------------
// The entered DSCR ratio (criteria.dscr, always the verbatim numeric value) ALSO drives a coarse
// `DSCRRATIO` dynamic token AND — above 0.75 — one additional pricing-band special mortgage option,
// on top of the always-present "Debt Service Coverage Ratio" + "DSCR" pair. The buckets are
// NON-OBVIOUS and CANNOT be derived by formatting the number (0.50 → "0.75", 0.80 → "DSCR<1"), so
// this is a REVIEWED RANGE TABLE from the confirmed §32.3 live capture, never a string built from the
// input. Every token below is captured, not guessed. Discontinuities at 0, 0.75, 1.00, 1.25:
//   dscr = 0            → DSCRRATIO "NoDSCR",  no band SMO
//   0   < dscr < 0.75   → DSCRRATIO "0.75",    no band SMO
//   0.75 ≤ dscr < 1.00  → DSCRRATIO "DSCR<1",  band SMO "DSCR <1.15"
//   1.00 ≤ dscr < 1.25  → DSCRRATIO "DSCR>=1", band SMO "DSCR >=1.00"
//   dscr ≥ 1.25         → DSCRRATIO "1.25",    band SMO "DSCR >=1.25 - J"
// Returns { ratio, smo } — ratio = the DSCRRATIO dynamic value; smo = the derived band SMO name (null
// when the band adds none). Caller passes a num()-parsed dscr (validated to [0, 2] upstream); null in
// → null out (no DSCRRATIO written, matching an omitted DSCR).
function dscrBand(dscr) {
  // Absent OR non-finite → no band (defense-in-depth). The sole production caller passes a
  // num()-parsed value (finite-or-null) and the route 422s garbage before buildSearch, but dscrBand
  // is exported in _internals; without this guard a NaN would skip every < comparison and fall
  // through to the top "1.25" band — a mis-price. Fail closed to "no band" instead.
  if (dscr == null || !isFinite(dscr)) return null;
  if (dscr <= 0)   return { ratio: 'NoDSCR',  smo: null };
  if (dscr < 0.75) return { ratio: '0.75',    smo: null };
  if (dscr < 1.00) return { ratio: 'DSCR<1',  smo: 'DSCR <1.15' };
  if (dscr < 1.25) return { ratio: 'DSCR>=1', smo: 'DSCR >=1.00' };
  return             { ratio: '1.25',    smo: 'DSCR >=1.25 - J' };
}

// ---- §32.4 RESERVES SELECTOR TABLE ----------------------------------------
// GLOBAL_RESERVES dynamic token. The DSCR profile FORCES a default (Reserves_24, env-overridable via
// LP_RESERVES_TOKEN) when the caller omits reserves — the audit's rule "explicitly override the
// inherited live default to Reserves_24". A caller MAY instead choose a specific reserves requirement
// via `reservesMonths`, mapped to the CONFIRMED live enum below — NEVER a token built by formatting
// the number. The singular/plural prefixes are GENUINELY INCONSISTENT in the live app (`Reserve_6`
// but `Reserves_3/12/18/24`, and `Reserve_none`); they are copied EXACTLY — do NOT "fix" Reserve_6 to
// Reserves_6. `none` (or 0) → the explicit "None" state `Reserve_none`, which the capture stresses is
// DISTINCT from blank/inherit (JSON null). We do NOT expose blank/inherit: the DSCR profile always
// emits a reserves value, so a caller either takes the forced default or an explicit enum value.
// An unrecognized value is REJECTED (422 via LpValidationError), never priced at a guessed token.
const RESERVES_TOKENS = {
  none: 'Reserve_none',
  '0':  'Reserve_none',
  '3':  'Reserves_3',
  '6':  'Reserve_6',     // SINGULAR — confirmed live inconsistency (§32.4). Copy exactly.
  '12': 'Reserves_12',
  '18': 'Reserves_18',
  '24': 'Reserves_24',
};
function reservesKey(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
// Returns the mapped GLOBAL_RESERVES token, or null when reserves is OMITTED (buildSearch then applies
// the profile default). An unrecognized value throws LpValidationError (→ 422 upstream).
function mapReserves(v) {
  const k = reservesKey(v);
  if (k === '') return null;                              // omitted → profile default (handled by caller)
  const t = RESERVES_TOKENS[k];
  if (!t) {
    throw new LpValidationError('unknown_reserves', 'reservesMonths',
      `Unknown reserves requirement ${JSON.stringify(String(v))}. Supported: "none" (or 0), 3, 6, 12, 18, 24 months. The request is rejected rather than priced at a guessed reserves token.`);
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
  // FOOTGUN: these have NO re-apply path — so if you ever add a caller field for one, you MUST add its
  // re-apply AFTER this clear runs, or the caller's value will be silently zeroed. (Contrast dscr /
  // ltv / fico, which ARE re-applied to criteria; and cashoutAmount, which IS re-applied — see its
  // entry below.)
  { path: 'criteria.subordinateLoanAmount', neutral: 0, why: 'second-lien amount — audit §31.6 leak example' },
  { path: 'criteria.lineAmount',            neutral: 0, why: 'line-of-credit amount' },
  { path: 'criteria.rehabBudget',           neutral: 0, why: 'rehab budget' },
  { path: 'criteria.drawAmount',            neutral: 0, why: 'construction draw amount' },
  { path: 'criteria.downPaymentAmount',     neutral: 0, why: 'down-payment amount' },
  // Cash-out "cash in hand". Neutral is ABSENT (delete the key), so a stale amount inherited from a
  // live foundation cannot leak onto a scenario that names none — and the CALLER'S amount is
  // RE-APPLIED after the clear (buildSearch), which is the standing scenario-owned footgun: a field
  // cleared to neutral and not re-applied is silently lost.
  //
  // THIS COMMENT SAID THE OPPOSITE UNTIL 2026-08-16, and the file it contradicted is the one the
  // parity doc names as the authority on this field. It was written under the §32.2 FAIL-CLOSED
  // reading — right while the only evidence was the frontend bug `dynamicPropertiesMap.undefined`,
  // which is not a field name — and was not updated when §30.4's captured `criteria.cashoutAmount`
  // reversed it. The amount IS transmitted, as a JSON number, on that captured key; the internal
  // Symbol channel is retained alongside for diagnostics and can never disagree with it (both are
  // written from the same variable). Full reasoning: scripts/test-lt-lp-cashout-pure.js.
  { path: 'criteria.cashoutAmount', neutral: DELETE, why: 'cash-out amount; cleared so a prior scenario cannot leak one, re-applied from the caller' },
  // §32.3 DSCR band token — a DYNAMIC property derived from the per-deal DSCR (dscrBand). It is
  // scenario-owned exactly like criteria.dscr, so a live foundation's stale DSCRRATIO must not leak
  // when this scenario omits dscr. Neutral is ABSENT (delete the whole {fieldId,value} object): on
  // omission no DSCRRATIO is sent (matching an omitted DSCR); when dscr IS supplied, buildSearch's
  // setDyn('DSCRRATIO', …) re-creates it AFTER this clear. Re-apply path is guaranteed (setDyn runs
  // after clearScenarioOwnedFields), so the DELETE-neutral footgun above does not apply.
  { path: 'dynamicPropertiesMap.DSCRRATIO', neutral: DELETE, why: 'DSCR band token derived from criteria.dscr — §32.3' },
  // Broker COMP-PLAN override — the audit's compPlan leak. Neutral is the base default false ("do not
  // override; the standard comp plan governs"), which neutralizes any per-session comp override
  // (rangeComplan only applies while this flag is true, so clearing the flag is sufficient and no
  // comp value we cannot document is touched).
  { path: 'brokerCriteria.overrideExistingComplan', neutral: false, why: 'per-session comp override — audit §31.6 compPlan example' },
  // §31.5/§31.6 — BROKER COMP PERCENT. The captured base carries NO compPlan key at all, so the
  // neutral is ABSENT (delete), not a number: an omitted compPercent must leave the request exactly
  // as the base has it. This is the audit's own leak case — clearing the visible Comp Percent input
  // did NOT clear the model, so later searches kept sending a prior session's compPlan. Re-applied by
  // buildSearch AFTER this clear when the caller supplies compPercent, so the DELETE footgun above
  // does not apply.
  { path: 'brokerCriteria.compPlan', neutral: DELETE, why: 'broker comp percent — audit §31.6 stale compPlan leak' },
  // §31.6 — THE PROPERTY ADDRESS. Found by the post-merge audit of #1220, and it is the same leak
  // class as compPlan with a worse consequence: every address part was written ONLY when the caller
  // supplied it, so against a LIVE foundation (production clones /pricing/defaultSearch) whatever
  // address the previous session left rode onto the wire. Reproduced: a caller sending ZIP 11211
  // priced as {zip:"11211", state:"NY", county:"36047", countyName:"Kings", city:"Beverly Hills"} —
  // a Brooklyn deal with a California city — and, worse, a payload whose county FIPS said Kings
  // while its county NAME said Los Angeles, because the name came from the stale base and the FIPS
  // from the caller. A wrong location does not fail loudly; it prices the wrong market.
  //
  // Neutral is ABSENT for every part. Unlike the economics neutrals (the base's own defaults), the
  // captured base's address is a REAL property's address — keeping it as the neutral would mean
  // "clearing" a stale address by writing a different stale one. Deleting can only ever REMOVE a
  // value, never introduce one. Every part is re-applied by buildSearch's address overlay AFTER this
  // clear; what disappears is exactly the inherited part nobody asked for.
  //
  // CORRECTION (re-audit): this comment previously claimed "validateScenario refuses a priced
  // scenario without state + county FIPS, so a real request is complete." That was FALSE —
  // `validateLocation` short-circuits `{ok:true}` when NO location field is present at all, so a
  // locationless scenario passed validation and, once the address became scenario-owned, would have
  // gone upstream with no state and no county. The claim is now TRUE because `validateScenario`
  // was given the explicit `location_required` refusal it was described as already having; the
  // safety property is asserted rather than assumed.
  { path: 'property.address.zip',         neutral: DELETE, why: 'per-deal ZIP — a stale one contradicts the state' },
  { path: 'property.address.state',       neutral: DELETE, why: 'per-deal state' },
  { path: 'property.address.city',        neutral: DELETE, why: 'per-deal city — never derived from a ZIP, so a stale one survives every enrichment' },
  { path: 'property.address.county',      neutral: DELETE, why: 'per-deal county FIPS' },
  { path: 'property.address.censustract', neutral: DELETE, why: 'per-deal county FIPS (the vendor carries it twice)' },
  { path: 'property.address.countyName',  neutral: DELETE, why: 'per-deal county name — the FIPS/name contradiction' },
  // The re-audit caught the first cut of this entry covering only SIX parts. The
  // address object has ELEVEN keys and NINE of them are per-deal; `street`,
  // `streetCont` and `zipExt` were left behind, so a stale foundation still put a
  // Beverly Hills street and a Beverly Hills ZIP+4 on a Brooklyn deal — and `zipExt`
  // is a LOCATION field, so that is a location contradiction, not merely spilled
  // detail. Worse, none of the three appears in `effectiveOf`, so the mechanism whose
  // whole job is to prove what went upstream could not see them.
  // `country` ("US") and `province` ("") are NOT per-deal and are deliberately absent
  // from this list: they are structural defaults every request carries.
  { path: 'property.address.street',      neutral: DELETE, why: 'per-deal street' },
  { path: 'property.address.streetCont',  neutral: DELETE, why: 'per-deal street line 2' },
  { path: 'property.address.zipExt',      neutral: DELETE, why: 'per-deal ZIP+4 — a stale one contradicts the ZIP beside it' },
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

// §37.6 — A DEFAULT SEARCH IS NOT A PRICING REQUEST, AND CLONING IT AS ONE IS WHY NOTHING PRICED.
//
// `GET /pricing/defaultSearch` returns the company's CONFIGURATION/STORAGE model. The browser does
// not send it: it TRANSFORMS it into a smaller, differently-shaped request before calling searchRaw.
// `buildSearch` used to start from `clone(opts.base || BASE)` — i.e. it posted the configuration
// model itself whenever a live foundation was available, which is every time in production. Measured
// on the live tenant, same DSCR scenario: the frontend's request is 6,808 bytes and returns HTTP 200
// with 17 programs; the configuration-model request is 8,576 bytes, differs in 203 structures, and
// returns HTTP 500 — every time, for every scenario, before any deal detail can even be compared.
// That is the whole reason a login that provably works still produced no pricing.
//
// The 500 ITSELF was bisected to a single leaf, against the frontend's own working body on the live
// tenant: `criteria.mortgageTypes` comes back NULL on the configuration model, and patching that one
// value — nothing else — turns the failing request into HTTP 200. `companyId: null` and a missing
// county FIPS were each tested in isolation and are innocent of the 500. But fixing only that leaf
// would be the worse outcome: the request would start SUCCEEDING while still carrying 200-odd wrong
// structures, and a body built that way returns 411 priced leaves against the frontend's 439, and 16
// programs against 17. A silently smaller product set is more dangerous than a loud 500, because
// nobody goes looking for the missing lender.
//
// So the foundation is the CANONICAL FRONTEND REQUEST (`BASE`, captured from a real successful
// search), always — and the live model is admitted only through this normalizer:
//
//   · a key the canonical request does not have is NEVER copied (that is what drops every
//     configuration-only property the frontend strips before pricing);
//   · a value whose TYPE disagrees with the canonical one is refused (an object where the request
//     wants a number cannot be "merged" into a valid request);
//   · NULL is refused. This is the rule that fixes the measured 500, and it is deliberately stated
//     as a rule rather than a special case for mortgageTypes: on the configuration model a null
//     means "not configured here", never "send null", and it must never overwrite a proven value;
//   · arrays are taken WHOLE or not at all — merging a live array element-wise would produce a list
//     that exists in neither system.
//
// The result: live company defaults still reach the wire (that was the point of fetching them), but
// only ever as values inside a request shape proven to price. Anything unrecognized is dropped, and
// dropping is safe here precisely because the canonical request already carries a working value for
// every key it defines.
// `dynamicPropertiesMap` is the ONE part of the request that is an OPEN MAP rather than a fixed
// schema: it is a bag of per-deal pricing inputs whose key set genuinely varies by deal (our own
// registry adds ~18 of them the captured base never carries). Applying the drop-unknown-keys rule to
// it therefore discards real pricing inputs rather than configuration noise — caught by the
// advanced-flags suite, which proves that a foundation carrying `FirstTimeInvestor` must keep it
// when the caller says `false`, precisely so we never fabricate an unconfirmed "off" token. Each
// entry must still look like a dynamic property ({fieldId, value}); anything else is not one.
function mergeDynamicProperties(canonical, live) {
  for (const key of Object.keys(live)) {
    const got = live[key];
    if (!got || typeof got !== 'object' || Array.isArray(got)) continue;
    if (typeof got.fieldId !== 'string' || !('value' in got)) continue;
    const want = canonical[key];
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      if (got.value !== null && got.value !== undefined) want.value = got.value;
    } else canonical[key] = { fieldId: got.fieldId, value: got.value };
  }
  return canonical;
}

function mergeKnownRequestDefaults(canonical, live) {
  if (!live || typeof live !== 'object' || Array.isArray(live)) return canonical;
  if (live.dynamicPropertiesMap && typeof live.dynamicPropertiesMap === 'object' && !Array.isArray(live.dynamicPropertiesMap)) {
    if (!canonical.dynamicPropertiesMap || typeof canonical.dynamicPropertiesMap !== 'object') canonical.dynamicPropertiesMap = {};
    mergeDynamicProperties(canonical.dynamicPropertiesMap, live.dynamicPropertiesMap);
  }
  for (const key of Object.keys(canonical)) {
    if (key === 'dynamicPropertiesMap') continue; // handled above, as an open map
    if (!Object.prototype.hasOwnProperty.call(live, key)) continue; // not offered by the live model
    const want = canonical[key];
    const got = live[key];
    if (got === null || got === undefined) continue;               // "not configured" — keep the proven value
    if (Array.isArray(want)) { if (Array.isArray(got)) canonical[key] = clone(got); continue; }
    if (Array.isArray(got)) continue;                              // live array where the request wants a scalar/object
    if (want !== null && typeof want === 'object') {
      if (typeof got === 'object') mergeKnownRequestDefaults(want, got);
      continue;
    }
    // Scalars: the canonical value may legitimately be null (a field the request carries but leaves
    // empty), in which case there is no type to check against and any scalar the live model offers
    // is accepted. Otherwise the types must agree.
    if (want === null || typeof want === typeof got) canonical[key] = got;
  }
  return canonical;
}

/**
 * Build a complete searchRaw body for a scenario by overlaying it onto the canonical base model.
 * @param sc scenario { purpose,value,loan,ltv,fico,dscr,propertyType,units,zip,state,county,countyFps,city,borrowerType,prepayMonths,io,escrowWaive,date }
 * @param opts { base, smo } — base = a live /pricing/defaultSearch whose VALUES are overlaid onto the
 *   canonical frontend request skeleton (never used as the request itself — see the note above);
 *   smo = a live /pricing/smo registry (Map or raw array) so option ids are the company's current
 *   ones. Both are optional; without them the proven captured defaults are used.
 */
function buildSearch(sc = {}, opts = {}) {
  const m = mergeKnownRequestDefaults(clone(BASE), opts.base);
  // §31.6 — clear scenario-owned fields to neutral BEFORE the DSCR profile + caller overlay, so a
  // stale value inherited from a live foundation can never leak into this scenario. Runs on the
  // clone, immediately after it, so every read below (e.g. the criteria.ltv fallback) sees neutral.
  clearScenarioOwnedFields(m);
  const smoReg = opts.smo || null;
  // §35.2/§36.2 — THE AMOUNT TRIANGLE. Any TWO of value / loan / LTV determine the third, so a caller
  // may send the short form the owner actually quotes from ("$400,000 loan at 75% LTV") and the
  // server derives the property value. Falls back to the live foundation's LTV only when fewer than
  // two are known (validateInputs refuses that case before we get here).
  const tri = deriveAmounts(sc);
  const value = tri.value;
  const loan = tri.loan;
  const ltv = tri.ltv != null ? tri.ltv : (m.criteria ? m.criteria.ltv : null);
  const purpose = mapPurpose(sc.purpose);
  const pm = mapProp(sc.propertyType);
  // Attachment type is INDEPENDENT of property type (audit §6): the live frontend can send e.g.
  // Condo + Detached. An explicit attachment overrides the type's default attachment; an explicit
  // `nonWarrantable` overrides the type's warrantability. Unit count stays independent (set below).
  //
  // BOTH SPELLINGS ARE ACCEPTED, and that is the whole bug this line closes. The independence was
  // implemented, but only under the key `attachment`, while the audit's contract — and every caller
  // following it — names the field `attachmentType` (the upstream path is `property.attachmentType`).
  // So a caller correctly asking for Condo + SemiDetached was silently given the type's default
  // Attached: the value was not refused, it was DROPPED, which is the silent-substitution class this
  // whole audit is about. `attachmentType` is the documented name and wins; `attachment` stays as an
  // accepted alias so nothing built against the older shape breaks.
  const attach = [sc.attachmentType, sc.attachment].find((v) => v != null && v !== '');
  if (attach !== undefined) pm.attachmentType = attach;
  if (sc.nonWarrantable !== undefined) pm.nonWarrantableProject = !!sc.nonWarrantable;
  const months = num(sc.prepayMonths);
  // Omitted → the profile's five-year default; 0 stays an explicit "no prepay". Both the SMO list
  // and the dynamic pair below read THIS value, never `months`, so they cannot disagree.
  const effMonths = months != null ? months : DEFAULT_PREPAY_MONTHS;

  const c = m.criteria || (m.criteria = {});
  if (value != null) c.purchasePrice = value;
  // Appraised (as-is) value is SEPARATE from the estimated/purchase price, ON EVERY PURPOSE
  // (2026-08-16 audit: "Entering Purchase Price $500,000 also sends appraisedValue=500000. The
  // frontend leaves Appraised Value blank/zero unless separately entered. Stop automatically copying
  // Purchase Price into Appraised Value.").
  //
  // THE EARLIER READING WAS WRONG AND ONLY WRONG ON PURCHASE. This code used to mirror value into
  // appraisedValue for a Purchase on the theory that "the appraisal comes in at contract price and
  // the frontend mirrors it". The live capture disproves that: the frontend carries Purchase Price
  // 500,000 with Appraised Value left at 0/blank, and the two are independent inputs there. Mirroring
  // states an appraised value NOBODY SUPPLIED — and appraised value is an LTV/eligibility basis, so
  // asserting one we were never given is the same class of silent mispricing as inheriting a stale
  // address: it does not fail, it prices a different deal. Blank on every purpose unless supplied.
  const apprSupplied = num(sc.appraisedValue != null ? sc.appraisedValue : sc.asIsValue);
  c.appraisedValue = apprSupplied != null ? apprSupplied : null;
  if (loan != null) c.loanAmount = loan;
  if (ltv != null) c.ltv = ltv;
  // §31.5 — SUBORDINATE FINANCING. Confirmed live: selecting Closed End Second and entering 50,000
  // sent `criteria.subordinateLoanAmount: 50000` and NO separate CLTV field — the engine derives the
  // combined ratio from first lien + subordinate + value, so we deliberately do NOT invent a CLTV
  // input. This is one of the SCENARIO_OWNED amounts cleared to 0 above, so this re-apply MUST stay
  // after that clear (the documented footgun) or a caller's value would be silently zeroed. The
  // HELOC/HELOAN subtype selectors are NOT wired: only the closed-end second amount was captured.
  const subordinate = num(sc.subordinateLoanAmount);
  if (subordinate != null) c.subordinateLoanAmount = subordinate;
  if (num(sc.fico) != null) c.fico = num(sc.fico);
  const dscrVal = num(sc.dscr);
  if (dscrVal != null) c.dscr = dscrVal;
  // §32.3 — DSCR threshold band, derived ONCE from the entered DSCR. Drives both the DSCRRATIO
  // dynamic token (set below) and the derived pricing-band SMO (pushed into specialMortgageOptions
  // below). Null when dscr is omitted → no DSCRRATIO, no band SMO (DSCRRATIO was cleared to neutral).
  const band = dscrBand(dscrVal);
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
  // §31.5 — BROKER COMP PERCENT, with the vendor's confirmed SIGN INVERSION: a visible 2.5 is
  // transmitted as brokerCriteria.compPlan = -2.5 (captured live). The caller sends what a human
  // SEES (a positive percent) and this one named conversion owns the negation — so the inversion
  // lives in exactly one place instead of every call site. A negative input is refused by
  // validateInputs rather than double-negated into a positive. Omitted → the key stays absent
  // (its cleared neutral), matching the captured base which carries no compPlan at all.
  {
    const pct = num(sc.compPercent);
    if (pct != null) { const bc = m.brokerCriteria || (m.brokerCriteria = {}); bc.compPlan = compPlanValue(pct); }
  }
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
  // §37.10 — THE FOURTH OPTION IS THE CAPTURED ONE, NOT ONE WE DERIVED.
  //
  // Both real captured requests — different deals, different states, both HTTP 200 with real
  // pricing — send exactly [3 Yr PPP, Debt Service Coverage Ratio, DSCR, **Prepay Buyout**], and
  // every option carries a real id. We were sending an invented fourth option instead:
  // "DSCR >=1.25 - J", with **NO id at all**, derived by reading a threshold table out of the
  // vendor's JS bundle. That table proves such names EXIST; it never showed the frontend SENDING
  // one, and an id-less element is structurally unlike every option in every capture.
  //
  // This is the same class as DSCRRATIO, which was measured to cost a whole lender program. Both
  // came from reading their code rather than watching their traffic. Swapping THIS one was measured
  // to change nothing on the scenarios tested — but "made no difference on two deals" is not
  // "harmless", and an unconfirmed value we can simply stop inventing is not worth defending.
  //
  // So: carry the fourth option through from the FOUNDATION (the captured base, and a live
  // defaultSearch, both real vendor documents) rather than fabricating one. `preserved` is every
  // option the foundation carried that is not one we are setting ourselves — on the captured base
  // that is exactly Prepay Buyout. If a company's live configuration carries others, they ride too,
  // which is the point: the vendor's own list beats anything we could infer.
  //
  // `LP_SEND_DSCR_BAND_SMO=1` restores the derived band for a future capture that shows the frontend
  // sending one. Do not turn it on by default without that capture.
  const ownNames = new Set(smo.map((o) => String(o && o.name || '').toLowerCase()));
  const baseSmo = (m.criteria && Array.isArray(m.criteria.specialMortgageOptions)) ? m.criteria.specialMortgageOptions : [];
  const preserved = baseSmo.filter((o) => {
    const n = String(o && o.name || '').toLowerCase();
    if (!n || ownNames.has(n)) return false;
    if (/\bppp\b|prepay(ment)? penalt/.test(n)) return false;   // the prepay TERM is ours to set
    if (/^dscr\s*[<>=]/.test(n)) return false;                  // a stale derived band from a live model
    return true;
  });
  if (band && band.smo && String(process.env.LP_SEND_DSCR_BAND_SMO || '') === '1') {
    smo.push(resolveSmo(band.smo, smoReg, null));
  }
  for (const o of preserved) smo.push(clone(o));
  {
    const fb = SMO_PPP[effMonths] || null;
    const pppName = effMonths === 0 ? 'No PPP'
      : (effMonths % 12 === 0) ? `${effMonths / 12} Yr PPP` : `${effMonths} Months PPP`;
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
  // §33.2 — INCOME DOCUMENTATION. The DSCR profile default is DSCR (audit §29.1/§35.3), forced when
  // the caller omits it so a live foundation carrying a different doc type cannot silently override
  // the profile. A caller MAY select any of the 25 CONFIRMED live menu values (label or exact token);
  // an unrecognized value 422s rather than being priced as DSCR. §33.6 ordering: this is set BEFORE
  // the DSCR ratio below, because selecting DSCR in the live UI resets the visible ratio.
  setDyn('IncomeDocType', mapIncomeDocType(sc.incomeDocType) || 'DSCR');
  // §37.9 — DSCRRATIO IS OFF, AND IT WAS COSTING US A WHOLE LENDER PROGRAM.
  //
  // MEASURED, apples to apples, against the live tenant: the captured frontend request for one
  // scenario returns 11 programs / 309 priced options / 8 lenders. OUR body for the SAME scenario —
  // read back out of that capture so the deal is identical — returned 10 / 281 / 8. Removing this
  // one dynamic property, and changing nothing else, returned EXACTLY 11 / 309 / 8. Full parity.
  //
  // The same test cleared the other suspect: substituting the frontend's own specialMortgageOptions
  // (its "Prepay Buyout" for our id-less "DSCR >=1.25 - J" band) changed the result NOT AT ALL, so
  // the band SMO is not what was costing the program — this was, on its own.
  //
  // WHY IT WAS WRONG TO SEND IT. The key does not appear in ANY captured working request: not the
  // frontend's, and not our own successful run. It was derived from a threshold table read out of the
  // vendor's JS bundle, which tells us the tokens EXIST — it never told us the frontend SENDS them,
  // and a pricing-band token we assert without being asked narrows the lender set that matches.
  // Losing a program is a silently WORSE quote for the borrower, which is the expensive direction.
  //
  // It stays reachable behind `LP_SEND_DSCRRATIO=1` rather than being deleted, because the tokens
  // themselves are real and a future capture may show when the frontend genuinely sends one. Do not
  // turn it on by default again without a capture showing the frontend doing it, and re-measure the
  // program count on the same scenario when you do.
  if (band && String(process.env.LP_SEND_DSCRRATIO || '') === '1') setDyn('DSCRRATIO', band.ratio);
  setDyn('AddlOccupancyType', mapRentalTerm(sc.rentalTerm));
  // §33.4/§34.2 — BORROWER TYPE. Previously ANY string was passed straight through to the vendor as a
  // vesting type; every other advanced enum 422s an unrecognized value, so this was the one silent
  // substitution left in the borrower block. Validated against the exact six-value tenant enum
  // (validateInputs rejects an unknown one before we get here); the profile default stays LLC.
  setDyn('GLOBAL_BorrowerType', sc.borrowerType || 'LLC');
  // Reserves — §32.4. The intentional DSCR profile default is 24 MONTHS (audit §1), forced when the
  // caller omits reserves so a live default carrying blank/different reserves cannot silently override
  // the profile (env-overridable per company via LP_RESERVES_TOKEN). A caller MAY choose a specific
  // reserves requirement via reservesMonths → the CONFIRMED live enum (mapReserves); an unknown value
  // 422s (never a guessed token). Always set (GLOBAL_RESERVES is confirmed from the captured base).
  setDyn('GLOBAL_RESERVES', mapReserves(sc.reservesMonths) || process.env.LP_RESERVES_TOKEN || 'Reserves_24');
  // Prepay term / structure. An OMITTED prepay takes the DSCR PROFILE DEFAULT — five-year Standard —
  // not whatever the live foundation happens to carry (2026-08-16 audit: "Five-year Standard prepay
  // is not a true default. It works only when prepayMonths:60 is explicitly supplied… Default must
  // be: PrepayTerm='60 Months', PrePayment_Plan_Type='Standard', 5 Yr PPP SMO"; §35.3/§36.6 list it
  // among the profile's automatic values).
  //
  // THIS SUPERSEDES §34.2's "omission must inherit the current Lender Price default", which was
  // written earlier in the same audit and reversed by §35/§36 and the final summary. Inheriting was
  // measurably wrong in practice: against the captured foundation an omitted prepay produced
  // "36 Months" with no 5 Yr PPP option — a THREE-year prepay on a deal the owner quotes at five,
  // silently, because a quote that omits prepay is the ordinary case rather than a rare one.
  // Prepayment changes the note's economics, so defaulting it to whatever the vendor last stored is
  // exactly the leak `clearScenarioOwnedFields` exists to stop.
  //
  // months===0 remains an EXPLICIT "no prepay" (PrepayTerm "None" → the No PPP SMO), which is a
  // different thing from omission and must stay distinguishable.
  // §33.3 — the STRUCTURE is an INDEPENDENT input from the term. "No Prepay" (a null plan value) is
  // NOT the same operation as PrepayTerm "None" (which produces the No PPP SMO), so an explicit
  // structure is honored on its own: it may be supplied with or without a term, and it overrides the
  // Standard default a term alone implies. Unrecognized values 422 (validated in validateInputs).
  const structure = mapPrepayStructure(sc.prepayStructure);
  setDyn('PrepayTerm', effMonths === 0 ? 'None' : `${effMonths} Months`);
  // A caller-supplied structure wins; otherwise a positive term implies the Standard default and an
  // explicit no-prepay term carries the null plan. A structure supplied ALONE still rides the
  // profile's default term, which is what makes "Standard" mean five-year Standard.
  setDyn('PrePayment_Plan_Type', structure != null
    ? (structure === PREPAY_STRUCTURE_NULL ? null : structure)
    : (effMonths === 0 ? null : 'Standard'));
  // Cash-out amount ("cash in hand") — TRANSMITTED as numeric `criteria.cashoutAmount`.
  //
  // THE AUDIT CONTRADICTS ITSELF HERE, so the reasoning is written down rather than left implied.
  // §31.4 and §30.4 both record a live capture carrying `criteria.cashoutAmount: 50000` as a JSON
  // number, and §30.4 lists it in the criteria table as a "newly confirmed direct criteria field".
  // §32.2 then reports a LATER re-test in which the visible input still held 50000 while the request
  // carried neither the number nor the key, and declares the earlier finding superseded. The final
  // instruction is unambiguous and is what this implements: "A $50,000 cash-out amount never reaches
  // criteria.cashoutAmount. Remove the obsolete dynamic-field feature flag. Send numeric
  // criteria.cashoutAmount=50000."
  //
  // WHY THAT IS NOT A GUESS, WHICH IS THE ONLY REASON IT MAY BE SENT AT ALL. The standing rule is
  // never to invent a vendor token — the old fail-closed behaviour existed because the only evidence
  // then was the frontend BUG `dynamicPropertiesMap.undefined`, which is not a field name and could
  // never be one. `criteria.cashoutAmount` is different in kind: it is a captured key on the criteria
  // object, recorded twice, and named explicitly in the instruction. The §32.2 non-appearance is most
  // consistent with the UI not having committed the input on that run; it is evidence about one
  // capture, not evidence that the key is wrong. The asymmetry decides it — omitting a real amount
  // silently prices a cash-out as though no cash were taken, while sending a captured criteria key
  // the vendor ignores costs nothing.
  //
  // The purpose guard in validateScenario has already refused a positive amount on a purchase or a
  // rate-and-term refinance, so reaching here means the purpose is CashoutRefinance. It is written
  // AFTER clearScenarioOwnedFields (which clears this key to neutral), which is the standing footgun:
  // a scenario-owned field's caller value must be re-applied after the clear or it is silently lost.
  // LP_CASHOUT_AMOUNT_FIELD is GONE — it addressed a dynamic property that never existed.
  const cashoutAmt = num(sc.cashoutAmount);
  if (cashoutAmt != null) {
    c.cashoutAmount = cashoutAmt;
    m[CASHOUT_INTERNAL] = cashoutAmt; // still retained for diagnostics; Symbol keys never serialize
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

  return wireDiscipline(m);
}

// §37.8 — WHAT LEAVES THIS FUNCTION IS DISCIPLINED, AT ONE PLACE, AFTER EVERYTHING ELSE HAS RUN.
//
// Three separate audits found the same class from three directions: a value that is legal in
// JavaScript, passes every check we wrote, and is then refused — or worse, silently mispriced — by a
// strict Java service that answers with a bare "Internal Server Error" and no field name. Guarding
// each producer separately is what let these through, because the list of producers is exactly what
// nobody can keep complete. So the last thing `buildSearch` does is inspect the finished body.
//
// (1) THE DSCR PROFILE CONSTANTS ARE FORCED, NOT INHERITED. `mergeKnownRequestDefaults` refuses a
//     null from the live configuration model but adopts any value of the right TYPE — which is
//     correct for a company default and catastrophic for the handful of fields that define what kind
//     of search this is. Measured against a live-model stub: `criteria.loanType` became "ARM" while
//     `loanTypeCriteria` stayed ["Fixed"] (a request contradicting itself), and
//     `criteria.mortgageTypes` became ["FHA"] on a DSCR search. Neither would error; both would
//     price the wrong product set and look like a successful quote. These five are the identity of a
//     DSCR investor search and a saved company preference may not move them.
//
// (2) A REQUIRED NUMBER IS NEVER null — AND THE ANSWER IS A REFUSAL, NOT A SUBSTITUTE. Probed
//     directly against the live tenant on a body otherwise proven to price: `criteria.fico` set to
//     null → HTTP 500, and REMOVED → HTTP 500. It is required and it may not be null, while
//     `clearScenarioOwnedFields` gives it the neutral `null` — so any caller omitting a credit score
//     sent a guaranteed 500.
//
//     The first cut of this repair filled the gap from the canonical request's own value. That was
//     WRONG, and four existing suites said so within a minute: the entire point of the
//     scenario-ownership rule is that an OMITTED economic field FAILS CLOSED to null rather than
//     inheriting one, because inheriting silently prices a deal nobody asked for — a 500 is a bad
//     day, a wrong price that looks like a good one is a bad year. So the substitution was removed
//     and the requirement was moved to `validateScenario`, which refuses the scenario locally with a
//     message naming the field. Nothing here manufactures an economic value.
//
// (3) THE WIRE IS TYPED THE WAY THE CAPTURE IS TYPED. `state`, county FIPS, `city` and `countyName`
//     were written from the scenario verbatim: a lowercase "ny" was validated uppercased and then
//     transmitted lowercase; a numeric 36047 went as a JSON number where the capture sends the
//     string "36047" (which also silently destroys a leading-zero FIPS such as "01001"); and an
//     object reached `countyName` with no check at all.
//
//     `street` / `streetCont` / `zipExt` are deliberately left ABSENT rather than filled with the
//     capture's empty strings: our own 6,799-byte body omitted all three and returned HTTP 200, so
//     they are provably not required — and the scenario-ownership suite exists to prove a prior
//     session's street can never ride along, which is worth more than cosmetic parity.
//
// Nothing here invents a value. Every default is the canonical request's own, every coercion is to
// the type the capture uses, and a field the scenario legitimately set is left alone.
const PROFILE_FORCED = {
  loanType: 'Fixed',                  // a DSCR investor search is fixed-rate; ARM is a different product
  mortgageTypes: ['Conventional'],    // the leaf whose null was the measured cause of the live 500
  propertyUse: 'Investment',
  compensationType: 'BorrowerCompPlan',
  lienPriorityType: 'FirstLien',
};
function wireDiscipline(m) {
  const c = m.criteria || (m.criteria = {});

  // (1) profile identity — forced last, so nothing downstream can have moved it.
  for (const [k, v] of Object.entries(PROFILE_FORCED)) c[k] = Array.isArray(v) ? v.slice() : v;
  // An empty array is not a null and survived the merge; on the one leaf whose null is a proven 500
  // it is the obvious sibling, so it is repaired rather than sent.
  if (!Array.isArray(c.mortgageTypes) || c.mortgageTypes.length === 0) c.mortgageTypes = ['Conventional'];
  // loanType and loanTypeCriteria must agree — a body that says Fixed in one place and ARM in the
  // other is a request no reader can honour.
  if (!Array.isArray(m.loanTypeCriteria) || m.loanTypeCriteria.length === 0) m.loanTypeCriteria = [c.loanType];
  else m.loanTypeCriteria = m.loanTypeCriteria.map(() => c.loanType).slice(0, 1);

  // (2) is enforced in validateScenario (a refusal), deliberately NOT here — see the note above.

  // (3) the address is typed and complete, the way the capture is.
  const a = m.property && m.property.address;
  if (a) {
    if (a.state != null) a.state = String(a.state).trim().toUpperCase();
    for (const k of ['county', 'censustract']) {
      if (a[k] != null) {
        // A FIPS is five digits. A number loses a leading zero, so pad rather than merely stringify.
        const s = String(a[k]).trim();
        a[k] = /^\d{1,5}$/.test(s) ? s.padStart(5, '0') : s;
      }
    }
    for (const k of ['city', 'countyName']) {
      // An object or array here is not a place name; drop it rather than serialize it onto the wire.
      if (a[k] != null && typeof a[k] !== 'string') {
        if (typeof a[k] === 'number') a[k] = String(a[k]);
        else delete a[k];
      }
    }
  }
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
const BOOLEAN_FIELDS = ['io', 'escrowWaive', 'fthb', 'selfEmployed', 'rural', 'mixedUse', 'waiveLenderFee', 'noMortgageHistory', 'nonWarrantable', 'crossCollateral', 'firstTimeInvestor', 'livingRentFree', 'dscrAssetDepletion', 'lateInLast12Months'];
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
// The smallest LTV that is a real scenario rather than a typo. Arithmetic sanity, NOT a business
// cap: the triangle divides by the LTV, so a vanishing one derives an absurd property value
// (0.000001 on a $400k loan → $400bn). 0.1% sits far below any real deal.
// A misconfigured env must never SILENTLY disable a bound: Number('abc') is NaN and every
// comparison against NaN is false, so a typo would turn the floor off with no warning. Fall back to
// the default unless the override is a real positive number.
function envRatio(name, dflt) {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0) ? n : dflt;
}
const MIN_LTV = envRatio('LP_MIN_LTV', 0.001);
const LIVE_TERMS = [5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 40];
const ALLOWED_TERMS = (process.env.LP_ALLOWED_TERMS
  ? process.env.LP_ALLOWED_TERMS.split(',').map((x) => Number(x.trim())).filter((n) => isFinite(n))
  : LIVE_TERMS);

// §31.8 — "NO MORTGAGE HISTORY" AND A MORTGAGE LATE CANNOT BOTH BE TRUE.
//
// PURE. A borrower who has never held a mortgage cannot have been late on one, so a scenario
// asserting both describes no real borrower. Upstream this does not error: each field is applied
// independently and the engine prices on whichever the rules happen to read — which is the
// silent-mis-pricing class this connector exists to refuse, and the worst shape of it, because the
// two answers ("clean, no history" and "a 90-day mortgage late") sit at opposite ends of the credit
// grid. It is also the ORDINARY way the contradiction arises: `noMortgageHistory` is a sticky
// checkbox, so leaving it ticked while entering the lates that were just pulled is one click.
//
// SCOPE IS EXACTLY WHAT THE AUDIT ESTABLISHED, and no wider. The lates (the eight
// `MORT*LATESLAST*` buckets) and their PARENT toggle `lateInLast12Months` are the same fact stated
// twice by the same UI — the parent is documented as being sent alongside those buckets — so both
// are in. DELIBERATELY NOT INCLUDED, because each is a business rule about what the vendor's flag
// MEANS rather than an arithmetic impossibility, and guessing one would refuse legitimate scenarios:
// a foreclosure, short sale, deed-in-lieu, mortgage charge-off or forbearance all imply a mortgage
// existed at some point, but "no mortgage history" may well mean no CURRENT or no RECENT mortgage —
// only the vendor can say. Ask before widening this; do not infer it.
//
// A count of "0" is NOT a contradiction: stating that a borrower with no mortgage history has zero
// lates is consistent, and it is what a form pre-filled with zeros sends. Only a real count
// conflicts. A count the registry does not recognise at all is left to the existing invalid-value
// refusal, so one wrong value is never reported as two different problems.
// DERIVED from the registry's own LATE_COUNT, never a hand-written second copy. A copy drifts, and
// this one drifts in the UNSAFE direction: a future confirmed vendor token (a '5' bucket) added to
// LATE_COUNT alone would be accepted by the builder and silently NOT counted as a conflict here, so
// the contradictory payload this rule exists to refuse would go upstream. Proven by the re-audit.
const NONZERO_LATE_COUNTS = new Set(Array.from(registry._tokens.LATE_COUNT).filter((v) => String(v) !== '0'));
function mortgageHistoryConflict(sc = {}) {
  if (sc.noMortgageHistory !== true) return null;
  const conflicts = [];
  const lates = sc.mortgageLates;
  if (lates && typeof lates === 'object' && !Array.isArray(lates)) {
    for (const [window, label] of [['last12', 'the last 12 months'], ['months13To24', 'months 13–24']]) {
      const bucket = lates[window];
      if (!bucket || typeof bucket !== 'object') continue;
      for (const sev of ['30', '60', '90', '120']) {
        if (bucket[sev] == null) continue;
        // String()-normalised exactly as applyRegistry does, so a numeric 1 and a "1" are one value.
        if (NONZERO_LATE_COUNTS.has(String(bucket[sev]))) {
          conflicts.push(`${bucket[sev]} × ${sev}-day late in ${label} (mortgageLates.${window}.${sev})`);
        }
      }
    }
  }
  if (sc.lateInLast12Months === true) conflicts.push('lateInLast12Months = true');
  if (!conflicts.length) return null;
  return {
    field: 'noMortgageHistory',
    message: `Contradictory scenario: noMortgageHistory is true, but the request also reports ${conflicts.join('; ')}. A borrower with no mortgage history cannot have been late on a mortgage. Clear noMortgageHistory, or remove the mortgage lates — whichever the credit report actually shows. Nothing was priced, because the two halves price at opposite ends of the credit grid and the engine would silently follow one of them.`,
    conflicts,
  };
}

function validateInputs(sc = {}) {
  const bad = (code, field, message) => ({ ok: false, code, field, message });
  // Strict booleans — a JSON string "false" is TRUTHY and used to flip the flag on.
  for (const f of BOOLEAN_FIELDS) {
    if (sc[f] != null && typeof sc[f] !== 'boolean') {
      return bad('non_boolean_value', f, `Field "${f}" must be a JSON boolean (true/false); got ${JSON.stringify(sc[f])}. A string is rejected rather than coerced.`);
    }
  }
  // §31.8 — A SCENARIO THAT CONTRADICTS ITSELF IS REFUSED, not priced on whichever half wins.
  const conflict = mortgageHistoryConflict(sc);
  if (conflict) return bad('contradictory_mortgage_history', conflict.field, conflict.message);
  // §33.2/§33.3/§33.4 — confirmed-token enums. Each is REJECTED (422) when unrecognized rather than
  // falling back to the profile default: silently pricing a bank-statement scenario as DSCR, an
  // exotic prepay schedule as Standard, or an unknown vesting type as LLC is the exact
  // silent-substitution class this connector exists to prevent.
  if (sc.incomeDocType != null && sc.incomeDocType !== '' && mapIncomeDocType(sc.incomeDocType) == null) {
    return bad('invalid_income_doc_type', 'incomeDocType',
      `Unknown income documentation type ${JSON.stringify(String(sc.incomeDocType))}. Supported: ${Object.keys(registry.INCOME_DOC_TYPES).join(', ')}.`);
  }
  if (sc.prepayStructure != null && sc.prepayStructure !== '' && mapPrepayStructure(sc.prepayStructure) == null) {
    return bad('invalid_prepay_structure', 'prepayStructure',
      `Unknown prepayment structure ${JSON.stringify(String(sc.prepayStructure))}. Supported: ${Object.keys(registry.PREPAY_STRUCTURES).join(', ')}.`);
  }
  if (sc.borrowerType != null && sc.borrowerType !== '' && !registry.BORROWER_TYPES.has(String(sc.borrowerType))) {
    return bad('invalid_borrower_type', 'borrowerType',
      `Unknown borrower (vesting) type ${JSON.stringify(String(sc.borrowerType))}. Supported: ${Array.from(registry.BORROWER_TYPES).join(', ')}.`);
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
  const cashout = numField('cashoutAmount', { min: 0 }); if (cashout.err) return cashout.err; // "cash in hand"; stored, and transmitted as the captured criteria.cashoutAmount
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
  // Attachment must be one of the frontend's independent options when supplied (audit §6). BOTH
  // spellings are checked — `attachmentType` is the documented API name and `attachment` the accepted
  // alias — because a key the BUILDER honours but the VALIDATOR ignores is strictly worse than one
  // neither knows: it is the only path by which an unchecked value reaches the vendor.
  for (const key of ['attachmentType', 'attachment']) {
    const v = sc[key];
    if (v != null && v !== '' && !ATTACHMENT_TYPES.includes(v)) {
      return bad('invalid_attachment', key, `Attachment must be one of: ${ATTACHMENT_TYPES.join(', ')}; got ${JSON.stringify(v)}.`);
    }
  }
  // LTV: loan must not exceed value (LTV > 100%), and a SUPPLIED ltv must not contradict loan/value.
  const ltvRaw = numField('ltv', { min: 0 }); if (ltvRaw.err) return ltvRaw.err;
  // A SUPPLIED ltv is range-checked on its OWN (audit — isolated LTV), whether or not value+loan were
  // both given: an ltv normalizing above 100% is invalid by itself and used to slip through when
  // value/loan were absent. Accept 75 or 0.75; ceiling env-overridable (LP_MAX_LTV, default 100%).
  if (ltvRaw.v != null) {
    const normLtv = ltvRaw.v > 1 ? ltvRaw.v / 100 : ltvRaw.v;
    const maxLtv = envRatio('LP_MAX_LTV', 1); // same NaN/zero guard as the floor
    if (normLtv > maxLtv) {
      return bad('ltv_out_of_range', 'ltv', `LTV ${(normLtv * 100).toFixed(2)}% exceeds the maximum ${(maxLtv * 100).toFixed(0)}%.`);
    }
    // A ZERO (or vanishing) LTV is not a scenario. It also cannot participate in the amount
    // triangle — dividing by it is meaningless — so without this floor it counted toward "two
    // figures known" while deriving nothing, and a null purchase price reached upstream: exactly
    // what the triangle rule exists to prevent. The floor is arithmetic sanity, not a business
    // cap: below 0.1% the derived property value explodes (a 0.000001 LTV on a $400k loan derives
    // a $400bn value), which is a typo, never a deal.
    if (normLtv < MIN_LTV) {
      return bad('ltv_out_of_range', 'ltv', `LTV ${(normLtv * 100).toFixed(4)}% is below the minimum ${(MIN_LTV * 100).toFixed(1)}% — an LTV of zero or near-zero is not a priceable scenario.`);
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
  // §31.5 — subordinate financing + broker comp percent.
  const sub = numField('subordinateLoanAmount', { min: 0, max: 1e9 }); if (sub.err) return sub.err;
  // A comp percent is entered as the number a human SEES (positive); the vendor's negative wire form
  // is produced by the one named conversion in the builder. A negative input is refused rather than
  // double-negated into a positive comp. 100 is an arithmetic ceiling for a percentage, not a
  // business cap — no company/lender cap was captured, so none is invented here.
  const comp = numField('compPercent', { min: 0, max: 100 }); if (comp.err) return comp.err;
  // Combined LTV: the first lien plus a subordinate lien cannot exceed the property value. The engine
  // derives CLTV itself (the live capture sent NO CLTV field), so we validate rather than transmit.
  if (sub.v != null && sub.v > 0) {
    const tri = deriveAmounts(sc);
    if (tri.value != null && tri.value > 0 && tri.loan != null) {
      const cltv = (tri.loan + sub.v) / tri.value;
      if (cltv > 1) {
        return bad('cltv_out_of_range', 'subordinateLoanAmount',
          `First lien (${tri.loan}) plus subordinate lien (${sub.v}) is ${(cltv * 100).toFixed(2)}% of the property value (${tri.value}) — a combined LTV over 100%.`);
      }
    }
  }
  // §35.2/§36.2 — THE AMOUNT TRIANGLE. A quote is priced off the property value, the first-lien
  // amount and the LTV; any TWO determine the third. Fewer than two is not a scenario we can price,
  // and deriving from ONE would be a guess, so it is refused here — BEFORE any upstream call —
  // rather than sent with a null purchase price that upstream would answer 500 or mis-price.
  {
    // The PURPOSE is the more fundamental fact, so an unknown one is reported as an unknown purpose
    // rather than being masked by the amount rule below (a caller who typed the purpose wrong should
    // be told THAT, not sent hunting for a missing amount).
    try { mapPurpose(sc.purpose); } catch (e) {
      if (e && e.lpValidation) return bad(e.code, e.field, e.message);
      throw e;
    }
    const tri = deriveAmounts(sc);
    if (tri.known < 2) {
      return bad('insufficient_amounts', 'loan',
        'A quote needs any TWO of property value, loan amount and LTV — the third is derived. '
        + `Supplied: ${Object.keys(tri.supplied).filter((k) => tri.supplied[k]).join(', ') || 'none'}.`);
    }
    // Two figures being PRESENT is not the same as the pair being PRICEABLE. The vendor needs a
    // property value AND a loan amount, so if the derivation could not produce both as positive
    // numbers the scenario is not a loan — a $4 property at the 0.1% LTV floor rounds to a $0 loan,
    // which would otherwise have gone on the wire as `loanAmount: 0`.
    if (!(tri.value > 0) || !(tri.loan > 0)) {
      return bad('insufficient_amounts', 'loan',
        `These amounts do not describe a loan: they work out to a property value of ${tri.value == null ? 'none' : tri.value} and a loan amount of ${tri.loan == null ? 'none' : tri.loan}. Check the value, loan and LTV.`);
    }
  }
  // §36.3/§36.4 — a cash-out amount belongs ONLY to a cash-out refinance. On a Purchase or a
  // rate-and-term Refinance it is REJECTED rather than ignored: a caller who sends one is describing
  // a different transaction than the purpose says, and silently dropping it would price the wrong deal.
  if (num(sc.cashoutAmount) != null && num(sc.cashoutAmount) > 0) {
    let p = null;
    try { p = mapPurpose(sc.purpose); } catch (_) { p = null; } // an unknown purpose is reported by mapPurpose itself
    if (p && p !== 'CashoutRefinance') {
      return bad('cashout_not_allowed', 'cashoutAmount',
        `A cash-out amount is only valid on a cash-out refinance; this request is a ${p === 'Purchase' ? 'purchase' : 'rate-and-term refinance'}. Use purpose "Cash out", or remove cashoutAmount.`);
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
  // §26.3/§35.2 — ZIP ENRICHMENT FIRST. Pricing is ZIP-driven: the vendor's own screen turns a
  // 5-digit ZIP into state + county + county FIPS before it searches, while we used to demand all
  // of them and refuse an incomplete location. The lookup is a committed Census table (pure,
  // offline), so this adds no network call and no database read to the pricing path. Anything the
  // CALLER supplied is an ASSERTION, never overwritten — a supplied value that contradicts the ZIP
  // is a 422, because silently preferring one side is how a loan gets priced in the wrong county.
  const enr = zipCounty.enrichLocation(sc);
  if (!enr.ok) return { ok: false, status: 422, error: enr.code, field: enr.field, message: enr.message };
  // Merge the filled fields UNDER the caller's own values, then validate/build from the completed
  // scenario. `countyEnrichment` is reported so the response can say the county was inferred (and,
  // for a ZIP spanning counties, that it was the dominant one).
  const enriched = enr.filled.length ? { ...sc, ...enr.location } : sc;
  // `countyEnrichment` must describe the county the REQUEST WILL CARRY, not the one the ZIP
  // resolved to. Reporting `enr.resolved` unconditionally reproduced the very contradiction the
  // name-fill rule was written to close, one level up: on a split ZIP where the caller supplied
  // their own county, the built request said New York County while this block said Bronx — one
  // answer naming two counties. The dominant county is still reported, under its own name, because
  // on a split ZIP "we would have picked this one" is genuinely useful; it is just not the answer.
  // `enr.resolved` exists only when a ZIP actually resolved; a scenario with no ZIP fills nothing,
  // so guard it rather than reading through an absent object.
  const resolved = enr.resolved || null;
  const effFps = (sc.countyFps != null && String(sc.countyFps).trim() !== '') ? String(sc.countyFps).trim() : (resolved ? resolved.countyFps : null);
  const overrode = !!resolved && effFps !== resolved.countyFps;
  const countyEnrichment = enr.filled.length
    ? {
      filled: enr.filled,
      split: enr.split,
      countyFps: effFps,
      countyName: overrode ? (enr.location.countyName || sc.countyName || sc.county || null) : (resolved ? resolved.countyName : null),
      // Only meaningful when the caller overrode the dominant county; null otherwise so nobody
      // reads it as "we changed your county".
      dominantCountyFps: overrode ? resolved.countyFps : null,
      dominantCountyName: overrode ? resolved.countyName : null,
      source: `census-zcta-${zipCounty._internals.meta.vintage}`,
    }
    : null;
  sc = enriched;
  const loc = validateLocation(sc);
  if (!loc.ok) return { ok: false, status: 422, error: loc.code, field: loc.field, message: loc.message };
  // A PRICED SCENARIO MUST SAY WHERE THE PROPERTY IS. `validateLocation` deliberately passes a
  // scenario carrying NO location at all — its comment reads "base defaults apply", which was true
  // while the request inherited the pricing foundation's address. It no longer is: the address is
  // now scenario-owned and cleared, so a locationless scenario would send no state and no county.
  // Neither behaviour is acceptable and they fail differently — the OLD one silently priced every
  // such deal in Linden, New Jersey (the captured base's town), which is the silent-mis-pricing
  // class this connector exists to refuse; the NEW one would send a location-less request whose
  // upstream handling nothing has established. State and county drive DSCR eligibility and pricing,
  // so the honest answer is to refuse and say what is missing. Enrichment has already run, so a
  // 5-digit ZIP alone satisfies this.
  if (sc.state == null && sc.countyFps == null && sc.zip == null && sc.county == null && sc.countyName == null) {
    return { ok: false, status: 422, error: 'location_required', field: 'zip',
      message: 'Say where the property is: a 5-digit ZIP is enough (state and county are derived from it), or supply state + countyFps yourself. A quote cannot be priced without a location.' };
  }
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
  return { ok: true, request, scenario: sc, countyEnrichment };
}

module.exports = { BASE, buildSearch, clearScenarioOwnedFields, mergeKnownRequestDefaults, smoRegistryFromList, REGISTRY_WARNINGS, CASHOUT_INTERNAL, validateScenario, validateLocation, validateInputs, LpValidationError,
  _internals: { SMO_DSCR, SMO_PPP, resolveSmo, mapPurpose, mapProp, mapRentalTerm, RENTAL_TERM_ALIASES, dscrBand, mapReserves, RESERVES_TOKENS, PURPOSE_ALIASES, purposeKey, STATE_FIPS, strictNum, ALLOWED_LOCKS, ALLOWED_TERMS, LIVE_LOCKS, LIVE_TERMS, ATTACHMENT_TYPES, BOOLEAN_FIELDS, mortgageHistoryConflict, NONZERO_LATE_COUNTS, SCENARIO_OWNED, clearScenarioOwnedFields, mergeKnownRequestDefaults, SCENARIO_OWNED_DELETE: DELETE, deriveAmounts, compPlanValue } };
