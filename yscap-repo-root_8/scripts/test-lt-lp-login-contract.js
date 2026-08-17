#!/usr/bin/env node
'use strict';
/**
 * THE LOGIN, PINNED TO THE SHAPE A HUMAN VERIFIED ON THE WIRE (2026-08-16).
 *
 * The developer captured a real browser login and confirmed, field by field, what Lender Price
 * accepts:
 *
 *     POST https://auth.digitallending.com/oauth/token
 *     Content-Type: application/x-www-form-urlencoded
 *     Authorization: Basic <client_id:client_secret>
 *     form: username, password, grant_type=password, client_id=acme2
 *     with the Lender Price website as the Origin / Referer
 *
 * …and confirmed that same flow reaches Quick Pricer in the browser. That capture is the SPEC, and
 * until now nothing in this repo asserted it: the connector's own header records that omitting the
 * Basic header was the original root cause of "correct credentials still return 401", which is
 * exactly the class of regression a single unnoticed edit re-introduces. A wire shape nobody pins is
 * a wire shape that drifts on the next refactor and fails in production only.
 *
 * WHY THIS IS THE CHEAP HALF OF THE PROOF, AND WHAT IT IS NOT. It asserts what we SEND, against a
 * capture of what a working client sends — it cannot prove the vendor accepts it, because that needs
 * real credentials, and NO production Lender Price secret exists in this environment (verified: the
 * LP_* variables are unset here, and `login()` refuses with `lp_creds_missing` before any request).
 * The other half is a live run from inside Render, where the credentials already are:
 *
 *     node -e "require('./src/longterm/lenderprice/client').loginSelfTest().then(r=>console.log(r))"
 *
 * `loginSelfTest` exists so that command can print its WHOLE result safely — it returns no token, no
 * refresh token and no credential, by construction, because the natural thing to type in a shell is
 * the whole object and terminals get pasted into tickets.
 *
 * Driven through the real `fetch` seam with obviously-fake credentials. No network, no DB, no RTL
 * imports.
 */

process.env.LP_USERNAME = 'suite@example.invalid';
process.env.LP_PASSWORD = 'not-a-real-password';
process.env.LP_CLIENT_SECRET = 'not-a-real-client-secret';

const lp = require('../src/longterm/lenderprice/client');
const I = lp._internals;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

const CALLS = [];
let RESPOND = () => ({ status: 200, body: '{}' });
global.fetch = async (url, init = {}) => {
  const body = String(init.body || '');
  CALLS.push({ url: String(url), method: init.method, headers: init.headers || {}, body, form: new URLSearchParams(body) });
  const r = RESPOND(CALLS[CALLS.length - 1], CALLS.length);
  if (r.throws) throw new Error(r.throws);
  return { status: r.status, text: async () => r.body };
};
const TOKEN = JSON.stringify({ access_token: 'T', refresh_token: 'R', expires_in: 3600, companyId: 'c1', userId: 'u1' });
const reset = () => { CALLS.length = 0; I.resetTokenState(); };

console.log('lender price — the password login, pinned to the verified capture');

