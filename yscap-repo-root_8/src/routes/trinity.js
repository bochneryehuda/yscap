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
const { requireAuth, requireStaff } = require('../auth');
const perms = require('../lib/permissions');
const client = require('../trinity/client');
const order = require('../trinity/order');
const ingest = require('../trinity/ingest');
const intake = require('../trinity/intake');
const report = require('../trinity/report');
const mapper = require('../trinity/mapper');

// BOTH, in this order, exactly as /api/sitewire and /api/trustpoint mount their walls.
// `requireAuth` IS `authenticate` — it is what reads the bearer token and puts `req.actor`
// on the request; there is no global authenticate in server.js, so a router that mounts
// only `requireStaff` is asking about an actor nobody ever resolved. This shipped with
// `requireStaff` alone, which meant `req.actor` was ALWAYS undefined and every single
// route on the Trinity desk answered 403 "staff only" — to everyone, for every file,
// forever. The whole desk was unreachable from the portal and nothing noticed, because
// every test called the modules directly and never once went through Express.
// Guarded by scripts/test-trinity-desk-route-db.js, which is the first thing here to
// speak HTTP.
router.use(requireAuth, requireStaff);

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

/**
 * Why this inspection's findings cannot be delivered from here yet.
 *
 * THE TWO DOORS DO NOT END IN THE SAME PLACE, and until 2026-08-16 only one of them
 * ended anywhere at all. A PORTAL draw request carries its own decision record, so
 * `portal-draws.approveTrinityRequest` can record the approved amounts and tell the
 * borrower. A draw the borrower submitted IN SITEWIRE has no portal request — the draw
 * itself lives in Sitewire — so there is nothing here for that function to approve, and
 * delivering it means putting the inspector's figures onto the SITEWIRE draw, which is
 * the money write-back and a servicing decision that has not been made yet.
 *
 * So this says so plainly, on the surface where somebody is standing waiting to press a
 * button, instead of the old bare "not tied to a portal draw request" — which named an
 * internal record the reader has no way to create and gave them nothing to do. The
 * inspection itself is complete and nothing is lost: the report, the photos and the
 * per-line figures are all on the file, and the draw is approved on the draw desk in
 * Sitewire exactly as it is today.
 */
function deliveryBlockedMessage(o) {
  return 'This inspection is not tied to a draw request — there is nothing here to deliver. '
    + 'The report, the photos and the per-line figures are all on the file.';
}

/**
 * The per-line DECISION endpoint is the PORTAL door's own screen — it edits the approved
 * amounts on a `portal_draw_requests` row before they are recorded. A draw the borrower
 * submitted in Sitewire has no such row: its amounts live on the Sitewire draw's own
 * request lines, and they are edited on the draw desk like every other Sitewire draw.
 * Saying that is the difference between a refusal somebody can act on and one that names
 * an internal record they have no way to create.
 */
