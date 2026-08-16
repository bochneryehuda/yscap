'use strict';
/**
 * AMC appraisal-ordering routes (staff).
 *
 * The new "Order an appraisal" desk that sits beside the Title / Insurance / Attorney
 * orders. Everything is file-scoped exactly like the draw desk: any staffer assigned
 * to the file (or an admin who sees all files) can build the auto-filled order,
 * preview it, place it, and read its status. The heavy lifting is in src/amc/*;
 * this router is a thin file-scoped shell.
 *
 * The appraisal-fee card is BIDIRECTIONALLY linked to the appraisal_card condition
 * (owner-directed 2026-08-05): entering the card here fills the condition (via the
 * ONE shared appraisal-card.saveApplicationCard chokepoint), and a card the borrower
 * entered on the condition shows up here on the preview — one card, two doors.
 *
 * Inert until the AMC switches are on: buildPreview/list read only (the desk renders
 * read-only with a "not configured" banner in an env that hasn't turned the AMC on),
 * and placing an order needs AMC_ENABLED + AMC_OUTBOUND_ENABLED (the client enforces
 * both fail-closed).
 */
const router = require('../lib/safe-router')();
const db = require('../db');
const { requireAuth, requireStaff } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const client = require('../amc/client');
const orderService = require('../amc/order-service');
const comments = require('../amc/comments');
const cancel = require('../amc/cancel');
const revisions = require('../amc/revisions');
const rov = require('../amc/rov');
const amcDocuments = require('../amc/documents');
const appraisalCard = require('../lib/appraisal-card');

router.use(requireAuth, requireStaff);

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

