'use strict';
/**
 * Class Valuation — build a POST /orders body from a loan file. PURE.
 *
 * Takes a NORMALIZED context (the route owns the database read) and returns the
 * body, plus TWO lists that matter as much as the body itself:
 *
 *   missing[]     — a required value the file does not have. The order cannot go.
 *   assumptions[] — a value we DERIVED rather than read. The order can go, but a
 *                   human should see it first.
 *
 * That second list exists because of the owner's standing rule for this desk:
 * "we need to make sure that we see all the fields that he's filling
 * automatically before he's sending those over." A silent default is the thing
 * to avoid — so anything this module decides on the file's behalf says so.
 *
 * NEVER GUESS AN ENUM. Class publishes closed value lists, and a value outside
 * one is rejected by them (or worse, accepted as the wrong thing). Every map here
 * is EXACT, and anything unrecognised resolves to null and is reported — never to
 * a plausible neighbour. The two places that bite:
 *
 *   • loanInfo.loanType has NO bridge, DSCR or fix-and-flip value. Our RTL loan
 *     types genuinely do not exist in their list, so they resolve to `Other` and
 *     are recorded as an assumption. The deal's real nature travels in `purpose`,
 *     which DOES carry Bridge and Construction.
 *   • propertyTypeEnum has no PUD. A PUD is a detached single-family house in a
 *     planned development and the industry files it as single family, so it maps
 *     to SingleFamily — as a stated assumption, never silently.
 *
 * TWO UAD VERSIONS, ONE BUILDER (owner-directed 2026-08-07: "we need to build the
 * 3.6 and the 2.6 … it's going to shift in the next few months … default to the
 * version one with an option to change to version two, which is 3.6").
 *
 *   v1 = UAD 2.6 — `POST /orders`      — TODAY'S DEFAULT
 *   v2 = UAD 3.6 — `POST /v2/orders`   — ready for the shift
 *
 * BOTH ARE DOCUMENTED IN THE SAME GUIDE ("Class Orders API Guide" rev 0.17): v2 is
 * an extension of v1 on the SAME hosts, selected by the path (or `api-version=2.0`).
 * It is NOT the separate `ClassOrdersAPIGuide_V2.pdf`, which describes a different
 * API on `orders-external.*` hosts and never mentions UAD at all — do not build
 * against that document.
 *
 * EVERYTHING THAT DIFFERS BETWEEN THE TWO LIVES IN `PROFILES`, and nothing else in
 * this file may branch on the version. That is deliberate: the differences are the
 * kind that fail SILENTLY rather than loudly — a renamed field, a re-cased key, a
 * value list that gained and lost members — so they are kept in one table where
 * they can be read side by side and tested against each other, instead of scattered
 * through the build as `if (v2)`. The traps, each real:
 *
 *   • the property type is `propertyTypeEnum` on 2.6 and `propertyType` on 3.6,
 *     with DIFFERENT value lists (3.6 gains PUD, COOP, CondoHotel, DetachedCondo
 *     and loses Farm, Duplex, Commercial, the land types…);
 *   • `contacts.Type` on 2.6 is `contacts.type` on 3.6, and the notification list
 *     re-cases both its keys the same way. A wrong case is an unrecognised field,
 *     dropped with no error;
 *   • `occupancy` is a FREE STRING on 2.6 and a CLOSED ENUM on 3.6;
 *   • 3.6 renames `caseFileId` -> `duReferenceNumber` and `lpaKey` ->
 *     `lpaKeyReferenceIdentifier`.
 *
 * Both versions spell `occupancy` correctly. (The `orders-external` document
 * misspells it `ocupancy`; an earlier cut of this module was built against that
 * document and deliberately sent the typo.)
 */

// ---------------------------------------------------------------------------
// THE VERSION PROFILES. Everything that differs between UAD 2.6 and UAD 3.6 is
// here and ONLY here — the value lists (transcribed from the guide verbatim, in
// their order), the field names, the key casing, and the maps from our own
// vocabulary into theirs. Adding a third version is one more entry.
// ---------------------------------------------------------------------------