function decisionUnavailableMessage(o) {
  if (o.sitewire_draw_id) {
    return 'This draw was submitted in Sitewire, so its amounts are reviewed on the draw desk. '
      + 'Deliver sends Trinity’s figures there for the borrower to accept or dispute.';
  }
  return deliveryBlockedMessage(o);
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
      // The progress timeline. Trinity has NO history endpoint (verified — /history,
      // /events, /statuses and /status all 404), so this table is the only place the
      // sequence exists: ordered → scheduled → inspected → report back, in their own
      // words, with the time each step actually happened.
      const timeline = (await db.query(
        `SELECT id, state, trinity_status, trinity_substatus, kind, detail,
                percent_complete, source, occurred_at
           FROM trinity_order_events WHERE trinity_inspection_order_id=$1
          ORDER BY occurred_at ASC, id ASC LIMIT 200`, [o.id])).rows;
      out.push({
        ...o,
        timeline,
        // Where this inspection's findings get delivered — said UP FRONT, so nobody
        // works an order to completion and only then discovers the button refuses.
        // HOW this one reaches the borrower. Both doors end in the same borrower
        // experience — accept or dispute — but a Sitewire-submitted draw gets there by
        // writing Trinity's figures onto the draw first, so the desk says so plainly.
        delivery: o.portal_draw_request_id
          ? { here: true, via: 'portal_request' }
          : (o.sitewire_draw_id
            ? { here: true, via: 'sitewire_draw',
                note: 'Delivering writes Trinity’s figures onto the Sitewire draw, then sends the borrower the findings to accept or dispute — exactly as a virtual inspection does. Nothing is released.' }
            : { here: false, via: 'unknown', reason: deliveryBlockedMessage(o) }),
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
    // What the desk may ORDER an inspection against right now — computed even when there
    // are no orders yet, because that is exactly the state the manual button exists for.
    // Best-effort: a routing read that fails must never take the whole desk down with it,
    // and an unknown routing is not permission to order (it reports ineligible).
    const orderable = await intake.orderOptions(req.appId)
      .catch(() => ({ eligible: false, reason: 'the file routing could not be read', draws: [], requests: [] }));

    res.json({
      orders: out,
      orderable,
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
/**
 * ORDER AN INSPECTION BY HAND — the owner's *"we should also have the option to order it
 * on our end in the draw center"* (2026-08-16).
 *
 * The automatic doors mint an order record as a side effect of a borrower submitting a
 * draw. This one mints it on purpose, against a draw the coordinator picks, and then
 * hands it to the SAME `placeOrder` — so everything that travels on an automatic order
 * travels here: the construction budget as Trinity's own line items, how much has
 * already been drawn on each line, the readable budget-and-draws spreadsheet, the
 * appraisal, the scope of work and the most recent previous inspection report.
 *
 * It is deliberately NOT a "create anything" endpoint. It refuses a file whose
 * inspections are not Trinity's, refuses a draw that is not on this file, and adopts an
 * existing record rather than ever minting a second one for the same draw.
 */
router.post('/files/:appId/orders', fileScope, async (req, res, next) => {
  try {
    if (!can(req, 'manage_draws')) return bad(res, 403, 'You do not have permission to manage draws.');
    const b = req.body || {};
    const r = await intake.orderManually(req.appId, {
      sitewireDrawId: b.sitewireDrawId != null ? b.sitewireDrawId : (b.sitewire_draw_id != null ? b.sitewire_draw_id : null),
      portalRequestId: b.portalRequestId != null ? b.portalRequestId : (b.portal_request_id != null ? b.portal_request_id : null),
      staffId: req.actor.id,
    });
    if (r.blocked) return res.status(422).json(r);
    if (r.error) return res.status(502).json(r);
    // A SKIP IS NOT A SUCCESS. `placeOrder` stands down with `{skipped:'off'|'outbound_off'
    // |'not_configured'|'in_flight'|…}` and NO error — which is right for the pollers that
    // call it, and wrong to hand back to somebody who just pressed a button: the screen
    // would say "Ordered from Trinity" about an order that was never sent. `already` is the
    // one skip that IS a success (the order exists), and it carries `ok`.
    if (r.skipped && !r.already) {
      return res.status(409).json({
        error: r.message || 'The inspection could not be ordered just now.',
        skipped: r.skipped,
      });
    }
    res.json(r);
  } catch (e) { next(e); }
});

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
    if (!o.portal_draw_request_id) return bad(res, 409, decisionUnavailableMessage(o));
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
    if (o.blocked_reason) return bad(res, 422, o.blocked_reason);

    // ---- THE SITEWIRE DOOR: same borrower workflow, different inspector ----------
    //
    // Owner-directed 2026-08-16: *"we still need to follow the workflow of getting
    // borrower approval that he agrees with the findings and he doesn't want to push
    // back. Follow everything like it was in the beginning."*
    //
    // So a draw the borrower submitted IN SITEWIRE is delivered by the EXACT machinery a
    // virtual draw uses — `deliver-findings.deliverFindings`, the same function the draw
    // desk's own button calls. Two steps, in this order and only this order:
    //   1. put Trinity's per-line figures onto the Sitewire draw, because that is where
    //      `persistDrawFindings` reads the inspector's numbers from;
    //   2. deliver, which builds the borrower's accept/dispute findings, the reply token,
    //      the branded report and the email — all of it already built, none of it copied.
    // Nothing is released: the borrower accepts or disputes, and the coordinator approves
    // on the draw desk exactly as today.
    if (!o.portal_draw_request_id) {
      if (!o.sitewire_draw_id) return bad(res, 409, deliveryBlockedMessage(o));
      if (!o.results_read_at) return bad(res, 422, 'Trinity’s figures have not been read back yet — refresh the inspection first.');

      const trinLines = (await db.query(
        `SELECT sitewire_job_item_id, approved_cents, name FROM trinity_order_lines
          WHERE trinity_inspection_order_id=$1 AND approved_cents IS NOT NULL`, [o.id])).rows;
      const wb = await require('../trinity/writeback').pushApprovalsToSitewire(req.appId, o,
        trinLines.map((l) => ({
          sitewire_job_item_id: l.sitewire_job_item_id, approved_cents: Number(l.approved_cents), name: l.name,
        })));
      // A failed write-back STOPS the delivery: findings built from numbers Sitewire does
      // not hold would show the borrower the wrong figures.
      if (wb.error) {
        return res.status(502).json({
          error: 'Trinity’s figures could not be written onto the Sitewire draw, so nothing was sent to the borrower. It has been parked for review.',
          writeback: wb,
        });
      }

      // AND SO DOES A WRITE-BACK THAT SIMPLY DID NOT HAPPEN — which is the failure mode
      // that does not announce itself. `pushApprovalsToSitewire` reports several outcomes
      // that are NOT errors and yet mean the figures are not on the draw: nothing tied to
      // this file's job items, no approved amounts to write, a switch turned off, a dry
      // run that deliberately sent nothing. Treating "no error" as "go ahead" would then
      // deliver findings built from a draw still holding NULL approvals — which
      // `fetchDrawFindings` reads as "the inspector has not answered", so the borrower
      // would be shown an accept page saying exactly that about an inspection that is
      // finished. Only two outcomes may proceed: we wrote the figures just now, or a
      // previous run already did and nothing has changed since.
      //
      // NOTE `wb.written > 0` — `ok` ALONE IS NOT ENOUGH, and this is the case the test
      // caught rather than the one that was designed for. A run whose every line names a
      // job item that is not on this draw returns a perfectly successful `{ok:true,
      // written:0}` with each line reported under `skipped`, because refusing outright
      // would be wrong when SOME lines land. At the delivery gate, though, nothing landing
      // is indistinguishable from the switch being off, so it must be refused the same way.
      const landed = (wb.ok && !wb.dryrun && (wb.written || 0) > 0) || wb.skipped === 'already_written';
      if (!landed) {
        const unmatched = wb.ok || wb.skipped === 'no_lines_tied_to_this_file' || wb.skipped === 'no_results';
        const why = wb.dryrun
          ? 'Sitewire writing is in test mode, so the figures were built but not sent.'
          : wb.skipped === 'sitewire_off' || wb.skipped === 'sitewire_writes_off'
            ? 'Sitewire writing is switched off, so the figures could not be put on the draw.'
            : unmatched
              ? 'None of Trinity’s lines could be matched to this draw’s own budget lines, so there is nothing to put on it.'
              : 'The figures could not be put on the Sitewire draw.';
        return bad(res, 422, `${why} Nothing has been sent to the borrower.`);
      }

      const out = await require('../sitewire/deliver-findings')
        .deliverFindings(req.appId, Number(o.sitewire_draw_id), { source: 'trinity' });
      await db.query(
        `UPDATE trinity_inspection_orders SET status='entered', updated_at=now() WHERE id=$1`, [o.id]).catch(() => {});
      await order.recordEvent(req.appId, o.id, {
        kind: 'delivered', state: 'entered', source: 'staff', staffId: req.actor.id,
        detail: `${req.actor.full_name || 'A coordinator'} delivered Trinity’s findings to the borrower on Sitewire draw ${o.sitewire_draw_id} `
          + `(${wb.written || 0} line${wb.written === 1 ? '' : 's'} written). The borrower now accepts or disputes as usual.`,
      }).catch(() => {});
      return res.json({ ok: true, via: 'sitewire_draw', writeback: wb, ...out });
    }

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
    // The last step of the timeline, and the only one a human performs: this is the
    // record of WHO decided to send the findings to the borrower, and when. There is no
    // autopilot on this program, so without this entry the file could never answer it.
    const total = entries.reduce((s, e) => s + Math.round(Number(e.approved_cents) || 0), 0);
    await order.recordEvent(req.appId, o.id, {
      kind: 'delivered', state: 'entered', source: 'staff', staffId: req.actor.id,
      detail: `${req.actor.full_name || 'A coordinator'} delivered the findings to the borrower — `
        + `$${(total / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} approved across `
        + `${entries.length} line${entries.length === 1 ? '' : 's'}.`,
    }).catch(() => {});
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

      // IS THE FORM WE ORDER ACTUALLY ENABLED ON THIS ACCOUNT?
      //
      // Found live on 2026-08-16, and it is the single thing most likely to stop go-live:
      // the SANDBOX company has form 19 ("Blank General Purpose Line Item Draw"), the
      // PRODUCTION company does not — it has form 1079 ("General Purpose Line Item Draw
      // PCR") instead. Same product, same schema to the field (verified against Trinity's
      // own published spec: identical request model, identical `DollarLineItem`, identical
      // budget read-back), different id. Trinity's own documentation warns of exactly this:
      // *"Not all form types are available to all customers in production."*
      //
      // Without this, the mismatch surfaces as a refused order on the first real draw —
      // after a coordinator has already pressed the button on a live file. Reading it here
      // turns it into a red line on the API Health page BEFORE anything is ordered. It is
      // computed from the forms list we already fetched, so it costs no extra call.
      const want = client.formId();
      const ids = [];
      (function collect(node) {
        if (Array.isArray(node)) return node.forEach(collect);
        if (node && typeof node === 'object') {
          if (Number.isFinite(Number(node.id)) && typeof node.name === 'string') ids.push(Number(node.id));
          Object.values(node).forEach(collect);
        }
      })(out.forms);
      out.formCheck = ids.length
        ? {
          formId: want,
          enabled: ids.includes(Number(want)),
          available: ids,
          message: ids.includes(Number(want))
            ? `Form ${want} is enabled on this account — orders will be accepted.`
            : `Form ${want} is NOT enabled on this Trinity account, so every order would be refused. `
              + `This account offers: ${ids.join(', ')}. Set TRINITY_FORM_ID to the line-item draw form for this account.`,
        }
        : { formId: want, enabled: null, message: 'Could not read the form list, so the form could not be checked.' };
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
