'use strict';
/**
 * AMC order service — the DB-backed half of appraisal ordering.
 *
 * The pure logic lives elsewhere: src/amc/form-select.js chooses the AppraisalScope
 * form for a deal, src/amc/order-build.js auto-fills a CreateAppraisal spec from a
 * NORMALIZED loan-file context, and src/amc/cdg.js turns that spec into the wire
 * message. This module owns the DB: it reads a loan file into that normalized shape,
 * builds a previewable order, persists it to amc_orders, places it through the
 * transport (src/amc/client.js), and journals every write to amc_write_log.
 *
 * Every function takes the db handle first (a route passes require('../db'); a test
 * passes a stub) so the service is exercisable without a live AMC connection. Placing
 * an order needs the feature switched on (the client/session enforce it); building a
 * draft + preview never touches the network, so the order desk works read-only in an
 * environment that hasn't turned the AMC on.
 *
 * RTL only; off by default. Nothing here runs until a route calls it AND the switches
 * (AMC_ENABLED / AMC_OUTBOUND_ENABLED) are on.
 */
const cfg = require('../config');
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const lookups = require('./lookups');
const formSelect = require('./form-select');
const orderBuild = require('./order-build');
const { loadAppraisalContacts } = require('../lib/appraisal-contacts');
// One definition for both desks — never a pasted copy; see the module header.
const { sendFailMessage, nackMessage, storedFailNote, storedNackNote } = require('../lib/appraisal-messages');


// ---------------------------------------------------------------------------
// Loan-file context loader — one query into the normalized shape order-build
// consumes. Returns null when the file is missing/archived.
// ---------------------------------------------------------------------------

// A property address is stored several ways (a structured object, a bare JSON
// string, a geocoded blob). Pull the parts order-build needs, best-effort.
function addrParts(pa) {
  if (!pa) return {};
  if (typeof pa === 'string') { try { pa = JSON.parse(pa); } catch { return {}; } }
  if (typeof pa !== 'object') return {};
  return {
    addressLine: pa.street || pa.line1 || pa.address || null,
    addressLine2: pa.line2 || pa.unit || null,
    city: pa.city || null,
    state: pa.state || null,
    postalCode: pa.zip || pa.postal || pa.postalCode || pa.postal_code || null,
    county: pa.county || null,
  };
}

// A borrower row → the order-build borrower shape (classification set by index).
function borrowerCtx(row, i) {
  if (!row) return null;
  const res = row.current_address && typeof row.current_address === 'object'
    ? {
      addressLine: row.current_address.line1 || row.current_address.street || null,
      addressLine2: row.current_address.line2 || null,
      city: row.current_address.city || null,
      state: row.current_address.state || null,
      postalCode: row.current_address.zip || row.current_address.postal || null,
    }
    : null;
  return {
    classification: i === 0 ? 'Primary' : 'Secondary',
    firstName: row.first_name || null,
    middleName: row.middle_name || null,
    lastName: row.last_name || null,
    fullName: row.full_name || null,
    email: row.email || null,
    cellPhone: row.cell_phone || null,
    residence: res && (res.addressLine || res.city) ? res : null,
  };
}