// Our canonical property key -> theirs. EXACT; anything unrecognised resolves to
// null and is REPORTED, never nudged into a plausible neighbour.
const PROPERTY_TYPE_26 = {
  sfr: 'SingleFamily',
  condo: 'Condominium',
  multi_2_4: 'TwoToFourFamily',
  multi_5_plus: 'MultiFamily',
  townhouse: 'TownhouseorRowhouse',
};
const PROPERTY_TYPE_36 = {
  sfr: 'SingleFamily',
  condo: 'Condominium',
  multi_2_4: 'TwoToFourFamily',
  pud: 'PUD',                // 3.6 carries PUD properly, so this is NOT an assumption
  // NOTE: `townhouse` is deliberately NOT here — 3.6 dropped TownhouseorRowhouse, so
  // it is a judgement and lives in the ASSUMED table below where the preview shows it.
};
// Mapped, but only as a DECLARED assumption the preview shows.
const PROPERTY_TYPE_ASSUMED_26 = {
  pud: ['SingleFamily', 'UAD 2.6 has no PUD value; a PUD is a detached single-family house in a planned development, and the industry files it as single family'],
};
const PROPERTY_TYPE_ASSUMED_36 = {
  // 3.6 dropped TownhouseorRowhouse. A townhouse in a planned development is a PUD,
  // which is the closest thing their 3.6 list carries — but it IS a judgement, so it
  // is declared rather than made quietly.
  townhouse: ['PUD', 'UAD 3.6 has no townhouse value; a townhouse in a planned development is filed as a PUD'],
  // 3.6 dropped MultiFamily (5+). Their list stops at TwoToFourFamily, so a 5+ unit
  // building has NO value on 3.6 and must not be squeezed into the 2-4 one.
};

// Our loan type -> their `purpose`. Their list carries Bridge and Construction,
// which is where an RTL deal's real nature belongs (their loanType list has neither).
const PURPOSE = {
  fix_and_flip: 'Bridge',
  bridge: 'Bridge',
  ground_up: 'Construction',
  dscr: 'Refinance',
  purchase: 'Purchase',
  refinance: 'Refinance',
  cash_out: 'Refinance',
};

// Our loan type -> their `loanInfo.loanType`. Deliberately sparse: everything else
// lands on `Other` as a stated assumption rather than being forced into a
// consumer-mortgage value that would misdescribe a business-purpose loan.
const LOAN_TYPE = { ground_up: 'NewConstruction' };

// Occupancy on UAD 2.6 (their v1). Their GUIDE documents this field as a FREE STRING
// ("Self-descriptive", p.30) — but the LIVE v1 API refuses a free value: it binds
// `occupancy` to a CLOSED .NET enum, `CV.OrdersExternal.Common.Orders.OccupancyTypeEnum`,
// whose members the guide never lists. That is the SAME guide-vs-live divergence that
// made every data route need the /intg prefix — the live API is authoritative, the
// document is stale. Their v1 value for the investment case is NOT "Investment" (that
// exact string is rejected), and their spec is not reachable from here.
//
// So we do not GUESS one value and hope. We carry an ORDERED list of the industry's
// standard occupancy members, most-semantically-correct first, and let the live API
// tell us which one it accepts: the sender tries them in order on the specific
// occupancy binding error and stops at the first Class takes (see routes/class.js).
// A model-binding 400 creates NOTHING at Class, so trying the next value can never
// place a second real order, and the accepted value is remembered so a classification
// cascades at most once per process. `Other` sits last as the near-certain fallback,
// so an order still goes through even if their enum is spelled unlike anything here —
// the appraiser determines the real occupancy on inspection regardless.
const OCCUPANCY_CANDIDATES_26 = {
  investment:  ['Investor', 'NonOwnerOccupied', 'InvestmentProperty', 'Investment', 'Vacant', 'Tenant', 'Rental', 'Other'],
  tenant:      ['Tenant', 'TenantOccupied', 'NonOwnerOccupied', 'Investor', 'Rental', 'Other'],
  vacant:      ['Vacant', 'Unoccupied', 'NonOwnerOccupied', 'Investor', 'Other'],
  owner:       ['Owner', 'OwnerOccupied', 'PrimaryResidence', 'Primary', 'Other'],
  primary:     ['PrimaryResidence', 'Primary', 'Owner', 'OwnerOccupied', 'PrimaryHome', 'Other'],
  second_home: ['SecondHome', 'SecondaryResidence', 'Secondary', 'VacationHome', 'Owner', 'Other'],
};
// An occupancy word we do not recognise still lets the order through on the value
// Class is likeliest to accept for "we could not classify it".
const OCCUPANCY_FALLBACK_26 = ['Other'];
// The single most-likely value per classification — what the order SCREEN offers as a
// type-ahead suggestion, and the back-compat map the older callers read.
const OCCUPANCY_26 = Object.fromEntries(
  Object.entries(OCCUPANCY_CANDIDATES_26).map(([k, list]) => [k, list[0]]));
