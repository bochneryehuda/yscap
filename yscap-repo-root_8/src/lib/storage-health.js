'use strict';
/**
 * Storage health CARD (owner-directed 2026-07-26, after the Cloudflare R2 cutover).
 *
 * `/api/health` already reported the flat `storage*` fields, but for an OBJECT STORE those only
 * answer "are the settings present?" — which is NOT the same question as "does the bucket actually
 * answer us." The S3/R2 adapter has always exposed a live `ping()` (a real signed round-trip), but
 * nothing ever called it, so a revoked token or a mis-scoped bucket would have stayed invisible
 * until the moment a borrower tried to upload. This module closes that gap.
 *
 * Three pieces, split so the decision logic is unit-testable with no network:
 *   - buildStorageCard(...)  PURE: turns a probe result + a ping result into the card shape.
 *   - readStorageHealth(...) async: probe + a TIME-BOUNDED, CACHED ping, then the pure one.
 *   - the ping cache: /api/health is PUBLIC, unauthenticated, un-rate-limited, AND polled by every
 *     open staff/borrower tab every 5 min + on window focus (the stale-build watchdog). A live
 *     signed round-trip per request would put real load on R2, add latency to the endpoint Render
 *     uses as its health check, and — because an abandoned ping is not aborted — leak a pending
 *     socket per timed-out call. So the ping result is memoized for a few seconds and concurrent
 *     callers SHARE one in-flight request. A revoked token still surfaces within seconds, which is
 *     the whole point, while health stays O(1) no matter how many tabs are open.
 *
 * NEVER THROWS and never hangs: a slow or unreachable bucket degrades to `reachable:false` (or
 * `null` when no live check applies) — it must never turn a liveness probe into a 500 or a stuck
 * request. Reports status only; writes nothing.
 */

// How long a live reachability round-trip may take before we stop waiting on it.
const PING_TIMEOUT_MS = 2500;
// How long a ping VERDICT stays fresh. Short enough that a revoked key shows up almost immediately,
// long enough that a burst of health polls costs exactly one round-trip.
const PING_TTL_MS = 15000;

function bool(v) { return v == null ? null : !!v; }
function str(v) { return (v == null || v === '') ? null : String(v); }

// --- ping cache (module-level; keyed by provider so a provider change can't serve a stale verdict)
let _cache = null;        // { key, at, result }
let _inflight = null;     // { key, promise } — concurrent callers share ONE round-trip

function _resetCache() { _cache = null; _inflight = null; }

/**
 * PURE — assemble the storage health card. Never throws.
 *
 * @param {object} o
 *   provider  the configured provider name ('local' | 's3' | 'sharepoint')
 *   probe     the provider's probe() result ({ ok, base, configured, persistent, error })
 *   ping      the provider's ping() result ({ ok, reason }), or null when not applicable/attempted
 * @returns {{provider, base, configured, writable, persistent, dualReadFallback, reachable, reason}}
 *   reachable: true = the bucket answered; false = it did not; null = no live check applies
 *              (the local disk has nothing remote to reach) or the check could not be run.
 */
