'use strict';
/**
 * Pricing-admin unlock — the password check that moved off the browser.
 *
 * Pure + HTTP, no database. Covers the three things that must stay true:
 *   1. NO SHIPPED FILE CARRIES THE PASSWORD OR THE CLIENT-SIDE CHECK. This is
 *      the regression that matters — the plaintext lived in a comment in four
 *      public files and the cyrb53 hash was compiled into the portal bundle
 *      every borrower downloads. A future edit that reintroduces either must
 *      fail here.
 *   2. The route accepts the same password, refuses everything else, and never
 *      leaks which part was wrong.
 *   3. /api/pricing-defaults is not stored by shared caches (the markup still
 *      has to reach the browser for the frozen engines to price — see the note
 *      on that route in src/server.js — but a CDN must not keep a copy).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------------------------------------------------------------------
// 1. The shipped files
// ---------------------------------------------------------------------------
// Every file that is served to a browser and used to carry the gate.
const SHIPPED = [
  'web/tools/termsheet.js',
  'web/v2/tools/termsheet.js',
  'web/tools/loan-application.html',
  'web/v2/tools/loan-application.html',
  'app/src/components/ProductStudioPanel.jsx',
  'app-v2/src/components/ProductStudioPanel.jsx',
];

// The historical password, spelled so this file does not contain it either.
const LEGACY_PW = ['Yscg', '@', '12345'].join('');
const LEGACY_HASH = '6019969998889003';

for (const rel of SHIPPED) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  ok(!src.includes(LEGACY_PW), `${rel}: no plaintext password`);
  ok(!src.includes(LEGACY_HASH), `${rel}: no ADMIN_HASH constant`);
  // The cyrb53 IMPLEMENTATION is the client-side check; the word may still
  // appear in a comment explaining what was removed, so match the function.
  ok(!/function\s+cyrb53\s*\(/.test(src), `${rel}: no cyrb53 implementation`);
  ok(src.includes('/api/pricing-admin/unlock'), `${rel}: asks the server instead`);
}

// The built portal bundles are what a browser actually downloads. They are
// checked in, so a stale rebuild would ship the old gate even after the source
// is clean — assert on the artifact, not only the source.
for (const dir of ['web/portal/assets', 'web/v2/portal/assets']) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) { console.log(`SKIP ${dir} (not built)`); continue; }
  for (const f of fs.readdirSync(abs).filter((n) => /^index-.*\.js$/.test(n))) {
    const src = fs.readFileSync(path.join(abs, f), 'utf8');
    ok(!src.includes(LEGACY_PW), `${dir}/${f}: no plaintext password in the bundle`);
    ok(!src.includes(LEGACY_HASH), `${dir}/${f}: no ADMIN_HASH in the bundle`);
  }
}

// The server-side module must hold a DIGEST, never the plaintext.
const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/pricing-admin.js'), 'utf8');
ok(!routeSrc.includes(LEGACY_PW), 'pricing-admin.js: stores a digest, not the plaintext');

// ---------------------------------------------------------------------------
// 2. The route
// ---------------------------------------------------------------------------
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api/pricing-admin', require(path.join(ROOT, 'src/routes/pricing-admin')));

function post(server, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/pricing-admin/unlock',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (_) {} resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    req.on('error', () => resolve({ status: 0, body: null, headers: {} }));
    req.end(data);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // The historical password still works — the owner asked for it to stay.
  let r = await post(server, { password: LEGACY_PW });
  ok(r.status === 200 && r.body && r.body.ok === true, 'the existing password still unlocks');
  ok(String(r.headers['cache-control'] || '').includes('no-store'), 'an unlock verdict is never cached');

  for (const [label, body] of [
    ['a wrong password', { password: 'nope' }],
    ['an empty password', { password: '' }],
    ['a missing password', {}],
    ['a null password', { password: null }],
    ['the digest itself', { password: '4e40702abfb8aa72c06261c4aa7ca059af5bd1f261ae0077e010b33d4db38d0c' }],
    ['a non-string password', { password: { toString: () => LEGACY_PW } }],
  ]) {
    const res = await post(server, body);
    ok(res.status === 401 && res.body && res.body.ok === false, `refuses ${label}`);
    ok(!JSON.stringify(res.body || {}).includes(LEGACY_PW), `refusal for ${label} echoes nothing back`);
  }

  // Rotating via the environment takes effect, and retires the old password.
  process.env.PRICING_ADMIN_PASSWORD = 'a-rotated-password';
  r = await post(server, { password: 'a-rotated-password' });
  ok(r.status === 200 && r.body.ok === true, 'a rotated password works');
  r = await post(server, { password: LEGACY_PW });
  ok(r.status === 401, 'rotating retires the old password');
  delete process.env.PRICING_ADMIN_PASSWORD;
  r = await post(server, { password: LEGACY_PW });
  ok(r.status === 200 && r.body.ok === true, 'unsetting falls back to the historical password');

  server.close();

  // -------------------------------------------------------------------------
  // 3. The markup endpoint's caching
  // -------------------------------------------------------------------------
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  const block = serverSrc.slice(serverSrc.indexOf("app.get('/api/pricing-defaults'"));
  const head = block.slice(0, block.indexOf('});') + 3);
  ok(/Cache-Control',\s*'private/.test(head), 'pricing-defaults is private, not publicly cacheable');
  ok(!/Cache-Control',\s*'public/.test(head), 'pricing-defaults is not `public`');
  ok(/X-Robots-Tag/.test(head), 'pricing-defaults is noindex');
  ok(/rateLimit\(\{\s*bucket:\s*'pricing-admin'/.test(serverSrc), 'the unlock route is rate limited');

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll pricing-admin unlock checks passed');
  process.exit(failures ? 1 : 0);
})();
