#!/usr/bin/env node
'use strict';
/**
 * §37.3 — THE REFRESH TOKEN WE HAVE ALWAYS CAPTURED AND NEVER USED.
 *
 * The login response carries `refresh_token` and the client stored it and did nothing with it: every
 * renewal replayed the account PASSWORD. The developer's instruction is explicit —
 *   "access token approaching expiration → try grant_type=refresh_token → store replacement access
 *    token and replacement refresh token → if refresh is rejected, perform one password login."
 *
 * WHAT THIS SUITE IS REALLY GUARDING is that the renewal can never LOSE the session. The grant has
 * not been confirmed with the vendor, so the implementation is fail-safe by construction: every
 * refresh failure — a 400, a 401, an unreadable body, a network throw — falls through to the
 * password login that has always worked. The tests below assert that fall-through on each failure
 * shape SEPARATELY, because "it fell back" is exactly the property a future refactor would break
 * quietly (a thrown error inside the renewal would leave the client unable to authenticate at all,
 * and nothing else in the system would say why).
 *
 * Three further properties are load-bearing and each has its own section:
 *   • the merge — a refresh response is a TOKEN response, not a LOGIN response, so it may omit
 *     `companyId`; taking it wholesale would leave a valid token with no company and silently drop
 *     every environment onto the static pricing fallback one hour into each deploy.
 *   • the backoff — a vendor that does not honour the grant would otherwise cost a rejected round
 *     trip before EVERY renewal, forever.
 *   • secrecy — no token, refresh token or credential may appear in diagnostics or in an error.
 *
 * Driven through the REAL IO seam (`global.fetch`), never a require-cache stub: `getSession` calls
 * its collaborators as local functions, so a module stub would silently do nothing and this suite
 * would exercise a different branch while appearing to pass. Offline; no credentials, no DB, no
 * network — the fetch stub answers everything. LT-only; no RTL imports.
 */

// Obviously-fake credentials so `credentials().ok` is true. No production Lender Price secret exists
// in this environment and none is needed: nothing here reaches the network.
process.env.LP_USERNAME = 'suite@example.invalid';
process.env.LP_PASSWORD = 'not-a-real-password';
process.env.LP_CLIENT_SECRET = 'not-a-real-client-secret';

const lp = require('../src/longterm/lenderprice/client');
const I = lp._internals;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

console.log('lender price — refresh-token renewal (fail-safe by construction)');

// ---------------------------------------------------------------------------
// PLAN — which grant to renew with. Pure; the whole truth table.
// ---------------------------------------------------------------------------
{
  const P = (s, o) => I.renewalPlan(s, o);
  ok(P(null).action === 'login', 'PLAN-1 no session at all → password login (cold start)');
  ok(P({ ok: false, refreshToken: 'r' }).action === 'login',
    'PLAN-2 a FAILED session is not a source of refresh tokens → login');
  ok(P({ ok: true }).action === 'login' && P({ ok: true }).reason === 'no_refresh_token',
    'PLAN-3 a session with no refresh token → login, saying so');
  ok(P({ ok: true, refreshToken: 'r' }).action === 'refresh',
    'PLAN-4 a session carrying a refresh token → REFRESH (the whole point)');
  ok(P({ ok: true, refreshToken: 'r' }, { now: 100, refreshBlockedUntil: 200 }).reason === 'refresh_backoff',
    'PLAN-5 inside the backoff window → straight to login, no wasted round trip');
  ok(P({ ok: true, refreshToken: 'r' }, { now: 300, refreshBlockedUntil: 200 }).action === 'refresh',
    'PLAN-6 …and once the window passes the grant is tried again');
  ok(P({ ok: true, refreshToken: 'r', refreshExpiresAt: 50 }, { now: 100 }).reason === 'refresh_expired',
    'PLAN-7 a refresh lifetime the vendor STATED and that has passed → login');
  ok(P({ ok: true, refreshToken: 'r', refreshExpiresAt: null }, { now: 1e12 }).action === 'refresh',
    'PLAN-8 an UNKNOWN refresh lifetime is tried, never assumed expired');
}

