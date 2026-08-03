#!/usr/bin/env node
/* =====================================================================
   test-static-gzip.js — the static-gzip middleware.

   Compression sits in front of EVERY page on the site, so a bug here is a
   site-wide outage, not a slow page. This exercises it over real HTTP against
   the real files: that the bytes survive a round trip byte-for-byte, that it
   refuses everything it is supposed to refuse, and that it cannot be talked
   into serving a file outside the web roots.
   ===================================================================== */
'use strict';
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const express = require('express');

const staticGzip = require('../src/lib/static-gzip');
const { acceptsGzip, resolveFile, cacheControlFor } = staticGzip._internals;

let failures = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const webDir = path.join(__dirname, '..', 'web');
const v2Dir = path.join(webDir, 'v2');

/* ---- 1. Accept-Encoding parsing ---------------------------------------- */
console.log('\nAccept-Encoding parsing');
ok('plain gzip accepted',            () => assert.strictEqual(acceptsGzip('gzip'), true));
ok('gzip, deflate, br accepted',     () => assert.strictEqual(acceptsGzip('gzip, deflate, br'), true));
ok('missing header refused',         () => assert.strictEqual(acceptsGzip(undefined), false));
ok('br-only refused',                () => assert.strictEqual(acceptsGzip('br'), false));
// The one that a naive /gzip/ regex gets BACKWARDS: q=0 means "do not".
ok('gzip;q=0 is an explicit refusal', () => assert.strictEqual(acceptsGzip('gzip;q=0'), false));
ok('gzip;q=0.5 accepted',            () => assert.strictEqual(acceptsGzip('gzip;q=0.5'), true));
ok('wildcard accepted',              () => assert.strictEqual(acceptsGzip('*'), true));
ok('case-insensitive',               () => assert.strictEqual(acceptsGzip('GZIP'), true));

/* ---- 2. Path resolution + traversal ------------------------------------ */
console.log('\npath resolution');
const ROOTS = [{ prefix: '', dir: v2Dir }, { prefix: '/v1', dir: webDir }, { prefix: '', dir: webDir }];
ok('resolves a real v2 file', () => {
  const r = resolveFile('/tools/termsheet.js', ROOTS);
  assert(r && r.full.startsWith(v2Dir), 'expected a file under v2Dir');
});
ok('resolves a /v1 prefixed file', () => {
  const r = resolveFile('/v1/tools/termsheet.js', ROOTS);
  assert(r && r.full.startsWith(webDir) && !r.full.startsWith(v2Dir), 'expected the v1 copy');
});
ok('missing file resolves to null', () => {
  assert.strictEqual(resolveFile('/tools/does-not-exist.js', ROOTS), null);
});
ok('a directory is not a file', () => {
  assert.strictEqual(resolveFile('/tools', ROOTS), null);
});
ok('traversal cannot escape the root', () => {
  for (const p of ['/../../src/config.js', '/tools/../../../src/config.js',
                   '/%2e%2e/%2e%2e/src/config.js', '/....//....//src/config.js']) {
    const r = resolveFile(p, ROOTS);
    if (r) assert(r.full.startsWith(v2Dir) || r.full.startsWith(webDir),
      'escaped the web roots via ' + p + ' -> ' + r.full);
  }
});
ok('a null byte is refused', () => {
  assert.strictEqual(resolveFile('/tools/termsheet.js\0.png', ROOTS), null);
});
ok('a malformed %-escape is refused', () => {
  assert.strictEqual(resolveFile('/tools/%E0%A4%A.js', ROOTS), null);
});

/* ---- 3. Cache headers match staticOpts --------------------------------- */
console.log('\ncache-control mirrors server.js staticOpts');
ok('.html never caches',        () => assert.strictEqual(cacheControlFor('/x/index.html'), 'no-cache, must-revalidate'));
ok('portal assets cache hard',  () => assert(/immutable/.test(cacheControlFor('/web/v2/portal/assets/index-abc.js'))));
ok('an ordinary .js is left alone', () => assert.strictEqual(cacheControlFor('/web/v2/tools/termsheet.js'), null));

/* ---- 4. Over real HTTP, against the real files ------------------------- */
console.log('\nend-to-end over HTTP');

const app = express();
app.get('/api/events', (req, res) => {            // the SSE canary
  res.set('Content-Type', 'text/event-stream');
  res.write('data: hello\n\n');
  res.end();
});
app.use(staticGzip([{ dir: v2Dir }, { prefix: '/v1', dir: webDir }, { dir: webDir }]));
app.use(express.static(v2Dir));
app.use('/v1', express.static(webDir));
app.use(express.static(webDir));

