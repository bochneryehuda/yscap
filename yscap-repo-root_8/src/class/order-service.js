'use strict';
/**
 * Class Valuation — read a loan file and build the order preview.
 *
 * The DB half. `order-build.js` stays pure and knows nothing about our schema;
 * this module owns the read and the normalization, exactly as the AMC pair does.
 *
 * THE PREVIEW IS THE POINT. The owner's standing rule for this desk:
 *   "we need to make sure that we see all the fields that he's filling
 *    automatically before he's sending those over"
 * so `buildPreview` returns a FLAT, LABELLED list of every field that would be
 * sent — not the four the AMC panel happened to render. `fieldRows()` walks the
 * built body itself rather than a hand-kept list, so a field added to the builder
 * shows up on the screen automatically instead of being silently invisible. That
 * is the defect the audit found on the AMC desk, and re-hand-listing here would
 * reproduce it.
 *
 * Each row carries its own provenance: `derived` (we worked it out — the reviewer
 * should look), `overridden` (a human typed it), `missing` (blocks the order), or
 * plain (read straight off the file). The screen colours by that, so "what did
 * the computer decide for me?" is answerable at a glance.
 */

const orderBuild = require('./order-build');
const client = require('./client');
const cfg = require('../config');
const formSelect = require('./form-select');
// Class REQUIRES a county on every order, and a mailing address never carries one.
// resolveCounty geocodes the property (cached) so PILOT fills it automatically — a
// stated assumption, never a silent default — and the builder blocks cleanly if it
// still could not be resolved.
const addressCanon = require('../lib/address-canon');
// The RTL strategy token (fix_and_flip / bridge / dscr / ground_up) is derived by the
// SAME mapper the AMC desk uses, so a class_form_map rule keyed on a strategy means
// exactly what the equivalent amc_form_map rule means. Both desks are RTL and this is a
// pure helper — reused rather than re-implemented so the two form maps can never drift.
const { dealStrategyKey } = require('../amc/order-build');

function addrParts(v) {
  const a = (v && typeof v === 'object') ? v : {};
  return {
    addressLine: a.addressLine || a.line1 || a.street || null,
    addressLine2: a.addressLine2 || a.line2 || a.unit || null,
    city: a.city || null,
    state: a.state || null,
    postalCode: a.postalCode || a.zip || null,
    county: a.county || null,
  };
}

// Our canonical property key, reused rather than re-derived — the same rule the
// AMC form selection follows, so the two desks can never disagree about what a
// property IS.
const { propertyTypeKey } = require('../lib/property-type');

async function loadContext(db, appId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.loan_type, a.property_address, a.property_type,
            a.occupancy, a.purchase_price, a.loan_amount, a.est_closing_date,
            a.program, a.rehab_type,
            a.borrower_id, a.co_borrower_id, a.loan_officer_id, a.processor_id,
            b.first_name AS b_first, b.last_name AS b_last, b.full_name AS b_full,
            b.email AS b_email, b.cell_phone AS b_cell,
            cb.first_name AS c_first, cb.last_name AS c_last, cb.full_name AS c_full,
            cb.email AS c_email, cb.cell_phone AS c_cell,
            lo.full_name AS lo_name, lo.email AS lo_email, lo.phone AS lo_phone,
            pr.email AS pr_email
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  // The fallback pool for Class's single notification recipient. Class's
  // notificationList accepts EXACTLY ONE item, of type BorrowerInfo (see
  // order-build) — the builder sends the borrower's own email, and only falls
  // back to the first of THESE when the borrower has no email on file. The loan
  // officer and processor follow the order in PILOT, not through Class. A
  // deactivated LO/processor drops out (their is_active LEFT JOIN yields NULL),
  // and a malformed or duplicate address is dropped rather than kept.
  const notifyEmails = [];
  const addEmail = (e) => {
    const v = String(e == null ? '' : e).trim().toLowerCase();
    if (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !notifyEmails.includes(v)) notifyEmails.push(v);
  };
  addEmail(a.lo_email);
  addEmail(a.pr_email);
  addEmail(a.b_email);
  addEmail(a.c_email);

  const pa = addrParts(a.property_address);
  return {
    appId: a.id,
    referenceNumber: a.ys_loan_number || null,
    // The RTL deal signals the product auto-pick keys on (see dealShapeFor). The rehab
    // tier and the program together derive the strategy; carried but never sent to Class.
    program: a.program || null,
    rehabType: a.rehab_type || null,
    property: {
      ...pa,
      // The canonical key, not the raw stored label — "Condominium" and "Condo"
      // must not be two different things to the vendor mapping.
      category: propertyTypeKey(a.property_type) || null,
      categoryLabel: a.property_type || null,
      occupancy: a.occupancy || 'investment',   // RTL is investment property by definition
    },
    loan: {
      loanNumber: a.ys_loan_number || null,
      loanAmount: a.loan_amount,
      purchaseAmount: a.purchase_price,
      loanType: a.loan_type || null,
    },
    contractPrice: a.purchase_price,
    dueDate: null,                               // staff choose on the screen
    borrower: { firstName: a.b_first, lastName: a.b_last, fullName: a.b_full, email: a.b_email, mobile: a.b_cell },
    coBorrower: a.co_borrower_id
      ? { firstName: a.c_first, lastName: a.c_last, fullName: a.c_full, email: a.c_email, mobile: a.c_cell }
      : null,
    loanOfficer: a.loan_officer_id
      ? { firstName: (a.lo_name || '').split(' ')[0] || null,
          lastName: (a.lo_name || '').split(' ').slice(1).join(' ') || null,
          email: a.lo_email, workPhone: a.lo_phone }
      : null,
    // Class's PropertyAccess contact is who lets the appraiser IN. The file models no
    // distinct access party, and a stale purchase-side realtor would be worse than
    // nothing on a refinance — so this stays null and order-build records that the
    // appraiser reaches the borrower to arrange entry, exactly NAN's parties.bestContact.
    propertyContact: null,
    lender: { clientName: 'YS Capital Group' },
    notifyEmails,
    // HOW IT IS PAID. Class's API offers three ways at order time (src/class/payment.js):
    // Invoice (billed to our account), PaymentLink (Class emails the borrower their
    // hosted payment page) and Prepay. Invoice is their default and ours; a staffer
    // switches to the payment link on the order screen, and the link goes to the
    // borrower's own address unless they name another.
    paymentMethod: 'Invoice',
    paymentEmail: a.b_email || null,
  };
}

