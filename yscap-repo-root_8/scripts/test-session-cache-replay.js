#!/usr/bin/env node
'use strict';

/**
 * The cached-response replay that signed people out seconds after signing in
 * (owner-reported 2026-08-03: "logging in as Super admin ... it's shooting me
 * out after a second", error `unauthenticated`).
 *
 * What happened, end to end:
 *   1. Express answers a GET with an ETag and NO Cache-Control, so the browser's
 *      PRIVATE cache is allowed to store per-user API/auth JSON.
 *   2. It then revalidates those entries (If-None-Match). On a 304 the fetch
 *      layer hands JavaScript the STORED response's HEADERS.
 *   3. The sliding session puts a token in an `X-Refresh-Token` RESPONSE header.
 *      A stored one is therefore replayed on every later 304 — overwriting the
 *      live token with a token minted in an earlier session.
 *   4. Once that replayed token aged past its 30-day life, the next call was
 *      rejected. The SPA reads any 401 as "your session died" and signs out.
 *      Clearing site data "fixed" it because it dropped the poisoned entry.
 *
 * Three guards, all locked in here:
 *   A. the server marks /api + /auth `no-store` (stops NEW poisoning),
 *   B. both clients accept a refreshed token only if it is strictly NEWER for
 *      the SAME account (saves a browser already poisoned),
 *   C. `bad_token` names its cause in the log, so this class of bug is read off
 *      one line instead of reconstructed over days.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name) => { console.log('  ok', name); pass++; };

console.log('session cache-replay guards');

// ---------------------------------------------------------------- A. server
{
  const src = read('src/server.js');
  const guard = src.indexOf(`app.use(['/api', '/auth'], (req, res, next) => {`);
  assert.ok(guard > 0, 'server.js must default /api and /auth to a no-store Cache-Control');
  assert.ok(/res\.set\('Cache-Control', 'no-store'\)/.test(src.slice(guard, guard + 200)),
    'the /api + /auth default must be exactly no-store');

  // Position matters: mounted AFTER a router it would never run for that
  // router's responses, which is the whole bug coming back.
  const firstRouter = src.indexOf(`app.use('/auth', require('./auth').router)`);
  assert.ok(firstRouter > 0, 'expected the /auth router mount to exist');
  assert.ok(guard < firstRouter,
    'the no-store default must be mounted ABOVE the routers or it cannot cover them');
  ok('server defaults /api + /auth to no-store, above every router');

  // It is a default, not a law — the deliberately PUBLIC endpoints still set
  // their own Cache-Control in their handlers (which run later and win).
  assert.ok(/res\.set\('Cache-Control', 'public, max-age=60'\)/.test(read('src/routes/roster.js')),
    'the public roster must keep its own cacheability');
  ok('deliberately public endpoints keep their own Cache-Control');
}

// ---------------------------------------------------------------- B. clients
// Not a regex check: the shipped guard is EXECUTED against a fake localStorage.
function loadGuard(file) {
  const src = read(file);
  const grab = (name) => {
    const i = src.indexOf(`function ${name}(`);
    assert.ok(i > 0, `${file}: expected a ${name}() guard`);
    // Walk braces to the end of the function so the test always runs the real body.
    let depth = 0, started = false, j = i;
    for (; j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    return src.slice(i, j);
  };
  let stored = '';
  const sandbox = {
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    JSON, Number, String,
    getToken: () => stored,
    setToken: (t) => { stored = t; },
    __set: (t) => { stored = t; },
    __get: () => stored,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${grab('tokenClaims')}\n${grab('acceptRefreshedToken')}`, sandbox);
  return {
    set: (t) => vm.runInContext(`__set(${JSON.stringify(t)})`, sandbox),
    get: () => vm.runInContext('__get()', sandbox),
    accept: (t) => vm.runInContext(`acceptRefreshedToken(${JSON.stringify(t)})`, sandbox),
  };
}

const mk = (sub, iat) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iat, exp: iat + 2592000, kind: 'staff' })}.sig`;
};

for (const file of ['app-v2/src/lib/api.js', 'app/src/lib/api.js']) {
  const g = loadGuard(file);
  const NOW = 1785734921;
  const live = mk('super-admin', NOW);

  // THE BUG: a token minted in an earlier session, replayed off a cached 304.
  g.set(live);
  g.accept(mk('super-admin', NOW - 40 * 86400));    // 40 days old — already past its 30-day life
  assert.strictEqual(g.get(), live,
    `${file}: a replayed OLD refresh token must NOT overwrite the live session`);
  ok(`${file}: a stale X-Refresh-Token replay cannot clobber the live token`);

  // Same token replayed (the common 304 case) — also a no-op.
  g.set(live);
  g.accept(live);
  assert.strictEqual(g.get(), live, `${file}: replaying the same token must be inert`);
  ok(`${file}: replaying the identical token is inert`);

  // A genuinely newer token for the same account IS taken — the sliding session
  // must keep working, or active users get logged out at the 30-day wall.
  g.set(live);
  const newer = mk('super-admin', NOW + 43200);
  g.accept(newer);
  assert.strictEqual(g.get(), newer, `${file}: a genuinely newer token must still be accepted`);
  ok(`${file}: a real sliding-session refresh is still accepted`);

  // Never swap in another account's token.
  g.set(live);
  g.accept(mk('somebody-else', NOW + 43200));
  assert.strictEqual(g.get(), live, `${file}: a different account's token must never be adopted`);
  ok(`${file}: another account's token is never adopted`);

  // Signed out: a header must never resurrect a session.
  g.set('');
  g.accept(mk('super-admin', NOW + 43200));
  assert.strictEqual(g.get(), '', `${file}: a refresh header must not revive a signed-out session`);
  ok(`${file}: a refresh header cannot revive a signed-out session`);

  // Garbage must leave the working token alone rather than wipe it.
  g.set(live);
  g.accept('not-a-jwt');
  assert.strictEqual(g.get(), live, `${file}: an unreadable token must leave the session alone`);
  ok(`${file}: an unreadable refresh token leaves the session alone`);
}

// ------------------------------------------------------------ C. diagnosable
{
  const C = require('../src/lib/crypto');
  assert.strictEqual(C.jwtFailureReason(''), 'absent',
    'no Authorization header at all must be distinguishable');
  assert.strictEqual(C.jwtFailureReason('not-a-jwt'), 'malformed');
  assert.strictEqual(
    C.jwtFailureReason('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.' + 'A'.repeat(43)),
    'bad_signature');

  const dead = C.signJwt({ sub: 'x', kind: 'staff' }, -7200);
  assert.ok(/^expired\(/.test(C.jwtFailureReason(dead)),
    'an aged-out token must report as expired, with how stale it is');
  assert.strictEqual(C.verifyJwt(dead), null, 'an expired token must still be REFUSED');

  const good = C.signJwt({ sub: 'x', kind: 'staff' }, 600);
  assert.ok(C.verifyJwt(good), 'a valid token must still verify');

  // The reason is for the LOG only — the client keeps getting the opaque answer.
  const auth = read('src/auth/index.js');
  assert.ok(/sessionDenied\(req, res, 'bad_token', 'unauthenticated', null,\s*C\.jwtFailureReason\(raw\)\)/.test(auth),
    'bad_token must pass the failure reason as the LOG-only detail argument');
  assert.ok(/res\.status\(401\)\.json\(\{ error: message, code, session: 'invalid', \.\.\.\(extra \|\| \{\}\) \}\)/.test(auth),
    'the 401 BODY must not gain the detail — naming it to a failed caller is free recon');
  ok('bad_token names its cause in the log, never in the response');
}

console.log(`\n${pass} checks passed`);
