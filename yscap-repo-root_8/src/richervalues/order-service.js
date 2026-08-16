'use strict';
/**
 * Richer Values — read a loan file, build the order preview, and place the order.
 *
 * The DB half. `order-build.js` stays pure and knows nothing about our schema;
 * this module owns the read, the normalization, the vendor round-trip and the
 * bookkeeping — exactly the split the AMC and Class desks use.
 *
 * THE PREVIEW IS THE POINT, and it is the same standing rule this desk inherits
 * from the Class one: "we need to make sure that we see all the fields that he's
 * filling automatically before he's sending those over". So `buildPreview` returns
 * a flat, labelled list of EVERY field that would be sent, each carrying where its
 * value came from — and the list is walked out of the BUILT body, so a field added
 * to the builder appears on the screen with no extra work.
 *
 * WHERE THE PROPERTY FACTS COME FROM, in order, and why that order:
 *   1. WHAT THE STAFFER TYPED. Always wins; a human looking at the property beats
 *      every record.
 *   2. THE LOAN FILE ITSELF (`applications`) — the year built and the living area,
 *      which the appraisal import already fills (db/403).
 *   3. THE PROPERTY WAREHOUSE (`properties`, db/409). This is the one that earns
 *      its keep: bedrooms, bathrooms and lot size are NOT columns on a loan file,
 *      and this order needs all three before an appraisal exists to state them.
 *      The warehouse holds every property any appraisal we have ever imported
 *      described — including as somebody else's comparable — so the subject of a
 *      new loan is often already in it. Every value carries its own source
 *      sentence, and the screen shows it, because a number PILOT found in a
 *      three-year-old comparable grid is worth checking.
 *   4. NOTHING. An unknown value is MISSING, never a default. This product prices
 *      off these figures.
 *
 * MONEY IS INTEGER CENTS on the way into the database (the house rule); their API
 * speaks dollars, so the conversion happens here and nowhere else.
 */

const orderBuild = require('./order-build');
const results = require('./results');
const reference = require('./reference');
const client = require('./client');
const payment = require('./payment');
const loanGuard = require('./loan-guard');
const scopeOfWork = require('./scope-of-work');
const cfg = require('../config');
const xmlWaiver = require('../lib/appraisal/xml-waiver');
const { propertyTypeKey } = require('../lib/property-type');
const { propertyKey } = require('../lib/research/property-key');

const RV = () => cfg.richerValue || {};

// ---------------------------------------------------------------------------
// Reading the file.
// ---------------------------------------------------------------------------
function addrParts(v) {
  const a = (v && typeof v === 'object') ? v : {};
  return {
    addressLine: a.addressLine || a.line1 || a.street || null,
    addressLine2: a.addressLine2 || a.line2 || null,
    unitNumber: a.unit || a.unitNumber || null,
    city: a.city || null,
    state: a.state || null,
    postalCode: a.postalCode || a.zip || null,
    county: a.county || null,
  };
}

/** A `{value, source}` pair — `source` is the sentence the screen shows. */
const from = (value, source) => ({ value: value == null || value === '' ? null : value, source: value == null || value === '' ? null : source });
const nothing = () => ({ value: null, source: null });