function get(server, urlPath, headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: urlPath, method: (headers || {})._method || 'GET',
      headers: Object.assign({ 'Accept-Encoding': 'gzip' }, headers) }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const t = [];
  const check = async (name, fn) => {
    try { await fn(); t.push(['ok', name]); }
    catch (e) { failures++; t.push(['FAIL', name + ' :: ' + (e && e.message)]); }
  };

  const TARGET = '/tools/termsheet.js';
  const onDisk = fs.readFileSync(path.join(v2Dir, 'tools', 'termsheet.js'));

  await check('a big .js comes back gzipped', async () => {
    const r = await get(server, TARGET);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert(/Accept-Encoding/i.test(r.headers.vary || ''), 'Vary must name Accept-Encoding');
  });

  await check('the bytes survive the round trip EXACTLY', async () => {
    const r = await get(server, TARGET);
    const out = zlib.gunzipSync(r.body);
    assert.strictEqual(out.length, onDisk.length, 'length differs');
    assert(out.equals(onDisk), 'content differs after gunzip — corruption');
  });

  await check('it actually saves a lot', async () => {
    const r = await get(server, TARGET);
    const ratio = r.body.length / onDisk.length;
    assert(ratio < 0.45, 'expected <45% of original, got ' + Math.round(ratio * 100) + '%');
    console.log(`       (${onDisk.length.toLocaleString()} -> ${r.body.length.toLocaleString()} bytes, ${Math.round((1 - ratio) * 100)}% saved)`);
  });

  await check('Content-Length matches the compressed body', async () => {
    const r = await get(server, TARGET);
    assert.strictEqual(Number(r.headers['content-length']), r.body.length);
  });

  await check('a client that does NOT accept gzip gets plain bytes', async () => {
    const r = await get(server, TARGET, { 'Accept-Encoding': 'identity' });
    assert.notStrictEqual(r.headers['content-encoding'], 'gzip');
    assert(r.body.equals(onDisk), 'uncompressed body should be the file verbatim');
  });

  await check('gzip;q=0 is honoured as a refusal', async () => {
    const r = await get(server, TARGET, { 'Accept-Encoding': 'gzip;q=0' });
    assert.notStrictEqual(r.headers['content-encoding'], 'gzip');
  });

  await check('a matching ETag returns 304 with no body', async () => {
    const first = await get(server, TARGET);
    const etag = first.headers.etag;
    assert(etag, 'no ETag issued');
    const second = await get(server, TARGET, { 'If-None-Match': etag });
    assert.strictEqual(second.status, 304);
    assert.strictEqual(second.body.length, 0);
  });

  await check('HEAD sends headers and no body', async () => {
    const r = await get(server, TARGET, { _method: 'HEAD' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert.strictEqual(r.body.length, 0);
  });

  await check('a Range request is left to express.static', async () => {
    const r = await get(server, TARGET, { Range: 'bytes=0-99' });
    assert.notStrictEqual(r.headers['content-encoding'], 'gzip',
      'a partial response must never be gzipped by us');
  });

  await check('an .html file is gzipped AND still never cached', async () => {
    const r = await get(server, '/tools/term-sheet.html');
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    assert(/no-cache/.test(r.headers['cache-control'] || ''), 'html must stay no-cache');
    const disk = fs.readFileSync(path.join(v2Dir, 'tools', 'term-sheet.html'));
    assert(zlib.gunzipSync(r.body).equals(disk), 'html corrupted');
  });

  await check('an already-compressed asset is NOT touched', async () => {
    // .woff2/.png are already compressed; re-encoding wastes CPU for nothing.
    const r = await get(server, '/assets/images/ys-logo-t.png');
    assert.notStrictEqual(r.headers['content-encoding'], 'gzip');
  });

  await check('a missing file still 404s (SPA fallback untouched)', async () => {
    const r = await get(server, '/tools/nope-not-here.js');
    assert.strictEqual(r.status, 404);
  });

  await check('SSE is never intercepted', async () => {
    const r = await get(server, '/api/events');
    assert.notStrictEqual(r.headers['content-encoding'], 'gzip',
      'compressing a Server-Sent Events stream would break it');
    assert(/event-stream/.test(r.headers['content-type'] || ''));
  });

  await check('the /v1 copy is served from the v1 root', async () => {
    const r = await get(server, '/v1/tools/termsheet.js');
    assert.strictEqual(r.headers['content-encoding'], 'gzip');
    const disk = fs.readFileSync(path.join(webDir, 'tools', 'termsheet.js'));
    assert(zlib.gunzipSync(r.body).equals(disk), '/v1 served the wrong file');
  });

  await check('a traversal attempt cannot read outside the web roots', async () => {
    for (const p of ['/../src/config.js', '/../../src/config.js', '/%2e%2e/src/config.js']) {
      const r = await get(server, p);
      if (r.status === 200) {
        const body = r.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(r.body) : r.body;
        assert(!/DATABASE_URL|JWT_SECRET/.test(body.toString('utf8')),
          'served a server-side file via ' + p);
      }
    }
  });

  server.close();
  t.forEach(([s, n]) => console.log(`  ${s.padEnd(4)} ${n}`));
  console.log(failures ? `\nFAILED (${failures})` : '\nPASS — static gzip is safe and lossless.');
  process.exit(failures ? 1 : 0);
})();
