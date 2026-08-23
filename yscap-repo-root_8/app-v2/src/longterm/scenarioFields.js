/**
 * THE PRICING ENGINE'S FORM RULES — what a field offers, when it appears, and the amount triangle.
 *
 * ⛔ WHY THIS IS A PLAIN `.js` MODULE AND NOT PART OF THE SCREEN. A `.jsx` file can only be loaded
 * by bundling it, and no CI job installs the front end's build tools — so a rule that lives inside
 * the screen is a rule CI cannot run. Everything here is pure, so `scripts/test-lt-pricer-fields.mjs`
 * imports it directly. Same reasoning as `priceBuild.js`, which was extracted for the same reason.
 *
 * ⛔ EVERY VALUE HERE IS A TOKEN THE SERVER ALREADY RESOLVES — never a label invented for the screen.
 * This is the whole lesson of the 2–4 family defect this module was written to fix: the screen had
 * been offering `TwoToFourFamily`, which `field-registry.resolvePropertyType` answers with `null`,
 * so the route refused it with `unknown_property_type` (422). The option was on the menu, it looked
 * exactly like the ones beside it, and picking it could not produce a price. So the drift guard in
 * that test does not check spelling — it RUNS the server's own resolver over every option this file
 * offers and fails if one of them does not resolve.
 *
 * ⛔ AND THE MIRROR IS A MIRROR. `deriveAmount` below reproduces the server's `deriveAmounts`
 * (search-model.js) so the screen can fill the loan box in as you type an LTV. The browser cannot
 * require server code, so a second copy is unavoidable — which is exactly why the test runs BOTH
 * over the same battery and fails the moment they disagree by a cent. Never "improve" the rounding
 * here on its own.
 */

/* ── property type ────────────────────────────────────────────────────────────
   The `value` is the upstream token. `Unit2_4` and `MultiFamily` are the registry's own spellings;
   `TwoToFourFamily` — the one the screen used to send — is NOT a token and never was. */
export const PROPERTY_TYPES = [
  { value: 'SingleFamily', label: 'Single family' },
  { value: 'Condo', label: 'Condo' },
  { value: 'Townhouse', label: 'Townhouse' },
  { value: 'PUD', label: 'PUD' },
  { value: 'Unit2_4', label: '2–4 family' },
  { value: 'MultiFamily', label: 'Multifamily (5+)' },
];

/**
 * WHAT THE UNITS BOX IS, for a given property type — the owner's rule: the unit count appears only
 * once it means something, it is a 2/3/4 CHOICE on a 2–4 family, and it is free to type on a
 * multifamily because "anything five and above" has no upper end.
 *
 * These bounds are not the screen's invention: `validateInputs` refuses a single-family with more
 * than one unit, a 2–4 family outside 2–4, and a multifamily under 5. Offering a number the server
 * would refuse is the same class of defect as offering a property type it cannot resolve, so the
 * control is shaped to the rule rather than left open and validated afterwards.
 */
export function unitsMode(propertyType) {
  if (propertyType === 'Unit2_4') return { mode: 'choice', options: [2, 3, 4], min: 2, max: 4 };
  if (propertyType === 'MultiFamily') return { mode: 'free', min: 5, max: null };
  return { mode: 'fixed', value: 1 };
}

/** The non-warrantable question belongs to a condo and to nothing else. It rides as its own boolean
 *  (`nonWarrantable`), which the builder applies OVER the type's own warrantability — so it stays a
 *  separate fact rather than a second condo token to keep in step. */
export function showsNonWarrantable(propertyType) {
  return propertyType === 'Condo';
}

/**
 * The units value that should be in force for a type — used when the type CHANGES, so a 4 left over
 * from a 2–4 family cannot ride into a single-family and be refused as a contradiction.
 * Returns a string because the form holds strings.
 */
