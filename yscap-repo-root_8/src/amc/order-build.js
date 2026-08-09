'use strict';
/**
 * AMC order builder — auto-fill a CreateAppraisal order from a loan file.
 *
 * Takes a NORMALIZED context (assembled by the route from the applications row +
 * borrowers + Property Research) and produces the `spec` that src/amc/cdg.js
 * buildCreateAppraisal turns into the wire message. Keeping this pure (it consumes a
 * normalized object, not raw DB rows) means the whole auto-fill mapping is unit-tested
 * without a database (scripts/test-amc-order-build-pure.js); the route owns the DB read.
 *
 * The owner's decision (2026-08-05): the form auto-picks and every field auto-fills,
 * and staff can change anything on the order preview before it's sent.
 *
 * A few enum mappings (mortgage type, property title category) can't be pinned exactly
 * without the AppraisalScope UAT account, so they map to sensible defaults and are
 * OVERRIDABLE on the preview — marked "verify against UAT".
 */
const { norm } = require('./form-select');
// The repo's ONE definition of "what kind of property is this" — reused, never
// re-derived, so the appraisal desk and the loan file cannot disagree.
const { propertyTypeKey } = require('../lib/property-type');
// The ONE test for "can the appraiser actually reach this person" — shared with the
// Class desk, so a contact that counts on one desk cannot fail to count on the other.
const { reachable, usableEmail } = require('../lib/appraisal-contacts');

// Our property category → AppraisalScope titleCategoryType. Best-effort labels;
// staff can override on the preview. Unknown → pass the category through as-is.
const TITLE_CATEGORY = {
  sfr: 'Single Family', singlefamily: 'Single Family', single: 'Single Family',
  condo: 'Condominium', condominium: 'Condominium',
  townhouse: 'Townhouse', pud: 'PUD',
  multi24: '2-4 Family', twotofour: '2-4 Family', duplex: '2-4 Family',
  multi5: 'Multi-Family', multifamily: 'Multi-Family',
};
function titleCategoryFor(propertyCategory) {
  const k = norm(propertyCategory);
  return TITLE_CATEGORY[k] || (propertyCategory ? String(propertyCategory) : null);
}

// Our occupancy → AppraisalScope propertyCurrentOccupancyType (out-of-the-box values
// are Owner Occupied / Tenant Occupied / Vacant). RTL is overwhelmingly investment.
function occupancyFor(occupancy) {
  const k = norm(occupancy);
  if (!k) return null;
  if (k === 'primary' || k === 'owneroccupied' || k === 'primaryresidence') return 'Owner Occupied';
  if (k === 'investment' || k === 'investor' || k === 'tenantoccupied' || k === 'nonowneroccupied') return 'Tenant Occupied';
  if (k === 'vacant') return 'Vacant';
  if (k === 'secondary' || k === 'secondhome') return 'Owner Occupied';
  return null;
}

// Deal purpose → CDG loanPurposeType. Anything that reads as a refinance → Refinance,
// else Purchase (the caller passes the deal-basis reading).
function loanPurposeFor(loanPurpose) {
  const k = norm(loanPurpose);
  if (!k) return null;
  return /refi|refinance/.test(k) ? 'Refinance' : 'Purchase';
}

// The deal shape form selection keys on.
//
// `loanType` and `propertyKey` (2026-08-07) are what the owner's real form defaults
// key on, and neither could be read off the original three fields:
//   • loanPurpose is deliberately collapsed to Purchase/Refinance — that IS the CDG
//     field — so it can never distinguish a fix & flip from a bridge, which is the
//     whole basis of choosing between the "Completed Subject to (w/As Is Value)"
//     forms and the plain ones.
//   • propertyCategory carries the RAW stored label, so "Condominium" and "Condo"
//     are different strings for one thing. propertyKey is the repo's canonical key
//     (property-type.propertyTypeKey), reused rather than re-derived so the appraisal
//     desk and the loan file can never disagree about what a property IS.
// Both are additive: the original three are untouched, so an existing rule matches
// exactly as before.
function dealShapeFor(ctx) {
  const rawType = ctx.loanType || ctx.loanPurpose || null;
  return {
    program: ctx.program || null,
    propertyCategory: ctx.property && ctx.property.category || ctx.propertyCategory || null,
    loanPurpose: loanPurposeFor(ctx.loanPurpose) || (ctx.loanPurpose || null),
    loanType: rawType,
    propertyKey: propertyTypeKey(ctx.property && ctx.property.category || ctx.propertyCategory || null),
  };
}