const OCCUPANCY_36 = {
  investment: 'Investment',
  primary: 'PrimaryResidence',
  owner: 'PrimaryResidence',
  second_home: 'SecondHome',
};
const OCCUPANCY_ASSUMED_36 = {
  // A tenant-occupied property held by an investor IS an investment property; their
  // 3.6 list has no tenancy word, so this says what it did.
  tenant: ['Investment', 'UAD 3.6 has no tenant-occupied value; a tenanted property held by an investor is filed as Investment'],
  // Vacancy is a condition, not an occupancy class, and 3.6 has no value for it.
  vacant: ['Other', 'UAD 3.6 has no vacant value; recorded as Other so the appraiser is not told the wrong occupancy'],
};

// Their published closed lists, verbatim and in their order. These exist so the
// order SCREEN can offer exactly what Class accepts instead of retyping the list
// in a component — one copy, and the picker cannot drift from the builder.
const ENUMS_26 = {
  propertyTypeEnum: [
    'SingleFamily', 'Condominium', 'Cooperative', 'ManufacturedHome', 'TwoToFourFamily',
    'Other', 'Farm', 'Duplex', 'MultiFamily', 'Commercial', 'Industrial',
    'TownhouseorRowhouse', 'MobileHome', 'ModularHome', 'VacantLand', 'VacantLot',
    'Office', 'RawLand', 'DevelopedLand',
  ],
  purpose: [
    'NA', 'Auction', 'Bridge', 'Construction', 'DebtConsolidation', 'DeedInLieu',
    'Foreclosure', 'HomeEquity', 'LeaseHold', 'AscertainMarketValue', 'Modification',
    'Other', 'Purchase', 'Refinance', 'Relocation', 'Renewal', 'REO', 'Loan', 'ORE',
    'Settlement', 'ShortSale',
  ],
  loanType: [
    'None', 'Conventional', 'ConventionalInsured', 'ConventionalUninsured', 'FHA',
    'FMHA', 'Other', 'PublicNativeAmericanHousing', 'Reverse', 'USDA', 'VA',
    'NewConstruction', 'ForeclosureREO', 'L203K', 'AllInOne', 'AltQMAgency',
    'AltQMIncome', 'AltQMJumbo', 'CMHC', 'ConstructionFinancing', 'FHA203kLimited',
    'FHA203kStandard', 'FSARHSFmHA', 'HARP2', 'HomeEquity', 'HomeOwnershipAcclerator',
    'HomeStyleRenovation', 'Jumbo', 'OneTimeClose', 'Section184NativeAmericalLoan',
    'ConstructionLoan', 'K203', 'HELOC',
  ],
};
const ENUMS_36 = {
  // A DIFFERENT list under a DIFFERENT field name — not a superset of the 2.6 one.
  propertyType: [
    'SingleFamily', 'Condominium', 'PUD', 'COOP', 'TwoToFourFamily', 'CondoHotel',
    'ManufacturedHousing', 'ModularHome', 'MobileHome', 'DetachedCondo',
  ],
  purpose: [...ENUMS_26.purpose, 'Reverse'],   // 3.6 adds exactly one value
  loanType: ENUMS_26.loanType,                 // unchanged between the two
  occupancy: ['PrimaryResidence', 'SecondHome', 'Investment', 'Other'],
};

