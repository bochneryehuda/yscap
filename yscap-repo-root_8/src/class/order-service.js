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
const { loadAppraisalContacts } = require('../lib/appraisal-contacts');

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
            a.borrower_id, a.co_borrower_id, a.loan_officer_id
       FROM applications a
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  const pa = addrParts(a.property_address);
  const people = (await loadAppraisalContacts(db, appId)) || {};
  return {
    appId: a.id,
    referenceNumber: a.ys_loan_number || null,
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
    // The four people the appraiser may have to call, read by the ONE shared reader
    // both appraisal desks use (src/lib/appraisal-contacts.js). It is what finally
    // fills `propertyContact` — the realtor or contractor who can open the door was
    // sitting on the file all along and neither vendor was ever told about them.
    // Reading it here rather than off the query above is deliberate: two desks
    // naming two different people for one property is the drift this prevents.
    ...people,
    lender: { clientName: 'YS Capital Group' },
    notifyEmails: [],
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
};

function fieldRows(built, extra) {
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
        // A display string only — `value` stays the raw id, because that is what is
        // sent and what an override must match.
        display: path === 'productId' && extra && extra.productTitle
          ? `${extra.productTitle} (#${v})` : undefined,
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
  // AND SO DOES AN ASSUMPTION ABOUT SOMETHING THAT IS NOT IN THE BODY. The builder
  // says "no property-access contact on the file — the appraiser will contact the
  // borrower to arrange entry", and that sentence reached nothing: the loop above
  // covers `missing` and had no twin for `assumptions`, so the one thing the reviewer
  // most needs to know about access was computed and dropped. The AMC desk shows the
  // same sentence.
  for (const a of (built.assumptions || [])) {
    if (!a || !a.field || rows.some((r) => r.path === a.field)) continue;
    rows.push({ path: a.field, label: LABELS[a.field] || a.field,
      value: a.value == null ? null : String(a.value), state: 'derived', why: a.why });
  }
  return rows;
}

async function buildPreview(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;
  // The version comes from the system default unless this order chose one. The
  // BUILDER resolves it (an override wins), and the answer it reports is what the
  // screen shows and what the send posts to — never re-derived here, or the screen
  // could describe one version while the order goes out on the other.
  const cfg = client.configured();
  const built = orderBuild.buildOrder(ctx, opts.overrides || {}, { version: opts.version || cfg.apiVersion });
  // THE FORM'S NAME, NOT ONLY ITS NUMBER. "Class product #1042" tells nobody what is
  // being ordered — the person placing the order has to know they are buying an
  // interior 1004, not a desktop. Their catalogue is the only place the name lives,
  // so it is looked up here (cached, best-effort) rather than being retyped into our
  // own list, which would silently rot the day they rename a form. Resolving it can
  // never block or fail an order: with the connection off, or their list unreadable,
  // the number stands alone exactly as before.
  const productTitle = cfg.enabled ? await client.productTitle(built.body.productId) : null;
  return {
    context: ctx,
    body: built.body,
    productTitle,
    fields: fieldRows(built, { productTitle }),
    contacts: built.body.contacts || [],
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
    defaultVersion: cfg.apiVersion,
    config: cfg,
    hosts: client.hosts(),
  };
}

module.exports = { loadContext, buildPreview, fieldRows, _internals: { LABELS, addrParts } };
