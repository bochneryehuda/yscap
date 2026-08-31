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
   ⛔ THREE, BY OWNER DIRECTION (2026-08-23): *"for now, you can park the rest of the options. You
   can leave only LLC, corporation, and individual."* The tenant enum carries six — Partnership,
   Trust and Non-Profit are real vesting types the pricer would quote — so this is a PARKING, not a
   discovery that they are invalid. They are named here rather than deleted so bringing one back is
   one line and nobody has to re-derive the tenant's spelling for it.

   Every value is the upstream token, and the drift guard in test-lt-pricer-fields.mjs runs the
   SERVER'S OWN `registry.BORROWER_TYPES` over each one — so a spelling this file invents fails the
   build rather than reaching a person as an option that cannot price. */
export const BORROWER_TYPES = [
  { value: 'LLC', label: 'LLC' },
  { value: 'Corporation', label: 'Corporation' },
  { value: 'Individual', label: 'Individual' },
];
/** PARKED by owner direction, not retired: the other three tokens the tenant enum carries. Kept
 *  beside the live list so restoring one is an edit, never a fresh piece of research. */
export const BORROWER_TYPES_PARKED = [
  { value: 'Partnership', label: 'Partnership' },
  { value: 'Trust', label: 'Trust' },
  { value: 'Non-Profit', label: 'Non-profit' },
];

/* ── the loan term ────────────────────────────────────────────────────────────
   Owner-directed 2026-08-23: a small box for the term of the loan, offering "15-year, 30-year and
   40-year".

   A CURATED SUBSET, NOT THE VENDOR'S WHOLE LIST, and that is deliberate. The connector accepts 5,
   then 8 through 30, then 40 (`ALLOWED_TERMS` in search-model.js — the live frontend's own list),
   so every one of these three is a term Lender Price will price; what this menu does is offer the
   three anybody actually asks for instead of twenty-five. Adding one back is one line here, and it
   cannot be refused downstream as long as it stays inside that list. */
export const LOAN_TERMS = [
  { value: '15', label: '15-year' },
  { value: '30', label: '30-year' },
  { value: '40', label: '40-year' },
];

/** 30 is also what the SERVER already falls back to when no term is sent (`effTermYears`), so
 *  putting this box on the screen changes nothing about what today's scenarios ask for — it makes
 *  the existing default visible and movable. */
export const DEFAULT_TERM_YEARS = '30';

/** THE LOCK IS A DROP-DOWN (owner-directed 2026-08-23): "defaulted to 30 days, but should have
 *  the option for 15 days, 45 days, and 60 days." The default stays the 30 the field has carried
 *  since it shipped (`emptyFields.lockDays`); a free-typed number was a way to ask Lender Price
 *  for a lock nobody offers. Plain strings, because `lockDays` rides the NUMERIC coercion on the
 *  way to the wire exactly as it always has. */
export const LOCK_DAYS = ['15', '30', '45', '60'];

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
/**
 * AN LTV IS LIFTED UP, NEVER ROUNDED DOWN.
 *
 * The same directional rule the server applies in `pricing/tier-rounding.js`:
 * *"A higher LTV prices worse, so an LTV is never rounded down — that would ask
 * for a band the loan has not earned."*
 *
 * ⛔ THIS WAS `Math.round`, AND THAT IS EXACTLY THE DRIFT THIS FILE'S PARITY TEST
 * EXISTS TO CATCH. When the server adopted directional rounding, this second copy
 * of the triangle was not moved with it, so 87,500 / 375,000 read 0.233333 on the
 * screen and 0.233334 on the server — the screen quoting a band the server would
 * not price, on nine of the seventy-eight cases in the shared battery. The copy is
 * deliberate (a browser cannot require server code); keeping the two rules
 * identical is the price of it.
 */
const RATIO_SLACK = (x) => Math.max(1e-9, Math.abs(x) * 1e-12);
const roundRatio = (n) => {
  if (!Number.isFinite(n)) return null;
  const x = n * 1e6;
  const whole = Math.round(x);
  // Within float noise of a representable 6dp figure, that figure IS the answer —
  // lifting there would invent a band out of a rounding artefact.
  return (Math.abs(x - whole) < RATIO_SLACK(x) ? whole : Math.ceil(x)) / 1e6;
};
// ONE reading of a typed figure, shared with the amount triangle below.
const numOf = toNumber;
/** Accept 75 or 0.75, exactly as the server does. */
export function normalizeLtv(v) {
  const n = numOf(v);
  if (n == null) return null;
  return roundRatio(n > 1 ? n / 100 : n);
}

