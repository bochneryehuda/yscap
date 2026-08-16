'use strict';
/**
 * Richer Values — the PURE order builder.
 *
 * No database, no network, no config. It takes a normalized loan-file context
 * (built by order-service.js) plus the staffer's choices, and returns the exact
 * multipart fields their intake endpoint would receive, together with what is
 * still MISSING, what PILOT DERIVED (so a human can check it), and what was
 * deliberately DROPPED because their validator forbids it on this branch.
 *
 * WHY "FORBIDDEN" IS A FIRST-CLASS OUTPUT AND NOT A DETAIL. Their validator is an
 * allow-list per branch: sending a field that does not belong to the branch you
 * chose fails the WHOLE order, and it fails it as an HTTP 200 carrying
 * `success:false`. Confirmed live — a pricing call carrying `gla_include` came
 * back `"gla_include" is not allowed`. So the builder does not merely fill fields
 * in; its real job is to send exactly the set the chosen branch allows and to say
 * out loud what it left out. A "harmless" extra field is not harmless here.
 *
 * THE BRANCHES, each of which turns a group of fields on and its opposite off:
 *   • single vs batch                (the address block vs the portfolio + file)
 *   • vacant land vs a structure     (and, under a structure, partly built or not)
 *   • flood certification on or off  (the borrower's name rides with it)
 *   • a historical effective date    (or none, in which case sending one fails)
 *   • the inspection type            (lockbox fields, or access contacts, or neither)
 *
 * NOTHING HERE IS GUESSED. A value PILOT cannot work out is reported as MISSING
 * for a human to answer — never defaulted into the order. The one exception is a
 * value the vendor's own catalogue makes unambiguous (their `standard` turnaround),
 * and even that is reported as an assumption.
 *
 * All of it is measured against the vendor's "Field Validation Rules" page for
 * `POST /api/v1/order/submit`, and every rule below was exercised against their
 * live training tenant before it was written down.
 */

// ---------------------------------------------------------------------------
// Their closed vocabularies. Kept here so the screen's pickers and the builder's
// validation can never drift — the screen reads these through `screenOptions()`.
// The report / inspection / turnaround catalogues are NOT here: those are served
// by their API per company and are cached in rv_reference_cache, because they are
// entitlements (what THIS client may order), not a fixed list.
// ---------------------------------------------------------------------------
const PROPERTY_CONDITIONS = [
  { value: 'new-construction',    label: 'Newly built',          note: 'Built in the last year or two (C1).' },
  { value: 'fully-remodeled',     label: 'Fully remodeled',      note: 'Remodeled throughout to today’s standards (C2).' },
  { value: 'partially-remodeled', label: 'Partly remodeled',     note: 'Some recent upgrades (C3).' },
  { value: 'maintained',          label: 'Well kept',            note: 'Marketable, good upkeep (C3.5).' },
  { value: 'moderate',            label: 'Worn',                 note: 'Worn, may have things needing repair (C4).' },
  { value: 'poor',                label: 'Poor',                 note: 'In definite disrepair (C5).' },
  { value: 'very-poor',           label: 'Very poor',            note: 'Needs major repair (C5.5).' },
  { value: 'unsalvageable',       label: 'Tear down',            note: 'Needs to come down and be rebuilt.' },
];

const RESIDENTIAL_TYPES = [
  { value: 'sfr',         label: 'Single family' },
  { value: 'townhouse',   label: 'Townhouse' },
  { value: 'condo',       label: 'Condo' },
  { value: 'duplex',      label: 'Duplex (2 units)' },
  { value: 'triplex',     label: 'Triplex (3 units)' },
  { value: 'quadruplex',  label: 'Quadruplex (4 units)' },
  { value: 'mobile',      label: 'Mobile / manufactured' },
];
const RESIDENTIAL_TYPE_VALUES = new Set(RESIDENTIAL_TYPES.map((t) => t.value));
// Their `residential_prop_type_units` is required for exactly these three.
const UNITS_REQUIRED_TYPES = new Set(['duplex', 'triplex', 'quadruplex']);
const UNITS_OF_TYPE = { duplex: 2, triplex: 3, quadruplex: 4 };
// A condo has no lot of its own — sending a lot size for one is REFUSED.
const NO_LOT_TYPES = new Set(['condo']);

const LOCKBOX_LOCATIONS = [
  { value: 'front-door', label: 'Front door' },
  { value: 'back-door', label: 'Back door' },
  { value: 'left-side-of-house', label: 'Left side of the house' },
  { value: 'right-side-of-house', label: 'Right side of the house' },
  { value: 'garage-door', label: 'Garage door' },
  { value: 'other', label: 'Somewhere else' },
];
const LOCKBOX_ENTRANCES = [
  { value: 'front-door', label: 'Front door' },
  { value: 'back-door', label: 'Back door' },
  { value: 'other', label: 'Another door' },
];