async function loadContext(db, appId) {
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.program, a.loan_type, a.property_address,
            a.property_type, a.units, a.occupancy,
            a.purchase_price, a.as_is_value, a.arv, a.rehab_budget, a.rehab_type,
            a.est_closing_date, a.loan_amount, a.lender,
            a.loan_officer_id, a.processor_id, a.borrower_id, a.co_borrower_id, a.llc_id,
            b.first_name, b.middle_name, b.last_name, b.full_name, b.email,
            b.cell_phone, b.current_address,
            cb.first_name AS co_first, cb.middle_name AS co_middle, cb.last_name AS co_last,
            cb.full_name AS co_full, cb.email AS co_email, cb.cell_phone AS co_cell,
            cb.current_address AS co_current_address,
            l.llc_name AS entity_name
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  const pa = addrParts(a.property_address);
  const isPurchase = !/refi|refinance/i.test(String(a.loan_type || ''));
  const borrowers = [
    borrowerCtx({ first_name: a.first_name, middle_name: a.middle_name, last_name: a.last_name,
      full_name: a.full_name, email: a.email, cell_phone: a.cell_phone, current_address: a.current_address }, 0),
    a.co_borrower_id
      ? borrowerCtx({ first_name: a.co_first, middle_name: a.co_middle, last_name: a.co_last,
        full_name: a.co_full, email: a.co_email, cell_phone: a.co_cell, current_address: a.co_current_address }, 1)
      : null,
  ].filter(Boolean);

  return {
    appId: a.id,
    loanNumber: a.ys_loan_number || null,
    clientOrderNumber: a.ys_loan_number || null,
    program: a.program || null,
    loanPurpose: a.loan_type || null,
    loanAmount: a.loan_amount != null ? Number(a.loan_amount) : null,
    estimatedClosingDate: a.est_closing_date ? String(a.est_closing_date).slice(0, 10) : null,
    entityName: a.entity_name || null,
    subdomain: (cfg.amc && cfg.amc.subdomain) || '',
    // The note buyer is STAFF-ONLY and never reaches the AMC message; carried only so
    // a form-selection rule could key on it in the future.
    noteBuyer: a.lender || null,
    property: {
      category: a.property_type || null,
      addressLine: pa.addressLine,
      addressLine2: pa.addressLine2,
      city: pa.city,
      state: pa.state,
      postalCode: pa.postalCode,
      county: pa.county,
      occupancy: a.occupancy || null,
      salesContractAmount: isPurchase && a.purchase_price != null ? Number(a.purchase_price) : null,
    },
    borrowers,
    // The four roles the appraiser may have to call, read by the ONE shared reader
    // both appraisal desks use (src/lib/appraisal-contacts.js). Never re-read a
    // borrower or an officer here — the two desks must name the same people.
    contacts: (await loadAppraisalContacts(db, appId)) || {},
    parties: {},

    // The appraisal-fee card, so the order desk shows whether payment is on file and
    // the same card fills the appraisal_card condition (bidirectional — owner-directed).
    card: await cardStatus(db, appId),
  };
}

// The appraisal payment card + its condition status for the order preview.
async function cardStatus(db, appId) {
  try {
    const c = await db.query(
      `SELECT last4, brand FROM application_payment_cards WHERE application_id = $1`, [appId]);
    const cond = await db.query(
      `SELECT status FROM checklist_items WHERE application_id = $1 AND tool_key = 'appraisal_card' LIMIT 1`, [appId]);
    const row = c.rows[0];
    return {
      onFile: !!row,
      last4: row ? row.last4 : null,
      brand: row ? row.brand : null,
      conditionStatus: cond.rows[0] ? cond.rows[0].status : null,
    };
  } catch (_) { return { onFile: false, last4: null, brand: null, conditionStatus: null }; }
}

// ---------------------------------------------------------------------------
// Form-selection rules (admin-editable amc_form_map rows).
// ---------------------------------------------------------------------------
// SCOPED TO THE ENVIRONMENT THIS SERVICE IS POINTED AT. db/481 gave the table an
// `environment` column precisely because their product ids differ between UAT and
// production, and said "the resolver only ever reads rows matching the environment
// the service is pointed at" — but nothing implemented it, so a UAT rule could pick a
// production form (and, now that a rule also supplies a NAME, could label one). Every
// seeded row is 'production', which is the default, so this changes nothing today.
async function formRules(db) {
  const r = await db.query(
    `SELECT id, program, property_category, loan_purpose, loan_type, property_key,
            product_code, product_name, subproduct_codes,
            amc_identifier, priority, active
       FROM amc_form_map
      WHERE active = true
        AND COALESCE(environment, 'production') = $1
      ORDER BY priority ASC, id ASC`,
    [(cfg.amc && cfg.amc.environment) || 'production']);
  return r.rows;
}