export function unitsFor(propertyType, current) {
  const m = unitsMode(propertyType);
  if (m.mode === 'fixed') return String(m.value);
  const n = Number(current);
  if (m.mode === 'choice') return m.options.includes(n) ? String(n) : String(m.options[0]);
  return Number.isFinite(n) && n >= m.min ? String(n) : String(m.min);
}

/* ── borrower type ────────────────────────────────────────────────────────────
   The owner named LLC, Corporation and Individual. The tenant enum carries six, and the other three
   are real vesting types a deal can genuinely take — so all six are offered, with the owner's three
   first and LLC as the default (which is also the server's own profile default). Hiding a valid
   choice would make the screen refuse a loan the pricer would have quoted. */
export const BORROWER_TYPES = [
  { value: 'LLC', label: 'LLC' },
  { value: 'Corporation', label: 'Corporation' },
  { value: 'Individual', label: 'Individual' },
  { value: 'Partnership', label: 'Partnership' },
  { value: 'Trust', label: 'Trust' },
  { value: 'Non-Profit', label: 'Non-profit' },
];

/* ── prepayment penalty ───────────────────────────────────────────────────────
   TWO INDEPENDENT FACTS, which is the owner's own reading: the TERM is how long the penalty runs,
   the TYPE is how it is charged. They are separate fields upstream too — `PrepayTerm` and
   `PrePayment_Plan_Type` — and the connector's own note records that "No Prepay" (a null plan) is
   NOT the same operation as a term of None. So they are never collapsed into one menu.

   The terms are exactly the six the connector can resolve to a special mortgage option (No PPP and
   1–5 Yr PPP). A term outside that set falls back to a derived option, which is a different and
   less certain path — so the menu offers what is known to resolve. */
export const PREPAY_TERMS = [
  { value: '0', label: 'No prepayment penalty' },
  { value: '12', label: '1 year' },
  { value: '24', label: '2 years' },
  { value: '36', label: '3 years' },
  { value: '48', label: '4 years' },
  { value: '60', label: '5 years' },
];

/** The structures the tenant publishes, in the order a human thinks about them: the ordinary one,
 *  then the flat percentages (the owner's "5% fixed"), then the interest form (their "6 months'
 *  interest"), then the declining ladders. Every value is the LABEL side of the connector's own
 *  map — it accepts either the label or the token, and the label is what a person reads. */
export const PREPAY_STRUCTURES = [
  { value: 'Standard', label: 'Standard' },
  { value: 'No Prepay', label: 'No prepay' },
  { value: 'Fixed 5%', label: 'Fixed 5%' },
  { value: 'Fixed 4%', label: 'Fixed 4%' },
  { value: 'Fixed 3%', label: 'Fixed 3%' },
  { value: 'Fixed 2%', label: 'Fixed 2%' },
  { value: 'Fixed 1%', label: 'Fixed 1%' },
  { value: '6 Months Interest', label: "6 months' interest" },
  { value: 'Step Down', label: 'Step down' },
  { value: '5,4,3,2,1', label: '5,4,3,2,1' },
  { value: '5,4,3,3,3', label: '5,4,3,3,3' },
  { value: '5,4,3,3', label: '5,4,3,3' },
  { value: '5,4,3,2', label: '5,4,3,2' },
  { value: '4,3,2,1', label: '4,3,2,1' },
  { value: '5,4,3', label: '5,4,3' },
  { value: '3,2,1', label: '3,2,1' },
  { value: '5,4', label: '5,4' },
  { value: '2,1', label: '2,1' },
  { value: 'Other', label: 'Other' },
];

export const PURPOSES = [
  { value: 'Purchase', label: 'Purchase' },
  { value: 'RateTermRefinance', label: 'Rate & term refinance' },
  { value: 'CashOutRefinance', label: 'Cash-out refinance' },
];

/* ── the amount triangle, mirrored ────────────────────────────────────────────
   ⛔ THIS IS A COPY OF THE SERVER'S `deriveAmounts` AND MUST STAY ONE. The rounding is not
   incidental: money to the cent and the ratio to six decimals is what stops a figure that arrived
   as an LTV and a figure that arrived as a loan amount disagreeing in the last place. */