async function loadContext(db, appId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.loan_type, a.program, a.rehab_type,
            a.property_address, a.property_type, a.units,
            a.purchase_price, a.as_is_value, a.arv, a.rehab_budget, a.loan_amount,
            a.sqft_pre, a.sqft_post, a.year_built, a.living_area_sqft,
            a.expected_closing, a.borrower_id, a.loan_officer_id, a.processor_id,
            b.full_name AS b_full, b.email AS b_email, b.cell_phone AS b_cell,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.phone AS lo_phone,
            pr.full_name AS pr_name, pr.email AS pr_email, pr.phone AS pr_phone
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  const pa = addrParts(a.property_address);

  // ---- the property warehouse (db/409) ----------------------------------
  // Best-effort: an address we cannot key, an unreachable table or a property we
  // have never seen all read as "we know nothing", which is a correct answer.
  let warehouse = null;
  try {
    const key = propertyKey({ street: pa.addressLine, unit: pa.unitNumber, city: pa.city, state: pa.state, zip: pa.postalCode });
    if (key) {
      const w = await db.query(
        `SELECT display_address, beds, baths_full, baths_half, baths_text, gla, below_grade_sqft,
                lot_area, year_built, stories, garage_spaces, condition_uad, condition_text,
                units, property_category
           FROM properties WHERE address_key = $1`, [key]);
      warehouse = w.rows[0] || null;
    }
  } catch (_) { warehouse = null; }

  // ---- the most recent appraisal on THIS file, if there is one ----------
  // A file being valued by this product usually has none — but a transferred or
  // previously imported appraisal is the best source there is, so it is asked.
  let appraisal = null;
  try {
    const ap = await db.query(
      `SELECT gla, below_grade_sqft, bedrooms, bathrooms, year_built, lot_size, stories, garage_spaces,
              condition_uad
         FROM appraisals WHERE application_id=$1 AND superseded=false
         ORDER BY imported_at DESC LIMIT 1`, [appId]);
    appraisal = ap.rows[0] || null;
  } catch (_) { appraisal = null; }

  const WH = 'From PILOT’s property records (an appraisal that described this property) — please check it.';
  const APPR = 'From the appraisal on this file.';
  const FILE = 'From the loan file.';

  const bathsOf = (row) => {
    if (!row) return null;
    if (row.bathrooms != null) return Number(row.bathrooms);
    const full = Number(row.baths_full);
    const half = Number(row.baths_half);
    if (!Number.isFinite(full) && !Number.isFinite(half)) return null;
    return (Number.isFinite(full) ? full : 0) + (Number.isFinite(half) ? half * 0.5 : 0);
  };
  const lotOf = (row) => {
    if (!row) return null;
    if (row.lot_size != null) return Number(row.lot_size);
    // The warehouse stores the lot as free text ("0.23 acres", "10,454 sf")
    // because that is how appraisers write it, so it is only used when it reads
    // unambiguously as a number of square feet. An acreage is converted; anything
    // else is left unknown rather than guessed at.
    const t = String(row.lot_area || '').trim();
    if (!t) return null;
    const acres = /^([\d.,]+)\s*ac(res?)?\b/i.exec(t);
    if (acres) { const n = Number(acres[1].replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n * 43560) : null; }
    const sf = /^([\d.,]+)\s*(sf|sq\.?\s*ft|square\s*feet)?$/i.exec(t);
    if (sf) { const n = Number(sf[1].replace(/,/g, '')); return Number.isFinite(n) ? Math.round(n) : null; }
    return null;
  };

  const firstOf = (...candidates) => {
    for (const c of candidates) if (c && c.value != null && c.value !== '') return c;
    return nothing();
  };

  const specs = {
    aboveGradeSqft: firstOf(
      from(a.living_area_sqft, FILE),
      from(appraisal && appraisal.gla, APPR),
      from(a.sqft_pre, 'From the loan file’s square footage before the work.'),
      from(warehouse && warehouse.gla, WH)),
    belowGradeSqft: firstOf(
      from(appraisal && appraisal.below_grade_sqft, APPR),
      from(warehouse && warehouse.below_grade_sqft, WH)),
    bedrooms: firstOf(
      from(appraisal && appraisal.bedrooms, APPR),
      from(warehouse && warehouse.beds, WH)),
    bathrooms: firstOf(
      from(bathsOf(appraisal), APPR),
      from(bathsOf(warehouse), WH)),
    yearBuilt: firstOf(
      from(a.year_built, FILE),
      from(appraisal && appraisal.year_built, APPR),
      from(warehouse && warehouse.year_built, WH)),
    lotSizeSquareFeet: firstOf(
      from(lotOf(appraisal), APPR),
      from(lotOf(warehouse), WH)),
    stories: firstOf(
      from(appraisal && appraisal.stories, APPR),
      from(warehouse && warehouse.stories, WH)),
    garageSpaces: firstOf(
      from(appraisal && appraisal.garage_spaces, APPR),
      from(warehouse && warehouse.garage_spaces, WH)),
    conditionUad: (appraisal && appraisal.condition_uad) || (warehouse && warehouse.condition_uad) || null,
  };

  // ---- WHO IS ON THE ORDER (owner-directed 2026-08-14) -------------------
  // *"We need: the loan officer, the processor for the report, a borrower, cell
  // phone — recommended all the Max contacts possible."*
  //
  // They are NOT interchangeable, and mixing them up is how a lender's own
  // valuation reaches a borrower:
  //
  //   report contact   the loan officer, falling back to the processor. This is
  //                    where the FINISHED REPORT goes, and it carries our own
  //                    valuation — so it is NEVER the borrower.
  //   report Cc        the OTHER one of the two, so both people who chase an
  //                    appraisal see it land. Also never the borrower.
  //   access contacts  the borrower and their MOBILE. A homeowner-led inspection
  //                    is done through a link Richer Values TEXTS, so the cell
  //                    phone is the one that matters, and this is the only place
  //                    the borrower belongs on the order.
  const officer = { name: a.lo_name, email: a.lo_email, phone: a.lo_phone, role: 'Loan officer' };
  const processor = { name: a.pr_name, email: a.pr_email, phone: a.pr_phone, role: 'Processor' };
  const borrower = { name: a.b_full, email: a.b_email, phone: a.b_cell, role: 'Borrower' };

  const reportContact = a.loan_officer_id && a.lo_email ? officer
    : (a.processor_id && a.pr_email ? processor : { name: null, email: null, phone: null });
  // The one who is NOT already the report contact, so nobody is sent to twice.
  const reportCc = [officer, processor]
    .filter((p) => p.email && p.email !== reportContact.email)
    .map((p) => p.email);

  return {
    appId: a.id,
    clientLoanNumber: a.ys_loan_number || null,
    program: a.program || null,
    rehabType: a.rehab_type || null,
    loanType: a.loan_type || null,
    expectedClosing: a.expected_closing || null,
    purchasePrice: a.purchase_price,
    asIsValue: a.as_is_value,
    arv: a.arv,
    rehabBudget: a.rehab_budget,
    loanAmount: a.loan_amount,
    borrowerName: a.b_full || null,
    borrowerId: a.borrower_id || null,
    property: {
      ...pa,
      // The canonical key, not the raw stored label — "Condominium" and "Condo"
      // must not be two different things to the vendor mapping.
      categoryKey: propertyTypeKey(a.property_type) || null,
      categoryLabel: a.property_type || null,
      units: a.units,
    },
    specs,
    proposed: { aboveGradeSqft: a.sqft_post || null },
    reportContact,
    reportCc,
    contacts: { officer, processor, borrower },
    borrowerEmail: a.b_email || null,
    borrowerCell: a.b_cell || null,
    // Where each spec came from, so the screen can say so without re-deriving it.
    warehouseHit: !!warehouse,
    warehouseAddress: warehouse ? warehouse.display_address : null,
  };
}

// ---------------------------------------------------------------------------
// The catalogue + the defaults, merged with what the staffer chose.
// ---------------------------------------------------------------------------
/**
 * Resolve the CHOICES for an order: the configured starting points, then anything
 * the vendor's own catalogue tells us about the chosen report, then the staffer's
 * overrides. Overrides always win — that is the whole reason the screen exists.
 */