/**
 * The house audit helper, the same shape every staff router defines for itself
 * (copied from routes/richervalues.js, deliberately — see its own note). Two
 * things it must keep doing: wrap a bare scalar, because `detail` is a jsonb
 * column and pg hands a scalar through verbatim where jsonb refuses it; and be
 * BEST-EFFORT, because by the time a payment reaches here the money has already
 * moved at the vendor and a failed log entry must never be reported as a failed
 * charge.
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

// Same file-scope rule as the draw desk: see_all_files -> any file; else only assigned.
async function canSeeFile(req, appId) {
  if (!isUuid(appId)) return false;
  if (can(req.actor, 'see_all_files')) {
    const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
    return r.rowCount > 0;
  }
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`,
    [appId, req.actor.id]);
  return r.rowCount > 0;
}

// Whether the appraisal-ordering feature is configured / switched on (drives the desk
// banner). Never leaks credentials — just the boolean flags.
router.get('/config', async (_req, res) => {
  res.json({ amc: client.configured() });
});

// The auto-filled order preview: chosen form, filled spec, what's still missing, the
// cached form catalog for a staff override, and the card status. Read-only.
router.get('/files/:id/preview', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const overrides = readOverrides(req.query);
  const preview = await orderService.buildPreview(db, appId, { overrides });
  if (!preview) return res.status(404).json({ error: 'file not found' });
  res.json(preview);
});

// Create a draft (place:false) or place the order with the AMC (place:true).
router.post('/files/:id/order', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const body = req.body || {};
  const out = await orderService.createOrder(db, appId, {
    staffId: req.actor && req.actor.id,
    place: !!body.place,
    overrides: readOverrides(body),
    checklistItemId: isUuid(body.checklistItemId) ? body.checklistItemId : null,
    parentOrderId: Number.isInteger(body.parentOrderId) ? body.parentOrderId : null,
  });
  if (!out.ok) return res.status(out.error === 'file_not_found' ? 404 : 400).json(out);

  // PAY IT AS PART OF PLACING IT — the owner's three ways, offered at the moment
  // the order goes out (owner-directed 2026-08-16). Optional: a body with no
  // `payment` places the order exactly as it always did, and the Pay button on the
  // order card is still there for later.
  //
  // AFTER, NEVER BEFORE, AND THE ORDER IS NEVER ROLLED BACK. The order has been
  // placed with the vendor by this point and cannot be unsent, so a payment that
  // fails is REPORTED beside a successful placement rather than pretended away.
  // Reporting the pair honestly is the whole job here: "ordered, not paid" is a
  // real and recoverable state; "the order failed" would be a lie that sends
  // somebody to place a second one.
  //
  // A DRAFT OR A DRY RUN IS NEVER CHARGED — there is no order at the vendor to pay
  // for, and charging a card against one would be the worst kind of surprise.
  const wants = body.payment && typeof body.payment === 'object' ? body.payment : null;
  const placedLive = !!body.place && !out.dryrun && out.order && out.order.id;
  if (wants && wants.method && placedLive) {
    const payment = require('../amc/payment');
    const staffId = req.actor && req.actor.id;
    try {
      if (String(wants.method).toUpperCase() === 'PAYMENT_LINK') {
        let emails = Array.isArray(wants.emails) && wants.emails.length ? wants.emails : null;
        if (!emails) {
          const r = await db.query(
            `SELECT b.email AS borrower_email, lo.email AS officer_email
               FROM applications a
               JOIN borrowers b ON b.id = a.borrower_id
               LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
              WHERE a.id=$1`, [appId]);
          const row = r.rows[0] || {};
          emails = [row.borrower_email, row.officer_email];
        }
        out.payment = await payment.sendInvoice(db, { orderId: out.order.id, emails, staffId });
      } else {
        out.payment = await payment.charge(db, {
          orderId: out.order.id, method: wants.method, card: wants.card, staffId,
        });
      }
      await audit(req, out.payment.ok ? 'appraisal_payment_charged' : 'appraisal_payment_failed',
        'application', appId, {
          orderId: out.order.id, method: wants.method, atPlacement: true,
          transactionId: out.payment.transactionId, error: out.payment.error,
        });
    } catch (e) {
      // The ORDER still succeeded. Never let a payment failure turn into a failed
      // placement — that is how a second order gets placed for the same appraisal.
      out.payment = { ok: false, error: 'error', detail: (e && e.message) || String(e) };
    }
  } else if (wants && wants.method) {
    // Said out loud rather than silently ignored, so nobody believes a draft was paid.
    out.payment = {
      ok: false, error: 'not_placed',
      detail: out.dryrun
        ? 'Nothing was charged — this was a test run, so there is no order at AppraisalScope to pay for.'
        : 'Nothing was charged — this was saved as a draft. Place it, then pay it from the order card.',
    };
  }
  res.json(out);
});

// The orders on a file (the desk list).
router.get('/files/:id/orders', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  res.json({ orders: await orderService.listOrders(db, appId) });
});

// One order (file-scoped via its own application_id).
router.get('/orders/:orderId', async (req, res) => {
  const id = parseInt(req.params.orderId, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not found' });
  const order = await orderService.getOrder(db, id);
  if (!order) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeFile(req, order.application_id))) return res.status(403).json({ error: 'forbidden' });
  res.json({ order });
});

// Enter the appraisal-fee card from the order desk — the SAME chokepoint the borrower
// condition uses, so it fills the appraisal_card condition automatically (the
// bidirectional link the owner asked for). Payment stays MANUAL; nothing is charged.
router.post('/files/:id/card', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
  if (!app.rows[0]) return res.status(404).json({ error: 'file not found' });
  const v = appraisalCard.validateCardInput(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const saved = await appraisalCard.saveApplicationCard({
    appId, borrowerId: app.rows[0].borrower_id,
    number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear, zip: v.zip,
  });
  res.json({ ok: true, card: saved });
});

// ---------------------------------------------------------------------------
// PAYING THE ORDER — the three ways, actually carried out.
//
// Owner-directed 2026-08-16: *"I want to be a real vendor charge, yes. I want them
// to charge the credit card that I'm importing."* The vendor's own client package
// is now in the repository, so `src/amc/cdg.js` builds their payment requests from
// their own samples and `src/amc/payment.js` carries them out.
//
// STILL MANUAL, and these routes are the whole reason that stays true: nothing
// calls them except a person pressing a button. There is no poll, no hook and no
// scheduler anywhere near this file.
//
// Money rules live in `src/amc/payment.js`, not here — this is the door, and it is
// deliberately thin so that "when may an appraisal be charged" has ONE answer.
// File-scoped like every other action on this desk, and audited: paying is the
// most consequential thing the desk can do.
// ---------------------------------------------------------------------------

/** What a person needs to know BEFORE pressing anything. Reveals no card number. */
router.get('/orders/:orderId/payment', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  try {
    res.json(await require('../amc/payment').paymentState(db, order.id));
  } catch (e) {
    res.status(500).json({ ok: false, error: 'error', detail: (e && e.message) || String(e) });
  }
});

