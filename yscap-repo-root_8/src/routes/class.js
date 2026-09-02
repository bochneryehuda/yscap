'use strict';
/**
 * Class Valuation — the staff order desk. STAFF ONLY, file-scoped.
 *
 * Read-shaped except one route. `POST /files/:id/order` is the only thing that
 * can reach Class in a way that costs money, and it is gated four deep: the
 * master switch, the outbound switch, `canPlace` (nothing missing), and an
 * explicit `confirm:true` from the screen. A GET can never place an order.
 *
 * NOTHING HERE DECIDES BETWEEN VENDORS. The owner has not picked a default and
 * said to leave it until one is actually ready, so this desk answers only for
 * Class; the AMC desk answers only for the AMC. Whichever surface eventually
 * chooses between them is a separate, deliberate piece of work — do not quietly
 * grow a default in here.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { visibleOfficersSql } = require('../lib/permissions');
const { can } = require('../lib/permissions');
const client = require('../class/client');
const classProducts = require('../class/products');
const orderService = require('../class/order-service');
const orderBuild = require('../class/order-build');
const callbacks = require('../class/callbacks');
const messages = require('../class/messages');
const revisionReasons = require('../class/revision-reasons');
const classDocuments = require('../class/documents');
const classPayment = require('../class/payment');

router.use(requireAuth, requireStaff);

/* THE FILE SCOPE IS THE SHARED FIVE-WAY RULE, NOT THE ASSIGNEE BRANCH ALONE
   (owner-reported 2026-08-25: an appraisal XML import answering "not found", and a
   processor sent to the Encompass tab from the term sheet hitting a refusal).
   `assigneeExistsSql` is branch 4 of `visibleOfficersSql`'s five, so this tab used to
   refuse a staffer who reaches the file by DELEGATION (staff_users.visible_officer_ids)
   or by an OPEN workflow hand-off — while staff.js's own /applications/:id middleware,
   which uses the full rule, let them open the whole file screen. Same person, same file,
   one tab saying "not found". Never re-inline a file scope; ask permissions.js. */
