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

// THE RTL STRATEGY the form defaults key on — one of the exact tokens db/481 seeds:
// `fix_and_flip` / `bridge` / `dscr` / `ground_up` (or null = can't tell, so the desk
// asks a human rather than guess a wrong form).
//
// WHY THIS EXISTS (the live bug, 2026-08-11): the amc_form_map `loan_type` dimension
// carries the RTL strategy, but the loan file has NO single column that spells it the
// way the seed does. It lives in the DEAL/PROJECT TYPE (applications.program, e.g.
// "Fix & Flip" / "Bridge / Stabilized" / "Ground-up Construction" / "Fix & Hold
// (BRRRR)") and the rehab tier (applications.rehab_type), NEVER in applications.loan_type
// — that column is the loan PURPOSE (Purchase/Refinance), the one thing this dimension
// was added precisely because it could NOT express. dealShapeFor used to feed loanType
// from loanPurpose, so every deal's strategy read as "Purchase"/"Refinance" and matched
// NONE of the nine seeded rules — the "no form default for NAN" report. So the strategy
// is DERIVED from the real signals, by keyword, into the seed's own tokens. norm() then
// makes both sides equal ('fix_and_flip' → 'fixandflip'), so emitting the token string
// is what makes chooseForm match. A property with no product word AND no rehab tier is
// genuinely unknown → null → the full catalog + a human pick (never a wrong report).
function dealStrategyKey(ctx) {
  const c = ctx || {};
  // The product word can arrive in the deal type (program), the rehab tier, or a legacy
  // keyword an old file stored in the loan_type column (exposed here as loanPurpose).
  // "Purchase"/"Refinance" match none of the patterns below, so reading the purpose can
  // only ever HELP (catch a legacy "Ground up") — never false-classify a normal deal.
  const has = (re) => [c.program, c.rehabType, c.loanPurpose, c.loanType].some((v) => re.test(norm(v)));
  // GROUND-UP KEYS ON 'ground' ONLY, NEVER 'construction' — the canonical fix & flip
  // program value is "Fix & Flip w/ Construction" (the ClickUp-synced enum; plain
  // "Fix & Flip" was a drift bug that was fixed), and it contains the word "construction".
  // Matching /construction/ here classified every fix & flip as ground_up (unseeded) →
  // no form default, which is the exact live bug this fix exists to remove. Every REAL
  // ground-up value carries "ground" (program "Ground-Up Construction", rehab_type
  // "Ground-up", legacy "Ground up"), so /ground/ loses nothing. Same reasoning as
  // pricing.js engineStrategy, which documents this trap.
  if (has(/ground/)) return 'ground_up';                            // deliberately unseeded → asks a human
  if (has(/dscr|rental|30year|thirtyyear|longterm/)) return 'dscr';
  // A renovation of any depth (flip, BRRRR/hold, or a rehab tier) has a scope of work,
  // so it needs the "Completed Subject to (w/As Is Value)" form — the seed's fix_and_flip.
  if (has(/flip|brrrr|fixhold|fixandhold|\bhold\b/)) return 'fix_and_flip';
  if (has(/cosmetic|light|moderate|heavy|renovation|reno|rehab/)) return 'fix_and_flip';
  if (has(/bridge|stabil/)) return 'bridge';
  return null;
}

// The deal shape form selection keys on.
//
// `loanType` and `propertyKey` (2026-08-07) are what the owner's real form defaults
// key on, and neither could be read off the original three fields:
//   • loanPurpose is deliberately collapsed to Purchase/Refinance — that IS the CDG
//     field — so it can never distinguish a fix & flip from a bridge, which is the
//     whole basis of choosing between the "Completed Subject to (w/As Is Value)"
//     forms and the plain ones. So `loanType` here is the DERIVED RTL strategy
//     (dealStrategyKey), NOT the CDG loan purpose.
//   • propertyCategory carries the RAW stored label, so "Condominium" and "Condo"
//     are different strings for one thing. propertyKey is the repo's canonical key
//     (property-type.propertyTypeKey), reused rather than re-derived so the appraisal
//     desk and the loan file can never disagree about what a property IS.
function dealShapeFor(ctx) {
  return {
    program: ctx.program || null,
    propertyCategory: ctx.property && ctx.property.category || ctx.propertyCategory || null,
    loanPurpose: loanPurposeFor(ctx.loanPurpose) || (ctx.loanPurpose || null),
    // The RTL strategy (fix_and_flip / bridge / dscr / ground_up), derived — see above.
    // A caller that already knows it can pass ctx.loanType to override the derivation.
    loanType: ctx.loanType || dealStrategyKey(ctx),
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
    // The order-update email recipients (loan officer + processor + borrower(s)) — from
    // the file context by default (loadContext), overridable per order. → products[].notifications.
    notifyEmails: Array.isArray(opts.notifyEmails) ? opts.notifyEmails.filter(Boolean)
      : (Array.isArray(ctx.notifyEmails) ? ctx.notifyEmails.filter(Boolean) : []),

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

    parties: {
      loanOfficerId: (ctx.parties && ctx.parties.loanOfficerAmcId) || null,
      loanProcessorId: (ctx.parties && ctx.parties.loanProcessorAmcId) || null,
      investorId: (ctx.parties && ctx.parties.investorAmcId) || null,
      // Best-person-to-contact is REQUIRED (enum Borrower | Co-Borrower | Owner | Agent).
      bestContact: opts.bestContact || (ctx.parties && ctx.parties.bestContact) || 'Borrower',
    },

    embeddedFiles: Array.isArray(opts.embeddedFiles) ? opts.embeddedFiles : [],
  };
  return spec;
}

function buildContacts(b) {
  const out = [];
  if (b.email || b.homePhone) out.push({ type: 'Home', email: b.email || undefined, phone: b.homePhone || b.cellPhone || undefined });
  if (b.workPhone) out.push({ type: 'Work', phone: b.workPhone });
  if (b.cellPhone && !(out[0] && out[0].phone === b.cellPhone)) out.push({ type: 'Mobile', phone: b.cellPhone });
  return out.length ? out : undefined;
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
  return missing;
}

module.exports = {
  buildOrderSpec, dealShapeFor, dealStrategyKey, missingRequired,
  titleCategoryFor, occupancyFor, loanPurposeFor,
};