const PROFILES = {
  v1: {
    version: 'v1', uad: '2.6', label: 'UAD 2.6 (their version 1)', path: '/orders',
    propertyTypeField: 'propertyTypeEnum',
    contactTypeKey: 'Type',
    notifyKeys: { type: 'Type', email: 'Email' },
    caseFileField: 'caseFileId', lpaField: 'lpaKey',
    propertyType: PROPERTY_TYPE_26, propertyTypeAssumed: PROPERTY_TYPE_ASSUMED_26,
    // v1 occupancy is a live enum whose members are undocumented — so it is a CANDIDATE
    // LIST the sender cascades through, not a single value validated here.
    occupancy: OCCUPANCY_CANDIDATES_26, occupancyAssumed: {},
    occupancyFallback: OCCUPANCY_FALLBACK_26,
    occupancyIsEnum: false, occupancyIsCandidates: true,
    enums: ENUMS_26,
  },
  v2: {
    version: 'v2', uad: '3.6', label: 'UAD 3.6 (their version 2)', path: '/v2/orders',
    propertyTypeField: 'propertyType',
    contactTypeKey: 'type',
    notifyKeys: { type: 'type', email: 'email' },
    caseFileField: 'duReferenceNumber', lpaField: 'lpaKeyReferenceIdentifier',
    propertyType: PROPERTY_TYPE_36, propertyTypeAssumed: PROPERTY_TYPE_ASSUMED_36,
    // v2 occupancy is a CLOSED four-value enum their guide publishes in full, so it is
    // validated here and needs no cascade — a single documented value.
    occupancy: OCCUPANCY_36, occupancyAssumed: OCCUPANCY_ASSUMED_36,
    occupancyIsEnum: true, occupancyIsCandidates: false,
    enums: ENUMS_36,
  },
};

const DEFAULT_VERSION = 'v1';   // the owner's choice until the industry shifts
// Accepts 'v1'/'v2', '1'/'2', '2.6'/'3.6' — the three ways a person or a config
// value spells this — and falls back to the default rather than throwing, because a
// typo in an env var must never take the desk down.
function profileFor(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  if (k === 'v2' || k === '2' || k === '3.6' || k === '36') return PROFILES.v2;
  if (k === 'v1' || k === '1' || k === '2.6' || k === '26') return PROFILES.v1;
  return PROFILES[DEFAULT_VERSION];
}

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const text = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

// A contact Class will accept. Their contact-type list is closed and IDENTICAL on
// both UAD versions; we only ever emit the four roles an appraisal genuinely needs.
// The KEY, however, is not identical — `Type` on 2.6, `type` on 3.6 — so the profile
// supplies it. A wrong case is an unrecognised field, dropped with no error.
function contact(profile, type, person, { primary = false } = {}) {
  if (!person) return null;
  const first = text(person.firstName);
  const last = text(person.lastName);
  const methods = [];
  const email = text(person.email);
  const mobile = text(person.mobile || person.cell);
  const work = text(person.workPhone || person.phone);
  if (email) methods.push({ value: email, type: 'Email', primaryContact: true });
  if (mobile) methods.push({ value: mobile, type: 'MobilePhone', primaryContact: !email });
  if (work) methods.push({ value: work, type: 'WorkPhone', primaryContact: false });
  if (!first && !last && !methods.length) return null;
  return {
    [profile.contactTypeKey]: type,
    firstName: first, lastName: last, primaryContact: !!primary, contactMethods: methods,
  };
}
// Read a contact's role back out whichever way it is spelled, so the checks below
// never have to know which version built the list.
const roleOf = (c) => (c && (c.Type != null ? c.Type : c.type)) || null;

/**
 * @param ctx {
 *   referenceNumber, productId,
 *   property:{ addressLine, addressLine2, city, state, postalCode, county, taxId, category, occupancy },
 *   loan:{ loanNumber, loanAmount, purchaseAmount, loanType, fhaCaseNumber },
 *   contractPrice, dateOfContract, dueDate, instructions,
 *   borrower, coBorrower, propertyContact, loanOfficer,
 *   lender:{ clientName, clientAddress, contactInformation },
 *   notifyEmails: []
 * }
 * @param overrides — a staff correction on the preview; always wins, and every key
 *                    used is reported so the preview can show it was overridden.
 */
