'use strict';
/**
 * Class Valuation transport — WHERE every call actually goes. PURE (no DB; `fetch`
 * is stubbed, nothing leaves the process).
 *
 * The one thing this file exists to prove: on the LIVE API every DATA route lives
 * under `/intg/` while the TOKEN route lives on the identity host at
 * `/connect/token` with NO prefix. The vendor guide prints the bare data paths
 * (`/orders`, `/products`, `/callbacks`) and those 404 — so a single missing prefix
 * meant PILOT's Class ordering could authenticate and then never reach a single
 * data endpoint. The prefix is one overridable value, so this also pins the
 * disable/override path.
 */

// Env must be set BEFORE config is required (config freezes env at load). Fake
// credentials so the password grant is "configured"; master + write gates on so
// both read and write routes actually build a URL and call fetch.
process.env.CLASS_ENABLED = '1';
process.env.CLASS_OUTBOUND_ENABLED = '1';
delete process.env.CLASS_DRYRUN;            // dry-run would short-circuit before the URL is built
process.env.CLASS_ENVIRONMENT = 'uat';
process.env.CLASS_CLIENT_ID = 'cid';
process.env.CLASS_CLIENT_SECRET = 'secret';
process.env.CLASS_USERNAME = 'user';
process.env.CLASS_PASSWORD = 'pass';
delete process.env.CLASS_TOKEN_URL;
delete process.env.CLASS_ORDERS_URL;
delete process.env.CLASS_API_PREFIX;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', l); } };
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)})`);

// A fetch response shaped exactly enough for fetchWithTimeout + request + rawFetch:
// .ok / .status / .headers.get / .arrayBuffer.
function makeRes(status, bodyObj) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
  };
}

// Capture every URL the transport hits. The token URL mints a token; everything
// else answers a bland success so no retry/backoff path runs.
let calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: (opts && opts.method) || 'GET' });
  if (String(url).endsWith('/connect/token')) return makeRes(200, { access_token: 'tok', expires_in: 3600 });
  return makeRes(200, { ok: true, products: [] });
};

// Fresh config + client with whatever env is currently set.
function loadClient() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/class/client')];
  return require('../src/class/client');
}
const lastUrl = () => calls[calls.length - 1].url;
const reset = () => { calls = []; };

const ORDERS = 'https://api.uat.classvaluation.com';
const TOKEN = 'https://ids.uat.classvaluation.com/connect/token';

(async () => {
  let client = loadClient();

  // --- the token route: identity host, /connect/token, and NEVER /intg ---
  reset();
  const tok = await client.getAccessToken();
  eq(tok, 'tok', 'the token is returned');
  eq(calls.length, 1, 'exactly one call minted the token');
  eq(lastUrl(), TOKEN, 'the token posts to the identity host at /connect/token');
  ok(!lastUrl().includes('/intg'), 'the token route is NEVER prefixed with /intg');
  eq(calls[0].method, 'POST', 'the token is a POST');

  // From here the token is cached in-process, so each data call is exactly ONE
  // fetch (the data route) and lastUrl() is unambiguous.

  // --- reads: every documented data path gets /intg ---
  reset();
  await client.products({ limit: 200 });
  eq(lastUrl(), `${ORDERS}/intg/products?limit=200`, 'GET /products becomes /intg/products (query preserved)');

  reset();
  await client.orders({}, { version: 'v1' });
  eq(lastUrl(), `${ORDERS}/intg/orders`, 'GET /orders (2.6) becomes /intg/orders');

  reset();
  await client.orders({}, { version: 'v2' });
  eq(lastUrl(), `${ORDERS}/intg/v2/orders`, 'GET /v2/orders (3.6) becomes /intg/v2/orders — the prefix sits ahead of the version');

  reset();
  await client.order('ORD-1', { version: 'v1' });
  eq(lastUrl(), `${ORDERS}/intg/orders/ORD-1`, 'GET one order gets /intg');

  reset();
  await client.notes('ORD-1');
  eq(lastUrl(), `${ORDERS}/intg/orders/ORD-1/notes`, 'notes get /intg');

  reset();
  await client.listCallbacks();
  eq(lastUrl(), `${ORDERS}/intg/callbacks`, 'listing callbacks gets /intg');

  // --- writes: same chokepoint, so they get /intg too ---
  reset();
  await client.createOrder({ any: 'body' }, undefined, { path: '/orders' });
  eq(lastUrl(), `${ORDERS}/intg/orders`, 'POST createOrder (2.6) gets /intg');
  eq(calls[calls.length - 1].method, 'POST', 'createOrder is a POST');

  reset();
  await client.createOrder({ any: 'body' }, undefined, { path: '/v2/orders' });
  eq(lastUrl(), `${ORDERS}/intg/v2/orders`, 'POST createOrder (3.6) gets /intg ahead of the version');

  reset();
  await client.registerCallback({ event: 'x', url: 'https://cb' });
  eq(lastUrl(), `${ORDERS}/intg/callbacks`, 'registerCallback gets /intg');

  reset();
  await client.deleteCallback('cb-1');
  eq(lastUrl(), `${ORDERS}/intg/callbacks?id=cb-1`, 'deleteCallback gets /intg (query preserved)');

  // --- the raw document-bytes path bypasses request(), so it needs /intg too ---
  reset();
  await client.attachmentBytes('ORD-1', 'ATT-1');
  eq(lastUrl(), `${ORDERS}/intg/orders/ORD-1/attachments/ATT-1`, 'attachmentBytes builds its URL under /intg');

  // --- a presigned/returned download URL is followed VERBATIM: no /intg injected ---
  reset();
  const presigned = 'https://files.example.com/dl/report.pdf?sig=abc123';
  await client.fetchUrl(presigned, { auth: false });
  eq(lastUrl(), presigned, 'fetchUrl follows a returned URL byte-for-byte — never rewrites it with /intg');

  // --- hosts() reports the prefix + the full data base, and UAT identity is confirmed ---
  const h = client.hosts();
  eq(h.apiPrefix, '/intg', 'hosts() reports the active prefix');
  eq(h.apiBase, `${ORDERS}/intg`, 'hosts() reports the full data base a preflight can print');
  eq(h.tokenConfirmed, true, 'the UAT identity host is now vendor-confirmed');
  eq(client.configured().hostsConfirmed, true, 'so UAT hosts read as fully confirmed');
  eq(client._internals.apiBase(), `${ORDERS}/intg`, '_internals.apiBase is the data base');

  // --- the prefix is overridable / disableable (CLASS_API_PREFIX='') ---
  process.env.CLASS_API_PREFIX = '';
  client = loadClient();
  // Token FIRST on the fresh client (before a data call caches the token) so this
  // fetch is the token route: it must stay on the identity host regardless of the
  // data prefix.
  reset();
  await client.getAccessToken();
  eq(lastUrl(), TOKEN, 'the token route is unaffected by the data prefix');
  reset();
  await client.products();
  eq(lastUrl(), `${ORDERS}/products`, 'an empty CLASS_API_PREFIX turns the prefix OFF (bare path)');
  delete process.env.CLASS_API_PREFIX;

  // --- a custom prefix is honoured (normalised to one leading slash, no trailing) ---
  process.env.CLASS_API_PREFIX = 'gateway/';
  client = loadClient();
  reset();
  await client.products();
  eq(lastUrl(), `${ORDERS}/gateway/products`, 'a custom CLASS_API_PREFIX is honoured and normalised');
  delete process.env.CLASS_API_PREFIX;

  console.log(`\nclass transport: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