/* ── money, as a person writes it ─────────────────────────────────────────────
   ⛔ THE FORM HOLDS THE TYPED TEXT, NOT A NUMBER, and these two are the only conversion. The owner
   asked for the property value and the loan amount to read "as dollars with a dollar sign with
   commas" — so the box shows `500,000` (the dollar sign is a fixed mark drawn beside it, never a
   character the person has to type or delete). What goes on the wire is a NUMBER, which is why
   `toScenario` parses through `toNumber` below: `Number("500,000")` is NaN, and a NaN reaching the
   pricer as a property value is the silent-mispricing class this connector was hardened against.

   DIGITS ONLY, DELIBERATELY. No decimal point: a property value and a loan amount are whole dollars
   on every rate sheet this prices against, and allowing cents would put a figure on screen that the
   grouping then has to reconcile as somebody types through it. A pasted "$1,250,000.00" keeps its
   WHOLE-DOLLAR digits and drops the rest rather than being refused — refusing a paste is how a
   person ends up retyping a number they already had right. */
export function digitsOf(v) {
  // A DECIMAL FRACTION IS DROPPED WHOLE, not folded into the digits. Stripping every non-digit from
  // a pasted "$1,250,000.00" glues the cents on and reads $1.25M as $125M — a hundredfold error, on
  // the property value, silently. So the text is cut at the first decimal point first.
  const head = String(v == null ? '' : v).split('.')[0];
  return head.replace(/\D+/g, '');
}
/** `500000` → `500,000`. An empty box stays empty — never `0`, which is a figure somebody chose. */
export function formatMoney(v) {
  const d = digitsOf(v).replace(/^0+(?=\d)/, '');
  if (!d) return '';
  return d.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
/** The one parse. Accepts what any of these boxes can hold — `$1,250,000`, `75%`, `1.20`, `` — and
 *  answers null for anything that is not a finite number, so a caller never ships NaN. */
export function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
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
const NUMERIC = new Set(['value', 'loan', 'fico', 'dscr', 'units', 'lockDays', 'prepayMonths', 'ltv', 'termYears']);
// `fthb` is the first-time-homebuyer flag the owner asked for, and it is the SAME fact Lender
// Price's own screen carries: the route already accepts it and the builder writes it to
// `criteria.firstTimeHomeBuyer`. Nothing server-side had to change — it had simply never been
// reachable from a screen.
const BOOLEAN = new Set(['io', 'escrowWaive', 'nonWarrantable', 'fthb']);
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
    if (NUMERIC.has(k)) {
      // ⛔ THROUGH `toNumber`, NEVER A BARE `Number(v)`. The money boxes hold grouped text now
      // ("500,000"), and `Number("500,000")` is NaN — which the route would take as a property
      // value and price a scenario nobody described. A figure that cannot be read is OMITTED, so
      // the server's own refusal names the missing fact instead of quoting a guess.
      const n = toNumber(v);
      if (n != null) out[k] = n;
      continue;
    }
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  // A units figure that contradicts the property type is refused upstream, so the form's own rule
  // decides it rather than whatever was left in the box when the type changed.
  if (out.propertyType) out.units = Number(unitsFor(out.propertyType, out.units));
  return out;
}

/**
 * WHY A SEARCH CANNOT BE SENT YET — or null when it can (owner-directed 2026-08-23).
 *
 * The owner: *"If the zip code is empty on somebody's price … your system is trying to price it
 * and is getting back with an error. You need to know by yourself"* — the person waited through
 * a doomed vendor call to be told what this form could see before it was pressed. So the screen
 * asks THIS rule before anything reaches the wire, and a scenario that cannot price never spends
 * the call or the wait.
 *
 * ⛔ IT REFUSES ONLY WHAT IS PROVABLY UNPRICEABLE FROM HERE — a missing/short ZIP, a ZIP the
 * lookup PROVED unresolvable with no typed state+county behind it, and an unreadable value /
 * amount / FICO / DSCR. Judgement about the FACTS (an implausible FICO, a unit mismatch) stays
 * the server's: a second copy of those rules here would drift, and the server's refusals already
 * answer in plain words. `zipStatus` is the screen's own lookup state ('ok' | 'error' |
 * 'loading' | 'idle'); a lookup still in flight does NOT block — the server resolves the ZIP
 * itself, and the client lookup is display.
 *
 * Pure; never throws. Returns a plain-English sentence, or null.
 */
