'use strict';
/**
 * test-elementix-callback-public.js — the Elementix approval's RETURN LEG must be
 * reachable by a plain browser redirect, and it must always land the person back
 * on the API Health page.
 *
 * WHY THIS TEST EXISTS (owner-reported 2026-08-09). The callback was first written
 * inside `admin-elementix.js`, which is mounted behind `requireAuth, requireStaff`
 * in server.js AND applies its own `requireAuth, requirePermission('platform_setup')`.
 * That is right for every other route in that file and WRONG for this one: ELEMENTIX
 * brings the person back by redirecting their BROWSER from another origin, so the
 * request carries no Authorization header — the portal keeps its token in
 * localStorage and attaches it to fetch calls, and a top-level navigation cannot
 * carry it. So the owner signed in at Elementix, was sent back, and the screen
 * answered
 *   {"error":"unauthenticated","code":"bad_token","session":"invalid"}
 * while the pending approval sat in the database untouched. An OAuth callback is a
 * redirect TARGET, not an API call.
 *
 * Two halves, because either one alone would let the bug back in:
 *
 *   A. THE MOUNT. A route that behaves perfectly is useless if it is mounted behind
 *      a gate, and no amount of driving requests through the router in isolation can
 *      see that — the mount lives in server.js. So section A reads the source and
 *      pins the wiring: the public mount exists, carries no auth middleware, sits
 *      AHEAD of both `/api/admin/elementix` and `/api/admin` (Express matches in
 *      mount order, so behind them it would be shadowed by the staff wall), and the
 *      gated file no longer defines a `/callback` of its own.
 *
 *   B. THE BEHAVIOUR. Section B drives REAL requests through the public router alone
 *      in a bare express app, with `../db` and `../elementix/oauth` stubbed in the
 *      require cache — no database, no network, no vendor. It proves the thing the
 *      owner actually hit: a request with NO headers at all completes the approval.
 *      And it proves the person is never left on a raw error page — every outcome,
 *      including a thrown exception, is a 302 back to the API Health screen.
 */

process.env.ELEMENTIX_URL = process.env.ELEMENTIX_URL || 'https://app.elementix.com/api/mcp';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || 'dev-only-ssn-key-for-tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret-for-tests';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const SRC = (...p) => path.join(ROOT, 'src', ...p);
const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * Strip comments so a source guard reads CODE, not prose. This matters here: the
 * public callback's whole header comment is about the gates that broke it, and it
 * quotes `requireAuth, requireStaff` verbatim to record the root cause. A naive
 * text scan flags that documentation as the bug it warns about — so the comment
 * would have to be deleted to make the test pass, which is precisely backwards.
 * Quotes are respected so a URL inside a string is never mistaken for a comment.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (next || ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    out += c; i += 1;
  }
  return out;
}

// Nothing in this suite may reach the network. The trap RECORDS as well as throws:
// the callback swallows errors by design (it must always redirect), so a throw on
// its own would be invisible and the next person could re-add a live call without
// ever seeing it. The list is asserted empty at the end.
const attemptedCalls = [];
global.fetch = (url) => {
  attemptedCalls.push(String(url));
  throw new Error(`this test must never call out — something tried to reach ${url}`);
};

let n = 0;
function ok(what) { n += 1; console.log(`  ✓ ${what}`); }

console.log('Elementix approval callback — public mount + return-leg behaviour');

// ===========================================================================
// A. THE MOUNT
// ===========================================================================
console.log('\nA. The mount (server.js + the two route files)');

const serverSrc = read(SRC('server.js'));
const gatedSrc = read(SRC('routes', 'admin-elementix.js'));
const publicSrc = read(SRC('routes', 'admin-elementix-callback.js'));