// Build the CreateAppraisal spec from the loan-file context + the chosen form.
// form: { productCode, subproductCodes, amcIdentifier } (from form-select) — productCode
//   may be overridden by opts.productCode when staff pick a different form.
// opts: { mortgageType, requestComment, rush, needByDate, notifyEmails, jobFee,
//         managementFee, bestContact, embeddedFiles, requestAction, parentSpOrderNumber }
function buildOrderSpec(ctx, form, opts = {}) {
  const pr = ctx.property || {};
  const spec = {
    requestAction: opts.requestAction || 'CreateAppraisal',
    parentSpOrderNumber: opts.parentSpOrderNumber || null,
    productCode: opts.productCode != null ? String(opts.productCode) : (form && form.productCode != null ? String(form.productCode) : null),
    subproductCodes: opts.subproductCodes != null ? opts.subproductCodes.map(String)
      : (form && Array.isArray(form.subproductCodes) ? form.subproductCodes.map(String) : []),
    amcIdentifier: opts.amcIdentifier != null ? String(opts.amcIdentifier)
      : (form && form.amcIdentifier != null ? String(form.amcIdentifier) : null),

    clientOrderNumber: ctx.clientOrderNumber || ctx.loanNumber || null,
    clientReferenceNumber: ctx.clientReferenceNumber || null,

    rush: opts.rush != null ? !!opts.rush : false,
    needByDate: opts.needByDate || null,
    jobFee: opts.jobFee != null ? opts.jobFee : null,
    managementFee: opts.managementFee != null ? opts.managementFee : null,
    requestComment: opts.requestComment || null,
    notifyEmails: notifyList(ctx, opts),

    loan: {
      loanNumber: ctx.loanNumber || null,
      // RTL loans are business-purpose; AppraisalScope requires a mortgageType. Default
      // to the vendor sample's value, overridable on the preview (verify against UAT).
      mortgageType: opts.mortgageType || ctx.mortgageType || 'Conventional',
      loanPurpose: loanPurposeFor(ctx.loanPurpose),
      baseLoanAmount: ctx.loanAmount != null ? ctx.loanAmount : null,
      estimatedClosingDate: ctx.estimatedClosingDate || null,
      lienPriority: ctx.lienPriority || null,
    },

    property: {
      titleCategory: opts.titleCategory || titleCategoryFor(pr.category || ctx.propertyCategory),
      addressLine: pr.addressLine || null,
      addressLine2: pr.addressLine2 || null,
      city: pr.city || null,
      state: pr.state || null,
      postalCode: pr.postalCode || null,
      county: pr.county || null,
      legalDescription: pr.legalDescription || null,
      occupancy: occupancyFor(pr.occupancy || ctx.occupancy),
      salesContractAmount: pr.salesContractAmount != null ? pr.salesContractAmount : null,
      salesConcessionAmount: pr.salesConcessionAmount != null ? pr.salesConcessionAmount : null,
      salesConcessionType: pr.salesConcessionType || null,
      viewTypeIds: Array.isArray(pr.viewTypeIds) ? pr.viewTypeIds : [],
    },

    borrowers: (ctx.borrowers || []).map((b, i) => ({
      classification: b.classification || (i === 0 ? 'Primary' : 'Secondary'),
      firstName: b.firstName || null,
      middleName: b.middleName || null,
      lastName: b.lastName || null,
      fullName: b.fullName || null,
      legalEntityName: b.entityName || ctx.entityName || null,
      contacts: buildContacts(b),
      residence: b.residence || null,
    })),

    // The people the appraiser may have to call, by ROLE — the same four Class
    // Valuation carries (src/class/order-build.js), read once by the shared
    // src/lib/appraisal-contacts.js so the two desks can never name different
    // people for one file. See buildRoleContacts below for how each role travels.
    contacts: buildRoleContacts(ctx),

    parties: {
      loanOfficerId: (ctx.parties && ctx.parties.loanOfficerAmcId) || null,
      loanProcessorId: (ctx.parties && ctx.parties.loanProcessorAmcId) || null,
      investorId: (ctx.parties && ctx.parties.investorAmcId) || null,
      // Best-person-to-contact is REQUIRED (enum Borrower | Co-Borrower | Owner | Agent).
      bestContact: opts.bestContact || (ctx.parties && ctx.parties.bestContact)
        || bestContactFor(ctx),
    },

    embeddedFiles: Array.isArray(opts.embeddedFiles) ? opts.embeddedFiles : [],
  };
  return spec;
}