function buildOrder(ctx = {}, overrides = {}, opts = {}) {
  // The version can be set system-wide (config) or chosen for THIS order on the
  // screen. An override wins, so a single file can be sent on 3.6 to try it out
  // without moving everyone — which is the point of building both ahead of the shift.
  const profile = profileFor(overrides.apiVersion || opts.version || ctx.apiVersion);
  const missing = [];
  const assumptions = [];
  const overridden = [];
  if (overrides.apiVersion) overridden.push('apiVersion');
  const pick = (key, derived) => {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] != null && overrides[key] !== '') {
      overridden.push(key);
      return overrides[key];
    }
    return derived;
  };

  /**
   * The same, for a field whose value must be one of THIS version's published values.
   *
   * A typed value is never taken on trust, because the two vocabularies overlap in
   * shape and not in content: `TownhouseorRowhouse` and `Vacant` are perfectly legal
   * UAD 2.6 values and are simply not on the 3.6 list. Switching the version on the
   * screen merges into the overrides already chosen, so without this check a value
   * picked under one version rides straight into the other — and an unrecognised
   * value is DROPPED BY CLASS WITH NO ERROR, which is the exact silent failure the
   * whole profile table exists to prevent. The appraiser gets an order with no
   * property type, and nothing anywhere says so.
   *
   * An unusable value is REFUSED, not corrected: it goes to `missing` (so `canPlace`
   * is false) and the field is left unset, so a wrong value can never be sent. The
   * message names the version, because "Townhouse is not a valid property type" reads
   * as nonsense to someone who just picked it off a list that offered it.
   */
  const rejected = new Set();
  const pickEnum = (key, derived, enumName, fieldPath) => {
    const allowed = (profile.enums && profile.enums[enumName]) || null;
    const has = Object.prototype.hasOwnProperty.call(overrides, key)
      && overrides[key] != null && overrides[key] !== '';
    if (!has) return derived;
    const v = overrides[key];
    // Only a single scalar can be a value from a list — a repeated query parameter
    // arrives as an array and is not one of them.
    if (allowed && !(typeof v === 'string' && allowed.includes(v))) {
      overridden.push(key);
      // Recorded so the ordinary "this field has no value" check below does not
      // report the same field a SECOND time with a vaguer reason. The specific
      // message — "that value is not on this version's list" — is the useful one.
      rejected.add(fieldPath);
      missing.push({
        field: fieldPath,
        why: `"${typeof v === 'string' ? v : JSON.stringify(v)}" is not one of the values UAD ${profile.uad} accepts for this field — pick one from the list on the order screen`,
      });
      return null;
    }
    overridden.push(key);
    return v;
  };

  const p = ctx.property || {};
  const loan = ctx.loan || {};

  // ---- property type -------------------------------------------------------
  // The FIELD NAME differs by version (`propertyTypeEnum` on 2.6, `propertyType` on
  // 3.6) and so does the value list, so both come from the profile. The override key
  // stays `propertyTypeEnum` on both versions on purpose: it is what the SCREEN
  // calls this row, and re-keying it per version would mean a staffer's correction
  // silently stopped applying the moment the default moved.
  const ptField = profile.propertyTypeField;
  const pKey = norm(p.category);
  let propertyType = profile.propertyType[pKey] || null;
  if (!propertyType && profile.propertyTypeAssumed[pKey]) {
    const [val, why] = profile.propertyTypeAssumed[pKey];
    propertyType = val;
    assumptions.push({ field: ptField, value: val, why });
  }
  propertyType = pickEnum('propertyTypeEnum', propertyType, ptField, ptField);
  if (!propertyType && !rejected.has(ptField)) {
    missing.push({ field: ptField, why: `UAD ${profile.uad} has no value matching the property type "${p.category || '(blank)'}" — pick one on the order screen` });
  }

  // ---- purpose + loan type -------------------------------------------------
  const lKey = norm(loan.loanType);
  let purpose = pickEnum('purpose', PURPOSE[lKey] || null, 'purpose', 'purpose');
  if (!purpose && !rejected.has('purpose')) missing.push({ field: 'purpose', why: `no Class purpose matches the loan type "${loan.loanType || '(blank)'}"` });

  let loanType = LOAN_TYPE[lKey] || null;
  if (!loanType && lKey) {
    loanType = 'Other';
    assumptions.push({ field: 'loanInfo.loanType', value: 'Other',
      why: `Class has no "${loan.loanType}" value — the deal's nature is carried in purpose="${purpose || '?'}" instead` });
  }
  loanType = pickEnum('loanType', loanType, 'loanType', 'loanInfo.loanType');

  // ---- occupancy -----------------------------------------------------------
  // On 3.6 a closed enum, validated here (a word with no exact value is DECLARED, a
  // category we cannot place at all is reported instead of guessed). On 2.6 a LIVE
  // enum whose members are undocumented, so it resolves to an ORDERED candidate list
  // the sender cascades through until Class accepts one — a human override is tried
  // first, the auto candidates fall in behind it, and `occupancy` starts on the head
  // of that list (see OCCUPANCY_CANDIDATES_26 and routes/class.js).
  const oKey = norm(p.occupancy);
  let occupancy;
  let occupancyCandidates;
  if (profile.occupancyIsCandidates) {
    const auto = profile.occupancy[oKey]
      || (profile.occupancyAssumed[oKey] ? [profile.occupancyAssumed[oKey][0]] : null)
      || profile.occupancyFallback || [];
    const override = pick('occupancy', null);   // a value a staffer typed on the screen
    const list = [];
    if (override != null && override !== '') list.push(String(override));
    for (const c of auto) list.push(c);
    occupancyCandidates = list.filter((v, i) => v && list.indexOf(v) === i);
    occupancy = occupancyCandidates[0] || null;
    if (!occupancy && oKey && !rejected.has('occupancy')) {
      missing.push({ field: 'occupancy', why: `no occupancy value could be derived for "${p.occupancy}"` });
    }
  } else {
    occupancy = profile.occupancy[oKey] || null;
    if (!occupancy && profile.occupancyAssumed[oKey]) {
      const [val, why] = profile.occupancyAssumed[oKey];
      occupancy = val;
      assumptions.push({ field: 'occupancy', value: val, why });
    }
    occupancy = pickEnum('occupancy', occupancy, 'occupancy', 'occupancy');
    if (!occupancy && oKey && !rejected.has('occupancy')) {
      missing.push({ field: 'occupancy', why: `UAD ${profile.uad} has no occupancy value matching "${p.occupancy}" — pick one on the order screen` });
    }
    occupancyCandidates = occupancy ? [occupancy] : [];
  }

  // ---- required identity ---------------------------------------------------
  const referenceNumber = pick('referenceNumber', text(ctx.referenceNumber));
  if (!referenceNumber) missing.push({ field: 'referenceNumber', why: 'our own order reference — the file needs a loan number' });

  const productId = pick('productId', ctx.productId != null ? ctx.productId : null);
  if (productId == null) missing.push({ field: 'productId', why: 'no Class product chosen — pick one from their product list' });

  const street = pick('street', text(p.addressLine));
  const city = pick('city', text(p.city));
  const state = pick('state', text(p.state));
  const zip = pick('zip', text(p.postalCode));
  for (const [k, v] of [['street', street], ['city', city], ['state', state], ['zip', zip]]) {
    if (!v) missing.push({ field: `property.${k}`, why: 'Class requires the full subject address' });
  }

  // ---- contacts ------------------------------------------------------------
  const contacts = [
    contact(profile, 'Borrower', ctx.borrower, { primary: true }),
    contact(profile, 'Coborrower', ctx.coBorrower),
    contact(profile, 'PropertyAccess', ctx.propertyContact),
    contact(profile, 'LoanOfficer', ctx.loanOfficer),
  ].filter(Boolean);
  if (!contacts.some((c) => roleOf(c) === 'Borrower')) {
    missing.push({ field: 'contacts.Borrower', why: 'Class needs a borrower contact to arrange access' });
  }
  if (!contacts.some((c) => roleOf(c) === 'PropertyAccess')) {
    assumptions.push({ field: 'contacts.PropertyAccess', value: '(none)',
      why: 'no property-access contact on the file — the appraiser will contact the borrower to arrange entry' });
  }

  const notify = (Array.isArray(ctx.notifyEmails) ? ctx.notifyEmails : [])
    .map(text).filter(Boolean)
    .filter((e, i, a) => a.indexOf(e) === i)
    .map((email) => ({ [profile.notifyKeys.type]: 'BorrowerInfo', [profile.notifyKeys.email]: email }));

  const body = {
    productId,
    referenceNumber,
    property: {
      street,
      line2: text(p.addressLine2),
      city, state, zip,
      county: text(p.county),
      taxId: text(p.taxId),
    },
    contacts,
    lender: {
      clientName: text((ctx.lender || {}).clientName),
      clientAddress: text((ctx.lender || {}).clientAddress),
      contactInformation: text((ctx.lender || {}).contactInformation),
    },
    loanInfo: {
      loanNumber: text(loan.loanNumber),
      loanAmount: money(loan.loanAmount) != null ? String(money(loan.loanAmount)) : null,
      loanType,
      fhaNumber: text(loan.fhaCaseNumber),
      purchaseAmount: money(loan.purchaseAmount),
    },
    dueDate: pick('dueDate', text(ctx.dueDate)),
    purpose,
    occupancy,
    // The property type rides under WHICHEVER name this version uses. Sending both
    // names "to be safe" would be the worst option: the version that does not know
    // the other name would reject the whole order rather than ignore one field.
    [ptField]: propertyType,
    instructions: pick('instructions', text(ctx.instructions)),
    contractPrice: money(ctx.contractPrice),
    dateOfContract: text(ctx.dateOfContract),
    notificationList: notify,
  };

  // The GSE reference numbers are renamed on 3.6, so they are keyed off the profile
  // too — and omitted entirely when the file has neither, which is every RTL deal.
  const caseFile = text(ctx.caseFileId);
  const lpaKey = text(ctx.lpaKey);
  if (caseFile) body[profile.caseFileField] = caseFile;
  if (lpaKey) body[profile.lpaField] = lpaKey;

  return {
    body, missing, assumptions, overridden,
    canPlace: missing.length === 0,
    // The desk has to be able to SAY which version this order is, and the client has
    // to know which path to post it to. Both come from here, never re-derived.
    apiVersion: profile.version,
    uad: profile.uad,
    versionLabel: profile.label,
    path: profile.path,
    // The occupancy the body starts on is `occupancyCandidates[0]`; the sender cascades
    // through the rest ONLY on the specific occupancy binding error. `occupancyKey` is
    // the classification the accepted value is remembered under.
    occupancyCandidates,
    occupancyKey: oKey || null,
  };
}