// ---------------------------------------------------------------------------
// Flatten the BUILT body into labelled rows. Walking the body (rather than a
// hand-kept field list) is what guarantees the screen can never fall behind the
// builder — add a field to order-build and it appears here with no extra work.
// ---------------------------------------------------------------------------
// One label per field PATH. Both UAD versions are covered here, so a field that is
// renamed between them (the property type) still reads in plain English on either.
const LABELS = {
  apiVersion: 'Which version of their form',
  productId: 'Product (their form)',
  referenceNumber: 'Our order number',
  'property.street': 'Street',
  'property.line2': 'Unit / line 2',
  'property.city': 'City',
  'property.state': 'State',
  'property.zip': 'ZIP',
  'property.county': 'County',
  'property.taxId': 'Tax / parcel id',
  'lender.clientName': 'Lender shown to the appraiser',
  'lender.clientAddress': 'Lender address',
  'lender.contactInformation': 'Lender contact',
  'loanInfo.loanNumber': 'Loan number',
  'loanInfo.loanAmount': 'Loan amount',
  'loanInfo.loanType': 'Their loan type',
  'loanInfo.fhaNumber': 'FHA case number',
  'loanInfo.purchaseAmount': 'Purchase amount',
  dueDate: 'Due date',
  purpose: 'Purpose',
  occupancy: 'Occupancy',
  propertyType: 'Their property type',        // UAD 3.6 name
  duReferenceNumber: 'Fannie Mae DU case number',
  lpaKeyReferenceIdentifier: 'Freddie Mac LPA key',
  caseFileId: 'GSE case file id',
  lpaKey: 'Freddie Mac LPA key',
  propertyTypeEnum: 'Their property type',
  instructions: 'Instructions to the appraiser',
  'paymentDetails.paymentMethod': 'How the appraisal is paid',
  'paymentDetails.recipientEmail': 'Who Class emails the payment link to',
  contractPrice: 'Contract price',
  dateOfContract: 'Contract date',
};

// A body field whose NAME differs by version, mapped back to the ONE key the screen
// and the builder use for its override. The override key stays `propertyTypeEnum` on
// both versions deliberately (so a staffer's correction keeps applying when the
// default moves) — which means that on 3.6, where the body key is `propertyType`,
// neither the key nor the path matches and a value a human typed rendered as "From
// the file" on the one screen whose entire job is showing where a value came from.
const OVERRIDE_KEY_FOR_PATH = {
  propertyType: 'propertyTypeEnum',
  propertyTypeEnum: 'propertyTypeEnum',
  'paymentDetails.paymentMethod': 'paymentMethod',
  'paymentDetails.recipientEmail': 'paymentEmail',
};