// ---------------------------------------------------------------------------
// What KIND of inspection a slug is — which is what decides whether the lockbox
// block or the access-contact block applies. Their rules are written in terms of
// "interior, non-direct" / "direct" / "exterior-only" / "none", never in terms of
// individual slugs, so this is the one place a slug becomes a kind.
// A slug we have never seen is 'unknown', and an unknown kind sends NEITHER
// block — the safe reading, because sending a forbidden field fails the order
// while omitting a required one fails with a message naming the field.
// ---------------------------------------------------------------------------
const INSPECTION_KIND = {
  'interior-w-exterior': 'interior',
  'pdi-interior': 'interior',
  'streamlined-interior': 'interior',
  'interior-homeowner-direct': 'direct',
  'streamlined-interior-direct': 'direct',
  'draw-inspection-direct': 'direct',
  'draw-inspection': 'interior',
  'exterior': 'exterior',
  'exterior-w-gla': 'exterior',
  'streamlined-exterior': 'exterior',
  'pdi-exterior': 'exterior',
  'none': 'none',
};

function inspectionKind(slug) { return INSPECTION_KIND[String(slug || '').trim()] || 'unknown'; }
/** Lockbox fields apply to an INTERIOR, NON-DIRECT inspection and to nothing else. */
function lockboxApplies(slug) { return inspectionKind(slug) === 'interior'; }
/**
 * At least one property-access contact is required when the inspection is
 * homeowner-led (they are the one doing it), or when it is an interior
 * inspection that is NOT on a lockbox (somebody has to let the inspector in).
 */