async function canSeeFile(req, appId) {
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${visibleOfficersSql('a', '$2')}`,
    [appId, req.actor.id]);
  return r.rowCount > 0;
}

// Only the keys the preview is allowed to override, so a crafted request cannot
// smuggle an arbitrary field into the vendor body.
const OVERRIDE_KEYS = new Set([
  'apiVersion',
  'productId', 'propertyTypeEnum', 'purpose', 'loanType', 'occupancy',
  'referenceNumber', 'street', 'city', 'state', 'zip', 'county', 'dueDate', 'instructions',
  // How the order is paid (Invoice / PaymentLink / Prepay) and, for a payment link,
  // who Class emails it to — chosen on the order screen, sent at order time (the
  // only moment Class's API lets it be chosen; see src/class/payment.js).
  'paymentMethod', 'paymentEmail',
]);
// Their registration reply is documented as a list of event names, but the shape is
// not guaranteed. Concatenating an OBJECT would append it as one element and write
// the literal "[object Object]" into class_callback_registrations as an event name.
function asNameList(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' || typeof x === 'number');
  if (v && typeof v === 'object') return Object.keys(v);
  return [];
}

function readOverrides(src) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) if (OVERRIDE_KEYS.has(k) && v != null && v !== '') out[k] = v;
  return out;
}

// Whether the integration is configured / switched on. Booleans only — never a
// credential, never a masked one either; there is nothing here worth leaking.
//
// It also hands the screen Class's own closed value lists. The picker MUST come
// from here rather than a list retyped in a component, or the options a staffer
// can choose would drift from what the builder is willing to send.
router.get('/config', async (req, res) => {
  const cfgd = client.configured();
  // The screen may ask about a version other than the default — that is how a
  // staffer looks at what a 3.6 order would carry before anything is switched over.
  const version = req.query.version || cfgd.apiVersion;
  const options = orderBuild.screenOptions(version);
  res.json({
    class: cfgd,
    hosts: client.hosts(),
    versions: orderBuild.VERSIONS,
    defaultVersion: cfgd.apiVersion,
    options,
    // The 2.6 names, kept so an older screen build keeps working after a deploy.
    enums: options.enums,
    occupancySuggestions: options.occupancySuggestions,
  });
});

// The auto-filled order preview: every field that would be sent, each labelled
// with where its value came from. Read-only, and safe with ordering switched off.
router.get('/files/:id/preview', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const preview = await orderService.buildPreview(db, appId, { overrides: readOverrides(req.query) });
  if (!preview) return res.status(404).json({ error: 'file not found' });
  res.json(preview);
});

// Their product catalogue, for the form picker. A read — master switch only.
// The endpoint is PAGINATED and each product's readable name is `title` (or
// `alternativeName`), so we page through the WHOLE catalogue and normalize every row —
// never one page, never a bare Mongo id. See src/class/products.js.
router.get('/products', async (req, res) => {
  if (!client.configured().enabled) return res.json({ available: false, products: [] });
  try {
    const products = await classProducts.fetchAll(client, { title: req.query.title });
    // THE FEE BEFORE ORDERING, as far as Class's API allows: their API has no fee
    // quote, so each product carries what Class LAST charged this account for it
    // (from payment-details / ClientFeeChanged on earlier orders). Best-effort — a
    // product with no history simply has no fee line, and the screen says so.
    let fees = {};
    try { fees = await classPayment.recentFees(db); } catch (_) { fees = {}; }
    for (const p of products) {
      const f = p && p.id != null ? fees[String(p.id)] : null;
      if (f) p.recentFee = f;
    }
    res.json({ available: true, products, feeSource: 'history' });
  } catch (e) {
    // Never relay the vendor's status — a 401 from Class would sign the STAFFER
    // out of PILOT (the repo's session chokepoint documents this class).
    res.status(502).json({ available: false, error: e.code || 'lookup_failed', detail: e.message });
  }
});

// PLACE THE ORDER. The only route here that costs money.
router.post('/files/:id/order', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });

  const body = req.body || {};
  // The screen must say so explicitly. A missing confirm is a refusal, not a
  // default — nobody places a real appraisal order by accident.
  if (body.confirm !== true) {
    return res.status(400).json({ error: 'confirm_required', message: 'Ordering needs an explicit confirmation from the screen.' });
  }

  const preview = await orderService.buildPreview(db, appId, { overrides: readOverrides(body.overrides) });
  if (!preview) return res.status(404).json({ error: 'file not found' });

  // Re-checked HERE, at send time — never trusted from whatever the screen
  // fetched earlier, which may be minutes stale.
  if (!preview.canPlace) {
    return res.status(422).json({ error: 'incomplete', missing: preview.missing,
      message: 'Some details Class requires are still missing.' });
  }

  const cfgd = client.configured();
  if (!cfgd.enabled) return res.status(409).json({ error: 'CLASS_DISABLED', message: 'The Class Valuation connection is switched off.' });
  if (!cfgd.ready) return res.status(409).json({ error: 'CLASS_NOT_CONFIGURED', message: 'The Class Valuation credentials are not all set.' });

  // THE ORDER ROW IS WRITTEN BEFORE THE CALL, NOT AFTER — and it records WHICH FORM
  // VERSION this order is on. Two reasons, both learned the hard way elsewhere in
  // this repo:
  //   1. Their callback tells us `orderId` and our `referenceNumber` and NOTHING about
  //      the version. A follow-up read has to be made on the matching path or it
  //      answers in the other version's field names. If we only wrote the row after a
  //      successful reply, an order that timed out on the wire would exist at Class
  //      with no record here at all — and the callback for it would be unmatchable.
  //   2. `placing` is a real state a human can see, rather than a gap.
  let orderRowId = null;
  try {
    const ins = await db.query(
      `INSERT INTO class_orders (application_id, reference_number, api_version, uad, order_path,
                                 product_id, request_body, dryrun, status, placed_by, placed_at,
                                 checklist_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'placing',$9, now(),$10) RETURNING id`,
      [appId, preview.body.referenceNumber || null, preview.apiVersion, preview.uad, preview.path,
       preview.body.productId != null ? String(preview.body.productId) : null,
       require('../lib/fields').jsonbText(preview.body), !!cfgd.dryrun, req.actor.id,
       // The appraisal condition this order fulfils, so the report files itself into
       // the right slot when it comes back (lib/appraisal/condition-slots.js). Nothing
       // ever set this, so every Class order's link was NULL.
       await require('../lib/appraisal/condition-slots').conditionItemId(db, appId)]);
    orderRowId = ins.rows[0].id;
  } catch (e) {
    // A bookkeeping failure must not stop the order — but it MUST be visible, because
    // an order placed with no row is an order whose callbacks cannot be matched.
    console.warn('[class] could not record the order row:', e && e.message);
  }

  const finish = async (patch) => {
    if (!orderRowId) return;
    const cols = Object.keys(patch);
    if (!cols.length) return;
    // `request_body` is jsonb; the value is a JSON string, so it is cast explicitly to
    // match the insert (`$7::jsonb`) and be independent of parameter-type inference.
    // Every other column takes its value straight.
    const setSql = cols.map((c, i) => `${c} = $${i + 2}${c === 'request_body' ? '::jsonb' : ''}`).join(', ');
    await db.query(
      `UPDATE class_orders SET ${setSql} WHERE id = $1`,
      [orderRowId, ...cols.map((c) => patch[c])]).catch(() => {});
  };

  const query = {
    OrgId: (require('../config').class || {}).orgId || undefined,
    LenderOrgId: (require('../config').class || {}).lenderOrgId || undefined,
  };
  // The occupancy cascade. v1 `occupancy` binds to a live enum whose members their
  // guide never lists (see order-build), so the body starts on the most-likely value
  // and we try the rest IN ORDER only on the specific occupancy binding error. A
  // model-binding 400 creates nothing at Class, so a rejected candidate never places a
  // real order — the FIRST value Class accepts is the one and only order, and it is
  // remembered so this file's classification cascades at most once per process. Any
  // OTHER failure (a different field, a business rejection, the write gate) stops the
  // cascade at once and surfaces as itself.
  const candidates = (Array.isArray(preview.occupancyCandidates) && preview.occupancyCandidates.length)
    ? preview.occupancyCandidates
    : [preview.body.occupancy];

  try {
    // THE PATH COMES FROM THE PREVIEW, not from the config: the preview is what
    // shaped this body, so posting it anywhere else would send a 2.6 body to the 3.6
    // endpoint or the reverse. Those two disagree about field names, so the failure
    // would be a rejected order at best and a silently dropped field at worst.
    let out, sentBody, usedOccupancy, triedCount = 0;
    for (let i = 0; i < candidates.length; i++) {
      sentBody = { ...preview.body, occupancy: candidates[i] };
      usedOccupancy = candidates[i];
      triedCount = i + 1;
      try {
        out = await client.createOrder(sentBody, query, { path: preview.path });
        break;   // accepted (or dry-run short-circuit) — stop here
      } catch (e) {
        const moreToTry = i < candidates.length - 1;
        if (orderBuild.isOccupancyEnumError(e) && moreToTry) continue;   // occupancy still bad — next value
        throw e;   // a real failure, or the candidates are exhausted
      }
    }

    if (out && out.__dryrun) {
      await finish({ status: 'dryrun' });
      return res.json({ ok: true, dryrun: true, apiVersion: preview.apiVersion, uad: preview.uad,
        message: `TEST MODE — a UAD ${preview.uad} order was built and logged, nothing was sent.`, body: sentBody });
    }
    // Remember the value Class accepted so later orders of this shape go out clean, and
    // record what actually went (the body the row stored at insert had the first-guess
    // occupancy). Both are best-effort and never affect the response.
    if (triedCount > 1) {
      orderService.rememberOccupancy(preview.apiVersion, preview.occupancyKey, usedOccupancy);
      console.warn(`[class] occupancy "${preview.occupancyKey}" accepted as "${usedOccupancy}" on ${preview.apiVersion} after ${triedCount} value(s)`);
    }
    await finish({
      status: 'ordered',
      class_order_id: out && out.orderId != null ? String(out.orderId) : null,
      transaction_id: out && out.transactionId != null ? String(out.transactionId) : null,
      request_body: require('../lib/fields').jsonbText(sentBody),
      // How it is paid, as sent — so the desk can say "Class emails the borrower a
      // link" or "billed to our account" without re-reading the body.
      payment_method: (sentBody.paymentDetails && sentBody.paymentDetails.paymentMethod) || null,
      payment_recipient_email: (sentBody.paymentDetails && sentBody.paymentDetails.recipientEmail) || null,
    });
    // THE SCOPE OF WORK AND THE CONTRACT GO UP RIGHT AWAY when the file already has
    // them (the poller repeats this every five minutes for anything that arrives
    // later). Best-effort: the order stands whatever happens here.
    if (orderRowId && out && out.orderId != null) {
      try {
        const row = (await db.query('SELECT * FROM class_orders WHERE id = $1', [orderRowId])).rows[0];
        if (row) await classDocuments.autoUploadForOrder(db, row);
      } catch (_) { /* the poller will retry */ }
    }
    // THE INVESTOR'S APPRAISAL REQUIREMENTS GO ON THE ORDER, right after it is
    // placed (owner-directed 2026-08-16) — the same message NAN gets, from the
    // same single definition. It runs AFTER `finish` because a note can only be
    // attached once Class has given the order a number. Nothing here can fail
    // the order: the appraisal is placed, the poster never throws, and it names
    // no capital partner (Class is an outside company).
    if (orderRowId) {
      try {
        await require('../lib/appraisal/order-requirements-post')
          .postForClassOrder(db, orderRowId, appId, { staffId: req.actor && req.actor.id });
      } catch (_) { /* the order stands regardless */ }
    }
    res.json({
      ok: true, orderId: out && out.orderId, transactionId: out && out.transactionId,
      apiVersion: preview.apiVersion, uad: preview.uad, body: sentBody,
      // AN UNRECORDED ORDER IS NOT A SUCCESS, even though the appraisal really was
      // ordered. With no row, nothing links their callbacks back to this file: the
      // order proceeds at Class and PILOT never hears about it again. Saying so is
      // the difference between a problem somebody can fix in a minute and one that
      // surfaces weeks later as "the appraisal never came back".
      recorded: !!orderRowId,
      warning: orderRowId ? undefined
        : 'The order WAS placed with Class, but PILOT could not record it — its updates will not reach this file. Tell an administrator, with the order number above.',
    });
  } catch (e) {
    // Store the WHOLE reason (our message + the meaningful text out of the vendor's
    // body), not just "HTTP 400" with the cause thrown away — so the errored order
    // shows WHY on the file screen, and so a person watching the logs sees a clear
    // [class] line instead of nothing (the reason used to live only in the DB row).
    const reason = orderBuild.describeOrderError(e);
    await finish({ status: 'error', last_error: reason });
    if (e.code === 'CLASS_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: e.code, message: 'Placing orders with Class Valuation is switched off.' });
    }
    console.warn(`[class] order failed for file ${appId}: ${reason}`);
    res.status(502).json({ error: e.code || 'order_failed', detail: e.message, vendor: e.body || null });
  }
});

// ---------------------------------------------------------------------------
// WHAT CLASS HAS TOLD US. The orders on this file, and the events behind them.
// Read-only, file-scoped, and safe with everything switched off.
// ---------------------------------------------------------------------------
router.get('/files/:id/orders', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(
    `SELECT id, class_order_id, transaction_id, reference_number, api_version, uad, order_path,
            product_id, product_title, status, status_reason, invision_url, due_date,
            appointment_date, inspected_at, assigned_vendor, client_fee_cents, paid_at,
            payment_method, payment_recipient_email, payment_link_sent_at,
            total_cents, paid_cents, outstanding_cents, additional_fees, payment_checked_at, payment_recorded_at,
            dryrun, last_event_at, last_error, request_body, placed_at, created_at
       FROM class_orders WHERE application_id = $1
      ORDER BY created_at DESC`, [appId]);
  // Attach the plain "what was sent" summary and drop the raw body so the response stays
  // lean — the screen shows the summary, never the vendor's internal order body.
  const orders = r.rows.map((o) => {
    const summary = orderBuild.orderSummary(o);
    const { request_body, ...rest } = o;   // eslint-disable-line no-unused-vars
    return { ...rest, summary, balance: classPayment.describeBalance(o) };
  });
  const ids = r.rows.map((o) => o.id);
  // Unread counts per order, so the file screen can badge a waiting reply without
  // fetching every thread.
  const unread = ids.length ? (await db.query(
    `SELECT class_order_row, count(*)::int n FROM class_notes
      WHERE class_order_row = ANY($1::bigint[]) AND direction = 'ToClient' AND read_at IS NULL
      GROUP BY class_order_row`, [ids])).rows : [];
  const openAsks = ids.length ? (await db.query(
    `SELECT class_order_row, kind, count(*)::int n FROM class_revisions
      WHERE class_order_row = ANY($1::bigint[]) AND status IN ('requested','sent')
      GROUP BY class_order_row, kind`, [ids])).rows : [];
  const events = ids.length ? (await db.query(
    `SELECT id, class_order_row, event_name, received_at, processed_at, process_error
       FROM class_callback_events WHERE class_order_row = ANY($1::bigint[])
      ORDER BY received_at DESC LIMIT 200`, [ids])).rows : [];
  const attachments = ids.length ? (await db.query(
    `SELECT id, class_order_row, name, content_type, document_id, announced_at, fetched_at,
            direction, category, uploaded_at, upload_error
       FROM class_attachments WHERE class_order_row = ANY($1::bigint[])
      ORDER BY COALESCE(uploaded_at, announced_at) DESC`, [ids])).rows : [];
  res.json({ orders, events, attachments, unread, openAsks });
});

// ---------------------------------------------------------------------------
// OUR DOCUMENTS, UP TO THEM (owner-directed 2026-09-02). The mirror of the AMC
// document picker: what the file has, what is already on the order, and a send.
// ---------------------------------------------------------------------------
router.get('/files/:id/documents', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const orderRowId = bigintId(req.query.orderRowId);
  if (orderRowId && !(await orderOnFile(appId, orderRowId))) return res.status(404).json({ error: 'no such order on this file' });
  res.json({ documents: await classDocuments.listUploadable(db, appId, orderRowId || null),
    categories: classDocuments.CLASS_CATEGORIES });
});

// body: { documentIds:[uuid], category? } — `category` forces one Class category for the
// whole pick (the picker's "send as the purchase contract" → SalesContract).
router.post('/files/:id/orders/:orderRowId/documents', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'no such order on this file' });
  const order = (await db.query('SELECT * FROM class_orders WHERE id = $1', [bigintId(req.params.orderRowId)])).rows[0];
  const ids = Array.isArray(req.body && req.body.documentIds) ? req.body.documentIds.filter(isUuid) : [];
  if (!ids.length) return res.status(400).json({ error: 'pick at least one document' });
  const out = await classDocuments.uploadToOrder(db, order,
    { staffId: req.actor.id, documentIds: ids, category: req.body.category }, {});
  if (!out.ok) {
    if (out.error === 'outbound_disabled') return res.status(409).json({ ...out, message: 'Writing to Class Valuation is switched off, so nothing can be sent yet.' });
    return res.status(400).json(out);
  }
  res.json(out);
});

// ---------------------------------------------------------------------------
// THE MONEY PICTURE — what Class says this order costs and what is still owed. A
// staffer opening it wants the live number, so the hourly throttle is skipped here.
// ---------------------------------------------------------------------------
router.get('/files/:id/orders/:orderRowId/payment', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'no such order on this file' });
  const order = (await db.query('SELECT * FROM class_orders WHERE id = $1', [bigintId(req.params.orderRowId)])).rows[0];
  const r = await classPayment.refreshOrder(db, order, { force: true });
  const o = r.ok ? r.order : order;
  res.json({
    ok: true, live: !!(r.ok && r.fresh), error: r.ok ? undefined : r.error, detail: r.ok ? undefined : r.message,
    paymentMethod: o.payment_method, recipientEmail: o.payment_recipient_email,
    linkSentAt: o.payment_link_sent_at, paidAt: o.paid_at, recordedAt: o.payment_recorded_at,
    clientFeeCents: o.client_fee_cents, totalCents: o.total_cents, paidCents: o.paid_cents,
    outstandingCents: o.outstanding_cents, additionalFees: o.additional_fees || [],
    checkedAt: o.payment_checked_at, balance: classPayment.describeBalance(o),
    // What this screen can and cannot do, said plainly (src/class/payment.js header).
    canCharge: false,
    canRecord: true,
    note: 'Class Valuation has no card charge in its API. A payment link is chosen when the order is placed; a card charged by the back office is RECORDED here so Class stops chasing the borrower.',
  });
});

// body: { nameCardHolder, amount (dollars), last4, authorizationCode } — tell Class a card
// payment was taken elsewhere. Records only; nothing is charged by this call.
router.post('/files/:id/orders/:orderRowId/payment/record', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'no such order on this file' });
  const order = (await db.query('SELECT * FROM class_orders WHERE id = $1', [bigintId(req.params.orderRowId)])).rows[0];
  const out = await classPayment.recordCardPayment(db, order, req.body || {});
  if (!out.ok) {
    if (out.error === 'outbound_disabled') return res.status(409).json({ ...out, message: 'Writing to Class Valuation is switched off, so the payment cannot be recorded yet.' });
    return res.status(400).json(out);
  }
  res.json({ ok: true, dryrun: out.dryrun, balance: out.order ? classPayment.describeBalance(out.order) : null });
});

// ---------------------------------------------------------------------------
// TALKING TO CLASS ABOUT A LIVE ORDER — messages, revisions, reconsiderations of
// value, cancellation. Every one is file-scoped through the SAME check as the rest
// of this router, and every one re-resolves the order from the file rather than
// trusting an id in the URL: an order row id is a bigserial, so without that check a
// staffer on file A could message about file B's order by guessing a number.
// ---------------------------------------------------------------------------
// The id is checked for RANGE before it is bound, not only for shape. A number past
// bigint reaches Postgres, raises 22003, and the catch-all turns that into a 500
// "something went wrong on our end" — which reads as PILOT being broken rather than as
// a bad id. `id` is a bigserial, so anything outside it is simply not an order of ours
// and belongs on the same "no such order here" path as a wrong-file id.
const MAX_BIGINT = 9223372036854775807n;
function bigintId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^[0-9]{1,19}$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n && n <= MAX_BIGINT ? s : null;
}

async function orderOnFile(appId, orderRowId) {
  const id = bigintId(orderRowId);
  if (!id) return false;
  const r = await db.query('SELECT id FROM class_orders WHERE id = $1 AND application_id = $2',
    [id, appId]);
  return r.rowCount > 0;
}

// The reason vocabulary the screen offers. Served from the one place the validator
// reads it, so the picker can never offer a code Class would reject.
router.get('/revision-reasons', async (req, res) => {
  const kind = String(req.query.kind || 'revision');
  const set = revisionReasons.forKind(kind);
  const label = (c) => ({ code: c, label: revisionReasons.labelFor(c) });
  res.json({
    kind,
    common: set.common.map(label),
    all: set.all.map(label),
    // Class has no separate ROV call — say so here, so the screen can explain it
    // rather than implying a request type that does not exist.
    rovIsARevision: true,
  });
});

router.get('/files/:id/orders/:orderRowId/thread', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  res.json(await messages.thread(req.params.orderRowId));
});

// Pull THEIR side of the thread on demand. A read — master switch only.
router.post('/files/:id/orders/:orderRowId/thread/sync', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  const out = await messages.syncNotes(req.params.orderRowId);
  res.status(out.ok ? 200 : 502).json(out);
});

router.post('/files/:id/orders/:orderRowId/notes', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  const out = await messages.note(req.params.orderRowId, (req.body || {}).content, { staffId: req.actor.id });
  // A send failure is NOT a lost message — the note is stored either way — so the
  // status says "we could not deliver it", never "it did not happen".
  res.status(out.ok ? 200 : (out.error === 'empty' ? 400 : 502)).json(out);
});

router.post('/files/:id/orders/:orderRowId/read', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  res.json(await messages.markRead(req.params.orderRowId));
});

// A REVISION or a RECONSIDERATION OF VALUE. One route, because it is one call at
// Class; `kind` decides which reasons are sensible and how it is recorded.
router.post('/files/:id/orders/:orderRowId/revision', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const out = await messages.requestRevision(req.params.orderRowId, {
    kind: b.kind === 'rov' ? 'rov' : 'revision',
    reasons: b.reasons,
    note: b.note,
    supporting: b.supporting,
    staffId: req.actor.id,
  });
  // not_ready = the report isn't in yet (a precondition, not a vendor failure) → 409, so
  // the screen shows the plain "wait for the report" note, never the red gateway box.
  res.status(out.ok ? 200 : (out.error === 'bad_reasons' ? 400 : out.error === 'not_ready' ? 409 : 502)).json(out);
});

router.post('/files/:id/orders/:orderRowId/cancel', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!(await orderOnFile(appId, req.params.orderRowId))) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  // Cancelling costs real work at their end and cannot be taken back from here, so
  // it needs the same explicit confirmation placing the order does.
  if (b.confirm !== true) {
    return res.status(400).json({ error: 'confirm_required', message: 'Cancelling an order needs an explicit confirmation.' });
  }
  const out = await messages.requestCancel(req.params.orderRowId, {
    reasons: b.reasons, note: b.note, staffId: req.actor.id });
  res.status(out.ok ? 200 : (out.error === 'bad_reasons' ? 400 : 502)).json(out);
});

// Delete a FAILED / DRYRUN attempt that never reached Class (owner-directed
// 2026-08-18). The shared decision module (lib/appraisal/order-delete) refuses
// anything the vendor has seen, anything paid, and anything with a filed
// document — those are cancelled or kept, never deleted. Notes/revisions/
// attachment rows cascade; the desk mirror re-syncs afterward.
router.delete('/files/:id/orders/:orderRowId', async (req, res) => {
  try {
    const appId = req.params.id;
    if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
    const id = bigintId(req.params.orderRowId);
    if (!id) return res.status(404).json({ error: 'not_found' });
    const order = (await db.query(`SELECT * FROM class_orders WHERE id=$1 AND application_id=$2`, [id, appId])).rows[0];
    if (!order) return res.status(404).json({ error: 'not_found' });
    const orderDelete = require('../lib/appraisal/order-delete');
    const pi = (await db.query(
      `SELECT settled_at, vendor_transaction_id, charge_started_at
         FROM appraisal_payment_intents WHERE vendor='class' AND vendor_order_id=$1::bigint`, [order.id])).rows[0] || null;
    const filed = (await db.query(
      `SELECT count(*)::int n FROM class_attachments WHERE class_order_row=$1 AND document_id IS NOT NULL`, [order.id])).rows[0].n;
    const verdict = orderDelete.mayDelete('class', order, { paymentIntent: pi, filedDocuments: filed });
    if (!verdict.ok) return res.status(422).json({ error: verdict.reason, message: verdict.message });
    await db.query(`DELETE FROM appraisal_payment_intents WHERE vendor='class' AND vendor_order_id=$1::bigint`, [order.id]);
    await db.query(`DELETE FROM class_orders WHERE id=$1`, [order.id]);
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,detail)
         VALUES ('staff',$1,'appraisal_order_attempt_deleted','application',$2,$3)`,
        [req.actor.id, appId, JSON.stringify({ vendor: 'class', orderId: String(order.id), status: order.status, lastError: order.last_error || null })]);
    } catch (_) { /* best-effort */ }
    try { await require('../lib/appraisal-order-mirror').syncOne(appId); } catch (_) { /* best-effort */ }
    res.json({ ok: true });
  } catch (e) { console.warn('[class] delete attempt error:', (e && e.message) || e); res.status(500).json({ error: 'server error' }); }
});