function fieldRows(built) {
  const rows = [];
  const derived = new Map((built.assumptions || []).map((a) => [a.field, a]));
  const missing = new Map((built.missing || []).map((m) => [m.field, m]));
  const overridden = new Set(built.overridden || []);
  const wasOverridden = (k, path) =>
    overridden.has(k) || overridden.has(path)
    || overridden.has(OVERRIDE_KEY_FOR_PATH[path]) || overridden.has(OVERRIDE_KEY_FOR_PATH[k]);

  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); continue; }
      if (Array.isArray(v)) continue;              // contacts / notifications render separately
      const d = derived.get(path);
      const m = missing.get(path);
      rows.push({
        path,
        label: LABELS[path] || path,
        value: v,
        state: m ? 'missing' : wasOverridden(k, path) ? 'overridden' : d ? 'derived' : 'read',
        why: (m && m.why) || (d && d.why) || null,
      });
    }
  };
  walk(built.body, '');

  // A missing field that has no place in the body yet (a whole contact, say)
  // still has to be shown, or the reviewer sees a blocker with no row.
  for (const [field, m] of missing) {
    if (!rows.some((r) => r.path === field)) {
      rows.push({ path: field, label: LABELS[field] || field, value: null, state: 'missing', why: m.why });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Product (form) auto-pick — the Class mirror of the AMC form-selection rules.
// Reads the admin-editable class_form_map, matches a rule to the deal, and returns the
// chosen Class productId. INERT until class_form_map is seeded (db/537 ships it EMPTY):
// with no rows chooseProduct returns null and staff pick from Class's live catalog —
// exactly today's behaviour. When the owner names the Class product ids and a later
// migration seeds the rows, the auto-pick lights up with no code change here.
// ---------------------------------------------------------------------------
const PRODUCT_RULE_COLS =
  `id, program, property_category, loan_purpose, loan_type, property_key,
   product_id, product_name, priority, active`;

async function loadProductRules(db) {
  // Scope to the tenant environment, and ONLY the tenant environment. Class product ids
  // are environment-specific — UAT ids are short numbers ("56634"), production ids are
  // 24-hex — so a rule seeded for one environment names a product the other does not
  // have. A cross-environment fallback used to fill the gap "so a product still
  // auto-picks"; once db/686 seeded the production rows it made every UAT deal
  // auto-pick a production id, which Class would refuse at send time. Better nothing
  // than a confident wrong product: with no rules for THIS environment nothing is
  // picked and staff choose from the live catalogue, exactly as before any seed.
  const env = (cfg.class && cfg.class.environment) || 'production';
  const forEnv = await db.query(
    `SELECT ${PRODUCT_RULE_COLS} FROM class_form_map
      WHERE active = true AND (environment = $1 OR environment IS NULL)
      ORDER BY priority ASC, id ASC`, [env]);
  return forEnv.rows;
}

// The deal shape the product rules match on — program + property category/key + loan
// purpose + the RTL STRATEGY. `loan_purpose` is the Purchase/Refinance stored on the file;
// `loan_type` is the strategy (fix_and_flip/bridge/dscr/ground_up) DERIVED the same way the
// AMC desk derives it, so a rule keyed on a strategy means the same thing on both desks.
function dealShapeFor(ctx) {
  const c = ctx || {};
  const strategy = dealStrategyKey({
    program: c.program,
    rehabType: c.rehabType,
    loanPurpose: c.loan && c.loan.loanType,
    loanType: c.loan && c.loan.loanType,
  });
  return {
    program: c.program || null,
    propertyCategory: c.property && c.property.categoryLabel,   // the RAW label
    loanPurpose: c.loan && c.loan.loanType,                     // Purchase / Refinance
    loanType: strategy,                                          // the RTL strategy token
    propertyKey: c.property && c.property.category,             // the canonical key (sfr / condo / …)
  };
}

// ---------------------------------------------------------------------------
// Learned v1 occupancy — the value Class actually accepted for a classification.
//
// v1 `occupancy` binds to an undocumented enum (see order-build), so the first order
// of a classification cascades through the candidate list until Class takes one. That
// winner is remembered HERE, in process, keyed by environment + version + classification,
// so every later order of the same shape starts on the accepted value and cascades no
// further. It is deliberately in-process only: a restart simply re-learns on the next
// order (a few free model-binding 400s), so there is no table to migrate or go stale,
// and nothing durable to be wrong.
// ---------------------------------------------------------------------------
const LEARNED_OCCUPANCY = new Map();
const occKey = (apiVersion, oKey) =>
  `${(cfg.class && cfg.class.environment) || 'production'}:${apiVersion}:${oKey}`;
function rememberOccupancy(apiVersion, oKey, value) {
  if (!apiVersion || !oKey || !value) return;
  LEARNED_OCCUPANCY.set(occKey(apiVersion, oKey), String(value));
}
function learnedOccupancy(apiVersion, oKey) {
  if (!apiVersion || !oKey) return null;
  return LEARNED_OCCUPANCY.get(occKey(apiVersion, oKey)) || null;
}

async function buildPreview(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;

  // Class REQUIRES a county and the file's mailing address rarely carries one, so
  // work it out from the property address (a geocode lookup, cached forever). It is
  // recorded as a DERIVED assumption below so the reviewer sees it — never a silent
  // default — and if it cannot be resolved the builder blocks the order with a plain
  // reason (order-build) instead of letting Class 400. Best-effort: a staff override
  // still wins in buildOrder, exactly like the product/version defaults.
  let countyDerived = false;
  if (ctx.property && !ctx.property.county) {
    try {
      const c = await addressCanon.resolveCounty(ctx.property);
      if (c) { ctx.property.county = c; countyDerived = true; }
    } catch (_) { /* the builder blocks cleanly if county stays blank */ }
  }
  // Auto-pick the Class product from the admin rules. A staff override (opts.overrides
  // .productId) still WINS inside buildOrder, which reads ctx.productId as the DERIVED
  // value — so we set it here and let the override take precedence, exactly the way the
  // form default does. `chosen` is null until class_form_map is seeded, so with no rules
  // productId stays unset and the order desk asks a human to pick, unchanged.
  const productRules = await loadProductRules(db);
  const chosen = formSelect.chooseProduct(dealShapeFor(ctx), productRules);
  if (chosen && ctx.productId == null) ctx.productId = chosen.productId;
  // The version comes from the system default unless this order chose one. The
  // BUILDER resolves it (an override wins), and the answer it reports is what the
  // screen shows and what the send posts to — never re-derived here, or the screen
  // could describe one version while the order goes out on the other.
  const cfgd = client.configured();
  const built = orderBuild.buildOrder(ctx, opts.overrides || {}, { version: opts.version || cfgd.apiVersion });

  // Record the county we worked out as a stated assumption so the reviewer sees it
  // on the preview (the desk's "show what was filled automatically" rule). Skip it
  // when a staffer typed one — the builder already marks that row overridden.
  if (countyDerived && ctx.property.county && !(built.overridden || []).includes('county')) {
    built.assumptions.push({
      field: 'property.county',
      value: ctx.property.county,
      why: 'read from the property address (Class requires a county and the file did not carry one) — confirm it is correct',
    });
  }

  // If this environment already learned which occupancy value Class accepts for this
  // classification, start the order on it (and put it at the head of the cascade) so a
  // proven file goes out clean on the first try. A learned value the builder did not
  // already offer is added; the builder's order is otherwise preserved.
  const learned = learnedOccupancy(built.apiVersion, built.occupancyKey);
  let occupancyCandidates = Array.isArray(built.occupancyCandidates) ? built.occupancyCandidates.slice() : [];
  if (learned) {
    occupancyCandidates = [learned, ...occupancyCandidates.filter((v) => v !== learned)];
    if (occupancyCandidates[0] != null) built.body.occupancy = occupancyCandidates[0];
  }

  return {
    context: ctx,
    body: built.body,
    fields: fieldRows(built),
    // The full occupancy cascade + the classification the accepted value is remembered
    // under. The order route walks these on the specific occupancy binding error and,
    // on success, remembers the winner via `rememberOccupancy`.
    occupancyCandidates,
    occupancyKey: built.occupancyKey,
    contacts: built.body.contacts || [],
    // Who Class will email as the appraisal moves. Class's notification list carries
    // exactly ONE item, of type BorrowerInfo — the borrower's own address (Class
    // notifies the borrower; the LO/processor follow the order in PILOT). The
    // notificationList is an array, so fieldRows() skips it — surface the actual
    // recipient(s) that go out here, per the desk's "show what goes out" rule.
    notifyEmails: (built.body.notificationList || [])
      .map((n) => n.Email || n.email).filter(Boolean),
    // The product PILOT auto-picked from class_form_map (null until the map is seeded).
    // Staff can still change it on the screen; the override wins in buildOrder.
    chosenProduct: chosen,
    missing: built.missing,
    assumptions: built.assumptions,
    overridden: built.overridden,
    canPlace: built.canPlace,
    // Which version this preview IS, and everything the screen needs to offer only
    // what that version accepts.
    apiVersion: built.apiVersion,
    uad: built.uad,
    versionLabel: built.versionLabel,
    path: built.path,
    options: orderBuild.screenOptions(built.apiVersion),
    versions: orderBuild.VERSIONS,
    defaultVersion: cfgd.apiVersion,
    config: cfgd,
    hosts: client.hosts(),
  };
}

module.exports = {
  loadContext, buildPreview, fieldRows, loadProductRules, dealShapeFor,
  rememberOccupancy, learnedOccupancy,
  _internals: { LABELS, addrParts, LEARNED_OCCUPANCY, occKey },
};
