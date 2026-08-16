'use strict';
/**
 * The Trinity desk — the staff surface for a PHYSICAL inspection on the general
 * physical program (a physical draw whose note buyer is NOT Blue Lake).
 *
 * What it deliberately does NOT have is an autopilot. The report lands, our figures
 * fill in from it, and then a HUMAN presses "Deliver to the borrower" (owner-directed
 * 2026-08-14). The delivery itself runs through the machinery that already exists —
 * `portal-draws.approveTrinityRequest` — so from the borrower's side the accept/dispute
 * experience is byte-for-byte the one they already have; only the inspector's name has
 * changed.
 *
 * Everything is file-scoped by the `/applications/:id` middleware pattern used across
 * the staff router, and every write needs `manage_draws`.
 */

const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const { requireStaff } = require('../auth');
const perms = require('../lib/permissions');
const client = require('../trinity/client');
const order = require('../trinity/order');
const ingest = require('../trinity/ingest');
const report = require('../trinity/report');
const mapper = require('../trinity/mapper');

router.use(requireStaff);

const can = (req, cap) => perms.can(req.actor, cap);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

/**
 * Every route is scoped to a file the actor may actually see, through the SAME
 * `visibleOfficersSql` chokepoint every other staff surface uses — never a hand-written
 * scope (the standing rule: one definition of "which files can this person open").
 * `see_all_files` drops the clause, so the placeholder is only bound when it is
 * referenced (an unreferenced parameter is a Postgres 42P18).
 */
async function fileScope(req, res, next) {
  try {
    const appId = req.params.appId;
    const seesAll = can(req, 'see_all_files');
    const sql = seesAll
      ? `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL`
      : `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${perms.visibleOfficersSql('a', '$2')}`;
    const params = seesAll ? [appId] : [appId, req.actor.id];
    const r = await db.query(sql, params);
    if (!r.rows.length) return bad(res, 403, 'You do not have access to this file.');
    req.appId = appId;
    next();
  } catch (e) { next(e); }
}

async function loadOrder(appId, orderId) {
  return (await db.query(
    `SELECT * FROM trinity_inspection_orders WHERE id=$1 AND application_id=$2`, [orderId, appId])).rows[0] || null;
}

// ---------------------------------------------------------------------------
// the desk view
// ---------------------------------------------------------------------------
/**
 * Everything the desk shows for this file: the orders, their progress in Trinity's own
 * words, the per-line numbers, the messages, the photos and the documents.
 */