function contactsRequired(slug, onLockbox) {
  const kind = inspectionKind(slug);
  if (kind === 'direct') return true;
  if (kind === 'interior') return onLockbox !== true;
  return false;
}
/** Whether an inspection happens at all — 'none' means a desktop report. */
function hasInspection(slug) { return inspectionKind(slug) !== 'none' && !!slug; }

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------
const trim = (v) => (v == null ? '' : String(v).trim());
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function int(v) { const n = num(v); return n == null ? null : Math.round(n); }
/** Their phone fields are EXACTLY ten digits — no dashes, no country code. */
function tenDigits(v) {
  const d = trim(v).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : null;
}
function isEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trim(v)); }
/** A calendar day string, never a Date — the repo's date-only rule. */
function dayString(v) {
  const s = trim(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s && /^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return null;
}
function todayString(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// PILOT → their vocabulary. Each of these REFUSES rather than guesses.
// ---------------------------------------------------------------------------
/**
 * Our canonical property key + unit count → their residential type.
 * `multi_5_plus` deliberately returns null: their residential list stops at four
 * units, so a 5+ property is not orderable as this product and the caller turns
 * that into a plain refusal rather than quietly ordering the wrong thing.
 */
function residentialTypeFor(propertyKey, units) {
  const k = trim(propertyKey).toLowerCase();
  if (k === 'sfr') return 'sfr';
  if (k === 'condo') return 'condo';
  if (k === 'townhouse') return 'townhouse';
  if (k === 'multi_2_4') {
    const u = int(units);
    if (u === 2) return 'duplex';
    if (u === 3) return 'triplex';
    if (u === 4) return 'quadruplex';
    return null;                 // 2–4 with no unit count — a human picks which
  }
  return null;                   // multi_5_plus, mixed use, land, unknown
}

/**
 * A UAD condition rating (C1…C6, or the "C4" inside a longer string) → their
 * condition. Their own documentation gives this mapping explicitly, which is why
 * it is safe to derive; it is still reported as an assumption.
 */
const UAD_TO_CONDITION = {
  c1: 'new-construction', c2: 'fully-remodeled', c3: 'partially-remodeled',
  'c3.5': 'maintained', c4: 'moderate', c5: 'poor', 'c5.5': 'very-poor', c6: 'unsalvageable',
};
function propertyConditionFromUad(v) {
  const s = trim(v).toLowerCase();
  if (!s) return null;
  const m = /c\s*([1-6](?:\.5)?)/.exec(s);
  if (!m) return null;
  return UAD_TO_CONDITION[`c${m[1]}`] || null;
}

/**
 * Our rehab tier → their condition, as a STARTING POINT only. A rehab tier says
 * how much work is planned, which correlates with condition but does not state
 * it, so this is always reported as an assumption for a human to confirm — and a
 * tier we do not recognise returns null rather than a middle value.
 */
function propertyConditionFromRehab(rehabType) {
  const s = trim(rehabType).toLowerCase();
  if (!s) return null;
  if (/ground[\s_-]*up|new[\s_-]*construction/.test(s)) return 'new-construction';
  if (/cosmetic|light/.test(s)) return 'maintained';
  if (/moderate/.test(s)) return 'moderate';
  if (/heavy|gut|adding\s*sf/.test(s)) return 'poor';
  return null;
}

// ---------------------------------------------------------------------------
// THE BUILDER.
//
// `ctx`     — the normalized loan file (order-service.loadContext)
// `choices` — what the staffer picked on the screen, plus the resolved vendor
//             tokens (companyToken / loanOfficerToken) the client works out.
//
// Returns { fields, missing, assumptions, dropped, canPlace, blocked }.
//   fields      the exact multipart body
//   missing     [{field, label, why}] — the order cannot go until these are answered
//   assumptions [{field, label, value, why}] — PILOT worked it out; check it
//   dropped     [{field, why}] — deliberately NOT sent (their validator forbids it)
//   blocked     a plain-English refusal that no amount of typing can fix
//               (a 5+ unit property; a batch order, which this desk does not do)
// ---------------------------------------------------------------------------
function buildOrder(ctx = {}, choices = {}) {
  const fields = {};
  const missing = [];
  const assumptions = [];
  const dropped = [];
  let blocked = null;

  const need = (field, label, why) => missing.push({ field, label, why: why || null });
  const derived = (field, label, value, why) => assumptions.push({ field, label, value, why });
  const drop = (field, why) => dropped.push({ field, why });
  const set = (field, value) => { if (value != null && value !== '') fields[field] = value; };

  const property = ctx.property || {};
  const specs = ctx.specs || {};
  const contact = ctx.reportContact || {};

  // ---- identity -----------------------------------------------------------
  set('company_token', choices.companyToken);
  if (!choices.companyToken) need('company_token', 'Which Richer Values company to order for',
    'Set RV_COMPANY_TOKEN, or configure a username and password so it can be worked out automatically.');

  set('loan_officer_token', choices.loanOfficerToken);
  if (!choices.loanOfficerToken) need('loan_officer_token', 'Who the order is placed by at Richer Values',
    'Set RV_LOAN_OFFICER_TOKEN, or configure a username and password so the API user is used.');

  // Their `order_placing_from` marks where an order came from. Documented value
  // for an integration is `rest_api`; it is not required, and it is what makes an
  // order recognisable as ours on their screens.
  set('order_placing_from', 'rest_api');
  set('client_loan_number', ctx.clientLoanNumber);

  // ---- the product -------------------------------------------------------
  const reportType = trim(choices.reportType) || null;
  set('report_type', reportType);
  if (!reportType) need('report_type', 'Which report', 'Pick the report to order.');

  // 'none' is a real, orderable inspection type on their side (a desktop report),
  // so an EMPTY choice is missing while an explicit 'none' is a decision.
  const inspectionType = choices.inspectionType == null ? null : trim(choices.inspectionType);
  set('inspection_type', inspectionType);
  if (!inspectionType) need('inspection_type', 'Which inspection', 'Pick the inspection, or “None” for a desktop report.');

  const turnaround = trim(choices.turnaroundTime) || null;
  set('turnaround_time', turnaround);
  if (!turnaround) need('turnaround_time', 'How fast', 'Pick standard or rush.');

  // Their three booleans are sent as the strings "0"/"1" — sending a JSON true
  // is refused. include_flood_certification is ALWAYS required (it is a yes/no
  // question, and "no" still has to be answered).
  const flood = choices.includeFloodCertification === true;
  set('include_flood_certification', flood ? '1' : '0');
  set('gla_include', choices.glaInclude === true ? '1' : '0');
  set('licensing_required', choices.licensingRequired === true ? '1' : '0');

  // The borrower's name rides with flood certification and is FORBIDDEN without it.
  if (flood) {
    const borrowerName = trim(choices.borrowerName) || trim(ctx.borrowerName);
    set('borrower_name', borrowerName);
    if (!borrowerName) need('borrower_name', 'Borrower’s name',
      'Their flood certificate is issued in the borrower’s name, so it is required whenever flood certification is included.');
  } else if (trim(choices.borrowerName)) {
    drop('borrower_name', 'Only sent when flood certification is included — sending it otherwise is refused.');
  }

  // ---- dates -------------------------------------------------------------
  // Their closing date must be today or later. A file whose expected closing has
  // already passed is a real and common state, so this is reported for a human
  // rather than silently pushed forward.
  const closing = dayString(choices.closingDate) || dayString(ctx.expectedClosing);
  const today = todayString(choices.now);
  if (!closing) {
    need('closing_date', 'Expected closing date', 'Richer Values requires a closing date on every order.');
  } else if (closing < today) {
    need('closing_date', 'Expected closing date',
      `The closing date on the file (${closing}) has already passed, and they only accept today or later. Set the real expected closing date.`);
  } else {
    set('closing_date', closing);
    if (!dayString(choices.closingDate)) derived('closing_date', 'Expected closing date', closing, 'Taken from the loan file’s expected closing date.');
  }

  // A historical effective date is a deliberate, rare choice. Their rule is
  // strict in BOTH directions: with the flag off, sending a date is refused; with
  // it on, the date must be at least 15 days in the past.
  const wantsHistorical = choices.historicalEffectiveDate === true;
  if (wantsHistorical) {
    set('historical_effective_date', '1');
    const eff = dayString(choices.effectiveDate);
    if (!eff) need('effective_date', 'Historical valuation date', 'Pick the date the value should be as of.');
    else if (!atLeastDaysBefore(eff, today, 15)) {
      need('effective_date', 'Historical valuation date',
        'Richer Values only accepts a historical date at least 15 days in the past.');
    } else set('effective_date', eff);
  } else {
    if (choices.effectiveDate) drop('effective_date', 'Only sent for a historical valuation date — sending it otherwise is refused.');
  }

  // ---- single vs batch ---------------------------------------------------
  // This desk orders ONE property at a time, deliberately: a PILOT order belongs
  // to a loan file, and a loan file is one property. Their batch endpoint is
  // supported by the client for a future portfolio surface; it is refused here
  // rather than half-built.
  const uploadType = trim(choices.propertyUploadType) || 'single';
  if (uploadType !== 'single') {
    blocked = 'This desk orders one property at a time, because an order belongs to a loan file. A portfolio order is a separate piece of work.';
  }
  set('property_upload_type', 'single');

  // ---- vacant land / partly built ----------------------------------------
  const vacantLand = choices.isVacantLand === true;
  set('is_property_vacant_land', vacantLand ? '1' : '0');
  if (vacantLand) {
    // Both of these belong to the "there is a structure" branch and are refused
    // on vacant land.
    if (choices.isPartiallyCompleted != null) drop('is_property_partially_completed', 'Not sent for vacant land — sending it is refused.');
    if (choices.partiallyCompletedPercentage != null) drop('partially_completed_estimated_percentage', 'Not sent for vacant land — sending it is refused.');
  } else {
    const partly = choices.isPartiallyCompleted === true;
    set('is_property_partially_completed', partly ? '1' : '0');
    if (partly) {
      const pct = int(choices.partiallyCompletedPercentage);
      if (pct == null) need('partially_completed_estimated_percentage', 'How far along the construction is',
        'Give the percentage complete (0–100).');
      else if (pct < 0 || pct > 100) need('partially_completed_estimated_percentage', 'How far along the construction is',
        'It has to be between 0 and 100.');
      else set('partially_completed_estimated_percentage', String(pct));
    } else if (choices.partiallyCompletedPercentage != null) {
      drop('partially_completed_estimated_percentage', 'Only sent when the property is under construction — sending it otherwise is refused.');
    }
  }

  // ---- the property ------------------------------------------------------
  const street = trim(choices.propertyAddress) || trim(property.addressLine);
  const city = trim(choices.city) || trim(property.city);
  const state = trim(choices.state) || trim(property.state);
  const zip = trim(choices.postalCode) || trim(property.postalCode);
  set('property_address', street);
  set('city', city);
  set('state', state);
  set('postal_code', zip);
  set('property_address_line_2', trim(choices.propertyAddressLine2) || trim(property.addressLine2));
  set('unit_number', trim(choices.unitNumber) || trim(property.unitNumber));
  if (!street) need('property_address', 'Street address', 'The property address on the file is empty.');
  if (!city) need('city', 'City', 'The property address on the file has no city.');
  if (!state) need('state', 'State', 'The property address on the file has no state.');
  if (!zip || zip.length < 3) need('postal_code', 'ZIP code', 'The property address on the file has no ZIP code.');

  // Their residential type. A chosen value always wins; otherwise it is derived
  // from the file's own property type and unit count.
  let resType = trim(choices.residentialPropertyType) || null;
  if (resType && !RESIDENTIAL_TYPE_VALUES.has(resType)) resType = null;
  if (!resType) {
    const auto = residentialTypeFor(property.categoryKey, property.units);
    if (auto) {
      resType = auto;
      derived('residential_property_type', 'Property type', auto,
        `Worked out from the file’s property type${property.units ? ` and ${property.units} units` : ''}.`);
    }
  }
  if (resType) set('residential_property_type', resType);
  else if (trim(property.categoryKey).toLowerCase() === 'multi_5_plus') {
    blocked = 'Richer Values’s report covers one to four units. This file is a 5+ unit property, so it is not something they can value.';
  } else {
    need('residential_property_type', 'Property type', 'Pick what kind of property this is.');
  }

  // Their unit count, required for exactly the 2–4 unit types.
  if (resType && UNITS_REQUIRED_TYPES.has(resType)) {
    const u = int(choices.residentialPropTypeUnits) != null ? int(choices.residentialPropTypeUnits) : UNITS_OF_TYPE[resType];
    set('residential_prop_type_units', String(u));
  }

  // Condition. Their catalogue makes the UAD mapping unambiguous, so an appraisal
  // rating on the file derives it; otherwise the rehab tier is a starting point;
  // otherwise a human picks. It is never defaulted to a middle value.
  let condition = trim(choices.propertyCondition) || null;
  if (condition && !PROPERTY_CONDITIONS.some((c) => c.value === condition)) condition = null;
  if (!condition) {
    const fromUad = propertyConditionFromUad(specs.conditionUad);
    if (fromUad) { condition = fromUad; derived('property_condition', 'Condition', fromUad, `Taken from the condition rating on file (${trim(specs.conditionUad)}).`); }
  }
  if (!condition) {
    const fromRehab = propertyConditionFromRehab(ctx.rehabType);
    if (fromRehab) { condition = fromRehab; derived('property_condition', 'Condition', fromRehab, `A starting point from the file’s ${trim(ctx.rehabType)} rehab — please check it against what you know about the property.`); }
  }
  if (condition) set('property_condition', condition);
  else need('property_condition', 'Condition', 'Pick the property’s condition today.');

  // ---- current specifications --------------------------------------------
  // These describe the property AS IT STANDS TODAY, and `specFor` records where
  // each value came from so the screen can show it.
  //
  // A REPORT ABOUT A PROPERTY THAT DOES NOT EXIST YET HAS NONE OF THEM, and that
  // is the vendor's own distinction, not ours: their report-type catalogue carries
  // `ask_current_stats`, which is 1 on the two reports about a standing building
  // (Property Valuation, Renovation Analysis) and 0 on the two construction ones
  // (New Construction, Partial/Incomplete Construction). A vacant lot has no
  // bedrooms, no bathrooms, no year built and no living area — so demanding them
  // made BOTH construction products impossible to order: `canPlace` stayed false
  // for ever on figures no human could truthfully supply, and `placeOrder` refused
  // with `incomplete`.
  //
  // MEASURED, NOT ASSUMED — this relaxes what BLOCKS, never what is SENT. Their
  // validator was probed live on every branch (a submit deliberately missing a
  // required field, so it could only ever be refused and could create nothing):
  // not one current statistic came back "is not allowed" on either construction
  // product, and their own required list is `include_flood_certification`,
  // `closing_date`, `property_address`, `property_condition` and
  // `report_contact_phone` — none of these. So a figure we DO know is still sent
  // on every product; only the refusal goes away where the report never asked.
  //
  // `asksCurrentStats` is read straight off their catalogue (reference.js already
  // normalized it and nothing had ever consumed it) and is tested `=== false`, so
  // an unknown report type, an unreachable catalogue or an older caller keeps
  // today's behaviour exactly.
  //
  // A MISSING SPEC IS A MISSING SPEC, NOT A CRASH. `ctx.specs` is whatever the
  // caller happened to build, and every read here used to be `specs.<key>.value` —
  // so a context that simply had no square footage on it (a brand-new file, a
  // property PILOT knows nothing about yet) threw `Cannot read properties of
  // undefined`, and the whole order PREVIEW answered 500 instead of showing the
  // desk which figures it still needs. Found by the A-to-Z audit engine, which
  // generates contexts nobody would sit down and type.
  //
  // THE CLASS: a builder that trusts a shape its one caller happens to produce is
  // one refactor away from a crash on the screen. `spec()` is the whole fix — an
  // absent key now reads as "nothing on file", which is exactly what `need()`
  // already knows how to say.
  const spec = (key) => {
    const v = specs && specs[key];
    return v && typeof v === 'object' ? v : { value: v == null ? null : v, source: null };
  };
  const specField = (field, label, chosen, fromFile, opts = {}) => {
    const from = fromFile && typeof fromFile === 'object' ? fromFile : { value: null, source: null };
    const v = opts.asInt !== false ? int(chosen != null && chosen !== '' ? chosen : from.value)
      : num(chosen != null && chosen !== '' ? chosen : from.value);
    if (v == null || (opts.positive && v <= 0)) {
      if (!opts.optional) need(field, label, opts.why || 'Richer Values needs this on every order.');
      return null;
    }
    set(field, String(v));
    if ((chosen == null || chosen === '') && from.source) derived(field, label, v, from.source);
    return v;
  };

  // On a report that never asks about the standing building, every one of these is
  // "send it if we happen to know it" rather than "answer this before you order".
  const currentStatsAsked = choices.asksCurrentStats !== false;
  const curOpt = currentStatsAsked ? {} : { optional: true };

  specField('above_grade_sqft', 'Living area (above grade)', choices.aboveGradeSqft, spec('aboveGradeSqft'), { positive: true, ...curOpt });
  // Below-grade square footage is legitimately zero on most properties, so a
  // known-zero is a real answer and only an UNKNOWN is missing.
  specField('below_grade_sqft', 'Below-grade area', choices.belowGradeSqft, spec('belowGradeSqft'), { ...curOpt });
  specField('bedrooms', 'Bedrooms', choices.bedrooms, spec('bedrooms'), { positive: true, ...curOpt });
  specField('bathrooms', 'Bathrooms', choices.bathrooms, spec('bathrooms'), { positive: true, asInt: false, ...curOpt });
  specField('year_built', 'Year built', choices.yearBuilt, spec('yearBuilt'), { positive: true, ...curOpt });

  if (resType && NO_LOT_TYPES.has(resType)) {
    if (choices.lotSizeSquareFeet != null || spec('lotSizeSquareFeet').value != null) {
      drop('lot_size_square_feet', 'A condo has no lot of its own — sending a lot size for one is refused.');
    }
  } else {
    // The lot is the ONE current figure a vacant site really does have, and on a
    // ground-up report it is most of what is being valued — so it is still sent
    // and still asked for; it simply stops blocking when the report never asked.
    specField('lot_size_square_feet', 'Lot size (sq ft)', choices.lotSizeSquareFeet, spec('lotSizeSquareFeet'), { positive: true, ...curOpt });
  }

  // Optional extras — never blocking, sent when known.
  specField('stories', 'Stories', choices.stories, spec('stories'), { optional: true, asInt: false });
  specField('garage_spaces', 'Garage spaces', choices.garageSpaces, spec('garageSpaces'), { optional: true });
  if (choices.isBasement != null) set('is_basement', choices.isBasement ? '1' : '0');
  if (choices.isBasementFinished != null) set('is_basement_finished', choices.isBasementFinished ? '1' : '0');

  // ---- proposed (after-renovation) specifications ------------------------
  // Only the report types that ask for proposed figures accept them. Sending
  // them to a report that does not is refused, so the caller passes
  // `asksProposedStats` straight off the vendor's own report-type catalogue
  // rather than a list retyped here.
  const proposed = [
    ['proposed_above_grade_sqft', 'Living area after the work', choices.proposedAboveGradeSqft, ctx.proposed && ctx.proposed.aboveGradeSqft],
    ['proposed_below_grade_sqft', 'Below-grade area after the work', choices.proposedBelowGradeSqft, null],
    ['proposed_bedrooms', 'Bedrooms after the work', choices.proposedBedrooms, null],
    ['proposed_bathrooms', 'Bathrooms after the work', choices.proposedBathrooms, null],
  ];
  for (const [field, label, chosen, fromFile] of proposed) {
    const v = num(chosen != null && chosen !== '' ? chosen : fromFile);
    if (v == null) continue;
    if (choices.asksProposedStats === false) { drop(field, 'This report does not ask for after-renovation figures.'); continue; }
    set(field, String(v));
    if ((chosen == null || chosen === '') && fromFile != null) derived(field, label, v, 'Taken from the loan file’s after-renovation square footage.');
  }

  // ---- the renovation budget ---------------------------------------------
  // The whole point of this product is the after-repair value, and that is priced
  // off the budget. It is optional in their schema and reported as MISSING here
  // when the chosen report needs one — their catalogue's own
  // `renovation_budget_needed` flag decides, so a report that does not need one
  // never nags.
  const budget = num(choices.borrowerBudget != null && choices.borrowerBudget !== '' ? choices.borrowerBudget : ctx.rehabBudget);
  if (budget != null && budget > 0) {
    set('borrower_budget', String(Math.round(budget)));
    if (choices.borrowerBudget == null || choices.borrowerBudget === '') {
      derived('borrower_budget', 'Renovation budget', Math.round(budget), 'Taken from the loan file’s rehab budget.');
    }
  } else if (choices.needsRenovationBudget === true) {
    need('borrower_budget', 'Renovation budget',
      'This report values the property after the work, so it needs the renovation budget. Add it on the file, or type it here.');
  }
  // Their `borrower_sow` = "is there a scope-of-work document?", and answering YES
  // makes a budget file REQUIRED. PILOT sends the scope of work as a real file
  // when it has one, so YES is only ever said alongside the attachment.
  if (Array.isArray(choices.budgetFiles) && choices.budgetFiles.length) {
    set('borrower_sow', 'YES');
    fields.budget_files = choices.budgetFiles;
  }

  // ---- inspection access -------------------------------------------------
  const onLockbox = choices.isPropertyOnLockbox === true;
  if (lockboxApplies(inspectionType)) {
    set('is_property_on_lockbox', onLockbox ? '1' : '0');
    if (onLockbox) {
      const code = trim(choices.lockboxCode);
      const loc = trim(choices.lockboxLocation);
      const ent = trim(choices.lockboxEntrance);
      set('lockbox_code', code);
      set('lockbox_location', loc);
      set('lockbox_entrance', ent);
      if (!code) need('lockbox_code', 'Lockbox code', 'The inspector cannot get in without it.');
      if (!loc) need('lockbox_location', 'Where the lockbox is', 'Pick where on the property the lockbox is.');
      if (!ent) need('lockbox_entrance', 'Which door it opens', 'Pick which door the key opens.');
      const gateNeeded = choices.communityGateCodeNeeded === true;
      set('community_gate_code_needed', gateNeeded ? '1' : '0');
      if (gateNeeded) {
        const gate = trim(choices.gateCode);
        set('gate_code', gate);
        if (!gate) need('gate_code', 'Gate code', 'The inspector cannot reach the property without it.');
      } else if (trim(choices.gateCode)) {
        drop('gate_code', 'Only sent when a gate code is needed — sending it otherwise is refused.');
      }
    } else {
      for (const [f, v] of [['lockbox_code', choices.lockboxCode], ['lockbox_location', choices.lockboxLocation],
        ['lockbox_entrance', choices.lockboxEntrance], ['gate_code', choices.gateCode]]) {
        if (trim(v)) drop(f, 'Only sent when the property is on a lockbox — sending it otherwise is refused.');
      }
      if (choices.communityGateCodeNeeded != null) drop('community_gate_code_needed', 'Only sent when the property is on a lockbox — sending it otherwise is refused.');
    }
  } else {
    for (const f of ['is_property_on_lockbox', 'lockbox_code', 'lockbox_location', 'lockbox_entrance',
      'community_gate_code_needed', 'gate_code']) {
      const given = choices[camel(f)];
      if (given != null && given !== '' && given !== false) {
        drop(f, 'Lockbox details only apply to an interior inspection an inspector attends — sending them otherwise is refused.');
      }
    }
  }

  // Who lets the inspector in. Their sub-fields: name required, phone exactly ten
  // digits, email a real address. A contact with a bad phone is REPORTED, never
  // trimmed and sent — the vendor texts that number to arrange the visit.
  const contacts = Array.isArray(choices.propertyAccessContacts) ? choices.propertyAccessContacts : [];
  const cleaned = [];
  contacts.forEach((c, i) => {
    if (!c) return;
    const name = trim(c.name);
    if (!name) { if (trim(c.phone) || trim(c.email)) need(`property_access_contacts[${i}][name]`, 'Access contact name', 'A contact needs a name.'); return; }
    const phone = trim(c.phone) ? tenDigits(c.phone) : null;
    if (trim(c.phone) && !phone) {
      need(`property_access_contacts[${i}][phone]`, `Phone for ${name}`,
        'Richer Values needs a 10-digit US mobile number — they text it to arrange the visit.');
      return;
    }
    const email = trim(c.email);
    if (email && !isEmail(email)) { need(`property_access_contacts[${i}][email]`, `Email for ${name}`, 'That does not look like an email address.'); return; }
    cleaned.push({ name, phone, email: email || null });
  });
  cleaned.forEach((c, i) => {
    set(`property_access_contacts[${i}][name]`, c.name);
    set(`property_access_contacts[${i}][phone]`, c.phone);
    set(`property_access_contacts[${i}][email]`, c.email);
  });
  if (contactsRequired(inspectionType, onLockbox) && !cleaned.length) {
    const why = inspectionKind(inspectionType) === 'direct'
      ? 'This inspection is done by the borrower or their contact on their own phone, so Richer Values needs somebody to text.'
      : 'The property is not on a lockbox, so somebody has to let the inspector in.';
    need('property_access_contacts', 'Who lets the inspector in', why);
  }
  // A homeowner-led inspection is carried out on a phone. A contact with no
  // mobile number cannot receive the link, so this is a blocking answer rather
  // than something the vendor discovers on the day.
  if (inspectionKind(inspectionType) === 'direct' && cleaned.length && !cleaned.some((c) => c.phone)) {
    need('property_access_contacts', 'A mobile number for the contact',
      'A homeowner-led inspection is done through a link Richer Values texts, so at least one contact needs a mobile number.');
  }

  // ---- who the report goes to -------------------------------------------
  const rcName = trim(choices.reportContactName) || trim(contact.name);
  const rcEmail = trim(choices.reportContactEmail) || trim(contact.email);
  const rcPhoneRaw = trim(choices.reportContactPhone) || trim(contact.phone);
  const rcPhone = tenDigits(rcPhoneRaw);
  set('report_contact_name', rcName);
  set('report_contact_email', rcEmail);
  set('report_contact_phone', rcPhone);
  if (!rcName) need('report_contact_name', 'Who the report goes to', 'Richer Values needs a name for every order.');
  if (!rcEmail || !isEmail(rcEmail)) need('report_contact_email', 'Their email', 'Richer Values needs a working email for every order.');
  if (!rcPhone) {
    need('report_contact_phone', 'Their phone number',
      rcPhoneRaw ? 'Richer Values needs a 10-digit US number, and this one is not one.' : 'Richer Values needs a phone number for every order.');
  }
  if (!trim(choices.reportContactName) && rcName) derived('report_contact_name', 'Who the report goes to', rcName, 'The loan officer on the file.');
  set('report_cc_user', trim(choices.reportCcUsers));

  // ---- notes -------------------------------------------------------------
  set('inspection_notes_or_instruction', trim(choices.inspectionNotes));
  set('valuation_commentary_or_instruction', trim(choices.valuationNotes));
  set('notes', trim(choices.notes));

  // ---- the deal's own numbers, which help them sanity-check the value -----
  const money = (field, chosen, fromFile) => {
    const v = num(chosen != null && chosen !== '' ? chosen : fromFile);
    if (v != null && v > 0) set(field, String(Math.round(v)));
  };
  money('expected_loan_amount', choices.expectedLoanAmount, ctx.loanAmount);
  money('acquisition_contract_price', choices.acquisitionContractPrice, ctx.purchasePrice);
  money('expected_as_is_value', choices.expectedAsIsValue, ctx.asIsValue);
  money('expected_arv', choices.expectedArv, ctx.arv);

  return {
    fields,
    missing,
    assumptions,
    dropped,
    blocked,
    canPlace: !blocked && missing.length === 0,
  };
}

// `is_property_on_lockbox` → `isPropertyOnLockbox`, so the forbidden-field sweep
// can look a snake_case field up in the camelCase choices object.
function camel(s) { return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }

/** Is `day` at least `n` days before `ref`? Calendar strings only — no timezone. */
function atLeastDaysBefore(day, ref, n) {
  const a = Date.parse(`${day}T00:00:00Z`);
  const b = Date.parse(`${ref}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (b - a) >= n * 86400000;
}

/**
 * What the screen renders its pickers from. The report / inspection / turnaround
 * lists are NOT here — they are the vendor's own per-company catalogue and are
 * served from the cache — but everything that is a fixed vocabulary is, so a
 * picker can never offer a value the builder would refuse.
 */
function screenOptions() {
  return {
    propertyConditions: PROPERTY_CONDITIONS,
    residentialTypes: RESIDENTIAL_TYPES,
    lockboxLocations: LOCKBOX_LOCATIONS,
    lockboxEntrances: LOCKBOX_ENTRANCES,
  };
}

// ---------------------------------------------------------------------------
// Flatten the BUILT body into labelled rows for the preview. Walking the body
// (rather than a hand-kept field list) is what guarantees the screen can never
// fall behind the builder — add a field above and it appears on the screen with
// no extra work. That is the Class desk's rule, and re-hand-listing here would
// reproduce the exact defect it was written to avoid.
// ---------------------------------------------------------------------------
const LABELS = {
  company_token: 'Richer Values company',
  loan_officer_token: 'Placed by (at Richer Values)',
  client_loan_number: 'Our loan number',
  report_type: 'Report',
  inspection_type: 'Inspection',
  turnaround_time: 'How fast',
  include_flood_certification: 'Include a flood certificate',
  gla_include: 'Measure the living area + floor plan',
  licensing_required: 'Require a licensed inspector',
  borrower_name: 'Borrower’s name',
  closing_date: 'Expected closing date',
  historical_effective_date: 'Value as of a past date',
  effective_date: 'That past date',
  property_upload_type: 'One property or a batch',
  is_property_vacant_land: 'Vacant land',
  is_property_partially_completed: 'Under construction',
  partially_completed_estimated_percentage: 'How far along',
  property_address: 'Street address',
  property_address_line_2: 'Address line 2',
  unit_number: 'Unit number',
  city: 'City',
  state: 'State',
  postal_code: 'ZIP code',
  residential_property_type: 'Property type',
  residential_prop_type_units: 'Units',
  property_condition: 'Condition',
  above_grade_sqft: 'Living area (above grade)',
  below_grade_sqft: 'Below-grade area',
  bedrooms: 'Bedrooms',
  bathrooms: 'Bathrooms',
  year_built: 'Year built',
  lot_size_square_feet: 'Lot size (sq ft)',
  stories: 'Stories',
  garage_spaces: 'Garage spaces',
  is_basement: 'Has a basement',
  is_basement_finished: 'Basement finished',
  proposed_above_grade_sqft: 'Living area after the work',
  proposed_below_grade_sqft: 'Below-grade area after the work',
  proposed_bedrooms: 'Bedrooms after the work',
  proposed_bathrooms: 'Bathrooms after the work',
  borrower_budget: 'Renovation budget',
  borrower_sow: 'Scope of work attached',
  budget_files: 'Scope-of-work file',
  is_property_on_lockbox: 'On a lockbox',
  lockbox_code: 'Lockbox code',
  lockbox_location: 'Where the lockbox is',
  lockbox_entrance: 'Which door it opens',
  community_gate_code_needed: 'Needs a gate code',
  gate_code: 'Gate code',
  report_contact_name: 'Report goes to',
  report_contact_email: 'Their email',
  report_contact_phone: 'Their phone',
  report_cc_user: 'Copied on the report',
  inspection_notes_or_instruction: 'Notes for the inspector',
  valuation_commentary_or_instruction: 'Notes for the analyst',
  notes: 'Notes',
  expected_loan_amount: 'Loan amount',
  acquisition_contract_price: 'Purchase price',
  expected_as_is_value: 'As-Is value we expect',
  expected_arv: 'ARV we expect',
  order_placing_from: 'Placed from',
};

// A field whose VALUE is a credential and must never be rendered. The token is
// shown as present/absent, exactly as the API-Health page treats a credential:
// this screen records THAT we are configured, never HOW.
const SECRET_FIELDS = new Set(['company_token', 'loan_officer_token']);

/**
 * One row per field that WOULD BE SENT, plus one per missing field, each carrying
 * its provenance so the screen can colour it: `missing` (blocks the order),
 * `overridden` (a human typed it), `derived` (PILOT worked it out — look at it),
 * or plain (read straight off the file).
 */
function fieldRows(built, choices = {}) {
  const rows = [];
  const assumed = new Map((built.assumptions || []).map((a) => [a.field, a]));
  const overrides = new Set(Object.keys(choices || {}).filter((k) => choices[k] != null && choices[k] !== ''));

  const contactRows = [];
  for (const [field, value] of Object.entries(built.fields || {})) {
    const isContact = field.startsWith('property_access_contacts[');
    const label = LABELS[field] || prettify(field);
    const row = {
      field,
      label: isContact ? contactLabel(field) : label,
      value: SECRET_FIELDS.has(field) ? '••••••••' : displayValue(field, value),
      // A HUMAN'S VALUE OUTRANKS A DERIVED ONE, and the order of this test is the
      // whole rule. Reading `derived` first labels a field the staffer just typed
      // as "PILOT filled this in" — which invites them to check a value they
      // themselves chose, and hides the fact that the file's own answer was
      // overruled.
      provenance: overrides.has(camel(field)) ? 'overridden' : (assumed.has(field) ? 'derived' : 'read'),
      why: (!overrides.has(camel(field)) && assumed.has(field)) ? assumed.get(field).why : null,
    };
    (isContact ? contactRows : rows).push(row);
  }
  for (const m of built.missing || []) {
    rows.push({ field: m.field, label: m.label, value: null, provenance: 'missing', why: m.why });
  }
  return rows.concat(contactRows);
}

function contactLabel(field) {
  const m = /^property_access_contacts\[(\d+)\]\[(\w+)\]$/.exec(field);
  if (!m) return field;
  const which = { name: 'name', phone: 'phone', email: 'email' }[m[2]] || m[2];
  return `Access contact ${Number(m[1]) + 1} — ${which}`;
}

// Their booleans travel as "0"/"1"; a screen showing "1" tells nobody anything.
const BOOLEAN_FIELDS = new Set(['include_flood_certification', 'gla_include', 'licensing_required',
  'is_property_vacant_land', 'is_property_partially_completed', 'is_property_on_lockbox',
  'community_gate_code_needed', 'historical_effective_date', 'is_basement', 'is_basement_finished']);
function displayValue(field, value) {
  if (BOOLEAN_FIELDS.has(field)) return value === '1' ? 'Yes' : 'No';
  if (Array.isArray(value)) return `${value.length} file${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object' && value.filename) return value.filename;
  return value;
}

function prettify(field) {
  return String(field).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

module.exports = {
  buildOrder, fieldRows, screenOptions,
  inspectionKind, lockboxApplies, contactsRequired, hasInspection,
  residentialTypeFor, propertyConditionFromUad, propertyConditionFromRehab,
  PROPERTY_CONDITIONS, RESIDENTIAL_TYPES, LOCKBOX_LOCATIONS, LOCKBOX_ENTRANCES,
  UNITS_OF_TYPE, NO_LOT_TYPES, LABELS,
  _internals: { tenDigits, dayString, todayString, atLeastDaysBefore, num, int, camel, displayValue },
};
