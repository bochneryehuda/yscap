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
const revisions = require('../amc/revisions');
const rov = require('../amc/rov');
const amcDocuments = require('../amc/documents');
const appraisalCard = require('../lib/appraisal-card');
// A bigint row id is not a parseInt — see src/lib/bigint-id.js. The Class desk hit
// exactly this and was hardened; this desk is its twin and must not drift.
const { bigintId } = require('../lib/bigint-id');

router.use(requireAuth, requireStaff);

// Their best-person-to-contact list (cdg.js marks the leaf "verify against UAT";
// these four are the values the vendor's own mapping documents).
const BEST_CONTACTS = ['Borrower', 'Co-Borrower', 'Owner', 'Agent'];
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

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
  let out;
  try {
    out = await orderService.createOrder(db, appId, {
      staffId: req.actor && req.actor.id,
      place: !!body.place,
      overrides: readOverrides(body),
      checklistItemId: isUuid(body.checklistItemId) ? body.checklistItemId : null,
      parentOrderId: Number.isInteger(body.parentOrderId) ? body.parentOrderId : null,
    });
  } catch (e) {
    // Anything unexpected here used to reach the global handler and come back as the
    // generic "Something went wrong on our end", which tells the person at the desk
    // nothing about a connection that is simply not set up yet.
    //
    // BUT THE EXCEPTION'S OWN TEXT NEVER GOES TO THE SCREEN. It is written for us, not
    // for them: a Postgres error code, "AMC DoLogin -> 401", a URL, a stack-adjacent
    // sentence. A non-developer reading that learns nothing and cannot act on it, and
    // it is the same class of leak the Class desk removed in this very change (its
    // route no longer relays the vendor's body). The log line carries the detail; the
    // person gets a plain sentence and the one thing they can actually do.
    console.warn('[amc] order failed:', (e && e.stack) || e);
    return res.status(502).json({
      ok: false, error: 'order_failed',
      message: 'The appraisal order could not be completed. Nothing was sent. '
        + 'Please try again, and if it keeps happening let the team know.',
    });
  }
  if (!out.ok) return res.status(out.error === 'file_not_found' ? 404 : 400).json(out);
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
  const id = bigintId(req.params.orderId);
  if (!id) return res.status(404).json({ error: 'not found' });
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

// ---- the two-way comment thread on an order --------------------------------
// Load an order and confirm the caller may see its file. Returns the order, or null
// (after sending the response).
async function orderScoped(req, res) {
  const id = bigintId(req.params.orderId);
  if (!id) { res.status(404).json({ error: 'not found' }); return null; }
  const order = await orderService.getOrder(db, id);
  if (!order) { res.status(404).json({ error: 'not found' }); return null; }
  if (!(await canSeeFile(req, order.application_id))) { res.status(403).json({ error: 'forbidden' }); return null; }
  return order;
}

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
  const cid = bigintId(req.params.commentId);
  if (!cid) return res.status(404).json({ error: 'not found' });
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
  // CLAMPED to the three actions the builder accepts (cdg.js buildUploadDocuments). `requestActionType` reaches the
  // vendor verbatim, and every other field on that message is pinned — this one was
  // passed straight through from the request body.
  const UPLOAD_ACTIONS = ['UploadDocument', 'UploadDocumentMulti', 'UploadContract'];
  const action = UPLOAD_ACTIONS.includes(req.body.action) ? req.body.action : undefined;
  const out = await amcDocuments.uploadToOrder(db, order, { staffId: req.actor.id, documentIds: ids, action }, {});
  if (!out.ok) return res.status(400).json(out);
  res.json(out);
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
  // CLAMPED to their documented enum. It reaches the vendor verbatim as
  // `partyRoleTypeIdentifier`, and it was the one overridable value on the order
  // message that was not pinned — the clamp on the upload `action` was added for
  // exactly this reason and stopped one field short.
  if (BEST_CONTACTS.includes(String(s.bestContact))) o.bestContact = String(s.bestContact);
  if (s.titleCategory) o.titleCategory = String(s.titleCategory);
  if (s.requestComment) o.requestComment = String(s.requestComment);
  if (s.needByDate) o.needByDate = String(s.needByDate);
  if (s.rush != null) o.rush = s.rush === true || s.rush === 'true' || s.rush === '1';
  if (s.requestAction) o.requestAction = String(s.requestAction);
  return o;
}

module.exports = router;