function resolveChoices(ctx, catalogue, overrides = {}, tokens = {}) {
  const d = (RV());
  const o = overrides || {};
  const bool = (v, fallback) => (v == null || v === '' ? fallback : (v === true || v === 'true' || v === '1' || v === 1));

  const reportType = o.reportType || d.defaultReportType || 'reno-arv';
  const rt = reference.pick(catalogue.reportTypes, reportType);
  const inspectionType = o.inspectionType != null ? o.inspectionType : (d.defaultInspectionType || 'interior-w-exterior');
  const it = reference.pick(catalogue.inspectionTypes, inspectionType);

  return {
    companyToken: tokens.companyToken || null,
    loanOfficerToken: tokens.loanOfficerToken || null,
    reportType,
    inspectionType,
    turnaroundTime: o.turnaroundTime || d.defaultTurnaround || 'standard',
    // The vendor's own catalogue decides whether these two surcharges are even
    // APPLICABLE to the chosen inspection — asking for a floor plan on an
    // exterior-only visit is not something they can do — so an inapplicable
    // surcharge is forced off rather than sent and refused.
    glaInclude: (it && !it.glaApplicable) ? false : bool(o.glaInclude, d.defaultGlaInclude !== false),
    licensingRequired: (it && !it.licensingApplicable) ? false : bool(o.licensingRequired, !!d.defaultLicensing),
    includeFloodCertification: bool(o.includeFloodCertification, !!d.defaultFloodCert),
    borrowerName: o.borrowerName,

    closingDate: o.closingDate,
    historicalEffectiveDate: bool(o.historicalEffectiveDate, false),
    effectiveDate: o.effectiveDate,

    propertyUploadType: 'single',
    isVacantLand: bool(o.isVacantLand, false),
    isPartiallyCompleted: bool(o.isPartiallyCompleted, false),
    partiallyCompletedPercentage: o.partiallyCompletedPercentage,

    propertyAddress: o.propertyAddress,
    propertyAddressLine2: o.propertyAddressLine2,
    unitNumber: o.unitNumber,
    city: o.city,
    state: o.state,
    postalCode: o.postalCode,
    residentialPropertyType: o.residentialPropertyType,
    residentialPropTypeUnits: o.residentialPropTypeUnits,
    propertyCondition: o.propertyCondition,

    aboveGradeSqft: o.aboveGradeSqft,
    belowGradeSqft: o.belowGradeSqft,
    bedrooms: o.bedrooms,
    bathrooms: o.bathrooms,
    yearBuilt: o.yearBuilt,
    lotSizeSquareFeet: o.lotSizeSquareFeet,
    stories: o.stories,
    garageSpaces: o.garageSpaces,
    isBasement: o.isBasement,
    isBasementFinished: o.isBasementFinished,

    // "Same as now" — the only way to say their screen's "same-unchanged" over an
    // API whose proposed_* fields take numbers and nothing else. See order-build.
    proposedSameAsCurrent: bool(o.proposedSameAsCurrent, false),
    proposedAboveGradeSqft: o.proposedAboveGradeSqft,
    proposedBelowGradeSqft: o.proposedBelowGradeSqft,
    proposedBedrooms: o.proposedBedrooms,
    proposedBathrooms: o.proposedBathrooms,
    // Straight off their catalogue rather than a list retyped here, so a report
    // whose rules change at their end changes what we ask for with no deploy.
    asksProposedStats: rt ? rt.asksProposedStats : undefined,
    // Their catalogue's own flag for "does this report describe a building that
    // already stands?". 0 on the two construction products, whose subject has no
    // bedrooms or year built to give — see the long note in order-build.js. Left
    // `undefined` when their catalogue is unreachable, which reads as "ask for
    // them", i.e. exactly the behaviour before this flag was consulted.
    asksCurrentStats: rt ? rt.asksCurrentStats : undefined,
    needsRenovationBudget: rt ? rt.needsRenovationBudget : undefined,

    borrowerBudget: o.borrowerBudget,
    budgetFiles: o.budgetFiles,

    isPropertyOnLockbox: bool(o.isPropertyOnLockbox, false),
    lockboxCode: o.lockboxCode,
    lockboxLocation: o.lockboxLocation,
    lockboxEntrance: o.lockboxEntrance,
    communityGateCodeNeeded: bool(o.communityGateCodeNeeded, false),
    gateCode: o.gateCode,
    propertyAccessContacts: normalizeContacts(o.propertyAccessContacts, ctx),

    reportContactName: o.reportContactName,
    reportContactEmail: o.reportContactEmail,
    reportContactPhone: o.reportContactPhone,
    // Both of the two people who chase an appraisal see it land. A staffer's own
    // list always wins — including an explicitly EMPTIED one, which is why this
    // tests for null rather than falsiness.
    reportCcUsers: o.reportCcUsers != null && o.reportCcUsers !== ''
      ? o.reportCcUsers
      : ((ctx && ctx.reportCc) || []).join(','),
    inspectionNotes: o.inspectionNotes,
    valuationNotes: o.valuationNotes,
    notes: o.notes,

    expectedLoanAmount: o.expectedLoanAmount,
    acquisitionContractPrice: o.acquisitionContractPrice,
    expectedAsIsValue: o.expectedAsIsValue,
    expectedArv: o.expectedArv,
  };
}

/**
 * Property-access contacts. A staffer's list always wins; with none given, the
 * BORROWER is offered as the starting point — on an investment file they are the
 * one who arranges access, and they are the person Richer Values texts for a
 * homeowner-led inspection. It is a suggestion the screen shows and the staffer
 * can replace, never something sent behind their back: `buildOrder` reports it as
 * derived, so it appears on the preview with its own explanation.
 */
function normalizeContacts(given, ctx) {
  if (Array.isArray(given) && given.length) {
    return given.map((c) => ({ name: c && c.name, phone: c && c.phone, email: c && c.email }));
  }
  if (!ctx) return [];
  // The borrower, WITH THEIR CELL PHONE (owner-directed 2026-08-14). The mobile
  // is not decoration: a homeowner-led inspection is carried out through a link
  // Richer Values texts, so an access contact with no mobile is an order that
  // cannot start. The office numbers on the file are deliberately not used here —
  // an appraiser standing at a door needs the person with the key.
  const b = {
    name: ctx.borrowerName,
    phone: ctx.borrowerCell || null,
    email: ctx.borrowerEmail || null,
  };
  return b.name ? [b] : [];
}

// ---------------------------------------------------------------------------
// The preview.
// ---------------------------------------------------------------------------
async function catalogueFor(db, companyToken, reportType, opts = {}) {
  if (!companyToken) {
    return { reportTypes: { items: [], error: 'not configured' }, inspectionTypes: { items: [] }, turnaroundTimes: { items: [] } };
  }
  const [reportTypes, inspectionTypes, turnaroundTimes] = await Promise.all([
    reference.reportTypes(db, companyToken, opts),
    reference.inspectionTypes(db, companyToken, reportType, opts),
    reference.turnaroundTimes(db, companyToken, reportType, opts),
  ]);
  return { reportTypes, inspectionTypes, turnaroundTimes };
}