// ---------------------------------------------------------------------------
// BODY — one definition of "token body → session", and it fails safe on junk.
// ---------------------------------------------------------------------------
{
  const s = I.sessionFromTokenBody({ access_token: 'A', refresh_token: 'R', expires_in: 3600, refresh_expires_in: 7200, companyId: 'c1' }, { now: 0 });
  ok(s.token === 'A' && s.refreshToken === 'R', 'BODY-1 access + refresh tokens are both taken from the body');
  ok(s.expiresAt === 3600000 && s.refreshExpiresAt === 7200000, 'BODY-2 both lifetimes are recorded as absolute instants');
  // A NaN expiry makes _fresh() false forever, so every request would perform its own login.
  const j = I.sessionFromTokenBody({ access_token: 'A', expires_in: 'oops' }, { now: 0 });
  ok(j.expiresAt === 3599000, 'BODY-3 an unreadable expires_in falls back to the ordinary hour (never NaN → a login storm)');
  ok(I.sessionFromTokenBody({ access_token: 'A', expires_in: -5 }, { now: 0 }).expiresAt === 3599000,
    'BODY-4 …and so does a negative one');
  ok(I.sessionFromTokenBody({ access_token: 'A' }, { now: 0 }).refreshExpiresAt === null,
    'BODY-5 an absent refresh lifetime is UNKNOWN (null), not zero');
}

// ---------------------------------------------------------------------------
// MERGE — a refresh response is a TOKEN response, not a LOGIN response.
// ---------------------------------------------------------------------------
{
  const prev = { ok: true, token: 'OLD', refreshToken: 'R1', companyId: 'c1', userId: 'u1', profile: { email: 'a@b.c', person: { id: 1 } } };
  const fresh = I.sessionFromTokenBody({ access_token: 'NEW', refresh_token: 'R2', expires_in: 3600 }, { now: 0 });
  const m = I.mergeRefreshed(prev, fresh);
  ok(m.token === 'NEW', 'MERGE-1 the fresh ACCESS token always wins');
  ok(m.refreshToken === 'R2', 'MERGE-2 a rotated refresh token replaces the old one (the developer\'s "replacement refresh token")');
  ok(m.companyId === 'c1' && m.userId === 'u1',
    'MERGE-3 companyId/userId are CARRIED OVER — a refresh body need not restate them, and losing companyId drops pricing onto the static fallback');
  ok(m.profile && m.profile.email === 'a@b.c', 'MERGE-4 …as is the profile the password login established');
  ok(m.renewedBy === 'refresh', 'MERGE-5 the session records WHICH grant renewed it');
  const keep = I.mergeRefreshed(prev, I.sessionFromTokenBody({ access_token: 'NEW', expires_in: 3600 }, { now: 0 }));
  ok(keep.refreshToken === 'R1',
    'MERGE-6 a refresh response that omits refresh_token (optional in RFC 6749) KEEPS the working one');
  ok(I.mergeRefreshed(null, fresh).token === 'NEW', 'MERGE-7 merging onto no prior session is not a crash');
}

