'use strict';
/**
 * AMC order comment thread — the two-way message channel between PILOT and the AMC.
 *
 * Outbound: a staffer's message rides the CDG AddComment action (an order-specific
 * update, so it hits the order endpoint with ?orderId=<cdg order number>). Inbound:
 * the AMC's replies are POLLED with GetComments and deduped on the AMC's own comment
 * id, so re-polling never double-files. The thread is persisted to amc_order_comments
 * so the whole conversation lives in the file.
 *
 * The network calls are injectable (deps.transport / deps.authContext) so the whole
 * thread is testable offline. Off by default: postComment goes through the gated
 * transport (AMC_OUTBOUND_ENABLED), and syncComments is only reached from the poll
 * worker, which no-ops while AMC_ENABLED is off.
 */
const db = require('../db');
const cdg = require('./cdg');
const client = require('./client');
const session = require('./session');
const { journal } = require('./order-service');

async function insertComment(dbh, orderId, { direction, body, authorName, staffId, amcCommentId, amcDatetime }) {
  const r = await dbh.query(
    `INSERT INTO amc_order_comments (order_id, direction, amc_comment_id, body, author_name, staff_id, amc_datetime)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [orderId, direction, amcCommentId || null, body, authorName || null, staffId || null, amcDatetime || null]);
  return r.rows[0];
}

// Send a message to the AMC on an order (AddComment). Records the outbound comment
// and journals the write. Never throws for an expected refusal.
async function postComment(dbh, order, { staffId, staffName, body }, deps = {}) {
  const text = String(body || '').trim();
  if (!text) return { ok: false, error: 'empty' };
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
  const built = cdg.buildAddComment({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number, text,
  });
  let resp;
  try {
    resp = await transport.write(built, { orderId: order.cdg_order_number || undefined, label: 'AddComment', dryrun });
  } catch (e) {
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddComment', request: built, ok: false, error: String(e.message || e), staffId });
    return { ok: false, error: e.code === 'AMC_OUTBOUND_DISABLED' ? 'outbound_disabled' : 'send_failed', message: String(e.message || e) };
  }
  if (resp && resp.__dryrun) {
    const row = await insertComment(dbh, order.id, { direction: 'outbound', body: text, authorName: staffName, staffId, amcCommentId: null });
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddComment', request: built, response: { dryrun: true }, ok: true, staffId });
    return { ok: true, dryrun: true, comment: row };
  }
  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddComment', request: built, response: resp, ok: false, error: err.description || err.code, staffId });
    return { ok: false, error: 'amc_nack', message: err.description || err.code };
  }
  // The AMC may echo the created comment with its id — capture it when present.
  const echoed = cdg.parseComments(resp);
  const amcId = (echoed[0] && echoed[0].amcCommentId) || null;
  const row = await insertComment(dbh, order.id, { direction: 'outbound', body: text, authorName: staffName, staffId, amcCommentId: amcId });
  await journal(dbh, { orderId: order.id, appId: order.application_id, action: 'AddComment', request: built, response: resp, ok: true, staffId });
  return { ok: true, comment: row };
}

// Pull the AMC's comments for an order and file the new ones. Deduped on the AMC's
// comment id (unique index); a comment with no id falls back to a (body, datetime)
// check so a re-poll never re-files it. Returns { ok, added }.
async function syncComments(dbh, order, deps = {}) {
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
  const resp = await transport.read(cdg.buildGetComments({
    apiKey: authCtx.apiKey, subdomain: order.sp_subdomain || authCtx.subdomain,
    spOrderNumber: order.sp_order_number, clientOrderNumber: order.client_order_number,
  }), { label: 'GetComments' });
  const err = cdg.parseError(resp);
  if (err) {
    if (String(err.code) === '-100' || /authenticat/i.test(err.description || '')) session.invalidate();
    return { ok: false, error: err };
  }
  const comments = cdg.parseComments(resp);
  let added = 0;
  for (const c of comments) {
    if (!c.body && !c.amcCommentId) continue;
    if (c.amcCommentId) {
      const ins = await dbh.query(
        // The unique index is PARTIAL (WHERE amc_comment_id IS NOT NULL), so the
        // ON CONFLICT target must carry the same predicate to be inferred.
        `INSERT INTO amc_order_comments (order_id, direction, amc_comment_id, body, author_name, amc_datetime)
         VALUES ($1,'inbound',$2,$3,$4,$5)
         ON CONFLICT (order_id, amc_comment_id) WHERE amc_comment_id IS NOT NULL DO NOTHING RETURNING id`,
        [order.id, c.amcCommentId, c.body, c.authorName || null, c.amcDatetime || null]);
      if (ins.rowCount) added += 1;
    } else {
      const seen = await dbh.query(
        `SELECT 1 FROM amc_order_comments
          WHERE order_id=$1 AND direction='inbound' AND amc_comment_id IS NULL
            AND body=$2 AND COALESCE(amc_datetime,'')=COALESCE($3,'')`,
        [order.id, c.body, c.amcDatetime || null]);
      if (!seen.rowCount) { await insertComment(dbh, order.id, { direction: 'inbound', body: c.body, authorName: c.authorName, amcDatetime: c.amcDatetime, amcCommentId: null }); added += 1; }
    }
  }
  return { ok: true, added };
}

async function listComments(dbh, orderId) {
  const r = await dbh.query(
    `SELECT id, direction, amc_comment_id, body, author_name, staff_id, amc_datetime, read_at, created_at
       FROM amc_order_comments WHERE order_id=$1 ORDER BY created_at ASC, id ASC`, [orderId]);
  return r.rows;
}

// Mark ONE inbound comment read. Returns true when it flipped (idempotent).
async function markRead(dbh, orderId, commentId) {
  const r = await dbh.query(
    `UPDATE amc_order_comments SET read_at=now()
      WHERE id=$1 AND order_id=$2 AND direction='inbound' AND read_at IS NULL RETURNING id`,
    [commentId, orderId]);
  return r.rowCount > 0;
}

async function unreadCount(dbh, orderId) {
  const r = await dbh.query(
    `SELECT count(*)::int n FROM amc_order_comments WHERE order_id=$1 AND direction='inbound' AND read_at IS NULL`, [orderId]);
  return r.rows[0] ? r.rows[0].n : 0;
}

module.exports = { postComment, syncComments, listComments, markRead, unreadCount, insertComment };