async function buildPreview(db, appId, { overrides = {}, refresh = false } = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;

  const cfgd = client.configured();
  const companyToken = await client.companyToken().catch(() => null);
  const loanOfficerToken = await client.loanOfficerToken(overrides.loanOfficerToken).catch(() => null);

  const reportType = overrides.reportType || RV().defaultReportType || 'reno-arv';
  const catalogue = await catalogueFor(db, companyToken, reportType, { force: !!refresh });
  const choices = resolveChoices(ctx, catalogue, overrides, { companyToken, loanOfficerToken });
  const built = orderBuild.buildOrder(ctx, choices);

  // The price. A LIST price is on the catalogue already; this is the real one for
  // this property, because their pricing moves with the state and the ZIP. Best-
  // effort — a price we could not fetch must never stop a preview rendering.
  let price = null;
  let priceError = null;
  if (cfgd.enabled && companyToken && built.fields.report_type && built.fields.inspection_type
      && built.fields.turnaround_time && built.fields.residential_property_type
      && built.fields.state && built.fields.postal_code) {
    try {
      const p = await client.pricing({
        company_token: companyToken,
        report_type: built.fields.report_type,
        inspection_type: built.fields.inspection_type,
        turnaround_time: built.fields.turnaround_time,
        residential_property_type: built.fields.residential_property_type,
        state: built.fields.state,
        postal_code: built.fields.postal_code,
      });
      price = (p && p.data && p.data.pricing_data) || null;
    } catch (e) { priceError = (e && e.message) || String(e); }
  }

  // What is ALREADY on this file, so the screen can refuse to order a second one
  // by accident rather than after the fact.
  const open = await db.query(
    `SELECT id, status, intake_token, order_token, created_at FROM rv_orders
      WHERE application_id=$1 AND status NOT IN ('cancelled','rejected','draft')
      ORDER BY created_at DESC LIMIT 5`, [appId]);

  // The waiver state, so the screen can say — BEFORE anyone orders — exactly what
  // ordering this will do to the appraisal condition. Promising it afterwards is
  // how a surprise happens.
  const waiver = await xmlWaiver.loadWaiver(appId, db);

  // The scope of work, NAMED but not READ. The preview only has to say whether one
  // will ride along; reading a multi-megabyte file to draw a screen would be paid
  // for on every keystroke of the builder.
  const sow = await scopeOfWork.findScopeOfWork(db, appId);

  // The $400,000 rule, judged here so the screen and the route can never disagree
  // about what is being confirmed.
  const guard = loanGuard.judgeLoanAmount(ctx.loanAmount);

  // What paying will do, said in advance. A card is described by its last four and
  // nothing else — a preview is not a reveal.
  const card = await payment.cardStatus(db, appId);
  const configuredMethod = String(RV().paymentMethod || 'COMPANY_CARD').toUpperCase();

  // OUR OWN CARD, the default route since the owner chose "we pay in-house, link as
  // backup". Asked BEFORE anyone presses pay, because "there is no card on the YS
  // Capital account" is a thing a human has to go and fix in the Richer Values
  // portal — telling them at the moment of payment is telling them too late.
  // Best-effort in every direction: it costs one read, and a read we could not make
  // must never stop the screen drawing or block the payment-link route underneath.
  let companyCard = { known: false, ready: false, why: null, card: null };
  if (cfgd.enabled && companyToken) {
    try {
      const src = await payment.resolveCompanySource(companyToken, RV().paymentSourceId || null);
      companyCard = src.ok
        ? { known: true, ready: true, why: null, card: src.card || null }
        : { known: true, ready: false, why: src.error || null, code: src.code || null, card: null };
    } catch (e) {
      companyCard = { known: false, ready: false, why: (e && e.message) || String(e), card: null };
    }
  }

  return {
    vendor: 'richer_value',
    config: cfgd,
    context: {
      loanNumber: ctx.clientLoanNumber,
      property: ctx.property,
      warehouseHit: ctx.warehouseHit,
      warehouseAddress: ctx.warehouseAddress,
      rehabBudget: ctx.rehabBudget,
      reportContact: ctx.reportContact,
    },
    catalogue: {
      reportTypes: catalogue.reportTypes.items,
      inspectionTypes: catalogue.inspectionTypes.items,
      turnaroundTimes: catalogue.turnaroundTimes.items,
      stale: !!(catalogue.reportTypes.stale || catalogue.inspectionTypes.stale || catalogue.turnaroundTimes.stale),
      error: catalogue.reportTypes.error || catalogue.inspectionTypes.error || catalogue.turnaroundTimes.error || null,
      fetchedAt: catalogue.reportTypes.fetchedAt || null,
    },
    options: orderBuild.screenOptions(),
    choices: publicChoices(choices),
    rows: orderBuild.fieldRows(built, overrides),
    missing: built.missing,
    assumptions: built.assumptions,
    dropped: built.dropped,
    blocked: built.blocked,
    canPlace: built.canPlace && cfgd.enabled && cfgd.orderReady,
    price,
    priceError,
    existingOrders: open.rows,
    contacts: ctx.contacts,
    // MEASURED against their training tenant: the same order WITH a scope of work
    // came back "Ordered" and WITHOUT one came back "On Hold". So the screen says
    // plainly which of the two this order is heading for.
    scopeOfWork: {
      present: sow.present,
      filename: sow.present ? sow.filename : null,
      source: sow.present ? sow.source : null,
      why: sow.present
        ? 'The scope of work on this file goes over with the order automatically.'
        : sow.why,
      warning: sow.present ? null
        : 'Richer Values normally puts an order with no scope of work ON HOLD until they get one. Add the scope of work first if you can.',
    },
    loanGuard: guard,
    payment: {
      // Exactly the four the owner allows. Invoice and ACH are not offered here
      // because they are not offered at all.
      methods: payment.METHODS,
      method: payment.METHODS.includes(configuredMethod) ? configuredMethod : 'COMPANY_CARD',
      card,
      companyCard,
      borrowerEmail: ctx.borrowerEmail,
      note: card.present
        ? (card.expired
          ? `The card on this file (${card.brand || 'card'} ending ${card.last4}) has expired. Enter a new one, or send the borrower a payment link.`
          : `The card entered on this file’s appraisal-card condition (${card.brand || 'card'} ending ${card.last4}) will be charged.`)
        : 'There is no credit card on this file yet. Enter one here, or send the borrower a payment link.',
    },
    xmlWaiver: {
      present: waiver.present,
      reason: waiver.reason || null,
      productHasNoXml: !!waiver.productHasNoXml,
      // What ordering will do, said plainly and in advance.
      willWaive: !waiver.present,
      note: waiver.present
        ? (waiver.productHasNoXml
          ? 'The appraisal data file (XML) is already waived on this file because a Hybrid Appraisal was ordered.'
          : 'This file already has a “no appraisal XML” waiver recorded by hand, so ordering will leave it exactly as it is.')
        : 'Ordering this will waive the appraisal data file (XML) on this file automatically — this report does not produce one. The PDF report is still required, and the As-Is value and the ARV still have to be on the file.',
    },
  };
}

/** The subset of the resolved choices the screen may see — never a vendor token. */
function publicChoices(c) {
  const { companyToken, loanOfficerToken, ...rest } = c;   // eslint-disable-line no-unused-vars
  return rest;
}