// True when a Class error is the v1 occupancy field failing to bind to their enum —
// the ONE error the order sender may safely retry with the next candidate. It is
// occupancy-SPECIFIC on purpose: once occupancy is accepted, a DIFFERENT field's
// binding error (or any other failure) must stop the cascade and surface as itself.
//
// A .NET model-binding 400 can arrive two ways and the signal lives in a different
// place in each: Class's own envelope `{success,code,error:"…OccupancyTypeEnum…
// $.occupancy…"}` (the shape actually observed), OR ASP.NET Core's DEFAULT
// ValidationProblemDetails `{title,status,errors:{"$.occupancy":["…"]}}`, where the
// field is a KEY. So we search the WHOLE serialized body rather than a fixed set of
// keys — and match only on the two stable identifiers for THIS error (the enum TYPE
// name and the JSON PATH), so a different field's error can never match even when the
// whole body is stringified. If occupancy is one of several bad fields, we retry it;
// once occupancy binds, the path/type no longer appears and the cascade stops.
function isOccupancyEnumError(err) {
  if (!err || err.status !== 400) return false;
  const parts = [];
  if (err.body != null) {
    try { parts.push(typeof err.body === 'string' ? err.body : JSON.stringify(err.body)); }
    catch (_) { /* a body we cannot serialize simply contributes nothing */ }
  }
  if (typeof err.message === 'string') parts.push(err.message);
  const text = parts.join(' ');
  return /Occupancy\w*Enum/i.test(text) || /\$\.occupancy\b/i.test(text);
}

