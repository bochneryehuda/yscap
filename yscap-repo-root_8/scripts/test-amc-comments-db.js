'use strict';
/**
 * DB-gated test for the AMC comment thread (src/amc/comments.js) against a real
 * Postgres. Drives the network through an INJECTED transport so the whole two-way
 * thread runs offline: send a message (AddComment), pull the AMC's replies
 * (GetComments) with dedupe, list, unread count, and mark-read. One transaction,
 * rolled back.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-comments-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const comments = require(path.join(ROOT, 'src/amc/comments'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// A successful AddComment ack (no error, no echoed id).
const addAck = { message: { digitalGatewaySystem: { statusResponses: [{ statusCode: '1000', statusName: 'Success', statusCondition: 'Ack' }] } } };
// A GetComments response with one id'd comment and one without.
const getResp = { message: { products: [
  { commentId: 'C1', requestCommentText: 'Please add two more comps.', requestCommentContactFullName: 'AMC Reviewer', requestCommentTextDatetime: '2026-09-01 10:00' },
  { requestCommentText: 'Second note without an id.', requestCommentTextDatetime: '2026-09-02 09:00' },
] } };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const bo = await c.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cmt','Test',$1) RETURNING id`, [`amc-cmt-${Date.now()}@example.com`]);
    const app = await c.query(`INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,'YSCAP-CMT-1') RETURNING id`, [bo.rows[0].id]);
    const ord = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, cdg_order_number, sp_order_number, status)
       VALUES ($1,'YSCAP-CMT-1','CLG100','SP-1','in_process') RETURNING *`, [app.rows[0].id]);
    const order = ord.rows[0];

    const deps = {
      authContext: { apiKey: 'K', subdomain: 'sub' },
      transport: { write: async () => addAck, read: async () => getResp },
    };

    // ---- outbound ----
    const sent = await comments.postComment(c, order, { staffId: null, staffName: 'Alice Officer', body: '  Please rush this order.  ' }, deps);
    ok(sent.ok && sent.comment && sent.comment.direction === 'outbound', 'outbound comment recorded');
    ok(sent.comment.body === 'Please rush this order.', 'outbound body trimmed');
    ok(sent.comment.author_name === 'Alice Officer', 'outbound author recorded');
    const j = await c.query(`SELECT count(*)::int n FROM amc_write_log WHERE order_id=$1 AND action='AddComment' AND ok=true`, [order.id]);
    ok(j.rows[0].n === 1, 'the send is journaled');
    // an empty message is refused before any send
    const empty = await comments.postComment(c, order, { staffId: null, body: '   ' }, deps);
    ok(!empty.ok && empty.error === 'empty', 'an empty message is refused');

    // ---- inbound pull + dedupe ----
    const s1 = await comments.syncComments(c, order, deps);
    ok(s1.ok && s1.added === 2, 'first pull files both inbound comments');
    const s2 = await comments.syncComments(c, order, deps);
    ok(s2.added === 0, 're-pull dedupes (nothing new)');

    // ---- list + unread ----
    const list = await comments.listComments(c, order.id);
    ok(list.length === 3, 'thread has 1 outbound + 2 inbound');
    ok(list[0].direction === 'outbound', 'thread is ordered (outbound first)');
    ok(await comments.unreadCount(c, order.id) === 2, 'two inbound comments unread');

    // ---- mark read ----
    const inbound = list.find((x) => x.direction === 'inbound' && x.amc_comment_id === 'C1');
    ok(await comments.markRead(c, order.id, inbound.id) === true, 'mark-read flips an inbound comment');
    ok(await comments.markRead(c, order.id, inbound.id) === false, 'mark-read is idempotent');
    ok(await comments.unreadCount(c, order.id) === 1, 'unread count drops after reading one');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-comments-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