/**
 * PAY IT. `method` is one of the owner's three.
 *
 * The card ways go through `payment.charge`, which claims the order before it sends
 * anything, so two presses can never be two charges. The link way emails the
 * vendor's own invoice to the borrower AND the loan officer — the owner's own
 * pairing — and is not locked, because a second invoice email is a nuisance rather
 * than a second charge.
 *
 * EVERY FAILURE IS ANSWERED IN WORDS a person can act on, and the two that mean
 * "we genuinely do not know whether the money moved" answer 409 with the order left
 * deliberately locked, never a retryable-looking error.
 */
router.post('/orders/:orderId/pay', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const payment = require('../amc/payment');
  const b = req.body || {};
  const method = String(b.method || '').toUpperCase();
  const staffId = req.actor && req.actor.id;

  try {
    if (method === 'PAYMENT_LINK') {
      // The borrower and the loan officer, which is what the owner asked for. A
      // caller may name addresses explicitly (a co-borrower, a different contact);
      // otherwise they are read off the file.
      let emails = Array.isArray(b.emails) ? b.emails : null;
      if (!emails) {
        const r = await db.query(
          `SELECT b.email AS borrower_email, lo.email AS officer_email
             FROM applications a
             JOIN borrowers b ON b.id = a.borrower_id
             LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
            WHERE a.id=$1`, [order.application_id]);
        const row = r.rows[0] || {};
        emails = [row.borrower_email, row.officer_email];
      }
      const out = await payment.sendInvoice(db, { orderId: order.id, emails, staffId });
      if (!out.ok) {
        return res.status(out.error === 'no_recipient' ? 400 : 502).json({
          ...out,
          detail: out.detail || 'AppraisalScope could not send the invoice — nobody was emailed.',
        });
      }
      await audit(req, 'appraisal_payment_invoice_sent', 'application', order.application_id,
        { orderId: order.id, sent: out.sent, failed: out.failed.map((f) => f.email) });
      return res.json(out);
    }

    if (method !== 'CARD_ON_FILE' && method !== 'NEW_CARD') {
      return res.status(400).json({
        error: 'unknown_method',
        detail: 'An appraisal is paid one of three ways: the card on file, a card entered now, or a payment link.',
      });
    }

    const out = await payment.charge(db, { orderId: order.id, method, card: b.card, staffId });
    if (!out.ok) {
      // 409 for the states where money may already have moved or is moving — those
      // must never read as "try again". 400 for a card the person can fix. 502 for
      // a refusal or a failed send.
      const status = ['already_paid', 'charge_in_flight', 'no_receipt', 'unknown_outcome'].includes(out.error) ? 409
        : ['bad_card', 'no_card', 'no_security_code', 'unknown_method'].includes(out.error) ? 400 : 502;
      // A charge that ended in an unknown state is worth an audit row of its own —
      // it is the state somebody will be asked about later.
      if (status === 409 && out.error !== 'already_paid' && out.error !== 'charge_in_flight') {
        await audit(req, 'appraisal_payment_unknown', 'application', order.application_id,
          { orderId: order.id, method, error: out.error });
      }
      return res.status(status).json(out);
    }
    // NEVER the card number, and never the security code — only what a receipt
    // legitimately shows.
    await audit(req, 'appraisal_payment_charged', 'application', order.application_id,
      { orderId: order.id, method, transactionId: out.transactionId, last4: out.last4, brand: out.brand });
    return res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'error', detail: (e && e.message) || String(e) });
  }
});

// ---- the two-way comment thread on an order --------------------------------
// Load an order and confirm the caller may see its file. Returns the order, or null
// (after sending the response).
async function orderScoped(req, res) {
  const id = parseInt(req.params.orderId, 10);
  if (!Number.isInteger(id)) { res.status(404).json({ error: 'not found' }); return null; }
  const order = await orderService.getOrder(db, id);
  if (!order) { res.status(404).json({ error: 'not found' }); return null; }
  if (!(await canSeeFile(req, order.application_id))) { res.status(403).json({ error: 'forbidden' }); return null; }
  return order;
}

// Ask the AMC to cancel a placed order (the NAN mirror of the Class cancel). A reason
// is required; the feature is off until the AMC is switched on (the gated transport
// enforces it) and only asks — the order moves to 'cancelled' when the vendor confirms.
router.post('/orders/:orderId/cancel', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const reason = (req.body && req.body.reason) || '';
  if (!String(reason).trim()) return res.status(400).json({ error: 'reason_required', message: 'Add a short reason for the cancellation.' });
  const out = await cancel.requestCancel(db, order, { reason, staffId: req.actor && req.actor.id });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// The message thread on an order (both directions), plus the unread count.
router.get('/orders/:orderId/comments', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  res.json({ comments: await comments.listComments(db, order.id), unread: await comments.unreadCount(db, order.id) });
});