export function searchProblem(f, zipStatus) {
  const src = f || {};
  const zip = String(src.zip || '').trim();
  if (!/^\d{5}$/.test(zip)) {
    return 'Type the property’s five-digit ZIP first — it decides the state and county the loan is priced in, and a search without one cannot price.';
  }
  if (zipStatus === 'error') {
    const state = String(src.state || '').trim();
    const county = String(src.county || '').trim();
    if (!(state.length === 2 && county)) {
      return 'That ZIP could not be matched to a county — type the two-letter state and the county so the scenario carries a location.';
    }
  }
  if (toNumber(src.value) == null) return 'Type the property value — every price is sized against it.';
  if (src.amountMode === 'ltv') {
    if (toNumber(src.ltv) == null) return 'Type the LTV — or switch to Loan $ and type the loan amount.';
  } else if (toNumber(src.loan) == null) {
    return 'Type the loan amount — or switch to LTV % and type the ratio.';
  }
  if (toNumber(src.fico) == null) return 'Type a FICO — the score the scenario is priced at.';
  if (toNumber(src.dscr) == null) return 'Type a DSCR — or open Calculate and work it out from the rent.';
  return null;
}

/**
 * THE SEARCH, AS A ROW OF SMALL FACTS — what the sticky strip shows while the form is collapsed
 * (owner-directed 2026-08-23: *"While it's collapsing, you should be able to see the basic
 * details that you're searching right now, small and nicely laid out"*).
 *
 * Built from the FORM SNAPSHOT the price was pressed with, so the strip describes the search
 * that produced the board — never a half-edited form (staleness is said separately). Labels come
 * from the option lists themselves, so a renamed option renames its chip with nothing to keep
 * in step. A fact that is blank is simply absent — a chip reading "FICO —" says nothing.
 *
 * Pure; never throws. Returns [{ k, v }].
 */
export function searchChips(f, zipInfo) {
  const src = f || {};
  const chips = [];
  const labelOf = (list, v) => {
    const hit = list.find((x) => x.value === String(v));
    return hit ? hit.label : String(v);
  };
  const moneyish = (v) => {
    const n = toNumber(v);
    return n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`;
  };
  chips.push({ k: 'Purpose', v: labelOf(PURPOSES, src.purpose) });
  const val = moneyish(src.value);
  if (val) chips.push({ k: 'Value', v: val });
  if (src.amountMode === 'ltv') {
    if (String(src.ltv || '').trim() !== '') chips.push({ k: 'LTV', v: `${src.ltv}%` });
  } else {
    const loan = moneyish(src.loan);
    if (loan) chips.push({ k: 'Loan', v: loan });
  }
  if (String(src.fico || '').trim() !== '') chips.push({ k: 'FICO', v: String(src.fico) });
  if (String(src.dscr || '').trim() !== '') chips.push({ k: 'DSCR', v: String(src.dscr) });
  const zip = String(src.zip || '').trim();
  if (zip) {
    const place = zipInfo && zipInfo.state
      ? `${zip} · ${zipInfo.state}${zipInfo.county ? `, ${zipInfo.county}` : ''}`
      : zip;
    chips.push({ k: 'ZIP', v: place });
  } else if (String(src.state || '').trim()) {
    chips.push({ k: 'State', v: String(src.state).trim() });
  }
  const um2 = unitsMode(src.propertyType);
  chips.push({
    k: 'Property',
    v: labelOf(PROPERTY_TYPES, src.propertyType)
      + (um2.mode !== 'fixed' && Number(src.units) > 1 ? ` · ${src.units} units` : ''),
  });
  if (String(src.termYears || '').trim() !== '') chips.push({ k: 'Term', v: `${src.termYears} yr` });
  if (String(src.lockDays || '').trim() !== '') chips.push({ k: 'Lock', v: `${src.lockDays} d` });
  if (src.prepayMonths === '0') chips.push({ k: 'Prepay', v: 'None' });
  else if (String(src.prepayMonths || '').trim() !== '') {
    chips.push({ k: 'Prepay', v: `${Math.round(Number(src.prepayMonths) / 12)} yr ${src.prepayStructure || ''}`.trim() });
  }
  const flags = [
    src.io ? 'Interest-only' : null,
    src.escrowWaive ? 'Escrow waived' : null,
    src.fthb ? 'First-time buyer' : null,
    src.nonWarrantable ? 'Non-warrantable' : null,
  ].filter(Boolean);
  if (flags.length) chips.push({ k: 'Options', v: flags.join(' · ') });
  return chips;
}