function buildStorageCard({ provider, probe, ping } = {}) {
  try {
    const p = (probe && typeof probe === 'object') ? probe : {};
    const prov = str(provider) || 'local';
    // `configured` is only meaningful when the provider actually reports a BOOLEAN (the S3 adapter
    // does). The local disk reports `configured: <path string>` — truthy even when nothing is set
    // up — so a bare `!!p.configured` would call every provider configured, including the
    // not-implemented stubs. Accept a real boolean, else fall back to the writability answer.
    const configured = (typeof p.configured === 'boolean') ? p.configured : bool(p.ok);
    const card = {
      provider: prov,
      base: str(p.base),
      configured,
      writable: bool(p.ok),
      persistent: bool(p.persistent),
      // During the local→object-store migration a READ that misses in the bucket falls back to
      // the old Render disk, so documents saved before the cutover still download. Surfacing it
      // tells an admin the migration is still in its overlap phase.
      dualReadFallback: prov === 's3',
      reachable: null,
      reason: null,
    };
    if (ping && typeof ping === 'object') card.reachable = bool(ping.ok);
    // Reason precedence, most specific first. A real probe ERROR (the disk could not be resolved,
    // the provider is a not-implemented stub) outranks the local-disk boilerplate — otherwise a
    // genuine failure renders as the reassuring "nothing remote to reach" line.
    card.reason = (ping && typeof ping === 'object' ? str(ping.reason) : null)
      || str(p.error)
      || (prov === 'local' ? 'local disk — no remote endpoint to reach' : null);
    // A configured-but-unreachable object store is the case worth shouting about: the settings
    // look right, so nothing else would flag it, yet every new upload would fail.
    if (card.configured && card.reachable === false && !card.reason) {
      card.reason = 'configured but the storage endpoint did not answer';
    }
    return card;
  } catch (_e) {
    // Fail SOFT: an unbuildable card must never break /api/health.
    return {
      provider: str(provider) || 'unknown',
      base: null, configured: null, writable: null, persistent: null,
      dualReadFallback: false, reachable: null, reason: 'storage health unavailable',
    };
  }
}

// Run the provider's ping() bounded by a timeout. Never throws. Not cached — see cachedPing.
async function _timedPing(storage, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(storage.ping()),
      // NOTE: this timer is deliberately NOT unref'd. An unref'd timer does not keep the event
      // loop alive, so if the ping never settles and nothing else is pending, the timeout would
      // never fire and the await would hang forever. The `finally` below clears it, so it can
      // never outlive the race — that is what keeps this from holding the process open.
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: `no answer within ${timeoutMs}ms` }), timeoutMs);
      }),
    ]);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'ping failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A fresh-enough ping verdict, doing at most ONE round-trip per TTL across all concurrent callers.
async function _cachedPing(storage, key, { timeoutMs, ttlMs, now }) {
  if (_cache && _cache.key === key && (now - _cache.at) < ttlMs) return _cache.result;
  if (_inflight && _inflight.key === key) return _inflight.promise;   // share the in-flight request
  const promise = _timedPing(storage, timeoutMs).then((result) => {
    _cache = { key, at: Date.now(), result };
    return result;
  }).finally(() => { if (_inflight && _inflight.promise === promise) _inflight = null; });
  _inflight = { key, promise };
  return promise;
}

/**
 * Async — probe the storage provider and, when it exposes a live `ping()`, actually reach the
 * endpoint (time-bounded + cached). Never throws; always resolves to a card.
 *
 * @param {object} storage  the storage module (needs probe(); ping() is optional)
 * @param {string} provider the configured provider name
 * @param {object} opts     { timeoutMs, ttlMs, fresh } — `fresh:true` bypasses the cache
 */
async function readStorageHealth(storage, provider, opts = {}) {
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : PING_TIMEOUT_MS;
  const ttlMs = (opts && Number.isFinite(opts.ttlMs)) ? opts.ttlMs : PING_TTL_MS;
  let probe = null;
  try {
    probe = (storage && typeof storage.probe === 'function') ? storage.probe() : null;
  } catch (e) {
    probe = { ok: false, error: (e && e.message) || 'probe failed' };
  }

  let ping = null;
  if (storage && typeof storage.ping === 'function') {
    // Key the cache on the provider AND the resolved base, so re-pointing at a different bucket
    // can never serve the previous bucket's verdict.
    const key = `${str(provider) || 'local'}::${(probe && probe.base) || ''}`;
    if (opts && opts.fresh) ping = await _timedPing(storage, timeoutMs);
    else ping = await _cachedPing(storage, key, { timeoutMs, ttlMs, now: Date.now() });
  }

  return buildStorageCard({ provider, probe, ping });
}

module.exports = { buildStorageCard, readStorageHealth, PING_TIMEOUT_MS, PING_TTL_MS, _resetCache };
