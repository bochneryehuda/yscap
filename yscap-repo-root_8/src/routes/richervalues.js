'use strict';
/**
 * Richer Values — the staff order desk for the Hybrid Appraisal. STAFF ONLY,
 * file-scoped.
 *
 * Read-shaped except the routes that reach the vendor in a way that costs money.
 * `POST /files/:id/order` is the main one, and it is gated four deep: the master
 * switch, the outbound switch, `canPlace` (nothing missing), and an explicit
 * `confirm:true` from the screen. A GET can never place an order.
 *
 * NOTHING HERE DECIDES BETWEEN VENDORS. There are three appraisal desks now and
 * none of them is the default — this one answers only for Richer Values, exactly as
 * the AMC desk answers only for the AMC and the Class desk only for Class.
 * Whichever surface chooses between them is the unified order section, which
 * dispatches; do not grow a default in here.
 *
 * A VENDOR'S HTTP STATUS IS NEVER RELAYED. A 401 from Richer Values relayed as a
 * 401 from PILOT would sign the STAFFER out (the session chokepoint in
 * src/auth/index.js documents this class), so every vendor failure comes back as
 * a 502 carrying their own words in the body.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff } = require('../auth');
const { assigneeExistsSql, can } = require('../lib/permissions');
const client = require('../richervalues/client');
const orderService = require('../richervalues/order-service');
const orderBuild = require('../richervalues/order-build');
const reference = require('../richervalues/reference');
const sync = require('../richervalues/sync');
const documents = require('../richervalues/documents');
const payment = require('../richervalues/payment');
const xmlWaiver = require('../lib/appraisal/xml-waiver');

router.use(requireAuth, requireStaff);

/**
 * The house audit helper, the same shape every staff route defines for itself.
 * Two things it must keep doing:
 *   • `detail` lands in a jsonb column, and pg hands a bare SCALAR to jsonb
 *     verbatim, which is rejected — so a scalar is wrapped rather than turning an
 *     otherwise-successful action into a failed request;
 *   • it is BEST-EFFORT. A logging write must never fail an action that already
 *     happened at the vendor — an order has been placed and money is committed by
 *     the time we get here.
 */
async function audit(req, action, entityType, entityId, detail) {
  let d = detail;
  if (d != null && typeof d !== 'object') d = { note: String(d) };
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entityType, entityId || null, req.ip, req.get('user-agent') || null, d || null]);
  } catch (e) {
    console.warn(`[audit] failed to log ${action}: ${(e && e.message) || e}`);
  }
}