// Send a message to the AMC on an order (AddComment). Needs the feature switched on
// (the gated transport enforces it); a refusal comes back as a plain reason.
router.post('/orders/:orderId/comments', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const body = (req.body && req.body.body) || '';
  if (!String(body).trim()) return res.status(400).json({ error: 'empty message' });
  let staffName = null;
  try {
    const s = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
    staffName = s.rows[0] ? s.rows[0].full_name : null;
  } catch (_) { staffName = null; }
  const out = await comments.postComment(db, order, { staffId: req.actor.id, staffName, body });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// Mark an inbound AMC message as read.
router.post('/orders/:orderId/comments/:commentId/read', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const cid = parseInt(req.params.commentId, 10);
  if (!Number.isInteger(cid)) return res.status(404).json({ error: 'not found' });
  const flipped = await comments.markRead(db, order.id, cid);
  res.json({ ok: true, updated: flipped });
});

// ---- revisions / ROV disputes / SOW-change requests ------------------------
// The revisions on an order.
router.get('/orders/:orderId/revisions', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  res.json({ revisions: await revisions.listRevisions(db, order.id) });
});

// A general revision request or a scope-of-work-change request.
// body: { kind: 'revision'|'sow_change'|'other', body }
router.post('/orders/:orderId/revisions', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const body = (req.body && req.body.body) || '';
  if (!String(body).trim()) return res.status(400).json({ error: 'empty request' });
  const kind = revisions.normKind(req.body && req.body.kind);
  if (kind === 'rov') return res.status(400).json({ error: 'use the ROV endpoint for a reconsideration of value' });
  const out = await revisions.postRevision(db, order, { staffId: req.actor.id, kind, body });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// Supporting comps for an ROV on a file's subject, pulled from the Property Research
// Center. Read-only — powers the ROV builder before the dispute is placed.
router.get('/files/:id/rov-comps', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const months = Math.min(60, Math.max(1, parseInt(req.query.sold_within_months, 10) || 12));
  res.json(await rov.suggestComps(db, appId, { limit, soldWithinMonths: months }));
});

// FREE search of the Property Research Center for ROV comps — staff pick which
// comparable sales to attach to the dispute. Scoped to closed sales and excludes
// the file's own subject (rov.searchComps). Manual comps are added client-side and
// flow through the same buildRovDetail as the picked ones.
router.get('/files/:id/rov-comp-search', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  res.json(await rov.searchComps(db, appId, req.query || {}));
});

// Place an ROV (reconsideration of value) dispute. The narrative + the structured
// detail are BUILT from the disputed values + the supporting comps, so what the AMC
// reads and what we store agree.
// body: { appraisedValue, opinionValue, note, comps:[{...}] }  (comps optional — the
// caller may pass the ones it picked from /rov-comps, or omit to auto-pull)
router.post('/orders/:orderId/rov', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const b = req.body || {};
  let comps = Array.isArray(b.comps) ? b.comps : null;
  if (!comps) {
    const sug = await rov.suggestComps(db, order.application_id, { limit: 6 });
    comps = sug.comps || [];
  }
  const detail = rov.buildRovDetail({ appraisedValue: b.appraisedValue, opinionValue: b.opinionValue, comps, note: b.note });
  const narrative = rov.buildRovNarrative(detail);
  const out = await revisions.postRevision(db, order, { staffId: req.actor.id, kind: 'rov', body: narrative, rovDetail: detail });
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

// ---- document upload (Document Center → order) -----------------------------
// The file's documents staff can pick from, each with a category and whether it is
// already on the given order (?orderId=). Read-only.
router.get('/files/:id/documents', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const orderId = Number.isInteger(parseInt(req.query.orderId, 10)) ? parseInt(req.query.orderId, 10) : null;
  res.json({ documents: await amcDocuments.listUploadable(db, appId, orderId) });
});

// Upload the picked documents to an order. body: { documentIds:[uuid], action? }.
router.post('/orders/:orderId/documents', async (req, res) => {
  const order = await orderScoped(req, res);
  if (!order) return;
  const ids = Array.isArray(req.body && req.body.documentIds) ? req.body.documentIds.filter(isUuid) : [];
  if (!ids.length) return res.status(400).json({ error: 'pick at least one document' });
  const out = await amcDocuments.uploadToOrder(db, order, { staffId: req.actor.id, documentIds: ids, action: req.body.action }, {});
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
});