// A single self-contained sentence for WHY a Class call failed, combining our own
// message with the meaningful text out of the vendor's body — so the reason we
// STORE (class_orders.last_error) and LOG is never just "HTTP 400" with the actual
// cause thrown away in the body. Class hands back three body shapes: their own
// envelope `{success,code,error/message}`, ASP.NET's `{title,errors:{field:[…]}}`
// (the field is a KEY), or a raw string kept under `raw`. The browser twin is
// `vendorSummary()` in app-v2/src/lib/orderError.js — keep the two in step.
function vendorErrorText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body.trim().slice(0, 300);
  if (typeof body === 'object') {
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();
    // ASP.NET's `errors{}` carries the specifics; its `title` is generic boilerplate
    // ("One or more validation errors occurred."), so the field messages win over it.
    if (body.errors && typeof body.errors === 'object') {
      const out = [];
      for (const k of Object.keys(body.errors)) {
        const m = body.errors[k];
        out.push((k ? k + ': ' : '') + (Array.isArray(m) ? m.join('; ') : String(m)));
      }
      if (out.length) return out.join(' · ');
    }
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim();
    if (typeof body.title === 'string' && body.title.trim()) return body.title.trim();
    if (typeof body.raw === 'string' && body.raw.trim()) return body.raw.trim().slice(0, 300);
    try { return JSON.stringify(body).slice(0, 300); } catch (_) { /* unserializable */ }
  }
  return '';
}

