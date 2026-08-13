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

// AppraisalScope's loan.estimatedClosingDate is OPTIONAL, but when SUPPLIED it must be TODAY
// OR LATER — the gateway rejects a past value with "-1008 Service Provider Processing Error:
// Invalid request data. missing_field_array: estimated_closing_date: Date must be greater than
// or equal to current date." A file's est_closing_date is frequently blank, or has drifted
// into the past by the time an appraisal is ordered. So we send the file's date ONLY when it
// is a valid calendar day on or after today; a blank, malformed, or PAST date is OMITTED
// (returns null → cdg.js drops the field) rather than fabricated forward. We deliberately do
// NOT substitute a made-up future date just to pass validation — that would feed the appraiser
// a closing date that isn't real; staff enter the real revised date on the file, and the order
// preview flags a stale/missing one (see closingDateStatus / orderAssumptions). This never
// writes back onto applications.est_closing_date (that field feeds first-payment/maturity
// derivation and the closing chain, and stays the staff's own value).
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function utcTodayISO() {
  return new Date().toISOString().slice(0, 10);
}
function isoDayOrNull(v) {
  return (typeof v === 'string' && ISO_DAY_RE.test(v)) ? v : null;
}
// The estimated closing date to send to the gateway: the file's date when it is a valid
// calendar day that is today-or-later, else null (OMIT — the field is optional). Never
// fabricates a date. opts.today is for tests.
function orderClosingDate(fileDate, opts = {}) {
  const today = isoDayOrNull(opts.today) || utcTodayISO();
  const d = isoDayOrNull(fileDate);
  return (d && d >= today) ? d : null;           // valid future date → send it; else omit
}
// Classify the file's closing date for the preview: 'ok' (a valid future date we'll send),
// 'stale' (a real date that has already passed — omitted, and worth flagging so staff enter
// the real revised date), or 'none' (blank/unparseable — nothing to send).
function closingDateStatus(fileDate, opts = {}) {
  const today = isoDayOrNull(opts.today) || utcTodayISO();
  const d = isoDayOrNull(fileDate);
  if (d && d >= today) return 'ok';
  return d ? 'stale' : 'none';
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
//         managementFee, bestContact, embeddedFiles, requestAction, parentSpOrderNumber,
//         estimatedClosingDate }
function buildOrderSpec(ctx, form, opts = {}) {
  const pr = ctx.property || {};

  // Client Displayed on Report (AppraisalScope's client_displayed_id). A pinned id (opts)
  // wins; its display name is taken from the matching resolved option so a pinned id NEVER
  // rides a stale default name for a different profile. With no pin, carry the ctx-resolved
  // id + name (the owner-directed default "YS Capital Group").
  const pinnedCdId = opts.clientDisplayedId != null && opts.clientDisplayedId !== ''
    ? String(opts.clientDisplayedId) : null;
  const pinnedCdName = opts.clientDisplayedName != null && opts.clientDisplayedName !== ''
    ? String(opts.clientDisplayedName) : null;
  let clientDisplayedId;
  let clientDisplayedName;
  if (pinnedCdId != null) {
    clientDisplayedId = pinnedCdId;
    if (pinnedCdName != null) {
      clientDisplayedName = pinnedCdName;
    } else {
      const match = (Array.isArray(ctx.clientDisplayedOptions) ? ctx.clientDisplayedOptions : [])
        .find((o) => o && String(o.id) === pinnedCdId);
      clientDisplayedName = match && match.name != null ? String(match.name) : null;
    }
  } else {
    clientDisplayedId = ctx.clientDisplayedId != null && ctx.clientDisplayedId !== ''
      ? String(ctx.clientDisplayedId) : null;
    clientDisplayedName = pinnedCdName != null ? pinnedCdName
      : (ctx.clientDisplayedName != null && ctx.clientDisplayedName !== ''
        ? String(ctx.clientDisplayedName) : null);
  }

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

    // The "Client Displayed on Report" (AppraisalScope's REQUIRED client_displayed_id) —
    // resolved in order-service (config id, else the account's profile matched to the default
    // name "YS Capital Group"). cdg.js sends the resolved id TWO ways with the same value —
    // on message.clientSystem.sourceInformation.sourceClientIdentifier AND on a
    // partyRoleType="Lender" party's partyRoleIdentifier — so the gateway is satisfied
    // whichever it reads. A staffer can pin a specific id via opts (its name comes from the matching option).
    clientDisplayedId,
    clientDisplayedName,

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
      // Optional field, but the gateway rejects a PAST value — so send the file's closing date
      // only when it is today-or-later, else OMIT it (orderClosingDate returns null → cdg.js
      // drops it). We never fabricate a date to pass validation; a stale/missing one is flagged
      // on the preview. A staffer may pin one (opts.estimatedClosingDate); it is checked too.
      estimatedClosingDate: orderClosingDate(opts.estimatedClosingDate || ctx.estimatedClosingDate, { today: opts.today }),
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
      // The vendor's REQUIRED `purchase_amount` maps from purchasePriceAmount — carry it
      // (purchase deals only; loadContext leaves it null on a refinance). Kept distinct
      // from salesContractAmount, which the vendor treats as a separate optional field.
      purchasePriceAmount: pr.purchasePriceAmount != null ? pr.purchasePriceAmount : null,
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
  // The MAIN CONTACT the appraiser reaches (AppraisalScope's REQUIRED `primary_contact`).
  // The vendor needs a real person AND a way to reach them — the best-contact role token
  // alone is not a contact — so resolve the choice to an actual borrower and carry their
  // name + phone + email. cdg.js emits this on the BestContact party.
  spec.primaryContact = resolvePrimaryContact(spec.borrowers, spec.parties.bestContact);
  return spec;
}

// Resolve the best-contact role to the actual person + a phone/email for them.
function resolvePrimaryContact(borrowers, bestContact) {
  const list = Array.isArray(borrowers) ? borrowers : [];
  const primary = list.find((b) => (b.classification || 'Primary') === 'Primary') || list[0] || null;
  const secondary = list.find((b) => b.classification === 'Secondary') || null;
  const reachable = (b) => (Array.isArray(b && b.contacts) ? b.contacts : []).some((c) => c && (c.phone || c.email));
  let who = bestContact === 'Co-Borrower' ? (secondary || primary) : primary;
  // The vendor needs a REACHABLE primary_contact. If the default person has no phone or
  // email on file but another borrower does, use that borrower — an order with one
  // reachable person should not be blocked because the default contact has no reach.
  if (who && !reachable(who)) who = list.find(reachable) || who;
  if (!who) return null;
  const contacts = Array.isArray(who.contacts) ? who.contacts : [];
  const firstWith = (k) => { for (const c of contacts) if (c && c[k]) return c[k]; return null; };
  const fullName = who.fullName
    || [who.firstName, who.lastName].filter(Boolean).join(' ')
    || who.legalEntityName || null;
  return {
    role: bestContact || 'Borrower',
    // The classification of the borrower this resolved TO — so cdg.js can name the
    // BestContact party as 'Borrower' vs 'Co-Borrower' and the gateway reads the right
    // borrower's contact. This matters when the reachable-fallback above switched `who`
    // from the primary to a co-borrower: the vendor's primary_contact comes from whichever
    // borrower the BestContact party points at, so it must point at the reachable one.
    classification: who.classification || 'Primary',
    firstName: who.firstName || null,
    lastName: who.lastName || null,
    fullName: fullName || null,
    phone: firstWith('phone'),
    email: firstWith('email'),
  };
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
  // AppraisalScope REQUIRES a numeric `client_displayed_id` — the client/lender profile shown
  // on the report, sent on the wire as sourceClientIdentifier (see cdg.js). It resolves to an
  // id from AMC_CLIENT_DISPLAYED_ID, or the account's GetClientDisplayOnReport profile matched
  // to the default name "YS Capital Group" (or the sole profile). A NAME alone cannot satisfy
  // the gateway, so we refuse HERE with a plain message when no id resolves — rather than send
  // an order that fails at the vendor with a cryptic "client_displayed_id: Required". For a
  // normal single-profile account this auto-resolves and never blocks.
  if (!spec.clientDisplayedId) missing.push('the client shown on the appraisal report');
  // AppraisalScope REQUIRES purchasePriceAmount (its `purchase_amount`) ONLY on a purchase
  // (its mapping: "Required when Intended Use is Purchase") — NOT salesContractAmount, which
  // the vendor treats as a separate optional field. Validate the field NAN actually reads,
  // and only when the order goes out as a Purchase, so a blank shows on the preview as a plain
  // "still needed" line and the submit refuses — never a silent bad order that only fails at
  // the vendor with a cryptic 400. (A refinance does not require purchase_amount.)
  if (spec.loan && spec.loan.loanPurpose === 'Purchase' && (!p || p.purchasePriceAmount == null)) {
    missing.push('purchase price');
  }
  const pc = spec.primaryContact;
  if (!pc || (!pc.phone && !pc.email)) missing.push('a phone or email for the main contact');
  return missing;
}

// ---------------------------------------------------------------------------
// The auto-filled ASSUMPTIONS on a built spec — the values PILOT chose because the
// file didn't state one (a default) or picked from a rule/mapping, each with a plain
// reason, so the desk can SHOW what it filled in before the order goes out. PURE: it
// READS the built spec + the inputs and classifies them; it never re-derives a default,
// so what the assumptions list says can never disagree with what buildOrderSpec sends.
// A value a staffer overrode (in opts) or that came verbatim from the file is NOT an
// assumption and is left off the list.
// ---------------------------------------------------------------------------
function orderAssumptions(ctx, form, opts = {}, spec = null) {
  const s = spec || buildOrderSpec(ctx, form, opts);
  const loan = s.loan || {};
  const property = s.property || {};
  const parties = s.parties || {};
  const out = [];
  const add = (field, label, value, why, source) => {
    if (value == null || value === '') return;
    out.push({ field, label, value: String(value), why, source });
  };

  // The appraisal form, auto-picked from the form rules (only when staff didn't pick one).
  // chooseForm returns the human name as `productName`; accept `name` too for a caller
  // that hands one in. Fall back to the id only when neither is known.
  if (opts.productCode == null && form && form.productCode != null) {
    add('productCode', 'Appraisal form', form.productName || form.name || ('Form #' + form.productCode),
      'Picked automatically from the form rules for this deal — you can change it above.', 'rule');
  }
  // Mortgage type: RTL loans are business-purpose and the file rarely states one, so it
  // is DEFAULTED. The vendor requires it, so it is worth a second look before ordering.
  if (opts.mortgageType == null && (ctx.mortgageType == null || ctx.mortgageType === '')) {
    add('mortgageType', 'Mortgage type', loan.mortgageType,
      'Filled in with a default — the file doesn’t state one. Check it before ordering.', 'default');
  }
  // Best person to contact: defaulted to the borrower when the file doesn't name one.
  const partiesBest = ctx.parties && ctx.parties.bestContact;
  if (opts.bestContact == null && (partiesBest == null || partiesBest === '')) {
    add('bestContact', 'Best person to contact', parties.bestContact,
      'Defaulted to the borrower — change it if the appraiser should reach someone else.', 'default');
  }
  // Property type (the vendor's title category), mapped from the file's property type.
  if (opts.titleCategory == null && property.titleCategory) {
    add('titleCategory', 'Property type', property.titleCategory,
      'Worked out from the property type on the file.', 'derived');
  }
  // The client shown on the appraisal report — surfaced so the desk sees what will print on
  // the report (defaults to "YS Capital Group"). Shown only when an id actually resolved (the
  // gateway requires the id); not shown when the staffer picked one explicitly, or when the
  // account has several to choose from / none resolvable (missingRequired flags those).
  if (opts.clientDisplayedId == null && opts.clientDisplayedName == null && s.clientDisplayedId
      && ctx.clientDisplayedSource && ctx.clientDisplayedSource !== 'multiple' && ctx.clientDisplayedSource !== 'none') {
    const shown = ctx.clientDisplayedName
      ? (s.clientDisplayedId ? `${ctx.clientDisplayedName} (#${s.clientDisplayedId})` : ctx.clientDisplayedName)
      : (s.clientDisplayedId ? ('#' + s.clientDisplayedId) : null);
    const why = ctx.clientDisplayedSource === 'catalog'
      ? 'Matched to a profile in your AppraisalScope account.'
      : ctx.clientDisplayedSource === 'config'
        ? 'Set for your AppraisalScope account.'
        : 'Filled in with your default — change it if the report should show a different client.';
    add('clientDisplayedId', 'Client shown on the report', shown, why, ctx.clientDisplayedSource);
  }
  // Property value on a refinance: there is no purchase price, so the value the loan is
  // sized on was used. The appraisal gateway requires an amount, so this is worth a look.
  const isRefi = /refi|refinance/.test(norm(ctx.loanPurpose));
  if (isRefi && property.salesContractAmount != null) {
    add('salesContractAmount', 'Property value', property.salesContractAmount,
      'This is a refinance, so there’s no purchase price — the estimated value on file was used.', 'derived');
  }
  // Closing date: the appraiser's system rejects a date in the past, so a stale file date is
  // NOT sent (the field is optional). Flag it as a warning so staff can enter the real revised
  // closing date on the file. A missing date is simply omitted (no warning — that's allowed).
  const closingRaw = opts.estimatedClosingDate || ctx.estimatedClosingDate;
  if (closingDateStatus(closingRaw, { today: opts.today }) === 'stale') {
    out.push({
      field: 'estimatedClosingDate',
      label: 'Closing date on file',
      value: String(isoDayOrNull(closingRaw) || ''),
      why: 'This has already passed, so it won’t be sent to the appraiser (their system needs a future date). Enter the file’s real revised closing date if you have one.',
      source: 'warning',
      warn: true,
    });
  }
  return out;
}

module.exports = {
  buildOrderSpec, orderAssumptions, dealShapeFor, dealStrategyKey, missingRequired,
  titleCategoryFor, occupancyFor, loanPurposeFor, resolvePrimaryContact,
  orderClosingDate, closingDateStatus,
};
