'use strict';
/**
 * AMC order revisions — general revision requests, ROV (reconsideration of value)
 * disputes, and scope-of-work-change requests.
 *
 * AppraisalScope has NO dedicated ROV or SOW-change action, so all three ride the
 * one CDG AddRevision primitive; the KIND (revision | rov | sow_change | other) and
 * the structured detail (an ROV's disputed values + supporting comps) live in
 * amc_order_revisions, so PILOT owns the workflow and the audit trail. Inbound status
 * is polled with GetRevisions and deduped on the AMC's revision id.
 *
 * Network is injectable (deps.transport / deps.authContext) for offline testing;
 * outbound goes through the gated transport (AMC_OUTBOUND_ENABLED).
 */
const db = require('../db');
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const { journal } = require('./order-service');

/**
 * WHAT THE PERSON AT THE DESK IS TOLD WHEN A SEND FAILS.
 *
 * The exception's own text is written for US — "AMC CreateAppraisal -> 502",
 * "AMC_OUTBOUND_DISABLED: refusing CreateAppraisal — writes are gated off", "fetch
 * failed", a raw vendor description. Returned as `message` it is relayed by the route
 * and rendered verbatim in the desk's banner, where a non-developer learns nothing from
 * it and cannot act on it. The two cases a person CAN act on are told apart, and the
 * detail goes to the log.
 */
// THE VENDOR'S OWN REFUSAL IS WORTH SHOWING — "Loan number already exists" tells the
// person exactly what to do, unlike a transport error — but it is THEIR text, so it is
// bounded and framed rather than pasted raw, and a bare numeric code (which says nothing
// to anybody) is replaced by plain words.
function nackMessage(err, what) {
  const d = err && err.description != null ? String(err.description).trim() : '';
  if (!d) return 'The appraisal company would not accept ' + what + '.';
  return 'The appraisal company would not accept ' + what + ': ' + d.slice(0, 300);
}

function sendFailMessage(e, what) {
  if (e && e.code === 'AMC_OUTBOUND_DISABLED') {
    return 'Sending to the appraisal company is switched off, so ' + what + ' was not sent.';
  }
  return 'Could not reach the appraisal company, so ' + what + ' was not sent. '
    + 'Please try again in a moment.';
}


const KINDS = ['revision', 'rov', 'sow_change', 'other'];
function normKind(k) { return KINDS.includes(k) ? k : 'revision'; }

async function insertRevision(dbh, orderId, { kind, body, amcRevisionId, status, rovDetail, staffId }) {
  const r = await dbh.query(
    `INSERT INTO amc_order_revisions (order_id, kind, amc_revision_id, body, status, rov_detail, created_by, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $5 IN ('submitted','acknowledged','in_review') THEN now() ELSE NULL END)
     RETURNING *`,
    [orderId, normKind(kind), amcRevisionId || null, body, status || 'draft',
     rovDetail ? JSON.stringify(rovDetail) : null, staffId || null]);
  return r.rows[0];
}

// Send a revision / ROV / SOW-change to the AMC (AddRevision). Records the row and
// journals the write. Never throws for an expected refusal.
async function postRevision(dbh, order, { staffId, kind, body, rovDetail }, deps = {}) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'empty', message: 'Say what needs changing before sending it.' };
  const transport = deps.transport || client;
  const dryrun = deps.dryrun != null ? !!deps.dryrun : !!client.configured().dryrun;
  let authCtx;
  try {
    // TEST MODE MUST NOT NEED A LOGIN, and a login that fails is answered in plain
    // words rather than thrown at the route's catch-all — which reported it as the
    // server's generic "Something went wrong on our end".
    authCtx = deps.authContext || (await session.authContext(dryrun ? { offline: true } : undefined));
  } catch (e) {
    return { ok: false, error: 'not_connected', message: session.signInMessage(e) };
  }
  const built = cdg.buildAddRevision({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, text,
  });
  let resp;
  try {
    resp = await transport.write(built, { orderId: order.cdg_order_number || undefined, label: 'AddRevision', dryrun });
  } catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddRevision', request: built, ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: sendFailMessage(e, 'the request') };
  }
  if (resp && resp.__dryrun) {
    const row = await insertRevision(dbh, order.id, { kind, body: text, amcRevisionId: null, status: 'submitted', rovDetail, staffId });
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddRevision', request: built, response: { dryrun: true }, ok: true, staffId });
    return { ok: true, dryrun: true, revision: row };
  }
  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddRevision', request: built, response: resp, ok: false, error: err.description || err.code, staffId });
    return { ok: false, error: 'amc_nack', message: nackMessage(err, 'the request') };
  }
  const ack = cdg.parseRevisionAck(resp);
  const row = await insertRevision(dbh, order.id, { kind, body: text, amcRevisionId: ack.amcRevisionId, status: 'submitted', rovDetail, staffId });
  await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddRevision', request: built, response: resp, ok: true, staffId });
  return { ok: true, revision: row };
}

// Poll the AMC's revisions for an order. Deduped on the AMC revision id: a revision
// we already have is left as-is (it may carry richer local kind/detail); an unknown
// one is filed as an inbound-originated row. Returns { ok, added }.
async function syncRevisions(dbh, order, deps = {}) {
  const transport = deps.transport || client;
  // A READ IS NEVER A DRY RUN, so it needs a REAL api key. The dry-run gate in the
  // transport applies to WRITES only (`client.read` passes `write:false`), so building
  // this with the offline, key-less context would not stop it — it would post an
  // UNAUTHENTICATED request to the vendor, get NACKed -100, and `session.invalidate()`
  // below would then throw away the good key the poller had just obtained: a forced
  // sign-in per order per tick, and the vendor's replies never filed, for as long as
  // test mode was on. Reading is free and harmless; it signs in properly.
  const authCtx = deps.authContext || (await session.authContext());
  const resp = await transport.read(cdg.buildGetRevisions({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number,
  }), { label: 'GetRevisions' });
  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    // `err` is the vendor's own error OBJECT — the panel renders `message`, and an
    // object reaches the screen as [object Object] or as nothing at all.
    return { ok: false, error: 'amc_nack', message: nackMessage(err, 'a request for the requests'), nack: err };
  }
  const revs = cdg.parseRevisions(resp);
  let added = 0;
  for (const rv of revs) {
    if (!rv.amcRevisionId) continue;
    const seen = await dbh.query(`SELECT 1 FROM amc_order_revisions WHERE order_id=$1 AND amc_revision_id=$2`, [order.id, rv.amcRevisionId]);
    if (seen.rowCount) continue;
    await insertRevision(dbh, order.id, { kind: 'other', body: '(revision seen at the AMC)', amcRevisionId: rv.amcRevisionId, status: 'acknowledged', rovDetail: rv.raw ? { raw: rv.raw } : null });
    added += 1;
  }
  return { ok: true, added };
}

async function listRevisions(dbh, orderId) {
  const r = await dbh.query(
    `SELECT id, kind, amc_revision_id, body, status, rov_detail, created_by, submitted_at, resolved_at, created_at
       FROM amc_order_revisions WHERE order_id=$1 ORDER BY created_at ASC, id ASC`, [orderId]);
  return r.rows;
}

module.exports = { KINDS, normKind, postRevision, syncRevisions, listRevisions, insertRevision };
