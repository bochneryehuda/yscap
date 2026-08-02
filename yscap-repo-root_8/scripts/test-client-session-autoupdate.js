#!/usr/bin/env node
'use strict';

/**
 * Client auto-update + stale-request sign-out guard (owner-reported: "staff keep
 * getting logged out until they clear their cookies / site data").
 *
 * The server session logic is already correct (see test-auth-session.js). The
 * remaining cause is on the BROWSER side: a long-lived tab (or the installed PWA)
 * keeps running an OLD, logout-prone bundle because nothing forces it to update,
 * and a slow in-flight request could sign out a token that has since been
 * refreshed. This locks in the two client fixes:
 *
 *   1. The service worker forces open clients onto the new shell: the cache name
 *      is bumped (so the activate cleanup purges the old one) AND the page reloads
 *      ONCE when a new worker takes control — with a first-load guard so a fresh
 *      first visit never reloads, and a one-shot flag so it can never loop.
 *   2. A 401 signs out ONLY the exact token it PROVED dead against /auth/me, and
 *      only while that token is still the active one — so a delayed 401 from an
 *      old token can never drop a freshly-refreshed session.
 *
 * Pure source assertions — there is no browser test runner in this repo.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name) => { console.log('  ok', name); pass++; };

console.log('client session auto-update + stale-request guard');

// 1. Service worker: cache version bumped off the stale v1, and the activate
//    handler purges any cache that is not the current one.
{
  const sw = read('app-v2/public/sw.js');
  const m = /const CACHE = '([^']+)'/.exec(sw);
  assert.ok(m, 'sw.js must define a CACHE name');
  assert.notStrictEqual(m[1], 'pilot-v2-shell-v1',
    'the service-worker CACHE must be bumped off v1 so the old shell is purged');
  assert.ok(/keys\.filter\(\(k\) => k !== CACHE\)/.test(sw),
    'activate must delete every cache that is not the current CACHE');
  ok('service worker bumps the cache and purges the old one');
}

// 2. main.jsx: controllerchange auto-reload, with the first-load guard AND a
//    one-shot loop guard.
{
  const main = read('app-v2/src/main.jsx');
  assert.ok(/addEventListener\('controllerchange'/.test(main),
    'main.jsx must listen for controllerchange to auto-update open tabs');
  assert.ok(/hadController/.test(main),
    'the first controllerchange (fresh page taking a controller) must NOT reload');
  // A one-shot flag (any name) guards against a reload loop, and the page reloads.
  assert.ok(/\b(reloaded|reloading)\b/.test(main) && /location\.reload\(\)/.test(main),
    'a new worker taking control must reload the page ONCE (loop-guarded)');
  ok('open tabs auto-reload once on a new deploy, never on first load, never looping');
}

// 3. Both clients: the 401 probe reports the token it tested, and the handler
//    signs out ONLY that token, only while it is still active.
for (const p of ['app-v2/src/lib/api.js', 'app/src/lib/api.js']) {
  const src = read(p);
  // confirmSessionDead reads the current token itself and returns it on the verdict.
  assert.ok(/async function confirmSessionDead\(\)/.test(src),
    `${p}: confirmSessionDead must read the CURRENT token (no stale captured arg)`);
  assert.ok(/return \{ dead: true, reason: [^}]*token \}/.test(src),
    `${p}: the dead-session verdict must carry the token it was proved against`);
  // handle401 compares the proved token to the live token before signing out.
  assert.ok(/verdict\.token !== getToken\(\)/.test(src),
    `${p}: must sign out only the token it proved dead, and only if still active`);
  ok(`${p}: a delayed 401 can never sign out a newer (refreshed) token`);
}

console.log(`\n${pass} checks passed`);