// ---------------------------------------------------------------------------
// The journal — every write, whether it worked or not.
// ---------------------------------------------------------------------------
async function journal(db, { orderRow, appId, action, method, path, request, response, ok, error, staffId }) {
  try {
    await db.query(
      `INSERT INTO rv_write_log (rv_order_row, application_id, action, method, path, request, response, ok, error, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [orderRow || null, appId || null, action, method || null, path || null,
        JSON.stringify(client.maskSafe(request) || {}), JSON.stringify(response || {}),
        ok === true, error ? String(error).slice(0, 2000) : null, staffId || null]);
  } catch (_) { /* the journal is a record, never the thing that fails the action */ }
}

// ---------------------------------------------------------------------------
// PLACING THE ORDER.
//
// The order of operations is deliberate and each step is recoverable from the row
// alone if the process dies between two of them:
//
//   1. WRITE THE ROW FIRST (status `placing`). If the submit succeeds and we then
//      crash, the row is what proves an order exists — the Class desk's rule, for
//      the same reason: a vendor-side order with no record here is the one failure
//      that cannot be cleaned up automatically.
//   2. SUBMIT. On success record the intake token immediately.
//   3. PAY, so the intake becomes a real order. Separate on purpose: an intake
//      that failed to pay is recoverable (`payIntake` can be retried) while a
//      failed submit is not.
//   4. READ BACK the order token.
//   5. WAIVE THE XML — after the order exists, never before. A waiver recorded for
//      an order that then failed to place would be a claim about a file with
//      nothing behind it.
// ---------------------------------------------------------------------------
async function placeOrder(db, appId, {
  overrides = {}, staffId = null, confirm = false,
  acknowledgements = [], payWith = null, card = null, paymentLinkTo = null,
} = {}) {
  const cfgd = client.configured();
  if (!confirm) { const e = new Error('An order has to be confirmed before it is placed.'); e.code = 'confirm_required'; throw e; }
  if (!cfgd.enabled) { const e = new Error('The Richer Values integration is switched off.'); e.code = 'rv_disabled'; throw e; }
  if (!cfgd.orderReady) { const e = new Error('Richer Values is not fully configured yet — see the API Health page.'); e.code = 'rv_not_configured'; throw e; }

  const ctx = await loadContext(db, appId);
  if (!ctx) { const e = new Error('file not found'); e.code = 'not_found'; throw e; }

  // ---- the $400,000 rule -------------------------------------------------
  // The SECOND half of the double confirmation lives HERE, not on the screen: a
  // confirmation a client can skip by not rendering it is not a confirmation. It
  // refuses ONLY the over-limit case — the "no loan amount registered yet" advice
  // is information, and refusing on it would stop ordering on every new file.
  const guard = loanGuard.judgeLoanAmount(ctx.loanAmount);
  const ack = loanGuard.checkAcknowledged(guard, acknowledgements);
  if (!ack.ok) {
    const e = new Error(ack.error);
    e.code = ack.code;
    e.loanGuard = guard;
    throw e;
  }

  const companyToken = await client.companyToken();
  const loanOfficerToken = await client.loanOfficerToken(overrides.loanOfficerToken);
  const reportType = overrides.reportType || RV().defaultReportType || 'reno-arv';
  const catalogue = await catalogueFor(db, companyToken, reportType);
  const choices = resolveChoices(ctx, catalogue, overrides, { companyToken, loanOfficerToken });

  // ---- the scope of work rides along, automatically -----------------------
  // Owner-directed, and measured: an order WITH one came back "Ordered", the same
  // order WITHOUT one came back "On Hold". A staffer who attached their own file
  // on the screen keeps it; otherwise the file's current scope of work is read and
  // sent. A scope of work we cannot read is NOT a reason to refuse the order — the
  // order still goes, and the row says the appraiser is waiting on the document.
  let sowNote = null;
  if (!(Array.isArray(choices.budgetFiles) && choices.budgetFiles.length)) {
    const read = await scopeOfWork.readScopeOfWork(db, appId);
    if (read.ok) choices.budgetFiles = [read.file];
    else sowNote = read.error;
  }

  const built = orderBuild.buildOrder(ctx, choices);

  if (built.blocked) { const e = new Error(built.blocked); e.code = 'not_eligible'; throw e; }
  if (!built.canPlace) {
    const e = new Error('The order is not complete yet.');
    e.code = 'incomplete';
    e.missing = built.missing;
    throw e;
  }

  // The appraisal condition this order belongs to, so the report files itself into
  // the right slot when it comes back.
  const item = (await db.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_appraisaldocs' LIMIT 1`, [appId])).rows[0];

  const dryrun = cfgd.dryrun;
  const ins = await db.query(
    `INSERT INTO rv_orders
       (application_id, checklist_item_id, company_token, client_loan_number,
        report_type, inspection_type, turnaround_time, gla_include, licensing_required,
        include_flood_certification, property_upload_type, request_body, dryrun,
        status, placed_by, placed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'single',$11::jsonb,$12,$13,$14, now())
     RETURNING *`,
    [appId, item ? item.id : null, companyToken, ctx.clientLoanNumber,
      built.fields.report_type, built.fields.inspection_type, built.fields.turnaround_time,
      built.fields.gla_include === '1', built.fields.licensing_required === '1',
      built.fields.include_flood_certification === '1',
      JSON.stringify(client.maskSafe(built.fields)), dryrun,
      dryrun ? 'dryrun' : 'placing', staffId]);
  const row = ins.rows[0];

  // ---- 2. submit --------------------------------------------------------
  let submitted;
  try {
    submitted = await client.submitOrder(built.fields);
  } catch (e) {
    await db.query(`UPDATE rv_orders SET status='error', last_error=$2 WHERE id=$1`,
      [row.id, describeVendorError(e)]);
    await journal(db, { orderRow: row.id, appId, action: 'submit', method: 'POST', path: '/api/v1/order/submit',
      request: built.fields, response: e.body || null, ok: false, error: e.message, staffId });
    throw e;
  }
  await journal(db, { orderRow: row.id, appId, action: 'submit', method: 'POST', path: '/api/v1/order/submit',
    request: built.fields, response: submitted, ok: true, staffId });

  if (submitted && submitted.__dryrun) {
    // TEST MODE: the request was built and logged, nothing was sent. The row stays
    // as a dryrun so it is visible on the desk and can never be mistaken for real.
    return { order: row, dryrun: true, built };
  }

  const data = (submitted && submitted.data) || {};
  const updated = await db.query(
    `UPDATE rv_orders SET intake_token=$2, payment_link=$3, intake_form_link=$4, status='intake', last_event_at=now()
      WHERE id=$1 RETURNING *`,
    [row.id, data.intake_token || null, data.payment_link || null, data.intake_form_link || null]);
  let order = updated.rows[0];

  // ---- 3 + 4. pay, and read back the order token ------------------------
  try {
    order = await payIntake(db, order, {
      staffId,
      method: payWith,
      card,
      paymentLinkTo,
      borrowerId: ctx.borrowerId || null,
    });
  } catch (e) {
    // The intake EXISTS at the vendor — it is just unpaid, which is a state their
    // own screens show and a human can settle from the payment link. So this is
    // recorded and surfaced, never treated as a failed order.
    await db.query(`UPDATE rv_orders SET last_error=$2 WHERE id=$1`,
      [order.id, `The order was submitted but not paid yet: ${describeVendorError(e)}`]);
    order = (await db.query(`SELECT * FROM rv_orders WHERE id=$1`, [order.id])).rows[0];
  }

  // ---- 5. waive the XML -------------------------------------------------
  const waived = await xmlWaiver.applyProductNoXmlWaiver(appId, {
    note: `Ordered a Hybrid Appraisal from Richer Values (${built.fields.report_type}). This product does not produce an appraisal data file (XML); the PDF report and the As-Is + ARV still apply.`,
    staffId,
    db,
  });
  if (waived.applied) {
    await db.query(`UPDATE rv_orders SET xml_waiver_applied=true WHERE id=$1`, [order.id]);
    order.xml_waiver_applied = true;
  }

  return {
    order,
    dryrun: false,
    built,
    xmlWaiver: waived,
    // Said out loud rather than left for somebody to notice: an order with no
    // scope of work is the one Richer Values puts On Hold.
    scopeOfWork: sowNote
      ? { attached: false, warning: `${sowNote} Richer Values may put this order on hold until they get one — send it from the order card as soon as you have it.` }
      : { attached: true, warning: null },
    loanGuard: guard,
  };
}

