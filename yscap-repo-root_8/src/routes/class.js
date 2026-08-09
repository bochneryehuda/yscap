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
const { assigneeExistsSql } = require('../lib/permissions');
const { can } = require('../lib/permissions');
const client = require('../class/client');
const orderService = require('../class/order-service');
const orderBuild = require('../class/order-build');
const callbacks = require('../class/callbacks');
const messages = require('../class/messages');
const revisionReasons = require('../class/revision-reasons');

router.use(requireAuth, requireStaff);

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

// Only the keys the preview is allowed to override, so a crafted request cannot
// smuggle an arbitrary field into the vendor body.
const OVERRIDE_KEYS = new Set([
  'apiVersion',
  'productId', 'propertyTypeEnum', 'purpose', 'loanType', 'occupancy',
  'referenceNumber', 'street', 'city', 'state', 'zip', 'dueDate', 'instructions',
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
router.get('/products', async (req, res) => {
  if (!client.configured().enabled) return res.json({ available: false, products: [] });
  try {
    const r = await client.products({ limit: req.query.limit || 200 });
    res.json({ available: true, products: (r && r.products) || [] });
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
                                 product_id, product_title, request_body, dryrun, status, placed_by, placed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'placing',$10, now()) RETURNING id`,
      [appId, preview.body.referenceNumber || null, preview.apiVersion, preview.uad, preview.path,
       preview.body.productId != null ? String(preview.body.productId) : null,
       // The form's NAME as it was at the moment of ordering. Stored rather than
       // looked up later on purpose: their catalogue can be renamed or retired, and
       // an order must always be able to say which report it actually bought.
       preview.productTitle || null,
       require('../lib/fields').jsonbText(preview.body), !!cfgd.dryrun, req.actor.id]);
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
    await db.query(
      `UPDATE class_orders SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [orderRowId, ...cols.map((c) => patch[c])]).catch(() => {});
  };

  try {
    // THE PATH COMES FROM THE PREVIEW, not from the config: the preview is what
    // shaped this body, so posting it anywhere else would send a 2.6 body to the 3.6
    // endpoint or the reverse. Those two disagree about field names, so the failure
    // would be a rejected order at best and a silently dropped field at worst.
    const out = await client.createOrder(preview.body, {
      OrgId: (require('../config').class || {}).orgId || undefined,
      LenderOrgId: (require('../config').class || {}).lenderOrgId || undefined,
    }, { path: preview.path });
    if (out && out.__dryrun) {
      await finish({ status: 'dryrun' });
      return res.json({ ok: true, dryrun: true, apiVersion: preview.apiVersion, uad: preview.uad,
        message: `TEST MODE — a UAD ${preview.uad} order was built and logged, nothing was sent.`, body: preview.body });
    }
    await finish({
      status: 'ordered',
      class_order_id: out && out.orderId != null ? String(out.orderId) : null,
      transaction_id: out && out.transactionId != null ? String(out.transactionId) : null,
    });
    res.json({
      ok: true, orderId: out && out.orderId, transactionId: out && out.transactionId,
      apiVersion: preview.apiVersion, uad: preview.uad, body: preview.body,
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
    await finish({ status: 'error', last_error: String((e && e.message) || e).slice(0, 500) });
    if (e.code === 'CLASS_OUTBOUND_DISABLED') {
      return res.status(409).json({ error: e.code, message: 'Placing orders with Class Valuation is switched off.' });
    }
    // The vendor's own body is NOT relayed. `client.request` deliberately preserves a
    // non-JSON error body so an operator can tell "your firewall blocked this" from
    // "your secret is wrong" — but that body is an EGRESS PROXY's or Class's, and it
    // has carried an internal hostname, a service-account name and a vendor stack
    // trace. Those belong in the server log, which is where they go; the browser gets
    // our own sentence, the same discipline /products already follows.
    console.warn('[class] order failed:', e && e.message, e && e.body ? JSON.stringify(e.body).slice(0, 500) : '');
    res.status(502).json({ error: e.code || 'order_failed', detail: e.message });
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
            dryrun, last_event_at, last_error, placed_at, created_at
       FROM class_orders WHERE application_id = $1
      ORDER BY created_at DESC`, [appId]);
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
    `SELECT id, class_order_row, name, content_type, document_id, announced_at, fetched_at
       FROM class_attachments WHERE class_order_row = ANY($1::bigint[])
      ORDER BY announced_at DESC`, [ids])).rows : [];
  res.json({ orders: r.rows, events, attachments, unread, openAsks });
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
//
// AND IT DOES NOT TRIM. `String.trim()` and Postgres disagree about what whitespace
// is — JavaScript strips a non-breaking space, U+2028 and a byte-order mark, Postgres
// strips none of them — so trimming first meant the value that PASSED the check was
// not the value that reached the bind. There is exactly one spelling of an order id
// here: digits, nothing around them. Anything else is not an order of ours.
const MAX_BIGINT = 9223372036854775807n;
function bigintId(v) {
  const s = String(v == null ? '' : v);
  if (!/^[0-9]{1,19}$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n && n <= MAX_BIGINT ? s : null;
}

// Returns the SANITIZED id when the order is on this file, else null. It returns the
// id rather than a boolean on purpose: every handler below then passes THAT value
// downstream instead of the raw `req.params.orderRowId`, so the check and the query
// can never be looking at two different strings. They already could — JavaScript's
// `trim()` removes a non-breaking space and Postgres does not, so `%C2%A049` passed
// this gate and then reached a bigint bind as a distinct value. Nothing could be
// read across files (this gate still governs that), but the resulting 22P02 was
// answered by the server's global error mapper rather than by the check written to
// answer it — a guarantee resting on a catch-all is a guarantee waiting to move.
async function orderOnFile(appId, orderRowId) {
  const id = bigintId(orderRowId);
  if (!id) return null;
  const r = await db.query('SELECT id FROM class_orders WHERE id = $1 AND application_id = $2',
    [id, appId]);
  return r.rowCount > 0 ? id : null;
}

// The status for a refused vendor action. `not_accepted_yet` is a state of OUR file —
// Class has not numbered the order yet — so answering 502 blames an upstream that is
// perfectly healthy, and reads that way in the logs too.
function vendorFailStatus(out) {
  if (out && (out.error === 'bad_reasons' || out.error === 'empty')) return 400;
  if (out && out.error === 'not_accepted_yet') return 409;
  return 502;
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
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  res.json(await messages.thread(rowId));
});

// Pull THEIR side of the thread on demand. A read — master switch only.
router.post('/files/:id/orders/:orderRowId/thread/sync', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  const out = await messages.syncNotes(rowId);
  res.status(out.ok ? 200 : vendorFailStatus(out)).json(out);
});

router.post('/files/:id/orders/:orderRowId/notes', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  const out = await messages.note(rowId, (req.body || {}).content, { staffId: req.actor.id });
  // A send failure is NOT a lost message — the note is stored either way — so the
  // status says "we could not deliver it", never "it did not happen".
  res.status(out.ok ? 200 : vendorFailStatus(out)).json(out);
});

router.post('/files/:id/orders/:orderRowId/read', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  res.json(await messages.markRead(rowId));
});

// A REVISION or a RECONSIDERATION OF VALUE. One route, because it is one call at
// Class; `kind` decides which reasons are sensible and how it is recorded.
router.post('/files/:id/orders/:orderRowId/revision', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const out = await messages.requestRevision(rowId, {
    kind: b.kind === 'rov' ? 'rov' : 'revision',
    reasons: b.reasons,
    note: b.note,
    supporting: b.supporting,
    staffId: req.actor.id,
  });
  res.status(out.ok ? 200 : vendorFailStatus(out)).json(out);
});

router.post('/files/:id/orders/:orderRowId/cancel', async (req, res) => {
  const appId = req.params.id;
  if (!(await canSeeFile(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const rowId = await orderOnFile(appId, req.params.orderRowId);
  if (!rowId) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  // Cancelling costs real work at their end and cannot be taken back from here, so
  // it needs the same explicit confirmation placing the order does.
  if (b.confirm !== true) {
    return res.status(400).json({ error: 'confirm_required', message: 'Cancelling an order needs an explicit confirmation.' });
  }
  const out = await messages.requestCancel(rowId, {
    reasons: b.reasons, note: b.note, staffId: req.actor.id });
  res.status(out.ok ? 200 : vendorFailStatus(out)).json(out);
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
    console.warn('[class] callback registration failed:', e && e.message, e && e.body ? JSON.stringify(e.body).slice(0, 500) : '');
    res.status(502).json({ error: e.code || 'register_failed', detail: e.message });
  }
});

module.exports = router;