// ROUNDING, NOT FORMATTING — and the names say so. `format.js` exports a `money` and a `ratio`
// that turn a number into a STRING to show somebody; these turn a number into another NUMBER for
// the arithmetic to stay stable. Calling them the same thing is the `pct`/`rate` confusion this
// codebase already carries a guard against, so they are named for what they do.
const roundCents = (n) => Math.round(n * 100) / 100;
const roundRatio = (n) => Math.round(n * 1e6) / 1e6;
function numOf(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
/** Accept 75 or 0.75, exactly as the server does. */
export function normalizeLtv(v) {
  const n = numOf(v);
  if (n == null) return null;
  return roundRatio(n > 1 ? n / 100 : n);
}

/**
 * Given the two figures the person typed, work out the third.
 * Returns `{ value, loan, ltv, derived }` with `derived` naming what WE filled in — the screen
 * labels it, because a number nobody typed must never look like one somebody chose.
 * Never throws; a figure it cannot derive comes back null.
 */
export function deriveAmount({ value, loan, ltv }) {
  let v = numOf(value);
  let l = numOf(loan);
  let r = normalizeLtv(ltv);
  const derived = [];
  if (v != null && l != null) {
    if (v > 0) { const calc = roundRatio(l / v); if (r == null) derived.push('ltv'); r = calc; }
  } else if (l != null && r != null && r > 0) {
    v = roundCents(l / r); derived.push('value');
  } else if (v != null && r != null && v > 0) {
    l = roundCents(v * r); derived.push('loan');
  }
  for (const k of derived.slice()) {
    const got = k === 'value' ? v : k === 'loan' ? l : r;
    if (!(got > 0)) {
      if (k === 'value') v = null; else if (k === 'loan') l = null; else r = null;
      derived.splice(derived.indexOf(k), 1);
    }
  }
  return { value: v, loan: l, ltv: r, derived };
}

/* ── the scenario the API wants ───────────────────────────────────────────────
   Numbers as numbers, blanks omitted ENTIRELY. An empty string sent as a value IS a value — the
   pricer would have to guess what it meant, and this engine never guesses. Omitting the key lets
   the server's own default apply and say so in `effectiveScenario`. */
const NUMERIC = new Set(['value', 'loan', 'fico', 'dscr', 'units', 'lockDays', 'prepayMonths', 'ltv']);
const BOOLEAN = new Set(['io', 'escrowWaive', 'nonWarrantable']);
/** Keys the form holds for its own bookkeeping and that are never sent upstream. */
const FORM_ONLY = new Set(['amountMode']);

export function toScenario(f) {
  const out = {};
  const src = f || {};
  const mode = src.amountMode === 'ltv' ? 'ltv' : 'loan';
  for (const [k, v] of Object.entries(src)) {
    if (FORM_ONLY.has(k)) continue;
    if (v === '' || v == null) continue;
    // THE AMOUNT THE PERSON DID NOT TYPE IS NOT SENT. In LTV mode the loan box holds a figure the
    // screen derived, and shipping it alongside the LTV would put two views of one fact on the wire
    // for the server to reconcile — it refuses a supplied LTV that disagrees with loan ÷ value, so a
    // rounding difference of a cent would come back as `ltv_conflict` rather than a price. Sending
    // only what was typed leaves exactly one authority for the third figure: the server's own.
    if (mode === 'ltv' && k === 'loan') continue;
    if (mode === 'loan' && k === 'ltv') continue;
    if (BOOLEAN.has(k)) { if (v === true || v === 'true') out[k] = true; continue; }
    out[k] = NUMERIC.has(k) ? Number(v) : v;
  }
  // A units figure that contradicts the property type is refused upstream, so the form's own rule
  // decides it rather than whatever was left in the box when the type changed.
  if (out.propertyType) out.units = Number(unitsFor(out.propertyType, out.units));
  return out;
}
