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
 * THE SPELLING OF `occupancy` IS VERSION-SPECIFIC, AND WE ARE ON V1. The **V1**
 * guide (rev 0.17, p.30) spells it correctly — `occupancy` — and that is what we
 * send. The separate **V2** document misspells it `ocupancy`. An earlier cut of
 * this module was written against V2 and deliberately sent the typo; on V1 that
 * would be an unrecognised field, silently dropped on their side with no error.
 * The two documents also disagree about the base hosts (see client.js). If this
 * integration is ever moved to V2, the spelling moves WITH it — never "correct" or
 * "fix" it in isolation.
 */

// ---------------------------------------------------------------------------
// THEIR CLOSED VALUE LISTS, transcribed from the V1 guide (rev 0.17, pp.29-30).
// These exist so the order SCREEN can offer exactly what Class accepts instead of
// retyping the vendor's list in a component — one copy, and the picker cannot
// drift from the builder. Order is theirs, verbatim; do not sort or prune.
//
// `occupancy` is deliberately absent: on V1 it is a free-form String with no
// published list (see the OCCUPANCY map below), so the screen suggests rather
// than constrains.
// ---------------------------------------------------------------------------
const ENUMS = {
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

// ---- our canonical property key -> their propertyTypeEnum -----------------
const PROPERTY_TYPE = {
  sfr: 'SingleFamily',
  condo: 'Condominium',
  multi_2_4: 'TwoToFourFamily',
  multi_5_plus: 'MultiFamily',
  townhouse: 'TownhouseorRowhouse',
};
// Mapped, but only as a declared assumption — see the header.
const PROPERTY_TYPE_ASSUMED = {
  pud: ['SingleFamily', 'Class has no PUD value; a PUD is filed as single family'],
};

// ---- our loan type -> their `purpose` -------------------------------------
// Their list carries Bridge and Construction, which is where an RTL deal's real
// nature belongs (their loanType list has neither).
const PURPOSE = {
  fix_and_flip: 'Bridge',
  bridge: 'Bridge',
  ground_up: 'Construction',
  dscr: 'Refinance',
  purchase: 'Purchase',
  refinance: 'Refinance',
  cash_out: 'Refinance',
};

// ---- our loan type -> their loanInfo.loanType -----------------------------
// Deliberately sparse. Everything else lands on `Other` as a stated assumption
// rather than being forced into a consumer-mortgage value that would misdescribe
// a business-purpose loan.
const LOAN_TYPE = {
  ground_up: 'NewConstruction',
};

// ---- our occupancy -> their `occupancy` (V1 spelling — see the header) ----
// UNLIKE every other map here, this one is NOT pinned to a published list: on V1
// `occupancy` is a free-form String ("Self-descriptive", p.30). The only value
// their own vocabulary confirms is `Investment` — the UAD 3.6 extension in the same
// guide types the field as PrimaryResidence | SecondHome | Investment | Other — and
// Investment is what essentially every RTL file resolves to. The other four are our
// plain-English wording and are unverified; if Class ever rejects one, it is a
// wording fix here, not a mapping bug.
const OCCUPANCY = {
  investment: 'Investment',
  tenant: 'Tenant',
  vacant: 'Vacant',
  primary: 'Owner',
  owner: 'Owner',
  second_home: 'Second Home',
};

const norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const text = (v) => { const s = String(v == null ? '' : v).trim(); return s || null; };

// A contact Class will accept. Their `contacts.Type` list is closed; we only ever
// emit the four roles an appraisal genuinely needs.
function contact(type, person, { primary = false } = {}) {
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
  return { Type: type, firstName: first, lastName: last, primaryContact: !!primary, contactMethods: methods };
}

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
function buildOrder(ctx = {}, overrides = {}) {
  const missing = [];
  const assumptions = [];
  const overridden = [];
  const pick = (key, derived) => {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] != null && overrides[key] !== '') {
      overridden.push(key);
      return overrides[key];
    }
    return derived;
  };

  const p = ctx.property || {};
  const loan = ctx.loan || {};

  // ---- property type -------------------------------------------------------
  const pKey = norm(p.category);
  let propertyTypeEnum = PROPERTY_TYPE[pKey] || null;
  if (!propertyTypeEnum && PROPERTY_TYPE_ASSUMED[pKey]) {
    const [val, why] = PROPERTY_TYPE_ASSUMED[pKey];
    propertyTypeEnum = val;
    assumptions.push({ field: 'propertyTypeEnum', value: val, why });
  }
  propertyTypeEnum = pick('propertyTypeEnum', propertyTypeEnum);
  if (!propertyTypeEnum) {
    missing.push({ field: 'propertyTypeEnum', why: `Class has no value matching the property type "${p.category || '(blank)'}" — pick one on the order screen` });
  }

  // ---- purpose + loan type -------------------------------------------------
  const lKey = norm(loan.loanType);
  let purpose = pick('purpose', PURPOSE[lKey] || null);
  if (!purpose) missing.push({ field: 'purpose', why: `no Class purpose matches the loan type "${loan.loanType || '(blank)'}"` });

  let loanType = LOAN_TYPE[lKey] || null;
  if (!loanType && lKey) {
    loanType = 'Other';
    assumptions.push({ field: 'loanInfo.loanType', value: 'Other',
      why: `Class has no "${loan.loanType}" value — the deal's nature is carried in purpose="${purpose || '?'}" instead` });
  }
  loanType = pick('loanType', loanType);

  // ---- occupancy (V1 spelling — see the header) ----------------------------
  const occupancy = pick('occupancy', OCCUPANCY[norm(p.occupancy)] || null);

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
    contact('Borrower', ctx.borrower, { primary: true }),
    contact('Coborrower', ctx.coBorrower),
    contact('PropertyAccess', ctx.propertyContact),
    contact('LoanOfficer', ctx.loanOfficer),
  ].filter(Boolean);
  if (!contacts.some((c) => c.Type === 'Borrower')) {
    missing.push({ field: 'contacts.Borrower', why: 'Class needs a borrower contact to arrange access' });
  }
  if (!contacts.some((c) => c.Type === 'PropertyAccess')) {
    assumptions.push({ field: 'contacts.PropertyAccess', value: '(none)',
      why: 'no property-access contact on the file — the appraiser will contact the borrower to arrange entry' });
  }

  const notify = (Array.isArray(ctx.notifyEmails) ? ctx.notifyEmails : [])
    .map(text).filter(Boolean)
    .filter((e, i, a) => a.indexOf(e) === i)
    .map((email) => ({ Type: 'BorrowerInfo', Email: email }));

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
    propertyTypeEnum,
    instructions: pick('instructions', text(ctx.instructions)),
    contractPrice: money(ctx.contractPrice),
    dateOfContract: text(ctx.dateOfContract),
    notificationList: notify,
  };

  return { body, missing, assumptions, overridden, canPlace: missing.length === 0 };
}

module.exports = {
  buildOrder,
  ENUMS,
  // The five words we send for the free-form `occupancy` field — suggestions for
  // the screen, not a list Class publishes.
  OCCUPANCY_SUGGESTIONS: Object.values(OCCUPANCY).filter((v, i, a) => a.indexOf(v) === i),
  _internals: { PROPERTY_TYPE, PROPERTY_TYPE_ASSUMED, PURPOSE, LOAN_TYPE, OCCUPANCY, norm, contact },
};