// ---------------------------------------------------------------------------
// The fetch seam. Every request the client makes lands here; nothing leaves the box.
// ---------------------------------------------------------------------------
const CALLS = [];
let RESPOND = () => ({ status: 500, body: '' });
global.fetch = async (url, init = {}) => {
  const body = String(init.body || '');
  const params = new URLSearchParams(body);
  const call = { url: String(url), grant: params.get('grant_type'), refreshToken: params.get('refresh_token'), headers: init.headers || {}, body };
  CALLS.push(call);
  const r = RESPOND(call, CALLS.length);
  if (r.throws) throw new Error(r.throws);
  return { status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
};
const tokenBody = (over = {}) => JSON.stringify({ access_token: 'T', refresh_token: 'R', expires_in: 60, companyId: 'c1', userId: 'u1', ...over });
function reset() { CALLS.length = 0; I.resetTokenState(); }
const grants = () => CALLS.map((c) => c.grant);

(async () => {
  // ---- WIRE — the refresh request itself ----------------------------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'T2', refresh_token: 'R2' }) });
    const r = await I.refreshSession('R1');
    const c = CALLS[0];
    ok(c.grant === 'refresh_token', 'WIRE-1 the renewal uses grant_type=refresh_token');
    ok(c.refreshToken === 'R1', 'WIRE-2 …carrying the refresh token the vendor issued us');
    ok(/^Basic /.test(c.headers.Authorization || ''),
      'WIRE-3 …with the OAuth CLIENT authenticated by Basic auth, exactly as the password login does');
    ok(!/password=/.test(c.body), 'WIRE-4 …and the account password is NOT sent on a refresh');
    ok(/\/oauth\/token$/.test(c.url), 'WIRE-5 …to the same token endpoint (host-allowlisted)');
    ok(r.ok === true && r.token === 'T2' && r.refreshToken === 'R2', 'WIRE-6 a 200 yields the replacement pair');
  }
  {
    reset();
    RESPOND = () => ({ status: 400, body: '{"error":"invalid_grant"}' });
    const r = await I.refreshSession('R1');
    ok(r.ok === false && r.rejected === true && r.error === 'lp_refresh_rejected',
      'WIRE-7 a 400 invalid_grant is a REJECTION (the ordinary "that token is spent"), not an outage');
    RESPOND = () => ({ status: 401, body: '' });
    ok((await I.refreshSession('R1')).rejected === true, 'WIRE-8 …and so is a 401');
    RESPOND = () => ({ status: 503, body: 'gateway' });
    const t = await I.refreshSession('R1');
    ok(t.ok === false && !t.rejected, 'WIRE-9 a 5xx is a TRANSIENT failure, deliberately not a rejection');
    RESPOND = () => ({ throws: 'ECONNRESET' });
    const n = await I.refreshSession('R1');
    ok(n.ok === false && n.error === 'lp_refresh_error', 'WIRE-10 a network throw is RETURNED, never thrown at the caller');
    RESPOND = () => ({ status: 200, body: '{"no_token":true}' });
    ok((await I.refreshSession('R1')).ok === false, 'WIRE-11 a 200 with no access_token is a failure, not a session with no token');
    ok((await I.refreshSession(null)).ok === false, 'WIRE-12 refreshing with no refresh token refuses before the wire');
  }

  // ---- LADDER — the renewal end to end, through getSession -----------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    const s1 = await lp.getSession();
    ok(s1.ok && grants().join(',') === 'password',
      'LADDER-1 cold start → ONE password login (there is nothing to refresh with)');
    ok(s1.renewedBy === 'password', 'LADDER-2 …recorded as such');

    // expires_in was 60s and the client renews 5 min early, so this session is already due.
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'T2', refresh_token: 'R2', expires_in: 3600 }) });
    const s2 = await lp.getSession();
    ok(grants().join(',') === 'refresh_token',
      'LADDER-3 a session approaching expiry renews with the REFRESH GRANT — the password is not replayed');
    ok(s2.token === 'T2' && s2.refreshToken === 'R2', 'LADDER-4 …storing BOTH replacements');
    ok(s2.companyId === 'c1', 'LADDER-5 …and the company survives the renewal');
    ok(CALLS.length === 1, 'LADDER-6 …in exactly one request');
  }

  // THE CARRY-OVER, EXERCISED END TO END ON A BARE TOKEN RESPONSE.
  // LADDER-5 above cannot prove it: its refresh body already carries `companyId`, so the merge is
  // never asked to carry anything. A pre-merge audit mutated the call site to `mergeRefreshed(null,
  // rr)` — a plausible refactor — and the whole suite stayed green, while against a vendor whose
  // refresh body is a bare token response the session would end with `companyId: null` and
  // `priceFoundation` would answer `lp_no_ids`: pricing dead outright, which is WORSE than the
  // static-fallback outcome the code comment predicts.
  {
    reset();
    // The password login carries the identity a refresh body need not repeat.
    RESPOND = () => ({ status: 200, body: tokenBody({ email: 'service@example.invalid' }) });
    await lp.getSession();
    CALLS.length = 0;
    // A refresh response with NOTHING but the token pair — RFC 6749's minimum, and what an
    // unobserved vendor may well send.
    RESPOND = () => ({ status: 200, body: JSON.stringify({ access_token: 'T-BARE', refresh_token: 'R-BARE', expires_in: 3600 }) });
    const s = await lp.getSession();
    ok(s.token === 'T-BARE', 'CARRY-1 a BARE refresh response still renews the access token');
    ok(s.companyId === 'c1' && s.userId === 'u1',
      'CARRY-2 …and the company/user are CARRIED OVER — without this every foundation fetch answers lp_no_ids and pricing dies outright');
    ok(s.profile && s.profile.email != null,
      'CARRY-3 …as is the profile the password login established');
  }

  // THE RENEWAL IS ACTUALLY STORED — asserted by READING IT BACK, not from the return value.
  // Every LADDER assertion above reads the value the call returned, so a mutation that returns the
  // merged session WITHOUT caching it leaves the suite green — while in production every request
  // would re-refresh with the SAME refresh token forever, and against a rotating-token server the
  // second use is rejected, so it silently degrades to a password login on every renewal.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody({ refresh_token: 'R1' }) });
    await lp.getSession();
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'T-STORED', refresh_token: 'R2', expires_in: 3600 }) });
    await lp.getSession();
    const again = await lp.getSession();          // still fresh → must be served from the cache
    ok(again.token === 'T-STORED' && CALLS.length === 1,
      'STORED-1 the renewed session is CACHED — a later call is served from it with no second request');
    ok(I.authDiagnostics().renewedBy === 'refresh',
      'STORED-2 …and the stored session records that the refresh grant renewed it');
    // Force one more renewal: it must present the ROTATED token, proving the new one was stored and
    // the old one is not being replayed.
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'T3', refresh_token: 'R3', expires_in: 60 }) });
    await lp.getSession({ force: true });
    ok(CALLS[0].refreshToken === 'R2',
      'STORED-3 the NEXT renewal presents the ROTATED refresh token, never the spent original');
  }

  // The refresh LIFETIME is carried over too — a vendor that rotates the token without restating
  // `refresh_expires_in` must not silently inherit "unknown" and lose the expiry it stated once.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody({ refresh_expires_in: 7 * 24 * 3600 }) });
    const first = await lp.getSession();
    const statedAt = first.refreshExpiresAt;
    ok(typeof statedAt === 'number', 'EXP-1 a stated refresh lifetime is recorded');
    RESPOND = () => ({ status: 200, body: JSON.stringify({ access_token: 'T9', refresh_token: 'R9', expires_in: 3600 }) });
    const s = await lp.getSession();
    ok(s.refreshExpiresAt === statedAt,
      'EXP-2 …and survives a refresh response that does not restate it');
  }

  // The 500-recovery path must NOT reset the backoff — the code comment says so, and nothing tested it.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 400, body: '{"error":"invalid_grant"}' }
      : { status: 200, body: tokenBody({ expires_in: 60 }) });
    await lp.getSession();
    const blocked = I.authDiagnostics().refreshBackoff;
    I.invalidateSession();                        // exactly what the upstream-500 recovery does
    ok(I.authDiagnostics().refreshBackoff === blocked && blocked !== null,
      'RECOVER-1 invalidateSession() does NOT clear the backoff — clearing it there re-arms a wasted rejected-refresh round trip on every upstream 500');
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ expires_in: 3600 }) });
    const s = await lp.getSession({ force: true });
    ok(s.ok === true && grants().join(',') === 'password',
      'RECOVER-2 …and the recovery still performs a real PASSWORD login (there is no session to refresh from)');
  }

  // A REJECTED refresh falls back to ONE password login — the developer's rule, and the property
  // that makes this safe to ship before the vendor confirms the grant.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    CALLS.length = 0;
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 400, body: '{"error":"invalid_grant"}' }
      : { status: 200, body: tokenBody({ access_token: 'T3', refresh_token: 'R3', expires_in: 3600 }) });
    const s = await lp.getSession();
    ok(grants().join(',') === 'refresh_token,password',
      'LADDER-7 refresh REJECTED → exactly one password login follows (never two, never none)');
    ok(s.ok === true && s.token === 'T3', 'LADDER-8 …and the caller gets a working session, not an error');
    ok(s.renewedBy === 'password', 'LADDER-9 …recorded as the password grant');
  }

  // Every OTHER failure shape must fall back too — asserted one at a time, because "it fell back"
  // is exactly what a later refactor breaks quietly.
  for (const [label, resp] of [
    ['a 5xx', { status: 503, body: '' }],
    ['a network throw', { throws: 'ECONNRESET' }],
    ['a 200 with no token', { status: 200, body: '{}' }],
    ['an unparseable body', { status: 200, body: 'not json' }],
  ]) {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    CALLS.length = 0;
    RESPOND = (c) => (c.grant === 'refresh_token' ? resp : { status: 200, body: tokenBody({ access_token: 'TX', expires_in: 3600 }) });
    const s = await lp.getSession();
    ok(s.ok === true && s.token === 'TX' && grants().join(',') === 'refresh_token,password',
      `LADDER-10 ${label} on the refresh still falls back to one password login`);
  }

  // ---- BACKOFF — a vendor that does not honour the grant is not asked forever ----
  // THE WINDOW MUST SURVIVE ITS OWN FALLBACK. The first implementation opened it on the rejection
  // and the password login that immediately follows — the fall-through, which always succeeds —
  // cleared it again, so the backoff never once applied. BACKOFF-1 is that mutation's guard.
  {
    ok(I.refreshBackoffMs(1) === I.REFRESH_GRANT_BACKOFF_MS, 'BACKOFF-0a one rejection → the base window');
    ok(I.refreshBackoffMs(2) === I.REFRESH_GRANT_BACKOFF_MS * 2 && I.refreshBackoffMs(3) === I.REFRESH_GRANT_BACKOFF_MS * 4,
      'BACKOFF-0b consecutive rejections DOUBLE the window (a vendor that never honours the grant settles down)');
    ok(I.refreshBackoffMs(99) === I.REFRESH_GRANT_BACKOFF_MAX_MS && I.refreshBackoffMs(1e9) === I.REFRESH_GRANT_BACKOFF_MAX_MS,
      'BACKOFF-0c …capped, and never overflows to Infinity however long it goes on');
    ok(I.refreshBackoffMs(0) === I.REFRESH_GRANT_BACKOFF_MS && I.refreshBackoffMs(null) === I.REFRESH_GRANT_BACKOFF_MS,
      'BACKOFF-0d a junk count is one rejection, never a zero-length window');
  }
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    // 1st renewal: refresh rejected, password login succeeds but issues a token due immediately.
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 400, body: '{"error":"invalid_grant"}' }
      : { status: 200, body: tokenBody({ expires_in: 60 }) });
    await lp.getSession();
    CALLS.length = 0;
    // 2nd renewal: the session HAS a refresh token, but the grant is in backoff.
    const s = await lp.getSession();
    ok(grants().join(',') === 'password',
      'BACKOFF-1 after a rejection the next renewal goes STRAIGHT to the password login — no wasted round trip');
    ok(s.ok === true, 'BACKOFF-2 …and the session is still perfectly good (the backoff costs nothing)');
    ok(I.authDiagnostics().refreshRejections === 1 && I.authDiagnostics().refreshBackoff !== null,
      'BACKOFF-3 …with the window and the consecutive-rejection count visible for diagnosis');
  }
  // Once the window passes, the grant is tried again — and a success forgets the whole history.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 400, body: '{"error":"invalid_grant"}' }
      : { status: 200, body: tokenBody({ expires_in: 60 }) });
    await lp.getSession();
    ok(I.authDiagnostics().refreshRejections === 1, 'BACKOFF-4 a rejection is counted');
    I.expireRefreshBackoff();   // stand in for the clock reaching the end of the window
    CALLS.length = 0;
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 200, body: tokenBody({ access_token: 'T9', expires_in: 3600 }) }
      : { status: 200, body: tokenBody() });
    const s = await lp.getSession();
    ok(grants().join(',') === 'refresh_token' && s.token === 'T9',
      'BACKOFF-5 …and once the window passes the grant gets its chance again (a merely spent token recovers)');
    ok(I.authDiagnostics().refreshRejections === 0,
      'BACKOFF-6 …a SUCCESSFUL refresh forgets the history, so one bad token never escalates the next one');
  }

  // A TRANSIENT failure must NOT open the backoff — the grant may be perfectly fine.
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    RESPOND = (c) => (c.grant === 'refresh_token' ? { status: 503, body: '' } : { status: 200, body: tokenBody({ expires_in: 60 }) });
    await lp.getSession();
    CALLS.length = 0;
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 200, body: tokenBody({ access_token: 'T8', expires_in: 3600 }) }
      : { status: 200, body: tokenBody() });
    await lp.getSession();
    ok(grants().join(',') === 'refresh_token',
      'BACKOFF-7 a transient refresh failure does NOT block the grant (only a rejection does)');
  }

  // ---- SINGLE-FLIGHT — N concurrent callers, one renewal ------------------
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'TC', expires_in: 3600 }) });
    const all = await Promise.all([lp.getSession(), lp.getSession(), lp.getSession(), lp.getSession()]);
    ok(CALLS.length === 1, 'FLIGHT-1 four concurrent callers trigger ONE renewal, not four');
    ok(all.every((s) => s.token === 'TC'), 'FLIGHT-2 …and every caller gets the same warm token');
  }

  // ---- SECRECY — nothing here may ever surface a token or a credential ----
  {
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody({ access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH' }) });
    await lp.getSession();
    const d = JSON.stringify(I.authDiagnostics());
    ok(!/SECRET-ACCESS/.test(d) && !/SECRET-REFRESH/.test(d),
      'SECRET-1 the health diagnostics carry NEITHER token — only which grant renewed and whether it is in backoff');
    ok(!new RegExp(process.env.LP_PASSWORD).test(d) && !new RegExp(process.env.LP_CLIENT_SECRET).test(d),
      'SECRET-2 …nor the password or client secret');
    ok(/"renewedBy"/.test(d) && /"hasRefreshToken"/.test(d),
      'SECRET-3 …while still saying enough to diagnose a renewal (which grant, is one held)');
    const scrubbed = I.scrub('refresh_token=SECRET-REFRESH&password=' + process.env.LP_PASSWORD);
    ok(!/SECRET-REFRESH/.test(scrubbed) && !new RegExp(process.env.LP_PASSWORD).test(scrubbed),
      'SECRET-4 an error string carrying a refresh token or password is scrubbed before it can be logged');
  }

  // ---- THE DIAGNOSTIC MUST STILL TEST THE PASSWORD -------------------------
  // `/login-check` exists to answer one question: do the credentials Render holds actually work?
  // It used to read `getSession({ force: true })`, which was exactly right while a renewal could
  // only ever BE a password login. The refresh grant changed that silently: `force` skips the
  // freshness check, but the renewal ladder then picks the REFRESH grant, so on a long-running
  // instance holding a warm session the check would answer 200 while the password was wrong,
  // expired or locked at the vendor — and the README tells an operator to curl exactly this to
  // verify credentials, so a green answer would be believed. Found by the pre-merge audit.
  {
    const route = require('../src/longterm/routes/dscr-pricer');
    const call = async () => {
      let body = null, status = 200;
      const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
      await route.handlers.loginCheck({ query: {} }, res);
      return { status, body };
    };
    reset();
    RESPOND = () => ({ status: 200, body: tokenBody() });
    await lp.getSession();                       // a warm session, carrying a refresh token
    CALLS.length = 0;
    // The vendor now REJECTS the password but would happily honour the refresh token.
    RESPOND = (c) => (c.grant === 'refresh_token'
      ? { status: 200, body: tokenBody({ access_token: 'T-REFRESHED', expires_in: 3600 }) }
      : { status: 401, body: '{"error":"invalid_grant"}' });
    const bad = await call();
    ok(bad.status === 502 && bad.body && bad.body.ok === false,
      'LOGINCHECK-1 a REJECTED PASSWORD fails the check even while the refresh grant would succeed');
    ok(grants().every((g) => g !== 'refresh_token'),
      'LOGINCHECK-2 …because the check uses the password grant only — it must never be answered by a renewal');
    CALLS.length = 0;
    RESPOND = () => ({ status: 200, body: tokenBody({ expires_in: 3600 }) });
    const good = await call();
    ok(good.status === 200 && good.body.ok === true && good.body.grant === 'password',
      'LOGINCHECK-3 a working password answers ok, saying WHICH grant proved it');
  }

  // The wrapper must actually CONSULT the rule — a pure decision nothing calls is decoration.
  {
    const src = require('fs').readFileSync(require.resolve('../src/longterm/lenderprice/client.js'), 'utf8');
    const body = src.slice(src.indexOf('async function getSession'), src.indexOf('async function apiGet'));
    ok(/renewalPlan\(/.test(body) && /refreshSession\(/.test(body) && /mergeRefreshed\(/.test(body),
      'WIRED-1 getSession consults renewalPlan and honours it (refreshSession + mergeRefreshed)');
    ok(/await login\(\)/.test(body), 'WIRED-2 …and the password login remains the unconditional fall-through');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