(async () => {
  // ---- THE VERIFIED SHAPE, FIELD BY FIELD ---------------------------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: TOKEN });
    const r = await lp.login();
    ok(r.ok === true && CALLS.length === 1, 'LOGIN-0 one request, and it succeeds');
    const c = CALLS[0];
    ok(c.url === 'https://auth.digitallending.com/oauth/token',
      'WIRE-1 POSTs the captured token endpoint on the AUTH host (not the API host)');
    ok(c.method === 'POST', 'WIRE-2 …as a POST');
    ok(/application\/x-www-form-urlencoded/.test(c.headers['Content-Type'] || ''),
      'WIRE-3 …form-urlencoded, as the browser sends (a JSON body is refused upstream)');
    ok(c.form.get('grant_type') === 'password', 'WIRE-4 grant_type=password');
    ok(c.form.get('username') === process.env.LP_USERNAME, 'WIRE-5 username, from the environment');
    ok(c.form.get('password') === process.env.LP_PASSWORD, 'WIRE-6 password, from the environment');
    ok(c.form.get('client_id') === 'acme2', 'WIRE-7 client_id=acme2 (the web app\'s OAuth client)');
    // THE ORIGINAL ROOT CAUSE: without this header, correct credentials still returned 401.
    const basic = c.headers.Authorization || '';
    ok(/^Basic /.test(basic), 'WIRE-8 the OAuth CLIENT is authenticated with HTTP Basic — omitting this WAS the original 401');
    const decoded = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString('utf8');
    ok(decoded === `acme2:${process.env.LP_CLIENT_SECRET}`,
      'WIRE-9 …as client_id:client_secret, so the secret travels ONLY in that header');
    ok(!/client_secret/.test(c.body), 'WIRE-10 …and never in the form body');
    ok(c.headers.Origin === 'https://yscapgroup.digitallending.com' && /^https:\/\/yscapgroup\.digitallending\.com/.test(c.headers.Referer || ''),
      'WIRE-11 the company site is the Origin/Referer — the login is origin-gated');
    ok(/Mozilla\/5\.0/.test(c.headers['User-Agent'] || ''), 'WIRE-12 …with a browser User-Agent, matching the capture');
  }

  // ---- WHAT COMES BACK IS TREATED AS OUTPUT -------------------------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: TOKEN });
    const r = await lp.login();
    ok(r.token === 'T' && r.refreshToken === 'R', 'OUT-1 both tokens are read off the response');
    ok(typeof r.expiresAt === 'number' && r.expiresAt > Date.now(), 'OUT-2 …with an absolute expiry derived from expires_in');
    ok(r.companyId === 'c1' && r.userId === 'u1', 'OUT-3 …and the ids every pricing-configuration fetch is keyed on');
    // A TOKEN IS NEVER CONFIGURATION. Nothing may read one from the environment.
    const src = require('fs').readFileSync(require.resolve('../src/longterm/lenderprice/client.js'), 'utf8');
    ok(!/process\.env\.LP_ACCESS_TOKEN|process\.env\.LP_TOKEN|process\.env\.LP_BEARER/.test(src),
      'OUT-4 no access token is EVER read from an env var — the token is output, held in memory, and replaced');
    ok(!/localStorage|document\.cookie|req\.headers\.authorization/i.test(src),
      'OUT-5 …and none is ever taken from a browser or an inbound request header');
  }

  // ---- THE FAILURE IS NAMED, AND SAYS WHAT TO CHECK ----------------------
  {
    reset();
    RESPOND = () => ({ status: 401, body: '{"error":"invalid_grant"}' });
    const r = await lp.login();
    ok(r.ok === false && r.error === 'lp_login_unauthorized' && r.http === 401, 'FAIL-1 a 401 is reported as an unauthorized login');
    ok(/LP_CLIENT_SECRET/.test(r.message) && /LP_USERNAME/.test(r.message),
      'FAIL-2 …naming the settings to check, which is what a 401 here actually means');
    reset();
    RESPOND = () => ({ status: 500, body: 'gateway' });
    ok((await lp.login()).error === 'lp_login_failed', 'FAIL-3 any other status is a failed login, never a session');
    // Credentials never appear in an error, whatever the vendor echoes back.
    reset();
    RESPOND = () => ({ status: 500, body: `oops ${process.env.LP_PASSWORD} / ${process.env.LP_CLIENT_SECRET}` });
    const leak = JSON.stringify(await lp.login());
    ok(!leak.includes(process.env.LP_PASSWORD) && !leak.includes(process.env.LP_CLIENT_SECRET),
      'FAIL-4 …and an echoed credential is scrubbed out of the reported body');
  }

  // ---- NO CREDENTIALS → REFUSED BEFORE THE WIRE ---------------------------
  {
    const keep = { u: process.env.LP_USERNAME, p: process.env.LP_PASSWORD, s: process.env.LP_CLIENT_SECRET };
    reset();
    delete process.env.LP_USERNAME;
    const r = await lp.login();
    ok(r.ok === false && r.error === 'lp_creds_missing' && CALLS.length === 0,
      'ENV-1 with a credential missing the login refuses BEFORE any request (this is what this workstation sees)');
    ok(/Render/.test(r.message), 'ENV-2 …and says where the settings belong');
    process.env.LP_USERNAME = keep.u; process.env.LP_PASSWORD = keep.p; process.env.LP_CLIENT_SECRET = keep.s;
  }

  // ---- THE SANCTIONED VERIFICATION CANNOT PRINT A SECRET ------------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: TOKEN });
    const r = await lp.loginSelfTest();
    const s = JSON.stringify(r);
    ok(r.ok === true && r.grant === 'password' && r.companyId === 'c1',
      'SELFTEST-1 it answers whether the PASSWORD works, and which company answered');
    ok(!/"token"/.test(s) && !s.includes('"T"') && !s.includes('"R"'),
      'SELFTEST-2 …carrying NEITHER token, so printing the whole result is safe');
    ok(!s.includes(process.env.LP_PASSWORD) && !s.includes(process.env.LP_CLIENT_SECRET),
      'SELFTEST-3 …nor any credential');
    ok(r.refreshTokenIssued === true, 'SELFTEST-4 …while still saying whether a renewal is even possible');
    reset();
    RESPOND = () => ({ status: 401, body: '' });
    const bad = await lp.loginSelfTest();
    ok(bad.ok === false && bad.http === 401, 'SELFTEST-5 a rejected password reports as such');
    // It must not disturb a working session — a diagnostic that fails should leave pricing alone.
    reset();
    RESPOND = () => ({ status: 200, body: TOKEN });
    await lp.getSession();
    const before = I.authDiagnostics();
    RESPOND = () => ({ status: 401, body: '' });
    await lp.loginSelfTest();
    ok(JSON.stringify(I.authDiagnostics()) === JSON.stringify(before),
      'SELFTEST-6 …and a FAILING check leaves the warm session untouched (a diagnostic never breaks what works)');
  }

  // ---- A 401 STARTS OVER WITH THE PASSWORD -------------------------------
  // The developer's instruction, verbatim: "On 401, clear it, log in again, and retry once." That is
  // a DIFFERENT path from the proactive renewal, which tries the refresh grant first: a 401 is
  // precisely the state in which the whole session may have been invalidated upstream, so the
  // refresh token may be dead too and trying it first is a wasted round trip in front of the
  // recovery — on a request a user is waiting for.
  {
    reset();
    RESPOND = () => ({ status: 200, body: TOKEN });
    await lp.getSession();                       // a warm session WITH a refresh token
    CALLS.length = 0;
    let apiHits = 0;
    RESPOND = (c) => {
      if (/\/oauth\/token$/.test(c.url)) return { status: 200, body: TOKEN };
      apiHits += 1;
      return apiHits === 1 ? { status: 401, body: '' } : { status: 200, body: '{"data":1}' };
    };
    const r = await lp.apiGet('/rest/v1/anything');
    const grants = CALLS.filter((c) => /\/oauth\/token$/.test(c.url)).map((c) => c.form.get('grant_type'));
    ok(r.ok === true, 'REAUTH-1 a 401 recovers and the call succeeds on the retry');
    ok(grants.join(',') === 'password',
      'REAUTH-2 …by CLEARING the session and logging in with the PASSWORD — never by refreshing a token the vendor may already have killed');
    ok(apiHits === 2, 'REAUTH-3 …retried exactly ONCE');
  }

  // ---- WHOSE FAULT IS AN UPSTREAM 500? ------------------------------------
  // Measured against the live vendor 2026-08-16: a well-formed body (ours OR Lender Price's own
  // defaultSearch posted back unchanged) returns a bare status code where a message belongs, while a
  // malformed one returns a real parser error. The two look identical in a log while one is an
  // outage to escalate and the other is a bug to fix, so the connector now SAYS which — and this
  // pins the reading, because the next occurrence should cost minutes rather than the hour it cost
  // to establish.
  {
    const C = I.classifyUpstreamError;
    const bare = C(500, JSON.stringify({ timestamp: 'x', status: 500, error: 'Internal Server Error', message: '500 ', path: '/…/searchRaw' }));
    ok(bare.kind === 'vendor_downstream',
      'FAULT-1 a bare status code where a message belongs reads as THEIR downstream failure — the exact body the live vendor returns today');
    ok(/NOT our request/i.test(bare.message) && /Lender Price/.test(bare.message),
      'FAULT-2 …and says so plainly, with what to do about it (nothing on our side)');
    const parsed = C(500, JSON.stringify({ status: 500, message: 'null cannot be cast to non-null type com.fasterxml.jackson.databind.node.ObjectNode' }));
    ok(parsed.kind === 'request_rejected' && /ObjectNode/.test(parsed.message),
      'FAULT-3 a real parser error is OURS, and the vendor\'s own words are carried through');
    ok(C(500, '{"message":"  502  "}').kind === 'vendor_downstream',
      'FAULT-4 any bare status code counts, whitespace and all (it is a shape, not one magic string)');
    ok(C(422, JSON.stringify({ message: 'bad scenario' })).kind === 'unknown' &&
       C(500, 'not json at all').kind === 'unknown' &&
       C(500, null).kind === 'unknown' && C(500, undefined).kind === 'unknown',
      'FAULT-5 anything it cannot read confidently is UNKNOWN — it never guesses whose fault a failure is');
    ok(C(500, JSON.stringify({ message: '500 ' })).message !== null && C(200, '{}').kind === 'unknown',
      'FAULT-6 …and it only ever judges a failure, never a success');
  }

  // ---- THE PRICING PATH NEEDS THE *PPE* USER ID ---------------------------
  // The cause of every reasonless 500. Two user identities exist behind this vendor — the login
  // (Digital Lending Platform) issues one, the pricing engine has its own — and we had always put
  // the LOGIN's id into the pricing path, so their service looked up a loan officer that does not
  // exist in it. With the right id the SAME request returns a real, actionable sentence.
  {
    reset();
    RESPOND = (c) => {
      if (/\/oauth\/token$/.test(c.url)) return { status: 200, body: TOKEN };
      if (/ppe-user-link$/.test(c.url)) return { status: 200, body: JSON.stringify({ userId: 'PPE-USER', linkId: 'L1' }) };
      return { status: 200, body: '{}' };
    };
    const id = await I.fetchPpeUserId('u1');
    ok(id === 'PPE-USER', 'PPEID-1 the pricing user id is resolved from the platform\'s documented ppe-user-link endpoint');
    const linkCall = CALLS.find((c) => /ppe-user-link$/.test(c.url));
    ok(linkCall && /\/rest\/v1\/loanofficer\/u1\/ppe-user-link$/.test(linkCall.url),
      'PPEID-2 …looked up by the LOGIN\'s user id, which is the only id we start with');
    const before = CALLS.length;
    await I.fetchPpeUserId('u1');
    ok(CALLS.length === before, 'PPEID-3 …and cached, because it changes only when an admin re-links a user');
    // FAIL-SAFE: an unresolvable link must never make pricing worse than it already was.
    I.invalidatePpeUser();
    RESPOND = (c) => (/\/oauth\/token$/.test(c.url) ? { status: 200, body: TOKEN } : { status: 500, body: '{}' });
    ok((await I.fetchPpeUserId('u1')) === null,
      'PPEID-4 an unresolvable link answers null — the caller then falls back to the login id, exactly as before this existed');
  }

  // ---- A NAMED SETUP PROBLEM IS NOT AN OUTAGE ----------------------------
  // Measured verbatim once the right id was sent. Telling these apart is the difference between
  // chasing a vendor about an outage and asking them to finish an account.
  {
    const C = I.classifyUpstreamError;
    const cfg = C(500, JSON.stringify({ status: 500, message: 'Loan Officer Pricing Configuration not setup' }));
    ok(cfg.kind === 'vendor_not_configured',
      'SETUP-1 a NAMED configuration problem reads as a setup step, not as an outage and not as our bug');
    ok(/Loan Officer Pricing Configuration not setup/.test(cfg.message) && /understood/.test(cfg.message),
      'SETUP-2 …quoting the vendor verbatim and saying the request itself was fine');
    ok(C(500, JSON.stringify({ message: '500 ' })).kind === 'vendor_downstream',
      'SETUP-3 …while a reasonless 500 still reads as their downstream outage');
    ok(C(500, JSON.stringify({ message: 'null cannot be cast to non-null type ObjectNode' })).kind === 'request_rejected',
      'SETUP-4 …and a parser error still reads as ours');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