router.get('/files/:appId', fileScope, async (req, res, next) => {
  try {
    const orders = (await db.query(
      `SELECT * FROM trinity_inspection_orders WHERE application_id=$1 ORDER BY created_at DESC`, [req.appId])).rows;
    const out = [];
    for (const o of orders) {
      const lines = (await db.query(
        `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [o.id])).rows;
      const comments = (await db.query(
        `SELECT id, direction, content, important, author_name, trinity_created_at, created_at
           FROM trinity_order_comments WHERE trinity_inspection_order_id=$1
          ORDER BY COALESCE(trinity_created_at, created_at) DESC LIMIT 100`, [o.id])).rows;
      const media = (await db.query(
        `SELECT id, kind, file_name, content_type, bytes, labels, archived_at, skip_reason
           FROM trinity_order_media WHERE trinity_inspection_order_id=$1 ORDER BY kind, id`, [o.id])).rows;
      out.push({
        ...o,
        // What the desk needs to know at a glance about where this sits.
        progress: {
          state: o.status,
          trinity_status: o.trinity_status,
          trinity_substatus: o.trinity_substatus,
          attention: o.trinity_status_id ? mapper.readStatus(o.trinity_status_id).attention : false,
        },
        lines,
        comments,
        photos: media.filter((m) => m.kind === 'photo'),
        documents: media.filter((m) => m.kind !== 'photo'),
      });
    }
    res.json({
      orders: out,
      connection: {
        configured: client.available(),
        enabled: client.enabled(),
        outbound: client.outboundEnabled(),
        dryrun: client.dryrun(),
      },
      // The desk states the rule so nobody has to remember it: nothing reaches the
      // borrower until a human sends it.
      autopilot: false,
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// placing / re-driving an order
// ---------------------------------------------------------------------------
router.post('/files/:appId/orders/:orderId/place', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const r = await order.placeOrder(req.appId, o.id, { staffId: req.actor.id });
    if (r.blocked) return res.status(422).json(r);
    if (r.error) return res.status(502).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

/** Pull the latest from Trinity right now (the poller does this on its own too). */
router.post('/files/:appId/orders/:orderId/refresh', fileScope, async (req, res, next) => {
  try {
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    if (!o.trinity_order_id) return bad(res, 409, 'This inspection has not been ordered from Trinity yet.');
    res.json(await ingest.syncOrder(req.appId, o.id));
  } catch (e) { next(e); }
});

/**
 * SCHEDULE the inspection — move the date and/or set rush.
 * Trinity requires 24 hours' notice; `order.reschedule` says so in our own words rather
 * than passing their validation error through.
 */
router.post('/files/:appId/orders/:orderId/schedule', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const b = req.body || {};
    const r = await order.reschedule(req.appId, o.id, {
      dateIso: b.date || b.dateIso || null,
      rush: b.rush === undefined ? null : !!b.rush,
      staffId: req.actor.id,
    });
    if (r.blocked) return res.status(422).json(r);
    if (r.error) return res.status(502).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

/**
 * Push the current property picture (lock box code, appraisal, address) onto the Trinity
 * project without placing an order.
 */
router.post('/files/:appId/orders/:orderId/sync-project', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const r = await order.syncProject(req.appId, o.id, { staffId: req.actor.id });
    if (r.error) return res.status(502).json(r);
    res.json(r);
  } catch (e) { next(e); }
});

/** Trinity's invoice for this order — what the inspection cost us. Staff-only. */
router.get('/files/:appId/orders/:orderId/invoice', fileScope, async (req, res, next) => {
  try {
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const m = (await db.query(
      `SELECT storage_ref, storage_provider, content_type, file_name FROM trinity_order_media
        WHERE trinity_inspection_order_id=$1 AND kind='invoice' AND storage_ref IS NOT NULL
        ORDER BY archived_at DESC NULLS LAST LIMIT 1`, [o.id])).rows[0];
    if (!m) return bad(res, 404, 'Trinity has not issued the invoice for this inspection yet.');
    const storage = require('../lib/storage');
    const buf = await storage.forRow(m).read(m.storage_ref);
    res.setHeader('Content-Type', m.content_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(m.file_name || 'trinity-invoice.pdf').replace(/[^\w.\-]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

/** Ask Trinity to cancel. Their cancel is a REQUEST — we record that we asked. */
router.post('/files/:appId/orders/:orderId/cancel', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    if (!o.trinity_order_id) return bad(res, 409, 'This inspection has not been ordered from Trinity yet.');
    if (!client.outboundEnabled() && !client.dryrun()) return bad(res, 409, 'Trinity writing is switched off.');
    await client.requestCancel(o.trinity_order_id, {
      firstName: 'Draw', lastName: 'Coordinator', emailAddress: 'draws@yscapgroup.com',
    });
    await db.query(
      `UPDATE trinity_inspection_orders SET cancel_requested_at=now(), updated_at=now() WHERE id=$1`, [o.id]);
    // Trinity's cancel does not take effect immediately (verified), so we say so rather
    // than showing a state the file is not actually in.
    res.json({ ok: true, message: 'Trinity has been asked to cancel this inspection. It stays open until they confirm it.' });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// messaging the Trinity team
// ---------------------------------------------------------------------------
router.post('/files/:appId/orders/:orderId/comments', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    if (!o.trinity_order_id) return bad(res, 409, 'This inspection has not been ordered from Trinity yet.');
    const content = String((req.body && req.body.content) || '').trim();
    if (!content) return bad(res, 400, 'Write a message first.');
    if (content.length > 2790) return bad(res, 400, 'That message is too long — Trinity accepts up to 2,790 characters.');
    if (!client.outboundEnabled() && !client.dryrun()) return bad(res, 409, 'Trinity writing is switched off.');
    const r = await order.postComment(req.appId, o.id, o.trinity_order_id, content, {
      staffId: req.actor.id,
      important: !!(req.body && req.body.important),
      authorName: req.actor.full_name || 'PILOT',
    });
    res.json(r);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------
/** Our branded PILOT report, built from Trinity's results. */
router.get('/files/:appId/orders/:orderId/report', fileScope, async (req, res, next) => {
  try {
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const mode = String(req.query.mode || 'staff') === 'borrower' ? 'borrower' : 'staff';
    const bytes = await report.buildBytes(req.appId, o.id, { mode });
    if (!bytes) return bad(res, 404, 'There is nothing to report on this inspection yet.');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="pilot-inspection-report.pdf"`);
    res.send(bytes);
  } catch (e) { next(e); }
});

/** Trinity's own report PDF, as they produced it (staff-only). */
router.get('/files/:appId/orders/:orderId/trinity-report', fileScope, async (req, res, next) => {
  try {
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    const m = (await db.query(
      `SELECT storage_ref, storage_provider, content_type, file_name FROM trinity_order_media
        WHERE trinity_inspection_order_id=$1 AND kind='report' AND storage_ref IS NOT NULL
        ORDER BY archived_at DESC NULLS LAST LIMIT 1`, [o.id])).rows[0];
    if (!m) return bad(res, 404, 'The Trinity report has not come back yet.');
    const storage = require('../lib/storage');
    const buf = await storage.forRow(m).read(m.storage_ref);
    res.setHeader('Content-Type', m.content_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(m.file_name || 'trinity-report.pdf').replace(/[^\w.\-]/g, '_')}"`);
    res.send(buf);
  } catch (e) { next(e); }
});

/** An inspection photo, streamed from our own storage (never a Trinity URL — they expire). */
router.get('/files/:appId/photos/:mediaId', fileScope, async (req, res, next) => {
  try {
    const m = (await db.query(
      `SELECT storage_ref, storage_provider, content_type, file_name FROM trinity_order_media
        WHERE id=$1 AND application_id=$2 AND kind='photo' AND storage_ref IS NOT NULL`,
      [req.params.mediaId, req.appId])).rows[0];
    if (!m) return bad(res, 404, 'photo not found');
    const ct = String(m.content_type || '');
    // Only ever serve what a browser can safely render inline.
    if (!/^image\//i.test(ct)) return bad(res, 415, 'unsupported media type');
    const storage = require('../lib/storage');
    const buf = await storage.forRow(m).read(m.storage_ref);
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// THE MANUAL STEP — deliver the findings to the borrower
// ---------------------------------------------------------------------------
/**
 * What the coordinator is about to send: Trinity's per-line numbers, mapped onto the
 * draw request's own lines and capped at what was requested.
 */
router.get('/files/:appId/orders/:orderId/decision', fileScope, async (req, res, next) => {
  try {
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    if (!o.portal_draw_request_id) return bad(res, 409, 'This inspection is not tied to a portal draw request.');
    const pr = (await db.query(
      `SELECT id, status, lines, total_requested_cents FROM portal_draw_requests WHERE id=$1 AND application_id=$2`,
      [o.portal_draw_request_id, req.appId])).rows[0];
    if (!pr) return bad(res, 404, 'The draw request was not found.');
    const lines = (await db.query(
      `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [o.id])).rows;
    const entries = mapper.toApprovalEntries(lines, Array.isArray(pr.lines) ? pr.lines : []);
    res.json({
      request: pr,
      order: o,
      trinity_lines: lines,
      entries,
      ready: !!o.results_read_at && !o.blocked_reason,
      blocked_reason: o.blocked_reason || null,
      // Said out loud on the surface that could otherwise be mistaken for an autopilot.
      note: 'Nothing has been sent to the borrower. Review these figures, then deliver them.',
    });
  } catch (e) { next(e); }
});

/**
 * Deliver the findings. THIS is the manual step, and it is the only thing on this route
 * that reaches a borrower. The figures default to Trinity's, and the coordinator may
 * override any line before sending.
 */
router.post('/files/:appId/orders/:orderId/deliver', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const o = await loadOrder(req.appId, req.params.orderId);
    if (!o) return bad(res, 404, 'That inspection order was not found on this file.');
    if (!o.portal_draw_request_id) return bad(res, 409, 'This inspection is not tied to a portal draw request.');
    if (o.blocked_reason) return bad(res, 422, o.blocked_reason);

    const pr = (await db.query(
      `SELECT id, lines FROM portal_draw_requests WHERE id=$1 AND application_id=$2`,
      [o.portal_draw_request_id, req.appId])).rows[0];
    if (!pr) return bad(res, 404, 'The draw request was not found.');

    let entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : null;
    if (!entries) {
      const lines = (await db.query(
        `SELECT * FROM trinity_order_lines WHERE trinity_inspection_order_id=$1 ORDER BY id`, [o.id])).rows;
      entries = mapper.toApprovalEntries(lines, Array.isArray(pr.lines) ? pr.lines : []);
    }
    if (!entries.length) return bad(res, 422, 'There are no approved amounts to deliver yet.');

    // Build our branded report first, so the borrower's notification and the document
    // land together rather than the email arriving before the report exists.
    await report.buildAndStore(req.appId, o.id, { mode: 'staff' }).catch(() => {});
    await report.buildAndStore(req.appId, o.id, { mode: 'borrower' }).catch(() => {});

    // The EXISTING delivery machinery — same borrower experience, same accept/dispute,
    // same close-out. Only the inspector is different.
    const portalDraws = require('../lib/portal-draws');
    const out = await portalDraws.approveTrinityRequest(req.appId, pr.id, entries, { staffId: req.actor.id });
    await db.query(
      `UPDATE trinity_inspection_orders SET status='entered', updated_at=now() WHERE id=$1`, [o.id]).catch(() => {});
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.status) return bad(res, e.status, e.message);
    next(e);
  }
});

// ---------------------------------------------------------------------------
// admin: connection check + webhook registration
// ---------------------------------------------------------------------------
router.get('/status', async (req, res, next) => {
  try {
    if (!can(req, 'platform_setup')) return bad(res, 403, 'Admins only.');
    const out = {
      configured: client.available(),
      enabled: client.enabled(),
      outbound: client.outboundEnabled(),
      dryrun: client.dryrun(),
      baseUrl: cfg.trinity && cfg.trinity.baseUrl,
      formId: client.formId(),
    };
    if (client.available()) {
      try { out.ping = await client.ping(); } catch (e) { out.ping = { error: String(e && e.message).slice(0, 200) }; }
      try { out.forms = await client.forms(); } catch (_) { /* best-effort */ }
      try { out.subscriptions = await client.subscriptions(); } catch (_) { /* best-effort */ }
    }
    res.json(out);
  } catch (e) { next(e); }
});

/** Register (or re-register) our webhook endpoint with Trinity. */
router.post('/subscribe', async (req, res, next) => {
  try {
    if (!can(req, 'platform_setup')) return bad(res, 403, 'Admins only.');
    const token = cfg.trinity && cfg.trinity.webhookToken;
    if (!token) return bad(res, 409, 'Set TRINITY_WEBHOOK_TOKEN first — the receiver refuses everything without it.');
    const appUrl = String(cfg.appUrl || '').replace(/\/+$/, '');
    if (!appUrl) return bad(res, 409, 'APP_URL is not set, so there is no address to give Trinity.');
    const url = `${appUrl}/api/public/trinity-webhook/${encodeURIComponent(token)}`;
    const r = await client.subscribe(url, ['All']);
    res.json({ ok: true, subscription: r });
  } catch (e) { next(e); }
});

module.exports = router;