// ---------------------------------------------------------------------------
// CALLBACK SETUP. Deliberately NOT under /callbacks — that path is the public
// receiver, mounted ahead of this router in server.js, and a staff route hidden
// behind it would be answered by the webhook's own catch-all instead.
// ---------------------------------------------------------------------------
router.get('/callback-setup', requirePermission('platform_setup'), async (_req, res) => {
  const cfgd = client.configured();
  const c = require('../config').class || {};
  const rows = (await db.query(
    `SELECT event_name, callback_url, class_id, auth_mode, registered_at, removed_at, last_error
       FROM class_callback_registrations ORDER BY event_name`)).rows;
  res.json({
    // Booleans and a URL only — never the username, never the password.
    ready: cfgd.callbackReady,
    callbackUrl: c.callbackUrl || null,
    events: callbacks.EVENTS,
    registered: rows,
    // Their registration is per ORGANIZATION and carries no version, so ONE
    // registration covers orders on both UAD versions. Said out loud here so nobody
    // goes looking for a second one to set up.
    coversBothVersions: true,
  });
});

router.post('/callback-setup/register', requirePermission('platform_setup'), async (req, res) => {
  const cfgd = client.configured();
  const c = require('../config').class || {};
  if (!cfgd.enabled) return res.status(409).json({ error: 'CLASS_DISABLED', message: 'The Class Valuation connection is switched off.' });
  if (!c.callbackUrl) return res.status(409).json({ error: 'no_callback_url', message: 'Set CLASS_CALLBACK_URL to the address Class should call.' });
  if (!cfgd.callbackReady) {
    return res.status(409).json({ error: 'no_callback_credentials',
      message: 'Set the username and password Class should use when it calls us. Without them the receiver refuses every delivery.' });
  }
  try {
    // `addAll` registers every event they support in one call — which is what we
    // want: an event we do not handle yet is still recorded, and turning one on later
    // becomes a code change rather than a second conversation with the vendor.
    const out = await client.registerAllCallbacks({
      callbackUrl: c.callbackUrl,
      userName: c.callbackUser,
      password: c.callbackPassword,
      authMode: 'BasicAuth',
    });
    const added = (out && (out.callbacksAdded || out.CallbacksAdded)) || {};
    const names = Array.isArray(added) ? added : Object.keys(added || {});
    for (const ev of names.concat(asNameList(out && out.callbacksExisting))) {
      await db.query(
        `INSERT INTO class_callback_registrations (event_name, callback_url, auth_mode, registered_by)
         VALUES ($1,$2,'BasicAuth',$3)
         ON CONFLICT (event_name, callback_url) WHERE removed_at IS NULL DO NOTHING`,
        [String(ev).slice(0, 64), c.callbackUrl, req.actor.id]).catch(() => {});
    }
    res.json({ ok: true, added: names, existing: (out && out.callbacksExisting) || [],
      couldNotBeAdded: (out && out.callbacksCouldNotBeAdded) || [] });
  } catch (e) {
    if (e.code === 'CLASS_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: e.code, message: 'Writing to Class Valuation is switched off, so we cannot register the callback yet.' });
    }
    res.status(502).json({ error: e.code || 'register_failed', detail: e.message, vendor: e.body || null });
  }
});

module.exports = router;