/**
 * WHAT DOES THE APPRAISAL COMPANY THINK WE HAVE ORDERED? (2026-08-16)
 *
 * Reads their own order list and reports anything on their side that PILOT has no
 * row for — an appraisal ordered on their website, or re-issued by them under a
 * new number, which would otherwise never be polled, never file its report onto
 * the condition, and never reach the Orders desk.
 *
 * REPORTS ONLY. It creates nothing: deciding that one of their orders IS a given
 * file's appraisal is a judgement with an expensive wrong answer, so it hands a
 * human the evidence instead. A pure vendor READ, so it is safe with ordering off.
 *
 * `platform_setup` — this reads the WHOLE account's orders across every file, so
 * it is not a per-file surface and must not be behind the per-file scope.
 */
router.get('/reconcile', async (req, res) => {
  if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'forbidden' });
  const out = await require('../amc/reconcile').findUnknownOrders(db, {
    days: req.query.days,
    loanNumber: req.query.loanNumber ? String(req.query.loanNumber) : null,
  });
  res.json(out);
});

/**
 * WHICH PAYMENT ROUTES THIS ACCOUNT IS ALLOWED TO USE — a pure read.
 *
 * PILOT does not charge appraisals: payment is manual by the owner's standing
 * direction (2026-08-05), the back office charges the stored card by hand, and
 * none of the vendor's Payment* actions is wired. This asks the vendor which
 * routes the account has TURNED ON, so the answer to "could we let PILOT take the
 * payment?" is a fact on a screen rather than a guess — and so that if the owner
 * ever says yes, the ground is already known. It authorises nothing and charges
 * nothing.
 */
router.get('/payment-options', async (req, res) => {
  if (!can(req.actor, 'platform_setup')) return res.status(403).json({ error: 'forbidden' });
  try {
    const cfgd = client.configured();
    if (!cfgd.enabled) return res.json({ ok: false, error: 'not_enabled' });
    if (!cfgd.ready) return res.json({ ok: false, error: 'not_configured' });
    const cdg = require('../amc/cdg');
    const session = require('../amc/session');
    const ctx = await session.authContext();
    const resp = await client.lookup(cdg.buildGetPaymentOptions({ apiKey: ctx.apiKey, subdomain: ctx.subdomain }),
      { label: 'GetPaymentOptions' });
    const err = cdg.parseError(resp);
    if (err) return res.json({ ok: false, error: 'vendor', message: err.description || String(err.code) });
    const options = cdg.parseLookup(resp);
    res.json({
      ok: true,
      // Their own flag for whether a payment form is offered at all.
      formAvailable: !!(resp && resp.responseData && String(resp.responseData.paymentFormAvailable) === '1'),
      options,
      // Said out loud on the payload, so nothing that renders it can imply PILOT
      // is about to start charging cards.
      note: 'Read-only. PILOT does not charge appraisals — the card is stored on the file and the back office charges it by hand.',
    });
  } catch (e) {
    res.json({ ok: false, error: 'error', message: (e && e.message) || String(e) });
  }
});

// Parse the overridable order fields from a query/body object. Staff can change the
// auto-picked form and the request options on the preview / place.
function readOverrides(src) {
  const s = src || {};
  const o = {};
  if (s.productCode != null && s.productCode !== '') o.productCode = String(s.productCode);
  if (s.amcIdentifier != null && s.amcIdentifier !== '') o.amcIdentifier = String(s.amcIdentifier);
  if (Array.isArray(s.subproductCodes)) o.subproductCodes = s.subproductCodes.map(String);
  if (s.mortgageType) o.mortgageType = String(s.mortgageType);
  if (s.bestContact) o.bestContact = String(s.bestContact);
  if (s.titleCategory) o.titleCategory = String(s.titleCategory);
  // The "Client Displayed on Report" (client_displayed_id) — auto-selected when the account
  // has one profile; a staffer can pin a specific one when the account has several.
  if (s.clientDisplayedId != null && s.clientDisplayedId !== '') o.clientDisplayedId = String(s.clientDisplayedId);
  if (s.requestComment) o.requestComment = String(s.requestComment);
  if (s.needByDate) o.needByDate = String(s.needByDate);
  if (s.rush != null) o.rush = s.rush === true || s.rush === 'true' || s.rush === '1';
  if (s.requestAction) o.requestAction = String(s.requestAction);
  return o;
}

module.exports = router;
