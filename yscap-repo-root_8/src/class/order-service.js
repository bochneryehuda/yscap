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

  // Everyone Class should email as the appraisal moves: the loan officer, the
  // processor, and the borrower(s). Each becomes a `BorrowerInfo` entry on the
  // order's notificationList (see order-build), so Class copies all of them when the
  // report comes back — the SAME set NAN carries as products[].notifications. A
  // deactivated LO/processor drops out (their is_active LEFT JOIN yields NULL), and
  // a malformed or duplicate address is dropped rather than sent.
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

async function buildPreview(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;
  // The version comes from the system default unless this order chose one. The
  // BUILDER resolves it (an override wins), and the answer it reports is what the
  // screen shows and what the send posts to — never re-derived here, or the screen
  // could describe one version while the order goes out on the other.
  const cfg = client.configured();
  const built = orderBuild.buildOrder(ctx, opts.overrides || {}, { version: opts.version || cfg.apiVersion });
  return {
    context: ctx,
    body: built.body,
    fields: fieldRows(built),
    contacts: built.body.contacts || [],
    // Who Class will email as the appraisal moves (LO + processor + borrowers). The
    // notificationList is an array, so fieldRows() skips it — surface it here so the
    // screen shows every recipient before the order goes out (the desk's standing rule).
    notifyEmails: ctx.notifyEmails,
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
