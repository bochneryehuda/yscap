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
  if (!text) return { ok: false, error: 'empty' };
  // A fix/revision or a value dispute (ROV) only makes sense once the report is IN — the
  // vendor rejects one otherwise ("must be in Completed status"). A scope-of-work change
  // is about the order still in progress, so it is deliberately NOT gated. The panel greys
  // the buttons before the report is ready; this is the server backstop.
  const reportIn = order && (order.status === 'completed' || order.status === 'product_available');
  if ((normKind(kind) === 'revision' || normKind(kind) === 'rov') && !reportIn) {
    return { ok: false, error: 'not_ready', notReady: true,
      message: 'The appraisal isn’t back yet, so a fix can’t be requested. You can ask once the report is in.' };
  }
  const transport = deps.transport || client;
  const authCtx = deps.authContext || (await session.authContext());
  const built = cdg.buildAddRevision({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, text,
  });
  let resp;
  try {
    resp = await transport.write(built, { orderId: order.cdg_order_number || undefined, label: 'AddRevision' });
  } catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddRevision', request: built, ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: String(e.message || e) };
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
    return { ok: false, error: 'amc_nack', message: err.description || err.code };
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
  const authCtx = deps.authContext || (await session.authContext());
  const resp = await transport.read(cdg.buildGetRevisions({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number,
  }), { label: 'GetRevisions' });
  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    return { ok: false, error: err };
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
