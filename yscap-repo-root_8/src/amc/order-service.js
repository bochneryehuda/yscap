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
    parties: { bestContact: 'Borrower' },
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
async function formRules(db) {
  const r = await db.query(
    `SELECT id, program, property_category, loan_purpose, product_code, subproduct_codes,
            amc_identifier, priority, active
       FROM amc_form_map
      WHERE active = true
      ORDER BY priority ASC, id ASC`);
  return r.rows;
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
  let forms = [];
  try { forms = await lookups.forms(db, ctx.subdomain); } catch (_) { forms = []; }
  return {
    context: ctx,
    deal,
    chosenForm: chosen,
    spec,
    missing,
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
        status, rush, need_by_date, job_fee, management_fee,
        request_payload, dryrun, ordered_by, sp_subdomain)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [appId, extra.checklistItemId || null, spec.clientOrderNumber || null, spec.clientReferenceNumber || null,
     spec.requestAction || 'CreateAppraisal', extra.parentOrderId || null,
     spec.productCode || null, (spec.subproductCodes && spec.subproductCodes.length) ? spec.subproductCodes : null,
     spec.amcIdentifier || null, 'draft', !!spec.rush, spec.needByDate || null,
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

// ---------------------------------------------------------------------------
// Turn a thrown transport error into a legible, persistable failure. The
// CDG/AppraisalScope gateway sends its real reason in the HTTP body, which
// client.js attaches to err.body (a parsed object, {raw:text} for a non-JSON
// intermediary reply, or a CDG NACK-shaped envelope). The catch used to keep
// only e.message ("AMC CreateAppraisal -> 500"), so nobody could see WHY —
// this makes the vendor's own words reach last_error / last_status_response /
// the write journal and the route response, so a live "Test now" is diagnosable.
// ---------------------------------------------------------------------------
function readGatewayBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') return body.slice(0, 400);
  try {
    // A NACK-shaped envelope returned with a non-2xx status: reuse the CDG parser.
    const nack = cdg.parseError(body);
    if (nack) return nack.description || (nack.code != null ? `status ${nack.code}` : null);
  } catch (_) { /* not NACK-shaped — fall through */ }
  const s = body.raw || body.message || body.error_description || body.error || body.title || body.detail;
  if (typeof s === 'string' && s.trim()) return s.slice(0, 400);
  try { return JSON.stringify(body).slice(0, 400); } catch (_) { return null; }
}

function describeSendFailure(e) {
  // A deliberate switch (outbound off / master off) is NOT a connection problem —
  // say so plainly rather than sending someone to chase a firewall ghost.
  const code = e && e.code;
  if (code === 'AMC_OUTBOUND_DISABLED') {
    const text = 'Sending orders to the appraisal gateway is turned off (the outbound switch is off), so the order was not sent.';
    return { text, detail: { kind: 'gated', httpStatus: null, code, message: String((e && e.message) || e), gateway: null, cause: null } };
  }
  if (code === 'AMC_DISABLED') {
    const text = 'The appraisal integration is turned off, so the order was not sent.';
    return { text, detail: { kind: 'gated', httpStatus: null, code, message: String((e && e.message) || e), gateway: null, cause: null } };
  }
  const status = Number.isInteger(e && e.status) ? e.status : null;
  const gatewayMsg = readGatewayBody(e && e.body);
  const timedOut = e && (e.name === 'AbortError' || /aborted|timeout/i.test(String(e.message || '')));
  const causeStr = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : null;
  let text;
  if (status) {
    const hint = status === 403 ? ' — the account may not be entitled to place orders at this endpoint, or our address is not on the vendor’s allow-list'
      : status === 404 ? ' — the order endpoint URL looks wrong'
      : status === 401 ? ' — the login token was not accepted for placing an order'
      : status >= 500 ? ' — the gateway hit a server error on the order' : '';
    text = `The appraisal gateway rejected the order (HTTP ${status})${gatewayMsg ? ': ' + gatewayMsg : ''}${hint}.`;
  } else if (timedOut) {
    text = 'The order timed out reaching the appraisal gateway (no reply). This looks like a connection problem, not a rejection of the order.';
  } else {
    text = `Could not reach the appraisal gateway${causeStr ? ' (' + causeStr + ')' : (e && e.message ? ' (' + e.message + ')' : '')}. This looks like a connection problem, not a rejection of the order.`;
  }
  const detail = {
    kind: status ? 'http_error' : (timedOut ? 'timeout' : 'network_error'),
    httpStatus: status,
    code: (e && e.code) || null,
    message: String((e && e.message) || e),
    gateway: (e && e.body != null) ? e.body : null,
    cause: causeStr,
  };
  return { text, detail };
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
  if (!ctx) return { ok: false, error: 'file_not_found' };
  const rules = await formRules(db);
  const deal = orderBuild.dealShapeFor(ctx);
  const chosen = formSelect.chooseForm(deal, rules);
  const spec = orderBuild.buildOrderSpec(ctx, chosen, opts.overrides || {});
  const missing = orderBuild.missingRequired(spec);

  if (opts.place && missing.length) return { ok: false, missing, error: 'incomplete' };

  // Build the message up front so the DRAFT stores the masked payload either way.
  let built = null;
  let authCtx = null;
  if (opts.place) {
    authCtx = await session.authContext();   // DoLogin (needs AMC_ENABLED); throws if off
    built = cdg.buildCreateAppraisal(spec, authCtx);
  } else {
    // A draft still records what WOULD be sent (masked), using the config identifiers
    // without a live api key — buildCreateAppraisal only needs them for the envelope.
    const a = cfg.amc || {};
    built = cdg.buildCreateAppraisal(spec, {
      apiKey: null, subdomain: a.subdomain, lenderIdentifier: a.lenderIdentifier, sourceClientId: a.sourceClientId,
    });
  }

  const order = await insertOrder(db, appId, spec, cdg.maskRequest(built.message ? built : { message: built }),
    opts.staffId, { checklistItemId: opts.checklistItemId, parentOrderId: opts.parentOrderId });

  if (!opts.place) return { ok: true, order, missing, draft: true };

  // Place it. An AddForm rides the parent's CDG order number as ?orderId=.
  let orderIdParam = null;
  if (spec.requestAction === 'AddForm' && opts.parentOrderId) {
    const p = await db.query('SELECT cdg_order_number FROM amc_orders WHERE id = $1', [opts.parentOrderId]);
    orderIdParam = p.rows[0] && p.rows[0].cdg_order_number;
  }

  await db.query(`UPDATE amc_orders SET status = 'placing', updated_at = now() WHERE id = $1`, [order.id]);

  let resp;
  try {
    resp = await client.write(built, { orderId: orderIdParam || undefined, label: spec.requestAction });
  } catch (e) {
    // Capture the gateway's REAL reason (status + body), not just e.message, so a
    // live failure is diagnosable from the file and the logs.
    const failure = describeSendFailure(e);
    // A transport 401 on the order endpoint — drop the cached DoLogin session so the
    // next attempt re-authenticates cleanly (the OAuth Bearer is already refreshed
    // once inside the transport before this surfaces).
    if (e && e.status === 401) session.invalidate();
    await db.query(`UPDATE amc_orders SET status = 'error', last_error = $2, last_status_response = $3, updated_at = now() WHERE id = $1`,
      [order.id, failure.text.slice(0, 2000), JSON.stringify(failure.detail)]);
    await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: failure.detail, ok: false, error: failure.text, staffId: opts.staffId });
    console.error(`[amc] CreateAppraisal send failed for order ${order.id}: ${failure.text}`, failure.detail.gateway || '');
    return { ok: false, error: e && e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: failure.text, httpStatus: failure.detail.httpStatus, detail: failure.detail };
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
      [order.id, err.description || err.code || 'AMC error', JSON.stringify(resp)]);
    await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: resp, ok: false, error: err.description || err.code, staffId: opts.staffId });
    return { ok: false, error: 'amc_nack', message: err.description || err.code };
  }

  const ack = cdg.parseAck(resp);
  const updated = await applyAck(db, order.id, ack, resp);
  await journal(db, { orderId: order.id, appId, action: spec.requestAction, request: built, response: resp, ok: true, staffId: opts.staffId });
  return { ok: true, order: updated };
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
async function listOrders(db, appId) {
  const r = await db.query(
    `SELECT id, request_action, parent_order_id, client_order_number, cdg_order_number,
            sp_order_number, appraisal_file_number, product_code, form_description,
            status, status_code, status_name, status_description, rush, need_by_date,
            dryrun, last_error, last_status_response, created_at, ordered_at, completed_at, last_polled_at, updated_at
       FROM amc_orders WHERE application_id = $1 ORDER BY created_at DESC`, [appId]);
  return r.rows;
}

async function getOrder(db, orderId) {
  const r = await db.query(`SELECT * FROM amc_orders WHERE id = $1`, [orderId]);
  return r.rows[0] || null;
}

module.exports = {
  loadContext, cardStatus, formRules, buildPreview,
  createOrder, listOrders, getOrder, journal,
  // exported for tests
  addrParts, borrowerCtx, describeSendFailure, readGatewayBody,
};