function buildContacts(b) {
  const out = [];
  // A manufactured `noemail+<task>@clickup.local` address is not a contact detail —
  // it is what the ClickUp sync writes when a borrower has NO email, and sending it
  // to the appraisal company reads as a real address to everybody downstream.
  const email = usableEmail(b.email);
  if (email || b.homePhone) out.push({ type: 'Home', email: email || undefined, phone: b.homePhone || b.cellPhone || undefined });
  if (b.workPhone) out.push({ type: 'Work', phone: b.workPhone });
  if (b.cellPhone && !(out[0] && out[0].phone === b.cellPhone)) out.push({ type: 'Mobile', phone: b.cellPhone });
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Role contacts — "add to AppraisalScope the contacts same as we have with Class"
// (owner-directed 2026-08-09).
//
// Class takes all four roles in ONE list. AppraisalScope does not have one list,
// and the difference is not cosmetic:
//   • BORROWER / CO-BORROWER already ride their own borrowers[] entries, so their
//     phone and email go there (buildContacts above) and are never duplicated.
//   • PROPERTY ACCESS is the person who opens the door. It travels as a named
//     party, and it is the only reason `bestContact` may read anything other than
//     "Borrower".
//   • OUR LOAN OFFICER MAY NEVER BE SENT AS THEIR "LoanOfficer". That slot on the
//     NAN tenant carries the NOTE BUYER (db/481 / src/amc/party-map.js — their list
//     literally reads "Investor Blue Lake"), so putting our employee there would
//     route the order, and its invoice, to the wrong capital partner. The officer
//     is carried as a NOTIFICATION address instead — a documented CDG field — so
//     they hear about the order without occupying a routing slot.
// A role we cannot fill is simply absent; nothing here invents a person.
// ---------------------------------------------------------------------------
function buildRoleContacts(ctx) {
  const src = ctx.contacts || {};
  const rows = [];
  const add = (role, person, how) => {
    if (!person) return;
    const name = person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ') || null;
    if (!name && !reachable(person)) return;
    rows.push({
      role,
      name,
      firstName: person.firstName || null,
      lastName: person.lastName || null,
      company: person.company || null,
      email: usableEmail(person.email),
      phone: person.mobile || person.workPhone || null,
      // How this person actually reaches the appraisal company, so the order
      // screen can say so instead of implying every role is sent the same way.
      sentAs: how,
    });
  };
  add('Borrower', src.borrower, 'borrower');
  add('Coborrower', src.coBorrower, 'borrower');
  add('PropertyAccess', src.propertyContact, 'party');
  add('LoanOfficer', src.loanOfficer, 'notification');
  return rows;
}

// The order's notification list: whatever staff typed, plus our own loan officer
// (see buildRoleContacts — this is how the officer travels, since their LoanOfficer
// slot belongs to the note buyer). De-duplicated case-insensitively so an officer
// somebody already typed in is not notified twice.
function notifyList(ctx, opts = {}) {
  const typed = Array.isArray(opts.notifyEmails) ? opts.notifyEmails : [];
  const lo = ctx.contacts && ctx.contacts.loanOfficer;
  const all = [...typed, lo && usableEmail(lo.email)].filter(Boolean).map((e) => String(e).trim()).filter(Boolean);
  const seen = new Set();
  return all.filter((e) => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Their required "best person to contact" enum (Borrower | Co-Borrower | Owner |
// Agent). A file with somebody recorded for property access means the appraiser
// should call THEM to get in; with nobody, it is the borrower — which is what this
// desk has always sent. The exact enum spelling is one of the leaves marked
// "verify against UAT" in cdg.js.
function bestContactFor(ctx) {
  // REACHABLE, not merely present. A realtor recorded with only a company name — which
  // the file-contacts door explicitly allows — used to flip this to 'Agent' while the
  // order screen said nobody was on file and the wire carried no number for them: the
  // appraiser was told to call an agent and given no way to.
  return reachable(ctx.contacts && ctx.contacts.propertyContact) ? 'Agent' : 'Borrower';
}

// Who is missing, in plain words, for the order screen. NOT a refusal: an appraisal
// can be ordered with only the borrower, which is how every order placed so far has
// gone out. It says what the appraiser will be left with.
function contactNotes(spec) {
  const rows = (spec && spec.contacts) || [];
  const has = (role) => rows.some((r) => r.role === role && (r.email || r.phone));
  // NOTE: `email`/`phone` on a built row are ALREADY filtered by `reachable` upstream
  // (buildRoleContacts drops a manufactured address), so this and bestContactFor and
  // missingRequired are all answering the same question about the same values.
  const notes = [];
  if (!has('PropertyAccess')) {
    notes.push('No property-access contact on the file — the appraiser will call the borrower to arrange entry.');
  }
  if (!has('LoanOfficer')) {
    notes.push('No loan-officer email on the file — nobody here will be copied on the appraisal company’s notices.');
  }
  return notes;
}

// What's still missing before this order can be sent? Returns [] when the required
// CreateAppraisal fields are all present, else a list of plain-language field names —
// so the preview shows exactly what to fix (and the submit path refuses without them).
function missingRequired(spec) {
  const missing = [];
  if (!spec.productCode) missing.push('appraisal form');
  if (!spec.loan || !spec.loan.loanNumber) missing.push('loan number');
  if (!spec.loan || !spec.loan.mortgageType) missing.push('mortgage type');
  const p = spec.property || {};
  if (!p.titleCategory) missing.push('property type');
  if (!p.addressLine) missing.push('property street address');
  if (!p.city) missing.push('property city');
  if (!p.state) missing.push('property state');
  if (!p.postalCode) missing.push('property ZIP');
  const primary = (spec.borrowers || []).find((b) => (b.classification || 'Primary') === 'Primary') || (spec.borrowers || [])[0];
  if (!primary || (!primary.firstName && !primary.legalEntityName)) missing.push('borrower first name');
  if (!primary || (!primary.lastName && !primary.legalEntityName)) missing.push('borrower last name');
  if (!spec.parties || !spec.parties.bestContact) missing.push('best person to contact');
  // Somebody has to let the appraiser in. Class refuses an order with no borrower
  // contact for exactly this reason. Here the test is satisfied by ANY of the ways a
  // reachable person actually reaches the appraisal company — the borrower's own
  // contact methods on borrowers[], or a named property-access party — because a
  // realtor with the lockbox answers the question just as well as the borrower does.
  const borrowerReachable = (spec.borrowers || []).some((b) =>
    Array.isArray(b.contacts) && b.contacts.some((c) => c.email || c.phone));
  const accessReachable = (spec.contacts || []).some((c) =>
    c.role === 'PropertyAccess' && (c.email || c.phone));
  if (!borrowerReachable && !accessReachable) {
    missing.push('an email or phone number for the borrower (the appraiser needs someone to call to get in)');
  }
  return missing;
}

module.exports = {
  buildOrderSpec, dealShapeFor, missingRequired, contactNotes,
  titleCategoryFor, occupancyFor, loanPurposeFor,
  _internals: { buildRoleContacts, bestContactFor, notifyList, buildContacts },
};
