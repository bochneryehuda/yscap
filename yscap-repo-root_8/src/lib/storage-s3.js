'use strict';
/**
 * S3-compatible object-storage provider (owner-directed 2026-07-26).
 *
 * A real implementation of the storage interface (src/lib/storage.js) backed by any S3-compatible
 * object store — AWS S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces. It exists so a document
 * can live in ONE shared "filing cabinet" that BOTH the web service and a separate background
 * worker can open (a Render persistent disk can only attach to one service; object storage can't).
 *
 * NO NEW DEPENDENCIES: requests are signed with AWS Signature V4 using Node's built-in `crypto`
 * (no aws-sdk). Credentials come from Render env ONLY (cfg.s3 ← S3_* vars), never source.
 *
 * INERT until selected: this module is only wired in when STORAGE_PROVIDER=s3. With the default
 * (local) it is never loaded, so entering the S3 vars in Render changes nothing until the owner
 * flips that one switch.
 *
 * Interface (identical to the local provider):
 *   save(buf, {filename})  -> { ref, provider, bytes }
 *   read(ref)              -> Buffer
 *   stream(ref)            -> { stream, size }
 *   stat(ref)              -> { size } | null   (async)
 *   remove(ref)            -> boolean
 *   probe()               -> { ok, base, configured, persistent, error }
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const cfg = require('../config');

const S3 = cfg.s3 || {};
const SERVICE = 's3';

// ── SigV4 primitives (pure) ────────────────────────────────────────────────────────────────────
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function hmacHex(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex'); }

// RFC-3986 encoding: only A-Za-z0-9-_.~ stay literal; everything else → %XX (uppercase).
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
// Canonical URI: encode each path segment but keep the '/' separators.
function canonicalUri(path) {
  if (!path || path === '/') return '/';
  return path.split('/').map(encodeRfc3986).join('/');
}
// Canonical query string: RFC-3986-encode each key+value, sort by encoded key.
function canonicalQuery(query) {
  const pairs = Object.keys(query || {}).map((k) => [encodeRfc3986(k), encodeRfc3986(query[k] == null ? '' : String(query[k]))]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}
// "YYYYMMDDTHHMMSSZ" (basic ISO-8601, no separators) + the "YYYYMMDD" datestamp.
function amzDates(date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 2026-07-26T07:00:00.000Z → 20260726T070000Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * PURE — build the SigV4 Authorization header for one request. Returns { authorization, signedHeaders,
 * canonicalRequest, stringToSign } (the last two aid testing). `headers` MUST already include host +
 * x-amz-date + x-amz-content-sha256; header names are matched case-insensitively.
 */
function signV4({ method, path, query = {}, headers, payloadHash, service, region, accessKeyId, secretAccessKey, dateStamp, amzDate }) {
  // Canonical headers: lower-cased name, trimmed+collapsed value, sorted by name.
  const lower = {};
  for (const name of Object.keys(headers)) lower[name.toLowerCase()] = String(headers[name]).trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    canonicalUri(path),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmacHex(kSigning, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signedHeaders, signature, canonicalRequest, stringToSign };
}

// ── configuration ────────────────────────────────────────────────────────────────────────────
function configured() {
  return !!(S3.bucket && S3.endpoint && S3.accessKeyId && S3.secretAccessKey);
}

// Build the request URL + canonical path for an object key. Path-style (default, what R2 wants):
// <endpoint>/<bucket>/<key>. Virtual-hosted style: <bucket>.<endpoint-host>/<key>.
function urlFor(key) {
  const ep = new URL(S3.endpoint);
  if (S3.forcePathStyle) {
    const path = `/${S3.bucket}/${key}`;
    return { protocol: ep.protocol, host: ep.host, hostname: ep.hostname, port: ep.port, path };
  }
  const host = `${S3.bucket}.${ep.host}`;
  return { protocol: ep.protocol, host, hostname: `${S3.bucket}.${ep.hostname}`, port: ep.port, path: `/${key}` };
}

/**
 * Perform ONE signed S3 request. Resolves { statusCode, headers, body:Buffer } for buffered calls,
 * or (when opts.stream) { statusCode, headers, stream } without buffering the body. Never signs a
 * streaming upload — the caller always passes a Buffer body for PUT (documents are ≤ maxUploadMb).
 */
