'use strict';
/**
 * Storage health CARD (owner-directed 2026-07-26, after the Cloudflare R2 cutover).
 *
 * `/api/health` already reported the flat `storage*` fields, but for an OBJECT STORE those only
 * answer "are the settings present?" — which is NOT the same question as "does the bucket actually
 * answer us." The S3/R2 adapter has always exposed a live `ping()` (a real signed round-trip), but
 * nothing ever called it, so a revoked token or a mis-scoped bucket would have stayed invisible
 * until the moment a borrower tried to upload. This module builds the card that closes that gap.
 *
 * Two pieces, deliberately split so the decision logic is unit-testable with no network:
 *   - buildStorageCard(...)  PURE: turns a probe result + a ping result into the card shape.
 *   - readStorageHealth(...) async: runs probe + a TIME-BOUNDED ping, then defers to the pure one.
 *
 * NEVER THROWS and never hangs: /api/health is a liveness endpoint, so a slow or unreachable
 * bucket degrades to `reachable:false` (or `null` when the check couldn't run) — it must never
 * turn a health probe into a 500 or a stuck request. Reports status only; writes nothing.
 */

// How long a live reachability round-trip may take before we stop waiting on it. Health must
// stay fast; an object store that can't answer in this window is already a real problem.
const PING_TIMEOUT_MS = 2500;

function bool(v) { return v == null ? null : !!v; }
function str(v) { return (v == null || v === '') ? null : String(v); }

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
    // `configured` is explicit on the S3 adapter; the local disk has no such notion, so fall
    // back to its writability answer rather than inventing a value.
    const configured = (p.configured != null) ? !!p.configured : bool(p.ok);
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
    if (ping && typeof ping === 'object') {
      card.reachable = bool(ping.ok);
      card.reason = str(ping.reason);
    } else if (prov === 'local') {
      card.reason = 'local disk — no remote endpoint to reach';
    }
    // A configured-but-unreachable object store is the case worth shouting about: the settings
    // look right, so nothing else would flag it, yet every new upload would fail.
    if (card.configured && card.reachable === false) {
      card.reason = card.reason || 'configured but the storage endpoint did not answer';
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

/**
 * Async — probe the storage provider and, when it exposes a live `ping()`, actually reach the
 * endpoint (time-bounded). Never throws; always resolves to a card.
 *
 * @param {object} storage  the storage module (needs probe(); ping() is optional)
 * @param {string} provider the configured provider name
 * @param {object} opts     { timeoutMs }
 */
async function readStorageHealth(storage, provider, opts = {}) {
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : PING_TIMEOUT_MS;
  let probe = null;
  try {
    probe = (storage && typeof storage.probe === 'function') ? storage.probe() : null;
  } catch (e) {
    probe = { ok: false, error: (e && e.message) || 'probe failed' };
  }

  let ping = null;
  if (storage && typeof storage.ping === 'function') {
    let timer = null;
    try {
      ping = await Promise.race([
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
      ping = { ok: false, reason: (e && e.message) || 'ping failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return buildStorageCard({ provider, probe, ping });
}

module.exports = { buildStorageCard, readStorageHealth, PING_TIMEOUT_MS };
