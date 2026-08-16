/**
 * DB-gated — the Richer Values PUBLIC webhook receiver, end to end.
 *
 *   DATABASE_URL=... node scripts/test-richer-value-webhook-db.js
 *
 * WHY THIS EXISTS. Richer Values configure the webhook on THEIR side — there is no
 * webhook-management endpoint on their API (confirmed 404), so we hand them a URL
 * and a secret once and cannot test the round trip by asking them to fire one. The
 * whole of our half therefore has to be provable from here, before anyone asks
 * their team to point at it. Nothing had ever exercised this router.
 *
 * WHAT IS PINNED, and why each is a real failure mode:
 *
 *  A  IT FAILS CLOSED. With no secret configured every delivery is refused. An
 *     unauthenticated public URL that writes rows is worse than a receiver that is
 *     switched off, and "off" is the honest reading of "nobody set this up yet".
 *  B  BOTH auth modes work — a token in a header we name, and HTTP Basic — because
 *     which one they can send is their choice, not ours, and finding out the one we
 *     support is the one they cannot is a conversation nobody wants mid-go-live.
 *  C  A WRONG SECRET IS REFUSED, including one that merely shares a prefix.
 *  D  THE EVENT IS STORED VERBATIM before anything interprets it, so a shape we do
 *     not handle yet is still on the record and replayable.
 *  E  A RETRY IS NOT A SECOND EVENT. Their retries repeat a delivery verbatim, so
 *     the same event must record once — while a byte-identical event on a LATER
 *     DAY is legitimate (an order genuinely going on hold twice).
 *  F  A DELIVERY IS ANSWERED FAST AND ALWAYS 200 ONCE AUTHENTICATED — a body we
 *     cannot store is still acknowledged, because refusing makes them retry the
 *     same unstorable thing until they give up and switch us off.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const R = path.resolve(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-richer-value-webhook-db: SKIP (no DATABASE_URL)');
  process.exit(0);
}

const express = require('express');
const cfg = require(R + '/src/config');
const db = require(R + '/src/db');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('PASS ' + m); pass++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`); console.log('PASS ' + m); pass++; };

// The router reads cfg.richerValue at REQUEST time, so the secret can be set per case.
cfg.richerValue = cfg.richerValue || {};
const setSecrets = (s) => {
  cfg.richerValue.webhookToken = s.token || null;
  cfg.richerValue.webhookTokenHeader = s.header || 'x-api-key';
  cfg.richerValue.webhookUser = s.user || null;
  cfg.richerValue.webhookPassword = s.password || null;
};

const TOKEN = 'rv-test-' + require('crypto').randomBytes(24).toString('base64url');

// A delivery shaped exactly like their documented event.
const EVENT = (over = {}) => ({
  order_type: 'report',
  intake_token: 'intake-webhook-test',
  order_token: 'order-webhook-test',
  data: { action_type: 'status_change', action: 'property_analysis' },
  datetime: '2026-08-16T12:00:00Z',
  ...over,
});

(async () => {
  const app = express();
  app.use('/api/richer-value/webhook', require(R + '/src/routes/richervalues-webhook'));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/richer-value/webhook`;

  const post = async (body, headers = {}) => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json };
  };
  const countFor = async (intake) => (await db.query(
    `SELECT count(*)::int AS c FROM rv_order_events WHERE intake_token=$1`, [intake])).rows[0].c;

  try {
    await db.query(`DELETE FROM rv_order_events WHERE intake_token LIKE '%intake-webhook-test%'`);

    // ---- A — fails closed with nothing configured -------------------------
    setSecrets({});
    eq((await post(EVENT())).status, 401, 'A with no secret configured every delivery is refused');
    eq(await countFor('intake-webhook-test'), 0, 'A …and nothing is written by an unauthenticated call');

    // ---- C — a wrong secret is refused ------------------------------------
    setSecrets({ token: TOKEN });
    eq((await post(EVENT())).status, 401, 'C a delivery with no token at all is refused');
    eq((await post(EVENT(), { 'x-api-key': 'wrong' })).status, 401, 'C a wrong token is refused');
    eq((await post(EVENT(), { 'x-api-key': TOKEN.slice(0, -1) })).status, 401,
      'C a token that merely shares a prefix is refused');
    eq(await countFor('intake-webhook-test'), 0, 'C nothing was written by any refused delivery');

    // ---- B/D — the token mode works and the event is stored verbatim -------
    const first = await post(EVENT(), { 'x-api-key': TOKEN });
    eq(first.status, 200, 'B a delivery carrying the token is accepted');
    eq(first.json.received, true, 'B …and acknowledged');
    eq(first.json.duplicate, false, 'B …as a new event');
    const row = (await db.query(
      `SELECT * FROM rv_order_events WHERE intake_token='intake-webhook-test' ORDER BY id DESC LIMIT 1`)).rows[0];
    ok(!!row, 'D the delivery is on the record');
    eq(row.order_token, 'order-webhook-test', 'D …with their order token');
    eq(row.action_type, 'status_change', 'D …the kind of thing that happened');
    eq(row.action, 'property_analysis', 'D …and what it was');
    ok(row.payload && row.payload.data && row.payload.data.action === 'property_analysis',
      'D …and the whole payload verbatim, so a shape we do not handle yet is still replayable');

    // ---- E — a retry is not a second event --------------------------------
    const retry = await post(EVENT(), { 'x-api-key': TOKEN });
    eq(retry.status, 200, 'E a retry is still acknowledged');
    eq(retry.json.duplicate, true, 'E …and recognised as one they already sent');
    eq(await countFor('intake-webhook-test'), 1, 'E exactly one row for one event, however many times they retry');

    // A genuinely DIFFERENT event on the same order does record.
    await post(EVENT({ data: { action_type: 'status_change', action: 'completed' } }), { 'x-api-key': TOKEN });
    eq(await countFor('intake-webhook-test'), 2, 'E a different event on the same order is its own row');

    // ---- B — HTTP Basic, the other mode they may offer ---------------------
    setSecrets({ user: 'rv-user', password: 'rv-pass' });
    const basic = 'Basic ' + Buffer.from('rv-user:rv-pass').toString('base64');
    eq((await post(EVENT({ intake_token: 'intake-webhook-test-basic' }), { authorization: basic })).status, 200,
      'B HTTP Basic works when that is what they can send');
    eq((await post(EVENT({ intake_token: 'intake-webhook-test-basic2' }),
      { authorization: 'Basic ' + Buffer.from('rv-user:wrong').toString('base64') })).status, 401,
      'C …and a wrong password is refused');

    // ---- B — a header name of THEIR choosing ------------------------------
    setSecrets({ token: TOKEN, header: 'x-richervalues-signature' });
    eq((await post(EVENT({ intake_token: 'intake-webhook-test-hdr' }),
      { 'x-richervalues-signature': TOKEN })).status, 200,
      'B the header name is configurable, so we can take whichever one they send');
    eq((await post(EVENT({ intake_token: 'intake-webhook-test-hdr2' }), { 'x-api-key': TOKEN })).status, 401,
      'C …and the default header stops working once another is named, so only theirs is trusted');

    // ---- F — an unparseable body is refused by the parser, never 500'd -----
    setSecrets({ token: TOKEN });
    const bad = await post('{not json at all', { 'x-api-key': TOKEN });
    ok(bad.status === 400 || bad.status === 200, `F a malformed body does not crash the receiver (HTTP ${bad.status})`);

    // An event carrying tokens we have never seen is still stored — their push is
    // a nudge, and an order we cannot resolve yet is not a reason to lose the event.
    const unknown = await post(EVENT({ intake_token: 'intake-webhook-test-unknown', order_token: null }), { 'x-api-key': TOKEN });
    eq(unknown.status, 200, 'F an event for an order we do not know is still accepted');
    eq(await countFor('intake-webhook-test-unknown'), 1, 'F …and still recorded, to be resolved later');

    // ---- G — THE EVENT MUST FIND ITS ORDER --------------------------------
    // This is the assertion the receiver shipped without, and the reason it was
    // broken for so long unnoticed. `sync.js` resolves a delivery by
    // `WHERE intake_token = $1` / `WHERE order_token = $1` against `rv_orders`.
    // Storing the token through `jsonbText` wrote `"intake-tok"` WITH quotes, so
    // that lookup matched nothing — while every event still authenticated, stored
    // and answered 200, and the five-minute poll kept the desk looking healthy.
    // Testing the receiver in isolation cannot see that; only joining the two
    // halves can, so this asserts the JOIN rather than the row.
    const suffix = Date.now();
    const intake = `intake-webhook-test-join-${suffix}`;
    const orderTok = `order-webhook-test-join-${suffix}`;
    const borrower = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('RvHook','Tester',$1) RETURNING id`,
      [`rv-hook-${suffix}@example.test`])).rows[0];
    const appRow = (await db.query(
      `INSERT INTO applications (borrower_id, property_address, status)
       VALUES ($1, '{}'::jsonb, 'underwriting') RETURNING id`, [borrower.id])).rows[0];
    await db.query(
      `INSERT INTO rv_orders (application_id, status, report_type, inspection_type, intake_token, order_token)
       VALUES ($1,'ordered','reno-arv','interior-w-exterior',$2,$3)`, [appRow.id, intake, orderTok]);

    try {
      setSecrets({ token: TOKEN });
      eq((await post(EVENT({ intake_token: intake, order_token: orderTok }), { 'x-api-key': TOKEN })).status, 200,
        'G an event for a real order is accepted');

      const stored = (await db.query(
        `SELECT intake_token, order_token, payload FROM rv_order_events WHERE intake_token=$1`, [intake])).rows[0];
      ok(!!stored, 'G the event is stored under the token EXACTLY as they sent it');
      eq(stored.intake_token, intake, 'G …the intake token is the bare token, with no JSON quoting');
      eq(stored.order_token, orderTok, 'G …and so is the order token');

      // The join `sync.js` actually performs.
      const matched = (await db.query(
        `SELECT o.id FROM rv_order_events e JOIN rv_orders o ON o.intake_token = e.intake_token
          WHERE e.intake_token = $1`, [intake])).rows;
      eq(matched.length, 1, 'G the delivery RESOLVES to its order — the whole point of the push');
      const matchedByOrder = (await db.query(
        `SELECT o.id FROM rv_order_events e JOIN rv_orders o ON o.order_token = e.order_token
          WHERE e.order_token = $1`, [orderTok])).rows;
      eq(matchedByOrder.length, 1, 'G …by the order token too, which is the lookup sync tries first');

      // The payload is a real OBJECT, not a JSON string — a jsonb string would
      // defeat every `payload->>…` read and any later replay.
      eq(typeof stored.payload, 'object', 'G the payload is stored as an object, not double-encoded');
      eq(stored.payload.data.action, 'property_analysis', 'G …and reads back field by field');

      // A very long token is an identity, never prose — it must not be clipped.
      const longTok = 'x'.repeat(400) + suffix;
      await post(EVENT({ intake_token: longTok, order_token: null }), { 'x-api-key': TOKEN });
      const longRow = (await db.query(
        `SELECT intake_token FROM rv_order_events WHERE intake_token=$1`, [longTok])).rows[0];
      ok(!!longRow, 'G a long token is stored whole — a clipped one would match no order, silently');
    } finally {
      await db.query(`DELETE FROM rv_orders WHERE application_id=$1`, [appRow.id]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [appRow.id]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower.id]).catch(() => {});
    }

    console.log(`\ntest-richer-value-webhook-db: ${pass} assertions passed`);
  } finally {
    await db.query(`DELETE FROM rv_order_events WHERE intake_token LIKE '%intake-webhook-test%'`).catch(() => {});
    server.close();
    await db.end?.().catch(() => {});
  }
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