/**
 * SETTLE THE INTAKE, so it becomes a real order.
 *
 * THE OWNER'S RULE (2026-08-14) — *"We don't want to allow Add to Invoice. We
 * don't want to allow ACH."* — leaves exactly four ways, and this is the one
 * place that chooses between them:
 *
 *   COMPANY_CARD   charge the card YS Capital keeps with Richer Values. THE DEFAULT
 *                  (owner-directed 2026-08-16, "we pay in-house, link as backup")
 *                  and the only card route their Stripe account does not refuse,
 *                  because no card NUMBER is ever sent — only the id of a card a
 *                  human saved in their portal.
 *   CARD_ON_FILE   charge the card on the appraisal-card condition.
 *   NEW_CARD       a card typed at the moment of ordering; it is SAVED onto the
 *                  file first (through the shared chokepoint, so the condition is
 *                  filled by the act of paying) and then charged.
 *   PAYMENT_LINK   Richer Values emails the borrower their hosted payment page. The
 *                  order exists but does not start until they pay — which is the
 *                  honest state, and the row says so.
 *   NONE           leave it unpaid for a human to settle from the payment link.
 *
 * A CARD METHOD WITH NO CARD ANYWHERE IS NOT AN ERROR, IT IS THE PAYMENT LINK.
 * The alternative — refusing the order because nobody has entered a card — would
 * throw away an intake that already exists at the vendor and cost the desk the
 * whole order. So the fall-through is recorded in words on the row: the order is
 * placed, the borrower is asked to pay, and the desk can see exactly what happened.
 *
 * It NEVER throws for a payment problem. An unpaid intake is a state their own
 * screens show and a human can settle; treating it as a failed order would hide an
 * order that genuinely exists.
 */
async function payIntake(db, order, { staffId = null, method: methodIn = null, card = null,
  paymentLinkTo = null, paymentLinkCc = [], borrowerId = null } = {}) {
  const method = String(methodIn || RV().paymentMethod || 'COMPANY_CARD').toUpperCase();
  if (method === 'NONE') return order;
  if (!order.intake_token) return order;

  const j = (entry) => journal(db, {
    orderRow: order.id, appId: order.application_id, staffId,
    method: 'POST', path: `/api/v1/public/${order.intake_token}/payment`, ...entry,
  });

  // WHAT ACTUALLY HAPPENED, carried back on the returned row as `__payment`.
  //
  // It is a TRANSIENT property on the object, never a column: three different
  // things can come out of one press and the row alone cannot tell them apart.
  // Settled, "not settled but the borrower has been asked", and "nothing worked"
  // are three different messages, and a screen that reads only `paid_at` would
  // either call a payment link a failure or call a failed charge a success. A
  // false success on a money action is the one outcome that must be impossible.
  const settle = async (result, usedMethod) => {
    if (result.dryrun) return { ...order, __payment: { ok: true, settled: false, note: null, via: usedMethod } };
    const tokens = result.orderTokens || [];
    const orderToken = (tokens[0] && tokens[0].order_token) || null;
    const r = await db.query(
      `UPDATE rv_orders SET order_token=$2, payment_method=$3, paid_at=now(), status='ordered',
              last_event_at=now(), last_error=NULL
        WHERE id=$1 RETURNING *`, [order.id, orderToken, usedMethod]);
    return { ...r.rows[0], __payment: { ok: true, settled: true, note: null, via: usedMethod } };
  };

  const unpaid = async (usedMethod, note, { ok = false } = {}) => {
    const r = await db.query(
      `UPDATE rv_orders SET payment_method=$2, last_error=$3, last_event_at=now() WHERE id=$1 RETURNING *`,
      [order.id, usedMethod, note]);
    return { ...r.rows[0], __payment: { ok, settled: false, note, via: usedMethod } };
  };

  // ---- the payment link, asked for or fallen back to ---------------------
  // Whether the link was CHOSEN or is where a refused card landed changes what the
  // outcome means, so it is decided once here rather than at each call.
  const askedForLink = method === 'PAYMENT_LINK';
  const sendLink = async (why) => {
    const to = paymentLinkTo || (await borrowerEmailFor(db, order.application_id));
    if (!to) {
      return unpaid('PAYMENT_LINK',
        `${why}Richer Values has the order but it is not paid yet, and there is no borrower email on the file to send the payment link to. `
        + 'Add an email, or open the payment link on the order card.');
    }
    try {
      const out = await payment.sendPaymentLink(order.intake_token, { to, cc: paymentLinkCc, comment: 'Payment for your property valuation.' });
      await j({ action: 'payment_link', ok: true, request: { to: out.sentTo }, response: {} });
      // The link going out IS the success when a link is what was asked for. It is
      // still `settled:false` — nobody has paid yet, and the row must not pretend
      // otherwise — but reporting it as a FAILURE would be just as wrong in the
      // other direction. `ok` answers "did what you pressed happen?", `settled`
      // answers "has the money moved?", and they are different questions.
      return unpaid('PAYMENT_LINK',
        `${why}Richer Values has emailed the payment link to ${Array.isArray(out.sentTo) ? out.sentTo.join(', ') : out.sentTo}. `
        + 'The order starts once it is paid.',
        { ok: askedForLink });
    } catch (e) {
      await j({ action: 'payment_link', ok: false, error: e.message, response: e.body || null });
      return unpaid('PAYMENT_LINK', `${why}The payment link could not be sent: ${describeVendorError(e)}. Use the payment link on the order card.`);
    }
  };

  if (method === 'PAYMENT_LINK') return sendLink('');

  // ---- OUR OWN CARD, the one Richer Values already holds ------------------
  // Owner-directed 2026-08-16 (their CEO named the two routes that can work in
  // production; the owner chose both — this one by default, the payment link as
  // the per-order backup). It is the ONLY card route their Stripe cannot refuse,
  // because no card number is ever sent: a human saves the card once in the Richer
  // Values portal and this references the source they already hold. Nothing is
  // added and nothing has to be deleted afterwards.
  //
  // A failure here falls through to the payment link exactly as the other card
  // routes do — "link as backup" is the owner's own phrase, and an intake that
  // already exists at the vendor must never be thrown away over a payment problem.
  if (method === 'COMPANY_CARD') {
    const out = await payment.payWithCompanyCard(order.intake_token, {
      companyToken: order.company_token,
      paymentSourceId: RV().paymentSourceId || null,
      journal: j,
    });
    if (out.ok) return settle(out, 'COMPANY_CARD');
    return sendLink(`${out.error} `);
  }

  // ---- a card ------------------------------------------------------------
  const journalCard = (entry) => journal(db, {
    orderRow: order.id, appId: order.application_id, staffId,
    method: 'POST', path: '/api/v1/company/add-card', ...entry,
  });

  if (method === 'NEW_CARD') {
    // The card belongs to the FILE'S BORROWER even when a staffer types it — that
    // is the rule the shared card chokepoint records, and leaving the owner blank
    // here would file a card nobody is named on.
    const owner = borrowerId || await borrowerIdFor(db, order.application_id);
    const out = await payment.saveThenCharge(db, order.application_id, {
      intakeToken: order.intake_token,
      companyToken: order.company_token,
      cardInput: card,
      borrowerId: owner,
      journal: journalCard,
    });
    if (out.ok) return settle(out, 'NEW_CARD');
    // The card IS saved on the file even when the charge was refused (see
    // payment.js) — re-typing it would be the second thing to go wrong in a row.
    return sendLink(`${out.error} `);
  }

  // CARD_ON_FILE (and anything we do not recognise, which is the safest reading —
  // it can only ever end at the payment link).
  const onFile = await payment.readFileCard(db, order.application_id);
  if (!onFile.present) {
    return sendLink('There is no credit card on this file’s appraisal-card condition yet, so nothing could be charged. ');
  }
  // A reveal is a decryption, and a decryption nobody recorded is the one thing
  // this data must never allow.
  await auditCardView(db, order.application_id, staffId);
  const out = await payment.chargeCard(db, {
    intakeToken: order.intake_token,
    companyToken: order.company_token,
    card: { number: onFile.number, cvc: onFile.cvc, expMonth: onFile.expMonth, expYear: onFile.expYear },
    journal: journalCard,
  });
  if (out.ok) return settle(out, 'CARD_ON_FILE');
  return sendLink(`${out.error} `);
}

