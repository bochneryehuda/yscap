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

// Normalize a client-on-report name for matching (case/spacing/punctuation-insensitive),
// e.g. "YS Capital Group" / "ys capital group, llc" → "yscapitalgroup(llc)".
function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
// Does a catalog entry's name mean the configured client-on-report name? Exact-normalized,
// else one contains the other — but ONLY when the shorter string is substantial (>= 5 chars)
// so a stray short token ("A", "LLC") can't spuriously match a long company name. So
// "YS Capital Group" matches "YS Capital Group, LLC" and "YS Capital", but never "A".
function nameMeans(entryName, wantName) {
  const a = normName(entryName), b = normName(wantName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5) return false;
  return a.includes(b) || b.includes(a);
}

// The freshest cached GetClientDisplayOnReport rows for a subdomain, then (if empty) under
// ANY subdomain (the seed/cache may live under a different one than the live tenant, exactly
// like formsCatalog). Never throws.
async function cachedClientDisplayed(db, subdomain) {
  let rows = [];
  try { rows = await lookups.list(db, 'GetClientDisplayOnReport', subdomain || ''); } catch (_) { rows = []; }
  if (!rows.length) {
    try {
      const r = await db.query(
        `SELECT payload FROM amc_lookup_cache WHERE lookup_type = 'GetClientDisplayOnReport'
          ORDER BY fetched_at DESC LIMIT 1`);
      if (r.rows[0] && Array.isArray(r.rows[0].payload)) rows = r.rows[0].payload;
    } catch (_) { /* none cached yet */ }
  }
  return (Array.isArray(rows) ? rows : [])
    .map((x) => ({ id: x && x.id != null ? String(x.id) : null, name: (x && x.name) || null }))
    .filter((x) => x.id);
}

// Self-heal an EMPTY client-on-report cache: refresh the GetClientDisplayOnReport lookup ONCE
// live so the account's profiles (incl. "YS Capital Group" + its id) become available. Only
// when the AMC is actually configured to authenticate; single-flight + throttled so an empty
// cache can't hammer the vendor on every preview; best-effort — a failure leaves the cache
// empty and resolution falls back to the configured name.
//
// The wait is BOUNDED (CDOR_REFRESH_WAIT_MS): a preview is a GET, and the live refresh is a
// login+lookup that normally answers sub-second — but a hung AMC endpoint has a long transport
// budget (90s × retries), so we wait only a few seconds for the id and otherwise return,
// letting the refresh finish in the BACKGROUND (this preview uses the name default; the next
// one picks up the populated id). So a preview never blocks for minutes on a hung vendor.
const CDOR_REFRESH_WAIT_MS = 8000;
let _cdorRefreshAt = 0;
let _cdorRefreshInflight = null;
async function ensureClientDisplayedCache(db) {
  let cfgd;
  try { cfgd = client.configured(); } catch (_) { cfgd = null; }
  if (!cfgd || !cfgd.enabled || !cfgd.ready) return;   // never trigger a DoLogin off a draft/no-AMC env
  if (!_cdorRefreshInflight) {
    if (Date.now() - _cdorRefreshAt < 5 * 60 * 1000) return;   // at most once / 5 min per instance
    _cdorRefreshAt = Date.now();
    _cdorRefreshInflight = (async () => {
      try { await lookups.refreshOne(db, 'GetClientDisplayOnReport'); }
      catch (_) { /* best-effort — leave the cache empty, fall back to the name default */ }
    })().finally(() => { _cdorRefreshInflight = null; });
  }
  // Bounded wait — never block a preview for minutes on a hung AMC (both the initiator and a
  // concurrent caller wait at most CDOR_REFRESH_WAIT_MS; the refresh keeps running after).
  const inflight = _cdorRefreshInflight;
  let to = null;
  try {
    await Promise.race([
      inflight ? inflight.catch(() => {}) : Promise.resolve(),
      new Promise((resolve) => { to = setTimeout(resolve, CDOR_REFRESH_WAIT_MS); }),
    ]);
  } catch (_) { /* ignore */ }
  finally { if (to) clearTimeout(to); }
}