function s3Request(method, key, { body = null, extraHeaders = {}, stream = false, clock = () => new Date() } = {}) {
  return new Promise((resolve, reject) => {
    if (!configured()) { reject(new Error('s3 storage not configured')); return; }
    const loc = urlFor(key);
    const { amzDate, dateStamp } = amzDates(clock());
    const payload = body == null ? Buffer.alloc(0) : (Buffer.isBuffer(body) ? body : Buffer.from(body));
    const payloadHash = sha256hex(payload);

    const headers = Object.assign({
      host: loc.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
    }, extraHeaders);
    if (method === 'PUT') headers['content-length'] = String(payload.length);

    const { authorization } = signV4({
      method, path: loc.path, query: {}, headers, payloadHash,
      service: SERVICE, region: S3.region || 'auto',
      accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey,
      dateStamp, amzDate,
    });
    headers.Authorization = authorization;

    const transport = loc.protocol === 'http:' ? http : https;
    const req = transport.request({
      method, host: loc.hostname, port: loc.port || undefined, path: loc.path, headers,
    }, (res) => {
      if (stream) { resolve({ statusCode: res.statusCode, headers: res.headers, stream: res }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    // A hung request must not wedge the process; documents are small so a generous cap is plenty.
    req.setTimeout(60000, () => { req.destroy(new Error('s3 request timed out')); });
    if (payload.length) req.write(payload);
    req.end();
  });
}

// Server-generated, opaque, sharded object key — same shape the local provider uses, so a document's
// ref is provider-agnostic. Never derived from user input (only a short sanitized extension is kept).
function newRef(filename) {
  const extMatch = String(filename || '').match(/\.[A-Za-z0-9]{1,12}$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const id = crypto.randomBytes(16).toString('hex');
  return `${id.slice(0, 2)}/${id}${ext}`;
}

// A key must stay inside the bucket namespace — reject traversal / absolute / empty refs.
function safeKey(ref) {
  const k = String(ref || '');
  if (!k || k.startsWith('/') || k.includes('..') || k.includes('\0')) throw new Error('invalid storage ref');
  return k;
}

const s3 = {
  name: 's3',
  get base() { return configured() ? `s3://${S3.bucket}` : null; },

  async save(buf, { filename } = {}) {
    const ref = newRef(filename);
    const res = await s3Request('PUT', ref, { body: buf });
    if (!res.statusCode || res.statusCode >= 300) {
      throw new Error(`s3 save failed (HTTP ${res.statusCode})`);
    }
    return { ref, provider: 's3', bytes: buf.length };
  },

  // Write bytes at an EXACT existing key (not a new one) — used by the one-time local→S3 copy job
  // so a document's stored ref stays valid after the move. Overwrites are idempotent (same bytes).
  async putAt(ref, buf) {
    const key = safeKey(ref);
    const res = await s3Request('PUT', key, { body: buf });
    if (!res.statusCode || res.statusCode >= 300) throw new Error(`s3 putAt failed (HTTP ${res.statusCode})`);
    return { ref: key, provider: 's3', bytes: buf.length };
  },

  async read(ref) {
    const key = safeKey(ref);
    const res = await s3Request('GET', key);
    if (res.statusCode !== 200) {
      const e = new Error(`s3 read failed (HTTP ${res.statusCode})`);
      e.statusCode = res.statusCode;
      throw e;
    }
    return res.body;
  },

  async stream(ref) {
    const key = safeKey(ref);
    const res = await s3Request('GET', key, { stream: true });
    if (res.statusCode !== 200) {
      // Drain the error body so the socket frees, then throw like fs.stat's ENOENT.
      if (res.stream) res.stream.resume();
      const e = new Error(`s3 stream failed (HTTP ${res.statusCode})`);
      e.statusCode = res.statusCode;
      throw e;
    }
    const size = parseInt(res.headers['content-length'], 10);
    return { stream: res.stream, size: Number.isFinite(size) ? size : null };
  },

  async stat(ref) {
    try {
      const key = safeKey(ref);
      const res = await s3Request('HEAD', key);
      if (res.statusCode !== 200) return null;
      const size = parseInt(res.headers['content-length'], 10);
      return { size: Number.isFinite(size) ? size : null };
    } catch (_e) { return null; }
  },

  async remove(ref) {
    try {
      const key = safeKey(ref);
      const res = await s3Request('DELETE', key);
      return !!res.statusCode && res.statusCode < 300;
    } catch (_e) { return false; }
  },

  // /api/health: is the bucket reachable + writable? A tiny write+read+delete round-trip proves the
  // credentials actually work (the difference between "keys are entered" and "keys work"). Never throws.
  probe() {
    // storage.probe() is sync in the local provider (fs check); keep the same shape but do a cheap
    // synchronous "configured?" answer here — a live round-trip would make probe() async and every
    // /api/health caller await it. `configured` reflects that all four S3 vars are present.
    return {
      ok: configured(),
      base: configured() ? `s3://${S3.bucket}` : null,
      configured: configured(),
      // Object storage is inherently persistent (survives deploys) — unlike the ephemeral container FS.
      persistent: configured(),
      error: configured() ? null : 's3 not configured (set S3_BUCKET/S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY)',
    };
  },

  // A live reachability check the health route can call explicitly (async). Best-effort, never throws.
  async ping() {
    if (!configured()) return { ok: false, reason: 's3 not configured' };
    try {
      // HEAD a key that almost certainly doesn't exist: a 404/403 still proves signing + reachability.
      const res = await s3Request('HEAD', '__pilot_healthcheck__/probe');
      const sc = res.statusCode;
      if (sc === 200 || sc === 404) return { ok: true, reason: `reachable (HTTP ${sc})` };
      if (sc === 403) return { ok: false, reason: 'credentials rejected (HTTP 403) — check the R2 token + bucket scope' };
      return { ok: false, reason: `unexpected response (HTTP ${sc})` };
    } catch (e) { return { ok: false, reason: (e && e.message) || 'unreachable' }; }
  },
};

module.exports = s3;
module.exports._internals = { signV4, sha256hex, encodeRfc3986, canonicalUri, canonicalQuery, amzDates, newRef, safeKey, configured };