/** The borrower's email, for a payment link. Best-effort: no email is a state the
 *  caller reports in words, never an exception. */
async function borrowerEmailFor(db, appId) {
  try {
    const r = await db.query(
      `SELECT b.email FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId]);
    return (r.rows[0] && r.rows[0].email) || null;
  } catch (_) { return null; }
}

/** Whose card it is. Same discipline: unreadable is null, never an exception. */
async function borrowerIdFor(db, appId) {
  try {
    const r = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId]);
    return (r.rows[0] && r.rows[0].borrower_id) || null;
  } catch (_) { return null; }
}

/** The audit row for revealing a stored card, written the same way the staff
 *  reveal writes it. Never throws — an audit failure must not stop a payment that
 *  is already under way, and the vendor journal records the charge either way. */
async function auditCardView(db, appId, staffId) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,'view_appraisal_card','application',$2,$3::jsonb)`,
      [staffId || null, appId, JSON.stringify({ why: 'charging a Richer Values Hybrid Appraisal order' })]);
  } catch (_) { /* the record is a record, never the thing that fails the action */ }
}

/**
 * A vendor refusal in words a desk can act on. Their validation failures name the
 * offending fields, and "data validation failed" on its own sends nobody anywhere.
 */
function describeVendorError(e) {
  if (!e) return 'unknown error';
  const fields = Array.isArray(e.fieldErrors) ? e.fieldErrors : [];
  if (fields.length) {
    const list = fields.slice(0, 6).map((f) => (f.field ? `${f.field}: ${f.message || 'refused'}` : f.message)).join('; ');
    return `${e.message} — ${list}${fields.length > 6 ? ` (and ${fields.length - 6} more)` : ''}`;
  }
  return e.message || String(e);
}

// ---------------------------------------------------------------------------
// APPLYING THE VALUES TO THE LOAN FILE.
//
// This is what makes the automatic XML waiver actually clear: the waiver's own
// rule is that the As-Is and the ARV must be on the file, and on this product
// they arrive as data rather than as something to read off a page.
//
// It goes through the SHARED As-Is desk (`lib/appraisal/as-is-desk.js`) rather
// than an UPDATE here, which buys four things that must not be re-implemented:
// the value bounds, the ARV-must-be-above-the-As-Is check, the FILE FREEZE (a
// term-sheet-sent / clear-to-close / funded file is not rewritten by a vendor
// callback), and the audit row + condition wording. The As-Is is set FIRST so the
// ARV check runs against the value that is about to be on the file.
// ---------------------------------------------------------------------------
async function applyValues(db, orderRow, { staffId = null, actor = null } = {}) {
  const order = typeof orderRow === 'object' ? orderRow : (await db.query(`SELECT * FROM rv_orders WHERE id=$1`, [orderRow])).rows[0];
  if (!order) return { ok: false, error: 'not found' };
  const read = order.results ? results.readEnvelope({ data: order.results }, order.order_token) : null;
  const parsed = read || (order.as_is_value != null || order.arv != null
    ? { asIs: order.as_is_value != null ? Number(order.as_is_value) : null,
      arv: order.arv != null ? Number(order.arv) : null,
      arvBasis: order.arv_basis || null,
      valuesUsable: order.as_is_value != null && order.arv != null && Number(order.arv) > Number(order.as_is_value),
      unusableReason: null }
    : null);

  if (!parsed) return { ok: false, error: 'Richer Values has not sent the finished figures yet.' };
  if (!parsed.valuesUsable) return { ok: false, error: parsed.unusableReason || 'The figures that came back cannot be used.' };

  const desk = require('../lib/appraisal/as-is-desk');
  const note = `Richer Values Hybrid Appraisal${parsed.arvBasis ? ` (${parsed.arvBasis} renovation strategy)` : ''}`;
  const asIsRes = await desk.setAsIsByHuman(order.application_id, parsed.asIs, { actorId: staffId, actor, note });
  if (!asIsRes.ok) return { ok: false, error: asIsRes.error, status: asIsRes.status, locked: asIsRes.locked };
  const arvRes = await desk.setArvByHuman(order.application_id, parsed.arv, { actorId: staffId, actor, note });
  if (!arvRes.ok) return { ok: false, error: arvRes.error, status: arvRes.status, locked: arvRes.locked, asIsApplied: asIsRes.value };

  await db.query(
    `UPDATE rv_orders SET values_applied_at=now(), values_applied_by=$2 WHERE id=$1`,
    [order.id, staffId || null]);

  return { ok: true, asIs: asIsRes.value, arv: arvRes.value, arvBasis: parsed.arvBasis };
}

