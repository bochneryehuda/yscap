'use strict';
/* =====================================================================
   static-gzip.js — serve the site's static text assets gzipped.

   WHY THIS EXISTS
   Nothing in this app compressed anything. `express.static` does not gzip on
   its own and no compression middleware was installed, so every visitor
   downloaded the raw bytes. Measured on the public Term Sheet Studio's own
   files: 585,845 B sent where 171,096 B would do — 71% waste, ~415 KB per
   visitor, on a page that already weighs over a megabyte.

   WHY IT IS WRITTEN THIS WAY (and not with the `compression` package)
   1. NO NEW DEPENDENCY. This repo deliberately ships with only express + pg +
      pdf-lib + unpdf so Render builds cleanly and there are no native deps.
      Node's built-in zlib does the whole job.
   2. IT SERVES FILES; IT DOES NOT WRAP RESPONSES. The usual middleware
      monkey-patches res.write/res.end for EVERY response, which is exactly how
      streaming breaks — and this app streams Server-Sent Events
      (/api/events) and document downloads. This module never touches a
      response it did not create: it resolves a real file on disk, or calls
      next() and gets out of the way.
   3. IT IS MOUNTED IMMEDIATELY BEFORE THE STATIC MOUNTS, so by the time a
      request reaches it every /api and /auth route (SSE included) has already
      had its chance. It cannot see them.

   WHAT IT DELIBERATELY DOES NOT DO
   - Range requests fall through untouched (a partial response must not be
     re-encoded, and browsers never Range-request a stylesheet).
   - Anything that is not a known text extension falls through — images, fonts
     (.woff2 is already compressed), PDFs, everything else.
   - It never invents a file: only a path that resolves to a real file inside
     one of the roots is served, so the SPA's "no such file → shell" fallback
     downstream is untouched.

   CACHE HEADERS ARE THE SAME RULES AS staticOpts IN server.js and must stay in
   step: .html never caches (a stale shell pointing at a purged bundle is what
   "unstyled the whole portal" on 2026-07-15), hashed /portal/assets/ caches
   forever, everything else is left to the default.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* Text types worth compressing. .woff2/.png/.jpg/.pdf are already compressed —
   re-encoding them burns CPU to make them very slightly bigger. */
const TYPES = {
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
};

/* Below this, the gzip header costs more than it saves. */
const MIN_BYTES = 1024;

/* Compressed bytes are cached in memory, keyed on the file's identity
   (path + mtime + size), so a file is only ever gzipped once per deploy. The
   cap is a safety net, not a tuning knob — the whole static tree is a few MB.
   Entries are evicted oldest-first (a Map iterates in insertion order). */
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const v = cache.get(key);
  cache.delete(key); cache.set(key, v);   // refresh recency
  return v;
}
function cachePut(key, buf) {
  cache.set(key, buf);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/* Accept-Encoding parsing that respects an explicit refusal. `gzip;q=0` means
   "do NOT gzip me" and a naive /gzip/ test would get that backwards. */
function acceptsGzip(header) {
  const h = String(header || '').toLowerCase();
  if (!h) return false;
  for (const part of h.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';');
    const token = tokenRaw.trim();
    if (token !== 'gzip' && token !== '*') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = parseFloat(m[1]);
    }
    if (q > 0) return true;
    if (token === 'gzip') return false;   // explicitly refused
  }
  return false;
}

/* Resolve a URL path to a real file inside one of the roots, or null.
   `roots` is [{ prefix, dir }] tried in order — the same order server.js
   mounts them, so this can never serve a file express.static would not. */
function resolveFile(urlPath, roots) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch (_) { return null; }                  // malformed %-escape
  if (p.indexOf('\0') !== -1) return null;
  if (!p.startsWith('/')) return null;

  for (const { prefix, dir } of roots) {
    let rel = p;
    if (prefix) {
      if (rel !== prefix && !rel.startsWith(prefix + '/')) continue;
      rel = rel.slice(prefix.length) || '/';
    }
    // path.normalize collapses ../ ; the startsWith check below is the real
    // guard, so a crafted path can never escape the root.
    const full = path.normalize(path.join(dir, rel));
    if (full !== dir && !full.startsWith(dir + path.sep)) continue;
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isFile()) continue;
    return { full, st };
  }
  return null;
}

/* Mirrors staticOpts.setHeaders in server.js — keep the two in step. */
function cacheControlFor(filePath) {
  if (/\.html?$/.test(filePath)) return 'no-cache, must-revalidate';
  if (/[/\\]portal[/\\]assets[/\\]/.test(filePath)) return 'public, max-age=31536000, immutable';
  return null;
}

/**
 * @param {Array<{prefix?:string, dir:string}>} roots  mount roots, in order
 */
function staticGzip(roots) {
  const norm = (roots || [])
    .filter(r => r && r.dir)
    .map(r => ({ prefix: (r.prefix || '').replace(/\/+$/, ''), dir: path.resolve(r.dir) }));

  return function staticGzipMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers.range) return next();          // never re-encode a partial response
    if (!acceptsGzip(req.headers['accept-encoding'])) return next();

    const urlPath = req.path || req.url || '';
    const ext = path.extname(urlPath.split('?')[0]).toLowerCase();
    const type = TYPES[ext];
    if (!type) return next();

    let hit;
    try { hit = resolveFile(urlPath, norm); } catch (_) { return next(); }
    if (!hit) return next();                        // let express.static / the SPA fallback decide
    if (hit.st.size < MIN_BYTES) return next();     // not worth a gzip header

    const key = hit.full + ':' + hit.st.mtimeMs + ':' + hit.st.size;
    const etag = 'W/"gz-' + hit.st.size.toString(16) + '-' + Math.round(hit.st.mtimeMs).toString(16) + '"';

    // Conditional GET: a matching ETag needs no body at all.
    res.vary('Accept-Encoding');
    const inm = req.headers['if-none-match'];
    if (inm && String(inm).split(',').some(t => t.trim() === etag)) {
      res.set('ETag', etag);
      const cc = cacheControlFor(hit.full); if (cc) res.set('Cache-Control', cc);
      return res.status(304).end();
    }

    let body = cacheGet(key);
    if (!body) {
      try {
        body = zlib.gzipSync(fs.readFileSync(hit.full), { level: 6 });
      } catch (_) {
        return next();                              // unreadable → let express.static try
      }
      cachePut(key, body);
    }

    res.set('Content-Type', type);
    res.set('Content-Encoding', 'gzip');
    res.set('Content-Length', String(body.length));
    res.set('ETag', etag);
    const cc = cacheControlFor(hit.full); if (cc) res.set('Cache-Control', cc);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  };
}

module.exports = staticGzip;
module.exports._internals = { acceptsGzip, resolveFile, cacheControlFor, TYPES, MIN_BYTES };