// The "Client Displayed on Report" (CDOR) — AppraisalScope's REQUIRED client_displayed_id.
// It is the client/lender alias AppraisalScope prints ON the appraisal report, chosen from
// the tenant's own GetClientDisplayOnReport list. The gateway maps its snake_case
// client_displayed_id from the numeric id in that list; cdg.js sends the resolved id TWO
// ways (clientSystem.sourceInformation.sourceClientIdentifier AND a Lender party's
// partyRoleIdentifier) so the gateway is satisfied whichever it reads. Here we resolve
// WHICH id (or name) to send:
//   1. AMC_CLIENT_DISPLAYED_ID (config) — an explicit id always wins; the LEGACY
//      AMC_SOURCE_CLIENT_ID pins the SAME id when AMC_CLIENT_DISPLAYED_ID is unset
//      (back-compat, so an older deploy that set only the legacy var still resolves an id
//      rather than silently blocking). Both surface as source 'config'.
//   2. else the cached GetClientDisplayOnReport list (refreshed live once if empty):
//      a. an entry whose name means the configured default ("YS Capital Group") → its id.
//      b. exactly ONE entry → auto-use it.
//      c. several entries, none matching the default → don't guess; a picker chooses. It's
//         'multiple' → missingRequired blocks (with the picker) rather than print the wrong
//         company on the report.
//   3. the list can't be read at all → fall back to the configured NAME (source 'name_default').
//      A numeric id is REQUIRED (cdg.js sends the id, not a name), so a name-only result carries
//      id=null and missingRequired blocks the order up-front (belt-and-suspenders) rather than
//      sending a name the gateway rejects. The name still rides along as the default label
//      ("YS Capital Group", owner-directed) for the missingRequired message / picker.
// Best-effort + never throws.
async function resolveClientDisplayed(db, subdomain) {
  const wantName = (cfg.amc && cfg.amc.clientDisplayedName) || null;
  // AMC_CLIENT_DISPLAYED_ID wins; AMC_SOURCE_CLIENT_ID is the legacy fallback for the SAME id.
  const configured = (cfg.amc && cfg.amc.clientDisplayedId)
    || (cfg.amc && cfg.amc.sourceClientId) || null;
  if (configured) return { id: String(configured), name: wantName, source: 'config', options: [] };

  let opts = await cachedClientDisplayed(db, subdomain);
  if (!opts.length) {                       // empty cache → try to populate it live, once
    try { await ensureClientDisplayedCache(db); } catch (_) { /* best-effort */ }
    opts = await cachedClientDisplayed(db, subdomain);
  }

  if (wantName) {
    const matches = opts.filter((o) => nameMeans(o.name, wantName));
    if (matches.length === 1) return { id: matches[0].id, name: matches[0].name, source: 'catalog', options: opts };
    // Several profiles match the default name (e.g. "YS Capital Group" + "YS Capital Group LLC")
    // → genuinely ambiguous; name left null so missingRequired blocks and the picker chooses.
    if (matches.length > 1) return { id: null, name: null, source: 'multiple', options: matches };
  }
  if (opts.length === 1) return { id: opts[0].id, name: opts[0].name, source: 'catalog', options: opts };
  // Several distinct profiles and none matches the default name → can't default; the picker
  // chooses (name null so the order blocks until one is picked rather than sending a guess).
  if (opts.length > 1) return { id: null, name: null, source: 'multiple', options: opts };
  // Nothing in the catalog at all — fall back to the configured NAME as the default label
  // (owner-directed: default to "YS Capital Group"). A numeric id is REQUIRED, so id stays null
  // and missingRequired blocks the order up-front rather than sending a name the gateway rejects.
  return { id: null, name: wantName || null, source: wantName ? 'name_default' : 'none', options: [] };
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
            l.llc_name AS entity_name,
            lo.email AS lo_email, pr.email AS pr_email
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
       LEFT JOIN staff_users pr ON pr.id = a.processor_id AND pr.is_active = true
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

  // Everyone who should receive the AMC's order-update emails: the loan officer, the
  // processor, and the borrower(s). The vendor carries these as products[].notifications
  // (see cdg.js) so NAN emails all of them when the appraisal comes back — owner-directed.
  const notifyEmails = [];
  const addEmail = (e) => {
    const v = String(e == null ? '' : e).trim().toLowerCase();
    if (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !notifyEmails.includes(v)) notifyEmails.push(v);
  };
  addEmail(a.lo_email);
  addEmail(a.pr_email);
  for (const b of borrowers) addEmail(b.email);

  // The client shown on the appraisal report (AppraisalScope's REQUIRED client_displayed_id).
  const cdor = await resolveClientDisplayed(db, cfg.amc && cfg.amc.subdomain);

  return {
    appId: a.id,
    loanNumber: a.ys_loan_number || null,
    clientOrderNumber: a.ys_loan_number || null,
    notifyEmails,
    program: a.program || null,
    loanPurpose: a.loan_type || null,
    // The rehab tier — a signal for the RTL strategy (a renovation → the fix & flip
    // "Completed Subject to (w/As Is Value)" form). See order-build.dealStrategyKey.
    rehabType: a.rehab_type || null,
    loanAmount: a.loan_amount != null ? Number(a.loan_amount) : null,
    estimatedClosingDate: a.est_closing_date ? String(a.est_closing_date).slice(0, 10) : null,
    entityName: a.entity_name || null,
    subdomain: (cfg.amc && cfg.amc.subdomain) || '',
    // The note buyer is STAFF-ONLY and never reaches the AMC message; carried only so
    // a form-selection rule could key on it in the future.
    noteBuyer: a.lender || null,
    // AppraisalScope's REQUIRED client_displayed_id — the client-on-report profile. See
    // resolveClientDisplayed: config override, else the account's single profile, else null
    // (blocked). buildOrderSpec reads clientDisplayedId; orderAssumptions shows the name.
    clientDisplayedId: cdor.id,
    clientDisplayedName: cdor.name,
    clientDisplayedSource: cdor.source,
    clientDisplayedOptions: cdor.options,
    property: {
      category: a.property_type || null,
      addressLine: pa.addressLine,
      addressLine2: pa.addressLine2,
      city: pa.city,
      state: pa.state,
      postalCode: pa.postalCode,
      county: pa.county,
      occupancy: a.occupancy || null,
      // AppraisalScope REQUIRES a property amount (its `purchase_amount`). On a PURCHASE
      // it is the contract price; on a REFINANCE there is no purchase, so send the value
      // the loan is sized on (as-is value → ARV → loan amount) so the appraiser still has
      // a figure and the order is not rejected for a blank one. missingRequired refuses a
      // blank on both, so a file with no value at all is caught on the preview, not by NAN.
      salesContractAmount: isPurchase
        ? (a.purchase_price != null ? Number(a.purchase_price) : null)
        : (a.as_is_value != null ? Number(a.as_is_value)
          : a.arv != null ? Number(a.arv)
          : a.loan_amount != null ? Number(a.loan_amount) : null),
      // AppraisalScope's REQUIRED `purchase_amount` maps SPECIFICALLY from the CDG
      // `purchasePriceAmount` (mapping row 39: "Required when Intended Use is Purchase"),
      // NOT from salesContractAmount — sending only salesContractAmount is exactly why
      // the gateway kept rejecting the order for a missing purchase_amount. So carry the
      // real purchase price here (purchase deals only; a refinance has no purchase, and
      // Intended Use=Refinance makes purchase_amount not required).
      purchasePriceAmount: isPurchase && a.purchase_price != null ? Number(a.purchase_price) : null,
    },
    borrowers,
    // Leave bestContact UNSET here: buildOrderSpec defaults it to 'Borrower' (so the sent
    // order is unchanged), and leaving it off the context lets orderAssumptions surface it
    // as an auto-filled default the desk should eyeball — pre-filling it here would hide
    // that auto-fill from the "What PILOT filled in for you" list on every real preview.
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
const FORM_RULE_COLS =
  `id, program, property_category, loan_purpose, loan_type, property_key, product_code,
   product_name, subproduct_codes, amc_identifier, priority, active`;

async function formRules(db) {
  // Read the columns chooseForm actually matches on. loan_type / property_key /
  // product_name were added by db/481 but never selected here, so every rule's
  // loan_type/property_key came back undefined (a wildcard) and every deal collapsed
  // to the lowest-id rule (always "Form 56634"), with no name to show.
  //
  // Scope to the tenant environment — the seeded ids are environment-specific, so a
  // UAT service should prefer its OWN rules and never pick a PRODUCTION id when a UAT
  // rule exists. BUT the only seed we can ship is the production tenant's (a UAT
  // tenant's ids can't be reached from here), so a service pointed anywhere the current
  // environment has no rules would otherwise return nothing and auto-pick nothing —
  // exactly the "always Form 56634" complaint in reverse (now: no default at all).
  // So: use this environment's rules when it HAS any (the design intent, and the case
  // the moment UAT ids get seeded); else fall back to whatever active rules DO exist so
  // the deal still gets a sensible default. Staff can change the form on the preview,
  // and an id that is wrong for the tenant surfaces as a VISIBLE send error (#1128) —
  // never a silent bad order.
  const env = (cfg.amc && cfg.amc.environment) || 'production';
  const forEnv = await db.query(
    `SELECT ${FORM_RULE_COLS} FROM amc_form_map
      WHERE active = true AND (environment = $1 OR environment IS NULL)
      ORDER BY priority ASC, id ASC`, [env]);
  if (forEnv.rows.length) return forEnv.rows;

  const anyEnv = await db.query(
    `SELECT ${FORM_RULE_COLS} FROM amc_form_map
      WHERE active = true
      ORDER BY priority ASC, id ASC`);
  if (anyEnv.rows.length) {
    console.warn(`[amc] no form-map rules for environment='${env}'; falling back to ` +
      `${anyEnv.rows.length} rule(s) from another environment so a form still auto-picks — ` +
      `set AMC_ENVIRONMENT correctly or seed '${env}' rules to silence this`);
  }
  return anyEnv.rows;
}

// The full list of forms staff can pick from, as [{id, name}]. Robust to the cache
// being keyed under a different subdomain than the live tenant (the seed lives under
// 'nan' while cfg.amc.subdomain may be something else): try the live subdomain, fall
// back to the freshest cached catalog under ANY subdomain, and always union in the
// mapped forms (amc_form_map) so a mapped form is never left without a name.
async function formsCatalog(db, ctx, rules) {
  const byId = new Map();   // id -> name, first non-blank name wins
  const add = (id, name) => {
    const k = String(id == null ? '' : id).trim();
    if (!k) return;
    const nm = String(name == null ? '' : name).trim();
    if (!byId.has(k)) byId.set(k, nm);
    else if (!byId.get(k) && nm) byId.set(k, nm);
  };
  let live = [];
  try { live = await lookups.forms(db, ctx && ctx.subdomain); } catch (_) { live = []; }
  if (!live.length) {
    // No catalog under our subdomain — take the freshest one cached under any subdomain.
    try {
      const r = await db.query(
        `SELECT payload FROM amc_lookup_cache
          WHERE lookup_type IN ('Get_JobTypes_By_LoanType','GetJobType')
          ORDER BY fetched_at DESC LIMIT 1`);
      if (r.rows[0] && Array.isArray(r.rows[0].payload)) live = r.rows[0].payload;
    } catch (_) { /* no catalog cached yet */ }
  }
  for (const f of live) add(f.id, f.name);
  for (const rule of (rules || [])) add(rule.product_code, rule.product_name);
  return Array.from(byId.entries())
    .map(([id, name]) => ({ id, name: name || null }))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

// The human name for a form id: the chosen rule's own name, else the catalog.
function formNameFor(catalog, code, chosen) {
  if (code == null || code === '') return null;
  if (chosen && String(chosen.productCode) === String(code) && chosen.productName) return chosen.productName;
  const hit = (catalog || []).find((f) => String(f.id) === String(code));
  return hit && hit.name ? hit.name : null;
}

// ---------------------------------------------------------------------------
// Preview — auto-fill the order without sending anything.
// ---------------------------------------------------------------------------
async function buildPreview(db, appId, opts = {}) {
  const ctx = await loadContext(db, appId);
  if (!ctx) return null;
  const rules = await formRules(db);
  const deal = orderBuild.dealShapeFor(ctx);
  // Staff can override the auto-picked form; opts.overrides.productCode wins in buildOrderSpec.
  const chosen = formSelect.chooseForm(deal, rules);
  const spec = orderBuild.buildOrderSpec(ctx, chosen, opts.overrides || {});
  const missing = orderBuild.missingRequired(spec);
  const forms = await formsCatalog(db, ctx, rules);
  return {
    context: ctx,
    deal,
    chosenForm: chosen,
    chosenFormName: formNameFor(forms, spec.productCode, chosen),   // the full name to SHOW
    spec,
    missing,
    // What PILOT auto-filled (a default or a rule/mapping) that staff should eyeball
    // before the order goes out — the NAN mirror of the Class desk's assumptions.
    assumptions: orderBuild.orderAssumptions(ctx, chosen, opts.overrides || {}, spec),
    canPlace: missing.length === 0,
    forms,            // the form catalog [{id,name}], for the staff override dropdown
    notifyEmails: ctx.notifyEmails,   // who NAN will email order updates to
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

  // The appraisal condition this order fulfils, so the report files itself into the
  // right slot when it comes back (see lib/appraisal/condition-slots.js). The caller
  // may name one; otherwise it is the file's own appraisal-documents condition. It is
  // resolved HERE rather than left to the caller because neither order panel sends it,
  // which left every order's link NULL and every returned report off the condition.
  const checklistItemId = opts.checklistItemId
    || (await require('../lib/appraisal/condition-slots').conditionItemId(db, appId));

  const order = await insertOrder(db, appId, spec, cdg.maskRequest(built.message ? built : { message: built }),
    opts.staffId, { checklistItemId, parentOrderId: opts.parentOrderId });

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
// A plain, human summary of exactly what was sent to AppraisalScope for an order —
// so the desk can see "what was in the order" (property, loan number, form, value,
// borrower, contacts) after it is placed, not just the vendor's status. Built from the
// STORED sent envelope (a snapshot), so it reflects the order as it went out even if the
// file has changed since. Returns [{label, value}] rows, blanks omitted.
function orderMoney(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? '$' + Math.round(n).toLocaleString('en-US') : String(v);
}
function orderSummary(order) {
  const rows = [];
  const add = (label, value) => { if (value != null && value !== '') rows.push({ label, value: String(value) }); };
  add('Form ordered', order.form_description || (order.product_code ? 'Form ' + order.product_code : null));
  const msg = order.request_payload && order.request_payload.message;
  if (msg) {
    const deal = (msg.deals && msg.deals[0]) || {};
    const loan = (deal.loans && deal.loans[0]) || {};
    const prop = (deal.properties && deal.properties[0]) || {};
    const addr = prop.address || {};
    add('Loan number', (loan.loanIdentifiers && loan.loanIdentifiers.lenderLoanIdentifier) || order.client_order_number);
    add('Property', [addr.addressLine, addr.addressLine2, addr.cityName, addr.stateCode, addr.postalCode].filter(Boolean).join(', '));
    add('County', addr.countyName);
    add('Property type', prop.titleCategoryType);
    add('Occupancy', prop.propertyCurrentOccupancyType);
    add('Loan purpose', loan.loanPurposeType);
    add('Purchase / property value', orderMoney(prop.salesContractAmount));
    add('Loan amount', orderMoney(loan.baseLoanAmount));
    const bs = (deal.borrowers || [])
      .map((b) => b.legalEntityName || [b.firstName, b.middleName, b.lastName].filter(Boolean).join(' '))
      .filter(Boolean);
    if (bs.length) add(bs.length > 1 ? 'Borrowers' : 'Borrower', bs.join(', '));
    const best = (deal.parties || []).find((p) => p.partyRoleType === 'BestContact');
    if (best) {
      const c = (best.contacts && best.contacts[0]) || {};
      add('Main contact', [best.fullName, c.contactPhone, c.contactEmail].filter(Boolean).join(' · '));
    }
    const si = (msg.clientSystem && msg.clientSystem.sourceInformation) || {};
    if (si.sourceClientName || si.sourceClientIdentifier) {
      add('Client shown on report', si.sourceClientName
        ? (si.sourceClientIdentifier ? `${si.sourceClientName} (#${si.sourceClientIdentifier})` : si.sourceClientName)
        : ('#' + si.sourceClientIdentifier));
    }
    const emails = (((msg.products && msg.products[0]) || {}).notifications || [])
      .map((n) => n && n.contactEmail).filter(Boolean);
    if (emails.length) add('Update emails to', emails.join(', '));
  } else if (order.client_order_number) {
    add('Loan number', order.client_order_number);
  }
  return rows;
}

async function listOrders(db, appId) {
  const r = await db.query(
    `SELECT id, request_action, parent_order_id, client_order_number, cdg_order_number,
            sp_order_number, appraisal_file_number, product_code, form_description,
            status, status_code, status_name, status_description, rush, need_by_date,
            dryrun, last_error, last_status_response, cancel_reason, cancel_requested_at,
            cancel_requested_by, request_payload, created_at, ordered_at, completed_at,
            last_polled_at, updated_at,
            -- How many messages the AMC has sent that nobody has read yet. Class has
            -- carried this since it shipped; NAN never did, so an inbound comment
            -- arrived with nothing on the screen to say so and the "mark read" door
            -- (which has always existed) could not be reached.
            (SELECT count(*)::int FROM amc_order_comments c
              WHERE c.order_id = amc_orders.id AND c.direction='inbound' AND c.read_at IS NULL) AS unread
       FROM amc_orders WHERE application_id = $1 ORDER BY created_at DESC`, [appId]);
  // Attach the plain "what was sent" summary; drop the raw envelope so the response
  // stays lean and never carries the internals of the masked message to the screen.
  return r.rows.map((o) => {
    const summary = orderSummary(o);
    const { request_payload, ...rest } = o;   // eslint-disable-line no-unused-vars
    return { ...rest, summary };
  });
}

async function getOrder(db, orderId) {
  const r = await db.query(`SELECT * FROM amc_orders WHERE id = $1`, [orderId]);
  return r.rows[0] || null;
}

module.exports = {
  loadContext, cardStatus, formRules, buildPreview,
  createOrder, listOrders, getOrder, journal, orderSummary,
  // exported for tests
  addrParts, borrowerCtx, describeSendFailure, readGatewayBody, formsCatalog, formNameFor,
  resolveClientDisplayed,
};