// ---------------------------------------------------------------------------
// Reads for the desk.
// ---------------------------------------------------------------------------
const ORDER_COLUMNS = `id, application_id, checklist_item_id, intake_token, order_token, client_loan_number,
  report_type, inspection_type, turnaround_time, gla_include, licensing_required, include_flood_certification,
  dryrun, price, total_price_cents, payment_method, paid_at, payment_link, intake_form_link,
  status, status_reason, vendor_status, vendor_inspection_status, inspection_scheduled_date, due_date,
  as_is_value, arv, arv_basis, values_applied_at, pdf_document_id, xml_waiver_applied,
  last_event_at, last_polled_at, last_error, cancel_reason, cancelled_at, placed_by, placed_at, created_at, updated_at`;

async function listOrders(db, appId) {
  const r = await db.query(
    `SELECT ${ORDER_COLUMNS} FROM rv_orders WHERE application_id=$1 ORDER BY created_at DESC`, [appId]);
  return r.rows;
}

async function getOrder(db, id) {
  const r = await db.query(`SELECT * FROM rv_orders WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

/** One order plus everything that has happened to it — the order card's payload. */
async function orderDetail(db, id) {
  const order = await getOrder(db, id);
  if (!order) return null;
  const [timeline, events, writes] = await Promise.all([
    db.query(`SELECT event_type, status, comment, occurred_at FROM rv_status_events
               WHERE rv_order_row=$1 ORDER BY occurred_at DESC NULLS LAST, id DESC LIMIT 100`, [id]),
    db.query(`SELECT action_type, action, event_at, received_at, process_error FROM rv_order_events
               WHERE rv_order_row=$1 ORDER BY received_at DESC LIMIT 50`, [id]),
    db.query(`SELECT action, ok, error, created_at FROM rv_write_log
               WHERE rv_order_row=$1 ORDER BY created_at DESC LIMIT 50`, [id]),
  ]);
  const read = order.results ? results.readEnvelope({ data: order.results }, order.order_token) : null;
  return {
    order: { ...order, request_body: undefined },
    // The full parsed report — the As-Is, the ARV, every renovation strategy, the
    // confidence block and the commentary — so the desk can show what was bought.
    report: read,
    summary: results.summaryLine(read),
    timeline: timeline.rows,
    events: events.rows,
    writes: writes.rows,
  };
}

/**
 * SEND THE UPDATED SCOPE OF WORK for one order — the owner's revision workflow.
 *
 * `revisionPlanFor` decides between updating the order, uploading the new file, and
 * reopening a finished report with the new budget; this half only supplies the
 * order's own budget and the journal. Returns the plan and the outcome so the desk
 * is told what actually happened rather than just "sent".
 */
async function sendScopeOfWorkRevision(db, orderId, { note = null, staffId = null } = {}) {
  const order = await getOrder(db, orderId);
  if (!order) return { ok: false, error: 'That order could not be found.' };

  const plan = scopeOfWork.revisionPlanFor(order);
  if (plan.action === 'none') return { ok: false, error: plan.why, plan };

  const budget = (await db.query(
    `SELECT rehab_budget FROM applications WHERE id=$1`, [order.application_id])).rows[0];

  const out = await scopeOfWork.sendRevision(db, order, {
    budget: budget ? budget.rehab_budget : null,
    note,
    plan,
    journal: (entry) => journal(db, {
      orderRow: order.id, appId: order.application_id, staffId,
      method: 'POST', path: '/api/v1/order/upload-documents', ...entry,
    }),
  });

  if (out.ok) {
    await db.query(
      `UPDATE rv_orders SET last_event_at=now(), last_error=NULL WHERE id=$1`, [order.id]);
    await db.query(
      `INSERT INTO rv_status_events (rv_order_row, application_id, event_type, status, comment, occurred_at, dedupe_key)
       VALUES ($1,$2,'sow_revision',$3,$4, now(), $5)
       ON CONFLICT (rv_order_row, dedupe_key) DO NOTHING`,
      [order.id, order.application_id, order.status || null,
        `The updated scope of work was sent to Richer Values (${out.action}).`,
        `sow:${order.id}:${Date.now()}`]);
  } else {
    await db.query(`UPDATE rv_orders SET last_error=$2 WHERE id=$1`,
      [order.id, `The updated scope of work could not be sent: ${out.error}`]);
  }
  return { ...out, plan };
}

/** What a revision WOULD do, so the screen can say so before anyone presses it. */
async function scopeOfWorkState(db, appId) {
  const found = await scopeOfWork.findScopeOfWork(db, appId);
  const orders = await db.query(
    `SELECT id, status, intake_token, order_token, dryrun FROM rv_orders
      WHERE application_id=$1 ORDER BY created_at DESC`, [appId]);
  return {
    document: found,
    orders: orders.rows.map((o) => ({ id: o.id, status: o.status, plan: scopeOfWork.revisionPlanFor(o) })),
  };
}

module.exports = {
  loadContext, buildPreview, placeOrder, payIntake, applyValues,
  listOrders, getOrder, orderDetail, journal, resolveChoices, catalogueFor,
  describeVendorError, sendScopeOfWorkRevision, scopeOfWorkState,
  _internals: { addrParts, normalizeContacts, publicChoices, borrowerEmailFor, borrowerIdFor },
};