// The same per-file scope every staff surface uses — never a hand-written one.
async function canSeeFile(req, appId) {
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`,
    [appId, req.actor.id]);
  return r.rowCount > 0;
}

/** Load an order and check the actor may see its file, in one step. */
async function loadOrder(req, res, id) {
  const order = await orderService.getOrder(db, id);
  if (!order) { res.status(404).json({ error: 'not found' }); return null; }
  if (!(await canSeeFile(req, order.application_id))) { res.status(403).json({ error: 'forbidden' }); return null; }
  return order;
}

/** The one way a vendor failure reaches the screen — never their status code. */
function vendorFail(res, e, code) {
  return res.status(502).json({
    error: e.code || code || 'vendor_failed',
    detail: orderService.describeVendorError(e),
    fieldErrors: Array.isArray(e.fieldErrors) ? e.fieldErrors : [],
    vendor: e.body || null,
  });
}

// Only the keys the preview and the order are allowed to take, so a crafted
// request cannot smuggle an arbitrary field into the vendor body. The builder is
// the thing that decides what is SENT; this decides what may be ASKED for.
const OVERRIDE_KEYS = new Set([
  'reportType', 'inspectionType', 'turnaroundTime', 'glaInclude', 'licensingRequired',
  'includeFloodCertification', 'borrowerName', 'closingDate', 'historicalEffectiveDate', 'effectiveDate',
  'isVacantLand', 'isPartiallyCompleted', 'partiallyCompletedPercentage',
  'propertyAddress', 'propertyAddressLine2', 'unitNumber', 'city', 'state', 'postalCode',
  'residentialPropertyType', 'residentialPropTypeUnits', 'propertyCondition',
  'aboveGradeSqft', 'belowGradeSqft', 'bedrooms', 'bathrooms', 'yearBuilt', 'lotSizeSquareFeet',
  'stories', 'garageSpaces', 'isBasement', 'isBasementFinished',
  'proposedAboveGradeSqft', 'proposedBelowGradeSqft', 'proposedBedrooms', 'proposedBathrooms',
  'borrowerBudget',
  'isPropertyOnLockbox', 'lockboxCode', 'lockboxLocation', 'lockboxEntrance',
  'communityGateCodeNeeded', 'gateCode', 'propertyAccessContacts',
  'reportContactName', 'reportContactEmail', 'reportContactPhone', 'reportCcUsers',
  'inspectionNotes', 'valuationNotes', 'notes',
  'expectedLoanAmount', 'acquisitionContractPrice', 'expectedAsIsValue', 'expectedArv',
  'loanOfficerToken',
]);

function readOverrides(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    if (!OVERRIDE_KEYS.has(k)) continue;
    if (v == null || v === '') continue;
    out[k] = v;
  }
  // The access-contact list arrives as JSON from a query string and as a real
  // array from a body. Anything unparseable is dropped rather than half-read —
  // a contact with a mangled phone is worse than no contact.
  if (typeof out.propertyAccessContacts === 'string') {
    try { out.propertyAccessContacts = JSON.parse(out.propertyAccessContacts); } catch (_) { delete out.propertyAccessContacts; }
  }
  if (out.propertyAccessContacts && !Array.isArray(out.propertyAccessContacts)) delete out.propertyAccessContacts;
  return out;
}

// ---------------------------------------------------------------------------
// Configuration + catalogue.
// ---------------------------------------------------------------------------
// Booleans only — never a credential, and never a masked one either; there is
// nothing here worth leaking. It also hands the screen the fixed vocabularies the
// builder validates against, so a picker can never offer a value the builder
// would refuse.
router.get('/config', async (req, res) => {
  res.json({
    richerValue: client.configured(),
    hosts: client.hosts(),
    options: orderBuild.screenOptions(),
  });
});

// Their per-company catalogue: which reports this client may order, which
// inspections go with each, and the turnaround options. Served from the cache;
// `?refresh=1` asks them again.
router.get('/catalogue', async (req, res) => {
  const companyToken = await client.companyToken().catch(() => null);
  if (!companyToken) return res.json({ available: false, reportTypes: [], inspectionTypes: [], turnaroundTimes: [] });
  const reportType = req.query.reportType || (client.configured().defaults || {}).reportType || 'reno-arv';
  const c = await orderService.catalogueFor(db, companyToken, reportType, { force: req.query.refresh === '1' });
  res.json({
    available: true,
    reportType,
    reportTypes: c.reportTypes.items,
    inspectionTypes: c.inspectionTypes.items,
    turnaroundTimes: c.turnaroundTimes.items,
    stale: !!(c.reportTypes.stale || c.inspectionTypes.stale || c.turnaroundTimes.stale),
    error: c.reportTypes.error || c.inspectionTypes.error || c.turnaroundTimes.error || null,
    fetchedAt: c.reportTypes.fetchedAt || null,
  });
});

// ---------------------------------------------------------------------------
// The preview — every field that would be sent, each labelled with where its
// value came from. Read-only, and safe with ordering switched off.
// ---------------------------------------------------------------------------
router.get('/files/:id/preview', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const preview = await orderService.buildPreview(db, appId, {
      overrides: readOverrides(req.query),
      refresh: req.query.refresh === '1',
    });
    if (!preview) return res.status(404).json({ error: 'file not found' });
    res.json(preview);
  } catch (e) { return vendorFail(res, e, 'preview_failed'); }
});

// A price for exactly this property, before anybody commits. A POST because it
// carries a body; it changes NOTHING at the vendor, which is why it is not behind
// the outbound gate.
router.post('/files/:id/price', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const preview = await orderService.buildPreview(db, appId, { overrides: readOverrides(req.body) });
    if (!preview) return res.status(404).json({ error: 'file not found' });
    res.json({ price: preview.price, error: preview.priceError });
  } catch (e) { return vendorFail(res, e, 'price_failed'); }
});

// ---------------------------------------------------------------------------
// PLACE THE ORDER. The route that costs money.
// ---------------------------------------------------------------------------
router.post('/files/:id/order', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  try {
    const out = await orderService.placeOrder(db, appId, {
      overrides: readOverrides(b),
      staffId: req.actor.id,
      confirm: b.confirm === true,
      // The second half of the $400,000 double confirmation. A screen that does
      // not render the warning cannot send its token, which is the point.
      acknowledgements: Array.isArray(b.acknowledgements) ? b.acknowledgements
        : (b.acknowledgements ? [b.acknowledgements] : []),
      // How it gets paid, chosen at the moment of ordering. The card NEVER touches
      // the loan file's ordinary columns or a log line — `payment.js` saves it
      // through the shared encrypted chokepoint and hands it straight to them.
      payWith: b.payWith || null,
      card: b.card || null,
      paymentLinkTo: b.paymentLinkTo || null,
    });
    await audit(req, 'rv_order_placed', 'application', appId, {
      orderId: out.order.id,
      reportType: out.order.report_type,
      inspectionType: out.order.inspection_type,
      dryrun: !!out.dryrun,
      xmlWaiverApplied: !!(out.xmlWaiver && out.xmlWaiver.applied),
      paymentMethod: out.order.payment_method || null,
      scopeOfWorkAttached: !!(out.scopeOfWork && out.scopeOfWork.attached),
      // WHO decided to order over the recommended limit, and that they were told.
      loanAmountOverLimit: !!(out.loanGuard && out.loanGuard.level === 'warn'),
    });
    res.status(201).json({
      ok: true,
      dryrun: !!out.dryrun,
      order: out.order,
      xmlWaiver: out.xmlWaiver || null,
      scopeOfWork: out.scopeOfWork || null,
      loanGuard: out.loanGuard || null,
    });
  } catch (e) {
    if (e.code === 'confirm_required') return res.status(400).json({ error: e.code, detail: e.message });
    if (e.code === 'loan_amount_over_limit') {
      return res.status(422).json({ error: e.code, detail: e.message, loanGuard: e.loanGuard || null });
    }
    if (e.code === 'incomplete') return res.status(422).json({ error: e.code, detail: e.message, missing: e.missing || [] });
    if (e.code === 'not_eligible') return res.status(422).json({ error: e.code, detail: e.message });
    if (e.code === 'rv_disabled' || e.code === 'rv_not_configured') return res.status(409).json({ error: e.code, detail: e.message });
    if (e.code === 'RV_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: 'outbound_disabled', detail: 'Ordering is switched off — turn on “Place Hybrid Appraisal orders” on the API Health page.' });
    }
    if (e.code === 'not_found') return res.status(404).json({ error: 'not found' });
    return vendorFail(res, e, 'order_failed');
  }
});

// ---------------------------------------------------------------------------
// The orders on a file, and one order in full.
// ---------------------------------------------------------------------------
router.get('/files/:id/orders', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const orders = await orderService.listOrders(db, appId);
  const waiver = await xmlWaiver.loadWaiver(appId, db);
  res.json({ orders, xmlWaiver: waiver });
});

router.get('/orders/:orderId', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const detail = await orderService.orderDetail(db, order.id);
  return res.json(detail);
});

// Ask them again, now. The same read the poller makes — offered as a button so a
// desk never has to wait out an interval to see where an order is up to.
router.post('/orders/:orderId/refresh', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  try {
    const out = await sync.syncOne(order, { staffId: req.actor.id });
    const detail = await orderService.orderDetail(db, order.id);
    return res.json({ ok: true, ...out, ...detail });
  } catch (e) { return vendorFail(res, e, 'refresh_failed'); }
});

// ---------------------------------------------------------------------------
// The two figures onto the loan file.
//
// Normally automatic. This is the button for when it was REFUSED — a frozen file
// a super-admin has since unlocked, or a value a person had already decided. It
// goes through the SAME shared As-Is desk, so the freeze, the bounds, the
// ARV-above-As-Is rule and the audit all still apply; the button changes who is
// asking, not what is allowed.
// ---------------------------------------------------------------------------
router.post('/orders/:orderId/apply-values', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const out = await orderService.applyValues(db, order, { staffId: req.actor.id, actor: req.actor });
  if (!out.ok) return res.status(out.status || 409).json({ error: 'not_applied', detail: out.error, locked: !!out.locked });
  await audit(req, 'rv_values_applied', 'application', order.application_id, {
    orderId: order.id, asIs: out.asIs, arv: out.arv, arvBasis: out.arvBasis,
  });
  return res.json({ ok: true, ...out });
});

// Pull the finished report onto the file now (normally automatic on completion).
router.post('/orders/:orderId/fetch-report', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const out = await documents.fileReport(db, order);
  if (!out.filed && !out.documentId) return res.status(409).json({ error: out.reason || 'not_ready', detail: out.detail || null });
  return res.json({ ok: true, ...out });
});

// ---------------------------------------------------------------------------
// Order actions. Every one of these WRITES at the vendor, so each is journaled
// and each requires the outbound gate to be open.
// ---------------------------------------------------------------------------
/** Shared shape: run a vendor write, journal it, patch the row, audit it. */
async function vendorAction(req, res, order, { action, run, patch, auditAction, detail }) {
  try {
    const response = await run();
    await orderService.journal(db, {
      orderRow: order.id, appId: order.application_id, action,
      request: detail || {}, response, ok: true, staffId: req.actor.id,
    });
    if (patch) await db.query(patch.sql, patch.vals);
    if (auditAction) await audit(req, auditAction, 'application', order.application_id, { orderId: order.id, ...(detail || {}) });
    const fresh = await orderService.orderDetail(db, order.id);
    return res.json({ ok: true, dryrun: !!(response && response.__dryrun), ...fresh });
  } catch (e) {
    await orderService.journal(db, {
      orderRow: order.id, appId: order.application_id, action,
      request: detail || {}, response: e.body || null, ok: false, error: e.message, staffId: req.actor.id,
    });
    if (e.code === 'RV_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: 'outbound_disabled', detail: 'Writing to Richer Values is switched off — turn it on on the API Health page.' });
    }
    return vendorFail(res, e, `${action}_failed`);
  }
}

// CANCEL. Their cancel takes a reason, and the order is NOT marked cancelled here
// on our say-so — their own status is what confirms it, exactly as the other two
// desks treat a cancellation. What DOES happen straight away is the reason being
// recorded, so "who cancelled this and why" is answerable immediately.
router.post('/orders/:orderId/cancel', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 8) return res.status(400).json({ error: 'reason_required', detail: 'Add a short reason for cancelling — it goes to Richer Values and onto the file.' });
  if (req.body && req.body.confirm !== true) return res.status(400).json({ error: 'confirm_required', detail: 'Cancelling has to be confirmed.' });

  return vendorAction(req, res, order, {
    action: 'cancel',
    detail: { reason },
    run: () => client.cancelOrder({ intake_token: order.intake_token, order_token: order.order_token, cancellation_reason: reason }),
    patch: {
      sql: `UPDATE rv_orders SET status='cancel_requested', cancel_reason=$2, cancelled_by=$3, cancelled_at=now() WHERE id=$1`,
      vals: [order.id, reason.slice(0, 2000), req.actor.id],
    },
    auditAction: 'rv_order_cancelled',
  });
});

// PUT IT ON HOLD / TAKE IT OFF HOLD.
router.post('/orders/:orderId/hold', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const reason = String((req.body && req.body.reason) || '').trim();
  if (reason.length < 8) return res.status(400).json({ error: 'reason_required', detail: 'Add a short reason for the hold.' });
  return vendorAction(req, res, order, {
    action: 'hold',
    detail: { reason },
    run: () => client.placeHold({ intake_token: order.intake_token, order_token: order.order_token, hold_reason: reason }),
    auditAction: 'rv_order_held',
  });
});

router.post('/orders/:orderId/release-hold', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const notes = String((req.body && req.body.notes) || '').trim();
  return vendorAction(req, res, order, {
    action: 'release_hold',
    detail: { notes },
    run: () => client.releaseHold({ intake_token: order.intake_token, order_token: order.order_token, notes }),
    auditAction: 'rv_order_hold_released',
  });
});

// REOPEN a completed order — their own five reasons, and the inspection choice
// their documentation says is only offered on a cancelled order.
const REOPEN_TYPES = new Set(['edits', 'new-budget', 'new-specs', 'dispute', 'market-update']);
router.post('/orders/:orderId/reopen', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const b = req.body || {};
  const type = String(b.reopenType || '').trim();
  if (!REOPEN_TYPES.has(type)) {
    return res.status(400).json({ error: 'reason_required', detail: 'Pick why this is being reopened.', options: [...REOPEN_TYPES] });
  }
  const notes = String(b.notes || '').trim();
  if (notes.length < 8) return res.status(400).json({ error: 'notes_required', detail: 'Add a short note explaining what needs to change.' });
  const body = {
    intake_token: order.intake_token, order_token: order.order_token,
    reopen_order_type: type, reopen_notes: notes,
  };
  if (b.reopenInspectionType) body.reopen_inspection_type = String(b.reopenInspectionType);
  if (b.newInspectionType) body.new_inspection_type = String(b.newInspectionType);
  return vendorAction(req, res, order, {
    action: 'reopen', detail: { type, notes },
    run: () => client.reopenOrder(body),
    patch: { sql: `UPDATE rv_orders SET status='revision', status_reason=$2 WHERE id=$1`, vals: [order.id, `Reopened: ${type}`] },
    auditAction: 'rv_order_reopened',
  });
});

// CHANGE THE INSPECTION / THE REPORT after ordering. Both are their own endpoints
// and both re-price, which is why the report change carries a payment source.
router.post('/orders/:orderId/inspection-type', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const next = String((req.body && req.body.inspectionType) || '').trim();
  if (!next) return res.status(400).json({ error: 'inspection_required', detail: 'Pick the new inspection.' });
  return vendorAction(req, res, order, {
    action: 'inspection_type_update', detail: { inspectionType: next },
    run: () => client.updateInspectionType({ intake_token: order.intake_token, order_token: order.order_token, new_inspection_type: next }),
    patch: { sql: `UPDATE rv_orders SET inspection_type=$2 WHERE id=$1`, vals: [order.id, next] },
    auditAction: 'rv_inspection_changed',
  });
});

router.post('/orders/:orderId/report-type', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const next = String((req.body && req.body.reportType) || '').trim();
  if (!next) return res.status(400).json({ error: 'report_required', detail: 'Pick the new report.' });
  const body = { intake_token: order.intake_token, order_token: order.order_token, new_report_type: next };
  if (req.body.paymentSourceId) body.payment_source_id = String(req.body.paymentSourceId);
  return vendorAction(req, res, order, {
    action: 'report_type_update', detail: { reportType: next },
    run: () => client.updateReportType(body),
    patch: { sql: `UPDATE rv_orders SET report_type=$2 WHERE id=$1`, vals: [order.id, next] },
    auditAction: 'rv_report_type_changed',
  });
});

// SETTLE AN UNPAID INTAKE. An intake that submitted but did not pay is a real,
// recoverable state — their screens show it too — so this is the retry rather
// than a reason to place a second order.
router.post('/orders/:orderId/pay', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  if (order.paid_at) return res.status(409).json({ error: 'already_paid', detail: 'This order has already been settled.' });
  const b = req.body || {};
  const method = String(b.method || b.payWith || '').toUpperCase() || null;
  if (method && !payment.METHODS.includes(method)) {
    return res.status(400).json({
      error: 'bad_method',
      detail: `Richer Values orders are paid by ${payment.METHODS.join(', ')} — not by invoice and not by ACH.`,
    });
  }
  try {
    const updated = await orderService.payIntake(db, order, {
      staffId: req.actor.id,
      method,
      card: b.card || null,
      paymentLinkTo: b.paymentLinkTo || null,
      borrowerId: b.borrowerId || null,
    });
    // THREE OUTCOMES, NOT TWO. `ok` = did what you pressed happen; `settled` = has
    // the money actually moved. A payment link the staffer ASKED for is ok-but-not-
    // settled; a card charge that fell through to one is neither, and must never be
    // announced as "charged". `payIntake` carries that verdict back rather than
    // leaving the screen to guess it from `paid_at`.
    const p = updated.__payment || { ok: !!updated.paid_at, settled: !!updated.paid_at, note: updated.last_error || null };
    await audit(req, 'rv_order_paid', 'application', order.application_id, {
      orderId: order.id, method: updated.payment_method, settled: !!p.settled, ok: !!p.ok,
    });
    const detail = await orderService.orderDetail(db, order.id);
    // `payIntake` never throws for a payment problem — it records what happened in
    // words on the row, so the desk reads the outcome rather than a 500.
    return res.json({ ok: !!p.ok, settled: !!p.settled, note: p.note || null, ...detail });
  } catch (e) { return vendorFail(res, e, 'pay_failed'); }
});

// What paying will do, and what card the file already carries — never the number.
router.get('/files/:id/payment', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const card = await payment.cardStatus(db, appId);
  res.json({ methods: payment.METHODS, card });
});

// ---------------------------------------------------------------------------
// THE SCOPE OF WORK: what would be sent, and sending it.
//
// Owner-directed (2026-08-14): *"updated scopes of work can be sent for revisions
// … we should be able to update the scope of work in their system if the scope of
// work updates in our system."* The PLAN is a read so the screen can say what will
// happen — update the order, send the file, or reopen a finished report — before
// anyone commits to it.
// ---------------------------------------------------------------------------
router.get('/files/:id/scope-of-work', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    res.json(await orderService.scopeOfWorkState(db, appId));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/orders/:orderId/scope-of-work', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  try {
    const out = await orderService.sendScopeOfWorkRevision(db, order.id, {
      note: (req.body && req.body.note) || null,
      staffId: req.actor.id,
    });
    await audit(req, 'rv_sow_revision_sent', 'application', order.application_id, {
      orderId: order.id, action: out.action || (out.plan && out.plan.action) || null, ok: !!out.ok,
    });
    if (!out.ok) return res.status(422).json({ error: 'sow_revision_failed', detail: out.error, plan: out.plan || null });
    const detail = await orderService.orderDetail(db, order.id);
    return res.json({ ok: true, action: out.action, why: out.why, dryrun: !!out.dryrun, ...detail });
  } catch (e) { return vendorFail(res, e, 'sow_revision_failed'); }
});

// Ask THEM to collect from the borrower instead. Their own endpoint; used when a
// borrower is paying for their own report.
router.post('/orders/:orderId/send-payment-link', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const to = Array.isArray(req.body && req.body.to) ? req.body.to.filter(Boolean) : [];
  if (!to.length) return res.status(400).json({ error: 'recipient_required', detail: 'Say who the payment link goes to.' });
  return vendorAction(req, res, order, {
    action: 'send_payment_link', detail: { to },
    run: () => client.sendPaymentLink(order.intake_token, {
      to, cc: Array.isArray(req.body.cc) ? req.body.cc.filter(Boolean) : [], comment: String(req.body.comment || ''),
    }),
    auditAction: 'rv_payment_link_sent',
  });
});

// DISMISS / REACTIVATE an intake that has not become an order.
router.post('/orders/:orderId/dismiss', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  return vendorAction(req, res, order, {
    action: 'dismiss',
    run: () => client.dismissOrder(order.intake_token),
    patch: { sql: `UPDATE rv_orders SET status='cancelled', cancelled_at=now(), cancelled_by=$2 WHERE id=$1`, vals: [order.id, req.actor.id] },
    auditAction: 'rv_order_dismissed',
  });
});

router.post('/orders/:orderId/reactivate', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  return vendorAction(req, res, order, {
    action: 'reactivate',
    run: () => client.reactivateOrder(order.intake_token),
    patch: { sql: `UPDATE rv_orders SET status='intake', cancelled_at=NULL, cancelled_by=NULL WHERE id=$1`, vals: [order.id] },
    auditAction: 'rv_order_reactivated',
  });
});

// SEND THEM A DOCUMENT off the loan file — the scope of work, photos, a prior
// inspection. The documents are chosen by id from THIS file, so the route can
// never be used to read a document from another one.
router.post('/orders/:orderId/documents', async (req, res) => {
  const order = await loadOrder(req, res, req.params.orderId);
  if (!order) return undefined;
  const ids = Array.isArray(req.body && req.body.documentIds) ? req.body.documentIds.filter(Boolean) : [];
  const field = String((req.body && req.body.field) || 'other_files');
  const ALLOWED = new Set(['budget_files', 'photo_files', 'video_files', 'inspection_files', 'plan_files', 'contract_files', 'other_files']);
  if (!ids.length) return res.status(400).json({ error: 'documents_required', detail: 'Pick at least one document to send.' });
  if (!ALLOWED.has(field)) return res.status(400).json({ error: 'bad_field', detail: 'That is not a kind of file Richer Values accepts.' });

  const rows = (await db.query(
    `SELECT id, filename, content_type, storage_provider, storage_ref FROM documents
      WHERE id = ANY($1::uuid[]) AND application_id=$2 AND is_current = true`,
    [ids, order.application_id])).rows;
  if (!rows.length) return res.status(404).json({ error: 'not_found', detail: 'Those documents are not on this file.' });

  const store = require('../lib/storage');
  const files = [];
  for (const r of rows) {
    try {
      const bytes = await store.forRow(r).read(r.storage_ref);
      if (bytes && bytes.length) files.push({ filename: r.filename, contentType: r.content_type, bytes });
    } catch (_) { /* one unreadable document must not stop the rest */ }
  }
  if (!files.length) return res.status(409).json({ error: 'unreadable', detail: 'None of those documents could be read.' });

  return vendorAction(req, res, order, {
    action: 'upload_documents', detail: { field, count: files.length },
    run: () => client.uploadDocuments({
      intake_token: order.intake_token, order_token: order.order_token, [field]: files,
    }),
    auditAction: 'rv_documents_sent',
  });
});

module.exports = router;