function describeOrderError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (typeof err.message === 'string' && err.message) parts.push(err.message);
  const vt = vendorErrorText(err.body);
  // Don't repeat the vendor text when our own message already carries it.
  if (vt && !parts.some((p) => p.includes(vt))) parts.push(vt);
  const s = parts.join(' — ').trim();
  return (s || 'the order was rejected with no detail').slice(0, 500);
}

// What the SCREEN needs in order to offer exactly what this version accepts.
// `occupancy` comes back as a closed list on 3.6 and as SUGGESTIONS on 2.6 (where
// the field is free text), and the screen renders a dropdown or a type-ahead
// accordingly — it must never present a free-text field as a closed choice, or a
// closed choice as free text.
function screenOptions(version) {
  const profile = profileFor(version);
  const uniq = (a) => a.filter((v, i) => a.indexOf(v) === i);
  // On the candidate version, `profile.occupancy` values are ARRAYS — the screen offers
  // the head of each list as a type-ahead suggestion (the single most-likely value),
  // not the whole cascade, so a staffer sees a clean list and the server still tries
  // the rest behind the scenes.
  const suggestFrom = (m) => uniq(Object.values(m).map((v) => (Array.isArray(v) ? v[0] : v)));
  return {
    version: profile.version,
    uad: profile.uad,
    label: profile.label,
    propertyTypeField: profile.propertyTypeField,
    enums: profile.enums,
    occupancyIsEnum: profile.occupancyIsEnum,
    occupancySuggestions: profile.occupancyIsEnum
      ? profile.enums.occupancy
      : suggestFrom(profile.occupancy),
  };
}

module.exports = {
  buildOrder,
  profileFor,
  screenOptions,
  isOccupancyEnumError,
  describeOrderError,
  DEFAULT_VERSION,
  VERSIONS: Object.values(PROFILES).map((p) => ({ version: p.version, uad: p.uad, label: p.label, path: p.path })),
  // Kept for the callers that predate two versions. These are the 2.6 lists.
  ENUMS: ENUMS_26,
  OCCUPANCY_SUGGESTIONS: Object.values(OCCUPANCY_26).filter((v, i, a) => a.indexOf(v) === i),
  _internals: {
    PROFILES, PURPOSE, LOAN_TYPE, norm, contact, roleOf,
    // The 2.6 names, kept so the existing checks read the same as they always did.
    PROPERTY_TYPE: PROPERTY_TYPE_26, PROPERTY_TYPE_ASSUMED: PROPERTY_TYPE_ASSUMED_26,
    OCCUPANCY: OCCUPANCY_26, OCCUPANCY_CANDIDATES_26,
    vendorErrorText,
  },
};