// ---------------------------------------------------------------------------
// The form's NAME — "we need to see the full form name in the order", not #56634
// (owner-directed 2026-08-09).
//
// A bare product code is the appraisal company's internal id and says nothing about
// what was ordered; "1004 - Single Family Residence - Completed Subject to (w/As Is
// Value)" is the thing a human is checking before an order goes out. Both names we
// already hold are used, most authoritative first:
//   1. the FORM CATALOG (`amc_lookup_cache`, GetJobType) — the vendor's own name for
//      that id on THIS tenant, so it stays right when they rename a product;
//   2. the rule's `product_name` (db/481) — what the owner called it when they set
//      the default, which covers an auto-picked form before any live lookup has run.
// Catalog rows are matched inside ONE subdomain only: their ids are per environment
// (db/481's own rule), and a name borrowed from another tenant would confidently
// describe the wrong report.
// Returns null when we genuinely do not know — the screen then says "Form #<code>"
// rather than inventing a name.
// ---------------------------------------------------------------------------
const idOf = (row) => {
  const v = row && (row.id != null ? row.id : (row.Id != null ? row.Id : (row.jobTypeId != null ? row.jobTypeId : row.job_type_id)));
  return v == null ? null : String(v).trim();
};
const nameOf = (row) => {
  const v = row && (row.name || row.Name || row.jobTypeName || row.job_type_name || row.description);
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

function formNameFor(productCode, forms, rules) {
  const code = productCode == null ? null : String(productCode).trim();
  if (!code) return null;
  const hit = (Array.isArray(forms) ? forms : []).find((f) => idOf(f) === code);
  const fromCatalog = hit ? nameOf(hit) : null;
  if (fromCatalog) return fromCatalog;
  const rule = (Array.isArray(rules) ? rules : []).find(
    (r) => r && r.product_code != null && String(r.product_code).trim() === code && r.product_name);
  return rule ? String(rule.product_name).trim() || null : null;
}

/**
 * The form catalog for a tenant, best-effort — an unreachable cache must never stop
 * an order being built. Always an array.
 *
 * WITH NO SUBDOMAIN CONFIGURED IT USES THE ONE CACHED TENANT, and that is the whole
 * point rather than a convenience. `AMC_SUBDOMAIN` is not set today — the commit that
 * added the form NAME says so itself — while db/481 seeded the live NAN catalog under
 * `subdomain='nan'`. Reading the catalog under the configured (blank) key found
 * nothing, so the desk could only name the nine forms db/481 ALSO wrote onto a rule,
 * and every other form — a staff override, a 1004D update, a field review, ground-up
 * — still printed a bare number, which is the complaint this was meant to answer. The
 * override dropdown was empty for the same reason.
 *
 * The fallback is deliberately narrow: it applies ONLY when nothing is configured, so
 * there is no second tenant it could be confused with, and only when exactly ONE
 * subdomain is cached. A CONFIGURED subdomain whose catalog is empty falls back to
 * nothing at all — borrowing another tenant's names there is exactly the "confidently
 * describes the wrong report" failure the per-subdomain rule exists to prevent.
 */
async function formCatalog(db, subdomain) {
  try {
    const rows = await lookups.forms(db, subdomain);
    if (rows.length || subdomain) return rows;
    const only = await db.query(
      `SELECT DISTINCT subdomain FROM amc_lookup_cache
        WHERE lookup_type IN ('Get_JobTypes_By_LoanType','GetJobType')
          AND COALESCE(subdomain,'') <> ''`);
    if (only.rows.length !== 1) return rows;
    return await lookups.forms(db, only.rows[0].subdomain);
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// Preview — auto-fill the order without sending anything.
// ---------------------------------------------------------------------------
async function buildPreview(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;
  const rules = await formRules(db);
  const deal = orderBuild.dealShapeFor(ctx);
  // Staff can override the auto-picked form; opts.productCode wins in buildOrderSpec.
  const chosen = formSelect.chooseForm(deal, rules);
  const spec = orderBuild.buildOrderSpec(ctx, chosen, opts.overrides || {});
  const missing = orderBuild.missingRequired(spec);
  const forms = await formCatalog(db, ctx.subdomain);
  // The name of the form that would ACTUALLY be ordered — spec.productCode, so a
  // staff override is named too, not just the auto-picked default.
  const formName = formNameFor(spec.productCode, forms, rules);
  return {
    context: ctx,
    deal,
    // `chosenForm` is the AUTO-PICKED form, so it is named from ITS OWN code — never
    // from `spec.productCode`, which a staff override replaces. Naming it from the
    // spec labelled the auto-picked code with the overridden form's name, which is the
    // "confidently describes the wrong report" failure this feature exists to avoid,
    // arriving through a staff override instead of through a wrong tenant.
    chosenForm: chosen ? { ...chosen, formName: formNameFor(chosen.productCode, forms, rules) } : null,
    // Named at the top level too: with no rule matched there is no chosenForm at all,
    // and a staff-picked form still has a name worth showing.
    productCode: spec.productCode || null,
    formName,
    spec,
    missing,
    contactNotes: orderBuild.contactNotes(spec),
    canPlace: missing.length === 0,
    forms,        // the cached form catalog, for a staff override dropdown
    card: ctx.card,
    config: client.configured(),
  };
}

// ---------------------------------------------------------------------------
// Persist + place.
// ---------------------------------------------------------------------------

// Insert the amc_orders draft row and return it. The stored request_payload is the
// MASKED message (never persist the api key).
async function insertOrder(db, appId, spec, maskedMessage, staffId, extra = {}) {
  const r = await db.query(
    `INSERT INTO amc_orders
       (application_id, checklist_item_id, client_order_number, client_reference_number,
        request_action, parent_order_id, product_code, subproduct_codes, amc_identifier,
        form_description,
        status, rush, need_by_date, job_fee, management_fee,
        request_payload, dryrun, ordered_by, sp_subdomain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [appId, extra.checklistItemId || null, spec.clientOrderNumber || null, spec.clientReferenceNumber || null,
     spec.requestAction || 'CreateAppraisal', extra.parentOrderId || null,
     spec.productCode || null, (spec.subproductCodes && spec.subproductCodes.length) ? spec.subproductCodes : null,
     spec.amcIdentifier || null,
     // The form's NAME is recorded ON THE ORDER at the moment it is placed, so the
     // orders list reads "1004 - Single Family Residence …" from the first second
     // rather than "Form 56634" until the AMC's own ACK happens to carry a
     // description. applyAck's COALESCE keeps the vendor's wording when it arrives.
     extra.formName || null,
     'draft', !!spec.rush, spec.needByDate || null,
     spec.jobFee != null ? spec.jobFee : null, spec.managementFee != null ? spec.managementFee : null,
     maskedMessage ? JSON.stringify(maskedMessage) : null, false, staffId || null,
     (cfg.amc && cfg.amc.subdomain) || null]);
  return r.rows[0];
}

// The write journal (mirrors sitewire_write_log / clickup_write_log).
async function journal(db, { orderId, appId, action, request, response, ok, error, staffId }) {
  try {
    await db.query(
      `INSERT INTO amc_write_log
         (order_id, application_id, action, request_summary, response_summary, ok, error, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orderId || null, appId || null, action || null,
       request ? JSON.stringify(cdg.maskRequest(request)) : null,
       response ? JSON.stringify(response) : null,
       ok === true, error || null, staffId || null]);
  } catch (_) { /* journaling must never break the order */ }
}

// Apply a parsed CreateAppraisal/AddForm ACK onto the order row.
async function applyAck(db, orderId, ack, resp) {
  const status = cdg.mapStatusToLifecycle(ack.statusCode, ack.statusName) || 'ordered';
  const r = await db.query(
    `UPDATE amc_orders SET
        cdg_order_number = COALESCE($2, cdg_order_number),
        sp_order_number = COALESCE($3, sp_order_number),
        appraisal_file_number = COALESCE($4, appraisal_file_number),
        form_description = COALESCE($5, form_description),
        status = $6, status_code = $7, status_name = $8, status_description = $9,
        ack_response = $10, ordered_at = COALESCE(ordered_at, now()), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [orderId, ack.cdgOrderNumber || null, ack.spOrderNumber || null, ack.appraisalFileNumber || null,
     ack.productDescription || null, status,
     ack.statusCode != null ? String(ack.statusCode) : null, ack.statusName || null,
     ack.statusDescription || null, JSON.stringify(resp)]);
  return r.rows[0];
}

/**
 * Create — and optionally PLACE — an appraisal order for a file.
 *
 * opts: { staffId, overrides, place, checklistItemId, parentOrderId }
 *  - place=false (default): persist a draft only; never touches the network.
 *  - place=true: build the wire message, send CreateAppraisal, apply the ACK.
 *
 * Returns { ok, order, missing?, error?, dryrun? }. Never throws for an expected
 * refusal (missing required fields, a vendor NACK, outbound-off); a genuine bug
 * still throws so the route's catch reports it.
 */
async function createOrder(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return { ok: false, error: 'file_not_found', message: 'That loan file could not be found.' };
  const rules = await formRules(db);
  const deal = orderBuild.dealShapeFor(ctx);
  const chosen = formSelect.chooseForm(deal, rules);
  const spec = orderBuild.buildOrderSpec(ctx, chosen, opts.overrides || {});
  const missing = orderBuild.missingRequired(spec);

  // The panel lists `missing` field by field, so the sentence only has to say why
  // nothing was sent — but it must exist, or the desk shows the word 'incomplete'.
  if (opts.place && missing.length) {
    return { ok: false, missing, error: 'incomplete',
      message: 'The order is not complete yet, so nothing was sent. What is still needed is listed below.' };
  }

  const formName = formNameFor(spec.productCode, await formCatalog(db, ctx.subdomain), rules);

  // The identifiers the envelope needs when there is no live session — a draft, and
  // TEST MODE, both build the exact message without one.
  const a = cfg.amc || {};
  const offlineCtx = { apiKey: null, subdomain: a.subdomain, lenderIdentifier: a.lenderIdentifier, sourceClientId: a.sourceClientId };

  // TEST MODE MUST NOT LOG IN. The whole point of the dry run is to build the request
  // and send NOTHING, but this used to call DoLogin first — so on a tenant whose
  // AppraisalScope login is not set up yet (which is the state today) pressing "Place
  // order" in test mode threw, the route had nothing to catch it, and the desk showed
  // the server's generic "Something went wrong on our end". A test run now needs no
  // credentials at all, and a REAL send that cannot log in is answered in plain words
  // instead of a 500.
  const dryrun = !!client.configured().dryrun;
  let built = cdg.buildCreateAppraisal(spec, offlineCtx);

  // The draft row is written BEFORE anything can fail, so a refusal below leaves the
  // work saved rather than thrown away — and the message we then show can honestly
  // say so.
  const order = await insertOrder(db, appId, spec, cdg.maskRequest(built.message ? built : { message: built }),
    opts.staffId, { checklistItemId: opts.checklistItemId, parentOrderId: opts.parentOrderId, formName });

  if (!opts.place) return { ok: true, order, missing, draft: true };

  if (!dryrun) {
    let authCtx = null;
    try {
      authCtx = await session.authContext();   // DoLogin (needs AMC_ENABLED); throws if off
    } catch (e) {
      const why = session.signInMessage(e, { savedDraft: true });
      // THE ROW GETS THE STORED FORM, THE PERSON GETS `why`. They are different jobs:
      // `why` is written for whoever just pressed the button (it says their draft was
      // saved), while the column is read later by somebody who was not there — and every
      // stored sentence has to carry the shared opening a panel recognises, or a screen
      // rendering this column would discard it as a legacy raw exception.
      await db.query(`UPDATE amc_orders SET last_error = $2, updated_at = now() WHERE id = $1`,
        [order.id, storedFailNote(e)]);
      await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, ok: false, error: why, staffId: opts.staffId });
      return { ok: false, error: 'not_connected', message: why, order: await getOrder(db, order.id) };
    }
    built = cdg.buildCreateAppraisal(spec, authCtx);
  }

  // Place it. An AddForm rides the parent's CDG order number as ?orderId=.
  let orderIdParam = null;
  if (spec.requestAction === 'AddForm' && opts.parentOrderId) {
    const p = await db.query('SELECT cdg_order_number FROM amc_orders WHERE id = $1', [opts.parentOrderId]);
    orderIdParam = p.rows[0] && p.rows[0].cdg_order_number;
  }

  await db.query(`UPDATE amc_orders SET status = 'placing', updated_at = now() WHERE id = $1`, [order.id]);

  let resp;
  try {
    // `dryrun` is passed, not re-read. It decided above whether to sign in, so if the
    // transport asked the switch again and got a different answer it would post the
    // message we built WITHOUT an api key — a real order, with real borrower details,
    // unauthenticated. The transport still re-checks the switch on its own; this only
    // ever forces the dry run on.
    resp = await client.write(built, { orderId: orderIdParam || undefined, label: spec.requestAction, dryrun });
  } catch (e) {
    // The ROW keeps a sentence, never the exception's own text — see
    // lib/appraisal-messages.storedFailNote. The raw text goes to the journal below,
    // which is where we read it.
    await db.query(`UPDATE amc_orders SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`,
      [order.id, storedFailNote(e)]);
    await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, ok: false, error: String(e.message || e), staffId: opts.staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: sendFailMessage(e, 'The order') };
  }

  // Dry-run: the transport short-circuited without sending. Record the attempt.
  if (resp && resp.__dryrun) {
    await db.query(`UPDATE amc_orders SET status = 'draft', dryrun = true, updated_at = now() WHERE id = $1`, [order.id]);
    await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: { dryrun: true }, ok: true, staffId: opts.staffId });
    const back = await getOrder(db, order.id);
    return { ok: true, order: back, dryrun: true };
  }

  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await db.query(`UPDATE amc_orders SET status = 'error', last_error = $2, last_status_response = $3, updated_at = now() WHERE id = $1`,
      [order.id, storedNackNote(err, 'the order'), JSON.stringify(resp)]);
    await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: resp, ok: false, error: err.description || err.code, staffId: opts.staffId });
    return { ok: false, error: 'amc_nack', message: nackMessage(err, 'the order') };
  }

  const ack = cdg.parseAck(resp);
  const updated = await applyAck(db, order.id, ack, resp);
  await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: resp, ok: true, staffId: opts.staffId });
  return { ok: true, order: updated };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
/**
 * NAME THE FORM ON EVERY ORDER, INCLUDING THE ONES ALREADY ON DISK.
 *
 * `form_description` is written when an order is CREATED (or when the vendor's answer
 * carries a name). The owner's report — "it says only the form number, we need to see
 * the full form name" — is about orders that were placed BEFORE the name was stored, so
 * on those the column is NULL and the screen falls back to "Form 56634" exactly as it
 * did the day it was reported. A backfill cannot fix it either: the names live in the
 * vendor's per-tenant catalog, so the answer is only knowable at read time.
 *
 * So it is resolved on READ, through the SAME `formNameFor` the preview and the order
 * builder use — one definition, so the list, the detail and the order we would place
 * can never name the same form differently. FILL-ONLY: a stored description (the
 * vendor's own wording, or what we recorded when it was placed) always wins. Never
 * throws — an unreachable catalog just leaves the number showing, as before.
 */
async function nameOrders(db, rows) {
  const filled = (v) => !!(v == null ? '' : String(v).trim());
  const need = rows.filter((o) => o && !filled(o.form_description) && filled(o.product_code));
  if (!need.length) return rows;
  try {
    const [forms, rules] = await Promise.all([
      formCatalog(db, (cfg.amc && cfg.amc.subdomain) || ''),
      formRules(db),
    ]);
    for (const o of need) {
      const name = formNameFor(o.product_code, forms, rules);
      if (name) o.form_description = name;
    }
  } catch (_) { /* the number still shows; naming is a nicety, never a failure */ }
  return rows;
}

async function listOrders(db, appId) {
  const r = await db.query(
    `SELECT id, request_action, parent_order_id, client_order_number, cdg_order_number,
            sp_order_number, appraisal_file_number, product_code, form_description,
            status, status_code, status_name, status_description, rush, need_by_date,
            dryrun, last_error, created_at, ordered_at, completed_at, last_polled_at, updated_at
       FROM amc_orders WHERE application_id = $1 ORDER BY created_at DESC`, [appId]);
  return nameOrders(db, r.rows);
}

async function getOrder(db, orderId) {
  const r = await db.query(`SELECT * FROM amc_orders WHERE id = $1`, [orderId]);
  if (!r.rows[0]) return null;
  return (await nameOrders(db, [r.rows[0]]))[0];
}

module.exports = {
  loadContext, cardStatus, formRules, buildPreview,
  createOrder, listOrders, getOrder, journal,
  // exported for tests
  addrParts, borrowerCtx, formNameFor,
};