{
  // A1. The public mount exists at the exact path Elementix redirects to. The path
  // is NOT free to change: it is the redirect_uri already registered with the
  // vendor and stored on every pending row, so a rename silently breaks in-flight
  // approvals AND the registered client.
  const mountRe = /app\.use\(\s*'\/api\/admin\/elementix\/callback'([\s\S]*?)\);/;
  const m = serverSrc.match(mountRe);
  assert.ok(m, 'server.js mounts /api/admin/elementix/callback as its own path');
  const mountBody = m[1];
  assert.ok(/require\('\.\/routes\/admin-elementix-callback'\)/.test(mountBody),
    'the callback mount uses the dedicated public router');
  ok('server.js mounts /api/admin/elementix/callback → routes/admin-elementix-callback');

  // A2. THE WHOLE POINT: no auth middleware on that mount. Elementix cannot send a
  // token, so any gate here makes the connection structurally unreachable.
  for (const gate of ['requireAuth', 'requireStaff', 'requirePermission', 'requireRole']) {
    assert.ok(!mountBody.includes(gate),
      `the callback mount must carry no ${gate} — a browser redirect cannot authenticate`);
  }
  ok('the callback mount carries NO auth middleware (requireAuth/requireStaff/requirePermission/requireRole)');

  // A3. A rate limit IS present — not because `state` is guessable (192 bits,
  // single-use, 15 minutes) but so this public door cannot be used to hammer the
  // vendor's token endpoint.
  assert.ok(/rateLimit\(/.test(mountBody), 'the public callback is rate-limited at the mount');
  ok('the callback mount is rate-limited');

  // A4. ORDER. Express matches mounts in the order they are registered, so the
  // public callback must come BEFORE the gated `/api/admin/elementix` router and
  // before the blanket `/api/admin` staff wall — behind either, the wall answers
  // first and the 401 is back.
  const iCallback = serverSrc.indexOf("app.use('/api/admin/elementix/callback'");
  const iGated = serverSrc.indexOf("app.use('/api/admin/elementix',");
  const iAdmin = serverSrc.indexOf("app.use('/api/admin',");
  assert.ok(iCallback > 0, 'the callback mount was found');
  assert.ok(iGated > 0, 'the gated Elementix admin mount was found');
  assert.ok(iCallback < iGated,
    'the public callback must be mounted BEFORE /api/admin/elementix or the staff wall shadows it');
  if (iAdmin > 0) {
    assert.ok(iCallback < iAdmin,
      'the public callback must be mounted BEFORE the blanket /api/admin staff wall');
  }
  ok('the public callback is mounted ahead of /api/admin/elementix and /api/admin');

  // A5. The gated file must not define a /callback of its own. Two routes on one
  // path is not a harmless duplicate: whichever mount matches first wins, so a
  // re-added gated copy could quietly take the traffic back and 401 again.
  assert.ok(!/router\.(get|post|all)\(\s*'\/callback'/.test(gatedSrc),
    'admin-elementix.js must NOT define a /callback route — it lives in the public router');
  assert.ok(/admin-elementix-callback/.test(gatedSrc),
    'admin-elementix.js points at where the return leg actually lives');
  ok('the gated admin-elementix.js defines no /callback and points at the public router');

  // A6. The gated file still gates EVERYTHING ELSE. Moving one route out must not
  // have opened the others (start, status, discover, disconnect, tools).
  assert.ok(/router\.use\(requireAuth, requirePermission\('platform_setup'\)\)/.test(gatedSrc),
    'admin-elementix.js still gates its own routes on platform_setup');
  ok('everything else about the connection stays gated on platform_setup');

  // A7. The PUBLIC file must never require the auth middleware. This is the
  // STRUCTURAL guard, not a stylistic one: a gate cannot be applied without being
  // imported, so with no `require('../auth')` there is no way to reinstate the bug
  // in this file without the test noticing. Checked against comment-stripped
  // source — the header quotes those gate names on purpose, to record why the
  // route moved.
  const publicCode = stripComments(publicSrc);
  assert.ok(!/require\(\s*'\.\.\/auth'\s*\)/.test(publicCode),
    'the public callback router must not require ../auth at all');
  for (const gate of ['requireAuth', 'requireStaff', 'requirePermission', 'requireRole']) {
    assert.ok(!publicCode.includes(gate),
      `the public callback router must not use ${gate} — Elementix redirects a browser here`);
  }
  assert.ok(/requireAuth, requireStaff/.test(publicSrc),
    'the header still records WHICH gates broke it — do not delete that explanation');
  ok('the public callback router imports and uses no auth gate (and still documents why)');

  // A8. It handles the mount ROOT (`/`), because the path segment is consumed by
  // app.use. A `/callback` inside a router mounted at `/api/admin/elementix/callback`
  // would answer only on `…/callback/callback` — a 404 that reads exactly like the
  // route not existing.
  assert.ok(/router\.get\(\s*'\/'/.test(publicSrc),
    "the public router handles '/' — the path segment is consumed by the mount");
  ok("the public router handles '/' (not '/callback' again)");
}

// ===========================================================================
// B. THE BEHAVIOUR — real requests, no database, no vendor
// ===========================================================================
console.log('\nB. Real requests through the public router (db + oauth stubbed)');

// ---- stubs installed in the require cache BEFORE the router is required ----
const auditRows = [];
const dbStub = {
  query: async (sql, params) => {
    if (/INSERT INTO audit_log/i.test(sql)) {
      auditRows.push({
        actorKind: params[0], actorId: params[1], action: params[2],
        ip: params[3], userAgent: params[4], detail: JSON.parse(params[5] || '{}'),
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query in this test: ${String(sql).slice(0, 60)}`);
  },
};

// `completeConnect` is driven from the test body: each case sets `nextComplete`.
let nextComplete = null;
const completeCalls = [];
const oauthStub = {
  completeConnect: async (args) => {
    completeCalls.push(args);
    if (typeof nextComplete === 'function') return nextComplete(args);
    throw new Error('no completeConnect behaviour was set for this case');
  },
};

function install(modPath, exportsObj) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
install(SRC('db.js'), dbStub);
install(SRC('elementix', 'oauth.js'), oauthStub);

const express = require('express');
const callbackRouter = require(SRC('routes', 'admin-elementix-callback.js'));

// Mounted EXACTLY as server.js mounts it — same path, and deliberately with no
// auth middleware, so this app models the real wiring rather than a friendlier one.
const app = express();
app.use('/api/admin/elementix/callback', callbackRouter);

const server = http.createServer(app);

/**
 * A raw GET with NO Authorization header and NO cookie — the shape of the request
 * a browser redirect from Elementix actually makes. Deliberately raw http rather
 * than a helper so nothing can smuggle credentials in.
 */
function get(pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathAndQuery, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const HEALTH = '/portal/#/internal/api-health';

/**
 * Read the redirect the way the API Health page reads it. The portal is a
 * HashRouter, so the query lives INSIDE the hash and `useLocation().search` is the
 * part after the first `?` — which is exactly what `ElementixActions` parses with
 * `new URLSearchParams(loc.search)`. Parsing it the same way here means these
 * assertions are about what the owner will actually SEE on the screen, and it
 * decodes `+` as a space, which `decodeURIComponent` does not.
 */
function outcomeOf(location) {
  const q = String(location || '');
  const i = q.indexOf('?');
  const p = new URLSearchParams(i >= 0 ? q.slice(i + 1) : '');
  return { outcome: p.get('elementix'), message: p.get('message') || '' };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // -------------------------------------------------------------------------
  console.log('\n  B1. The owner\'s exact case: a browser redirect with no session');
  // -------------------------------------------------------------------------
  {
    auditRows.length = 0; completeCalls.length = 0;
    nextComplete = async () => ({
      ok: true, selfRenewing: true, startedBy: 'staff-uuid-1',
      detail: 'Connected, and Elementix issued a refresh token.',
    });

    // No Authorization header, no cookie. This is the request that used to answer
    // {"error":"unauthenticated","code":"bad_token","session":"invalid"}.
    const res = await get('/api/admin/elementix/callback?code=THE_CODE&state=THE_STATE');

    assert.strictEqual(res.status, 302,
      'a sessionless browser redirect must be answered with a redirect, not a 401');
    assert.ok(!/unauthenticated|bad_token/i.test(res.body),
      'the owner\'s error string must never appear again');
    assert.ok(res.location.startsWith(HEALTH), 'it lands back on the API Health page');
    assert.ok(res.location.includes('elementix=connected'), 'the page is told the approval succeeded');
    ok('a request with NO headers completes the approval and returns 302 (was 401)');

    // The code and state are passed through verbatim — the state is the credential,
    // and PKCE binds the code to a verifier that never leaves our database.
    assert.deepStrictEqual(completeCalls, [{ code: 'THE_CODE', state: 'THE_STATE' }]);
    ok('the code and state reach completeConnect verbatim');

    // The audit row names WHOEVER PRESSED CONNECT. There is no session here, so
    // `startedBy` off the pending row is the only honest attribution available —
    // and it is better provenance than a session would have been: it records who
    // chose to connect, not who happened to have a browser open.
    assert.strictEqual(auditRows.length, 1, 'exactly one audit row');
    assert.strictEqual(auditRows[0].action, 'elementix_connected');
    assert.strictEqual(auditRows[0].actorKind, 'staff');
    assert.strictEqual(auditRows[0].actorId, 'staff-uuid-1');
    assert.strictEqual(auditRows[0].detail.selfRenewing, true);
    ok('the audit row is attributed to the staff member who started the approval');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B2. Elementix says the person REFUSED');
  // -------------------------------------------------------------------------
  {
    auditRows.length = 0; completeCalls.length = 0;
    nextComplete = async () => { throw new Error('completeConnect must not be called on a denial'); };

    const res = await get('/api/admin/elementix/callback'
      + '?error=access_denied&error_description=The%20user%20declined');

    assert.strictEqual(res.status, 302);
    assert.strictEqual(outcomeOf(res.location).outcome, 'error', 'the page is told it did not connect');
    assert.ok(/declined/i.test(outcomeOf(res.location).message),
      'the vendor\'s own wording is carried through so the person knows what happened');
    assert.deepStrictEqual(completeCalls, [],
      'there is no code to exchange on a denial — do not call the token endpoint');
    ok('a denial redirects with the vendor\'s reason and never attempts a token exchange');

    // Nobody to attribute it to (the pending row was not claimed), so it is the
    // system's own action rather than a staff member's.
    assert.strictEqual(auditRows.length, 1);
    assert.strictEqual(auditRows[0].action, 'elementix_connect_denied');
    assert.strictEqual(auditRows[0].actorKind, 'system');
    assert.strictEqual(auditRows[0].actorId, null);
    ok('a denial is audited as the system\'s action, with no staff id invented');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B3. A stale / replayed link');
  // -------------------------------------------------------------------------
  {
    auditRows.length = 0; completeCalls.length = 0;
    nextComplete = async () => ({
      ok: false, reason: 'stale_state',
      detail: 'That approval link had already been used or had expired. Start the connection again.',
      startedBy: null,
    });

    const res = await get('/api/admin/elementix/callback?code=OLD&state=SPENT');

    assert.strictEqual(res.status, 302, 'still a redirect — never a raw error page');
    const { outcome, message } = outcomeOf(res.location);
    assert.strictEqual(outcome, 'error');
    assert.ok(/already been used or had expired/i.test(message),
      'the message says what happened');
    assert.ok(/start the connection again/i.test(message),
      'and what to do about it — the person is mid-approval and needs a next step');
    ok('a spent or expired state redirects with an actionable message');

    assert.strictEqual(auditRows.length, 1);
    assert.strictEqual(auditRows[0].action, 'elementix_connect_failed');
    assert.strictEqual(auditRows[0].detail.reason, 'stale_state');
    assert.strictEqual(auditRows[0].actorKind, 'system',
      'with no claimed pending row there is nobody to name');
    ok('the failure and its reason are audited');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B4. The token exchange fails (the vendor is unhappy)');
  // -------------------------------------------------------------------------
  {
    auditRows.length = 0;
    nextComplete = async () => ({
      ok: false, reason: 'token_exchange_failed',
      detail: 'Elementix refused the exchange (400 invalid_grant).',
      startedBy: 'staff-uuid-7',
    });

    const res = await get('/api/admin/elementix/callback?code=C&state=S');
    assert.strictEqual(res.status, 302);
    assert.strictEqual(outcomeOf(res.location).outcome, 'error');
    assert.ok(/invalid_grant/.test(outcomeOf(res.location).message),
      'the vendor\'s detail is surfaced so somebody can act on it');
    assert.strictEqual(auditRows[0].actorKind, 'staff');
    assert.strictEqual(auditRows[0].actorId, 'staff-uuid-7',
      'a claimed pending row still names the person, even on a failure');
    ok('a failed token exchange redirects with the reason and is attributed');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B5. completeConnect THROWS — still a redirect, never a 500');
  // -------------------------------------------------------------------------
  {
    auditRows.length = 0;
    nextComplete = async () => { throw new Error('the database went away mid-approval'); };

    const res = await get('/api/admin/elementix/callback?code=C&state=S');

    assert.strictEqual(res.status, 302,
      'a person mid-approval must never be dropped on a raw error page — the only '
      + 'thing they can act on is the API Health screen');
    assert.ok(res.location.startsWith(HEALTH));
    assert.strictEqual(outcomeOf(res.location).outcome, 'error');
    assert.ok(/database went away/.test(outcomeOf(res.location).message));
    ok('an unexpected exception still redirects to the API Health page (no 500)');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B6. A bare callback with nothing on it');
  // -------------------------------------------------------------------------
  {
    nextComplete = async () => ({ ok: false, reason: 'missing_code' });
    const res = await get('/api/admin/elementix/callback');
    assert.strictEqual(res.status, 302, 'even a naked GET is answered with a redirect');
    assert.ok(res.location.includes('elementix=error'));
    ok('a bare GET with no code and no state redirects rather than erroring');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B7. A browser-shaped request with a JUNK Authorization header');
  // -------------------------------------------------------------------------
  {
    // Some browsers / extensions / proxies attach headers we did not ask for. A
    // stale or malformed token must never turn a successful approval into a 401 —
    // this route does not read the header at all, and that is deliberate.
    nextComplete = async () => ({ ok: true, selfRenewing: false, startedBy: null, detail: 'Connected.' });
    const res = await get('/api/admin/elementix/callback?code=C&state=S',
      { authorization: 'Bearer this-token-expired-three-days-ago' });
    assert.strictEqual(res.status, 302);
    assert.ok(res.location.includes('elementix=connected'),
      'a junk Authorization header is ignored, not treated as a failed login');
    ok('a stale/garbage Authorization header does not break the approval');
  }

  // -------------------------------------------------------------------------
  console.log('\n  B8. An audit failure never breaks the approval');
  // -------------------------------------------------------------------------
  {
    const realQuery = dbStub.query;
    dbStub.query = async () => { throw new Error('audit_log is unavailable'); };
    try {
      nextComplete = async () => ({ ok: true, selfRenewing: true, startedBy: 'x', detail: 'Connected.' });
      const res = await get('/api/admin/elementix/callback?code=C&state=S');
      assert.strictEqual(res.status, 302);
      assert.ok(res.location.includes('elementix=connected'),
        'the connection is already stored — a failed audit write must not undo or hide it');
      ok('an audit write failure does not stop the approval landing');
    } finally {
      dbStub.query = realQuery;
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n  B9. A crafted link cannot redirect anywhere but our own page');
  // -------------------------------------------------------------------------
  {
    // This route is PUBLIC, so anyone can hit it with anything — and the vendor's
    // `error_description` is the one piece of attacker-controlled text that reaches
    // a `Location` header. Three things must hold for every value of it: the target
    // stays our own relative API Health path (never an open redirect — a callback
    // that can be made to bounce a staff member to another site is a phishing
    // primitive), no CRLF reaches the header (response splitting), and the OUTCOME
    // cannot be flipped to `connected` by smuggling a second query parameter.
    nextComplete = async () => { throw new Error('a denial must not reach completeConnect'); };
    const crafted = [
      'https://evil.example.com/steal',        // absolute URL
      '//evil.example.com',                    // protocol-relative
      '\r\nLocation: https://evil.example.com', // response splitting
      '?x=1&elementix=connected',              // outcome spoofing
      '#/internal/somewhere-else',             // fragment takeover
      '</script><img src=x onerror=alert(1)>', // script injection
    ];
    for (const evil of crafted) {
      const res = await get('/api/admin/elementix/callback'
        + `?error=access_denied&error_description=${encodeURIComponent(evil)}`);
      assert.strictEqual(res.status, 302, `still a redirect for ${JSON.stringify(evil)}`);
      assert.ok(res.location.startsWith(`${HEALTH}?`),
        `the target must always be our own relative API Health path, got ${res.location}`);
      assert.ok(!/[\r\n]/.test(res.location), 'no CRLF may reach the Location header');
      const { outcome, message } = outcomeOf(res.location);
      assert.strictEqual(outcome, 'error',
        'a crafted message must never flip the outcome to "connected"');
      assert.strictEqual(message, evil,
        'the message survives as encoded DATA — the page renders it as React text, so it cannot execute');
    }
    ok(`all ${crafted.length} crafted messages stay data: no open redirect, no header injection, no outcome spoofing`);
  }

  await new Promise((r) => server.close(r));

  // The other half of the network trap at the top of this file.
  assert.deepStrictEqual(attemptedCalls, [],
    `this test tried to reach the network: ${attemptedCalls.join(', ')}`);
  ok('nothing in this suite called out to the network');

  console.log(`\n✓ ${n} assertions passed — the Elementix callback is publicly reachable `
    + 'and always lands on the API Health page.\n');
})().catch((e) => {
  console.error('\n✘ FAILED:', e && e.message);
  console.error(e && e.stack);
  try { server.close(); } catch (_) { /* already down */ }
  process.exit(1);
});
