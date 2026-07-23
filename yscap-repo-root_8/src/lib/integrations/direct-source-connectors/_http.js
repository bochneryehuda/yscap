'use strict';
/**
 * #220 — shared guarded HTTP helper for the direct-source verification connectors
 * (Plaid, ATTOM, HouseCanary, Clear Capital, Xactus, State SoS, …).
 *
 * Every connector's real fetch() calls an authoritative outside API. They ALL go
 * through this one door so the safety properties are guaranteed in ONE place:
 *
 *   • HTTPS-ONLY — a connector may never be pointed at a plaintext or non-web
 *     scheme (an http:// base in config is refused, not silently downgraded).
 *   • NO private/loopback/metadata hosts — the URL host can never be localhost,
 *     a private-range literal, or the cloud metadata IP (169.254.169.254). The
 *     provider base URLs are fixed config values, not user input, but this is
 *     belt-and-suspenders against a misconfig or an env-var injection.
 *   • BOUNDED — every request has a hard timeout (AbortController); a hung
 *     provider can never wedge an underwriting run.
 *   • RESILIENT — transient failures (5xx, 429, network) retry with backoff via
 *     the shared resilience layer; a 4xx is returned as-is (a real answer).
 *   • NEVER THROWS — returns { ok, status, json, text, reason }. A connector's
 *     fetch() stays best-effort; the verification hub already treats a non-ok
 *     result as "skip this source", never a crash.
 *
 * Pure of the DB (no pg). Depends only on global fetch + the resilience layer.
 */
const resilience = require('../../ai/resilience');

// hostnames / IP literals a direct-source request may NEVER target.
const BLOCKED_HOSTS = Object.freeze(new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254']));

/**
 * isBlockedHost(host) — true for loopback, unspecified, link-local/metadata, and
 * RFC-1918 private IPv4 literals. Hostnames that aren't IP literals pass (they
 * resolve at connect time; we only defend against obvious internal targets in a
 * fixed-config setting). PURE, never throws.
 */
function isBlockedHost(host) {
  try {
    const h = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (BLOCKED_HOSTS.has(h)) return true;
    // RFC-1918 + link-local IPv4 literals.
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      if (a === 10) return true;
      if (a === 127) return true;
      if (a === 169 && b === 254) return true;         // link-local / metadata
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
      if (a === 192 && b === 168) return true;          // 192.168.0.0/16
      if (a === 0) return true;
    }
    return false;
  } catch (_e) { return true; } // fail CLOSED — an unparseable host is blocked
}

/**
 * assertSafeUrl(url) → { ok, url?, host?, reason? }  (PURE, never throws)
 * https-only + non-private host. Used by requestJson and unit-testable alone.
 */
function assertSafeUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (_e) { return { ok: false, reason: 'invalid url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: `refused non-https scheme ${u.protocol}` };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: `refused private/internal host ${u.hostname}` };
  return { ok: true, url: u.toString(), host: u.hostname };
}

function isRetryableStatus(status) { return status >= 500 || status === 429; }
function delay(ms) { return new Promise((r) => { setTimeout(r, Math.max(0, ms | 0)); }); }
function backoff(i) {
  try { if (typeof resilience.backoffMs === 'function') return resilience.backoffMs(i); } catch (_e) { /* fall through */ }
  return Math.min(4000, 250 * Math.pow(2, i));
}

/**
 * requestJson(url, opts?) → Promise<{ ok, status, json, text, reason }>
 *   opts: { method, headers, body (auto-JSON-stringified if object), timeoutMs,
 *           retries, fetchImpl (for tests) }
 * NEVER THROWS. A non-2xx returns ok:false with the STATUS + parsed body so the
 * caller can distinguish "provider said no" (4xx) from "provider is down" (5xx).
 * A 5xx/429/network error retries with backoff up to `retries` times (default 2);
 * a 4xx is a real answer and returns immediately. The status is always preserved.
 */
async function requestJson(url, opts = {}) {
  const safe = assertSafeUrl(url);
  if (!safe.ok) return { ok: false, status: 0, json: null, text: null, reason: safe.reason };

  const doFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, status: 0, json: null, text: null, reason: 'no fetch implementation available' };

  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(1000, Number(opts.timeoutMs)) : 15000;
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
  let body = opts.body;
  if (body != null && typeof body !== 'string') {
    try { body = JSON.stringify(body); if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'; }
    catch (_e) { return { ok: false, status: 0, json: null, text: null, reason: 'unserializable body' }; }
  }
  const retries = Number.isFinite(Number(opts.retries)) ? Math.max(0, Math.min(5, Number(opts.retries))) : 2;

  // ONE attempt — always resolves to a result shape (never throws).
  const attemptOnce = async () => {
    let controller = null; let timer = null;
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController();
        timer = setTimeout(() => { try { controller.abort(); } catch (_e) { /* noop */ } }, timeoutMs);
      }
      const res = await doFetch(safe.url, { method, headers, body, signal: controller ? controller.signal : undefined });
      const status = res && Number.isFinite(res.status) ? res.status : 0;
      let text = null;
      try { text = typeof res.text === 'function' ? await res.text() : null; } catch (_e) { text = null; }
      let json = null;
      if (text) { try { json = JSON.parse(text); } catch (_e) { json = null; } }
      const ok = status >= 200 && status < 300;
      return { ok, status, json, text, reason: ok ? null : `http ${status}`, retryable: isRetryableStatus(status) };
    } catch (e) {
      // a thrown fetch/network/abort error is retryable (status 0).
      return { ok: false, status: 0, json: null, text: null, reason: (e && e.message) || 'request failed', retryable: true };
    } finally { if (timer) clearTimeout(timer); }
  };

  let last = { ok: false, status: 0, json: null, text: null, reason: 'not attempted' };
  for (let i = 0; i <= retries; i += 1) {
    last = await attemptOnce();
    if (last.ok || !last.retryable) break;
    if (i < retries) { try { await delay(backoff(i)); } catch (_e) { /* noop */ } }
  }
  return { ok: last.ok, status: last.status, json: last.json, text: last.text, reason: last.reason };
}

module.exports = { requestJson, assertSafeUrl, isBlockedHost, BLOCKED_HOSTS };
