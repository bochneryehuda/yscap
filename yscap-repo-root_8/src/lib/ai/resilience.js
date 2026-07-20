'use strict';
/**
 * Resilience layer shared by the two Azure clients (docint.js reader + azure-openai.js
 * analyzer). It turns "one fetch that might fail" into "a bounded, well-behaved retry
 * that never hammers a down service and never silently drops a document."
 *
 * Three pieces, all dependency-free (no opossum / no npm adds — the hard repo rule) and
 * all best-effort (never throw):
 *
 *   1. classify(...)   — decide, per failure, whether it is worth retrying (transient) or
 *                        terminal (a property of THIS document / a config problem), and
 *                        whether it should count against the endpoint's circuit breaker.
 *   2. runWithRetry()  — the loop: full-jitter exponential backoff, honoring Azure's own
 *                        Retry-After / retry-after-ms header first, bounded by an overall
 *                        wall-clock deadline so a request can never hang.
 *   3. Breaker         — a tiny per-endpoint circuit breaker (in-memory): after enough
 *                        transient/auth failures it OPENS and fails fast for a cool-down,
 *                        so a sustained Azure outage or a bad key doesn't turn one failure
 *                        into thousands of doomed calls. HALF-OPEN lets a single probe
 *                        through to test recovery.
 *
 * Retry policy (from the resilience research): retry ONLY {408, 429, 500, 502, 503, 504}
 * plus transient network errno + our own timeout; everything else is terminal and routes
 * to human review (the engine already raises a "verify by hand" finding). Full jitter
 * (sleep = random()*min(cap, base*2^attempt)) is AWS's lowest-retry-storm choice.
 *
 * Everything time/random is injectable (now, sleep, rng) so the loop is unit-testable with
 * no real clock and no real network.
 */

// Transient network errno / abort names that are always worth a bounded retry.
const TRANSIENT_ERR = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH',
]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify an HTTP status into a retry/breaker decision.
 *   retryable    — safe to try again after a backoff (transient).
 *   breakerFault — should count against the endpoint's circuit breaker (transient outage
 *                  OR auth/config problem). Document-specific 4xx do NOT (a batch of bad
 *                  docs must not trip the breaker and block healthy traffic).
 *   outcome      — coarse taxonomy for surfacing to a human: transient | auth | config |
 *                  bad_request | too_large.
 */
function classifyStatus(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return { ok: true, retryable: false, breakerFault: false, outcome: 'ok' };
  if (RETRYABLE_STATUS.has(s) || s >= 500) return { ok: false, retryable: true, breakerFault: true, outcome: 'transient' };
  if (s === 401 || s === 403) return { ok: false, retryable: false, breakerFault: true, outcome: 'auth' };
  if (s === 404) return { ok: false, retryable: false, breakerFault: true, outcome: 'config' };
  if (s === 413) return { ok: false, retryable: false, breakerFault: false, outcome: 'too_large' };
  return { ok: false, retryable: false, breakerFault: false, outcome: 'bad_request' };
}

/** Classify a thrown fetch error (network drop / our AbortController timeout). */
function classifyThrown(err) {
  const name = err && err.name;
  const code = err && err.code;
  const transient = name === 'AbortError' || TRANSIENT_ERR.has(code) ||
    /timeout|socket hang up|network|fetch failed/i.test(String((err && err.message) || ''));
  return {
    ok: false, retryable: transient, breakerFault: transient,
    outcome: transient ? 'transient' : 'network',
    reason: name === 'AbortError' ? 'the request timed out' : `could not reach the service (${(err && err.message) || 'network error'})`,
  };
}

/**
 * Parse Azure's rate-limit hint into milliseconds. Azure OpenAI sends `retry-after-ms`
 * (already ms) and/or `Retry-After` (seconds); Document Intelligence sends `Retry-After`
 * (seconds). We prefer this over our computed backoff (§1.2 of the research). `headers` is
 * a Headers object or a plain {get} shim. Returns null when no hint is present/parseable.
 */
function retryAfterMs(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const ms = headers.get('retry-after-ms');
  if (ms != null && String(ms).trim() !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const secs = headers.get('retry-after');
  if (secs != null && String(secs).trim() !== '' && Number.isFinite(Number(secs))) return Math.max(0, Number(secs) * 1000);
  return null;
}

/** Full-jitter backoff for one attempt (0-indexed): random in [0, min(cap, base*2^attempt)). */
function backoffMs(attempt, { baseMs = 500, capMs = 20000, rng = Math.random } = {}) {
  const expo = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  return Math.floor(rng() * expo);
}

/**
 * A tiny per-endpoint circuit breaker. States: closed (normal) -> open (fail fast, after
 * `threshold` consecutive breaker-faults) -> half-open (one probe allowed after
 * `cooldownMs`) -> closed on a probe success, or back to open on a probe failure.
 *
 * In-memory only (fine for a single Express process); on a restart it starts closed, which
 * is the safe default (we'd rather try once than wrongly stay dark).
 */
class Breaker {
  constructor({ threshold = 5, cooldownMs = 30000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = 'closed';   // closed | open | half-open
    this.openedAt = 0;
    this.probing = false;
  }
  /** May a request go out now? Transitions open->half-open once the cooldown elapses. */
  canRequest(now) {
    if (this.state === 'open') {
      if (now - this.openedAt >= this.cooldownMs) { this.state = 'half-open'; this.probing = false; }
      else return false;
    }
    if (this.state === 'half-open') {
      if (this.probing) return false;   // one probe at a time
      this.probing = true;
    }
    return true;
  }
  onSuccess() { this.failures = 0; this.state = 'closed'; this.probing = false; }
  onFailure(now) {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open'; this.openedAt = now; this.probing = false;
    }
  }
  /**
   * A terminal document-specific error (bad/blocked/truncated doc): the endpoint ANSWERED, so
   * it is healthy. In half-open this is a successful probe — it must CLOSE the breaker and free
   * the probe slot, otherwise one blocked document during recovery strands the breaker half-open
   * forever (probing stuck true → every later request fails fast). Closed: just reset the count.
   */
  onNeutral() {
    if (this.state === 'half-open') { this.failures = 0; this.state = 'closed'; this.probing = false; }
    else if (this.state !== 'open') this.failures = 0;
  }
  snapshot() { return { state: this.state, failures: this.failures, openedAt: this.openedAt }; }
}

// One breaker per Azure endpoint (they fail independently). Fetched by name.
const _breakers = new Map();
function breakerFor(name, opts) {
  if (!_breakers.has(name)) _breakers.set(name, new Breaker(opts));
  return _breakers.get(name);
}
function _resetBreakers() { _breakers.clear(); }  // test hook

// Read-only snapshot of every endpoint breaker's state — for operator visibility on /api/health
// (so a sustained Azure outage / bad key shows up as "paused" instead of silent slow failures).
function snapshotBreakers() {
  const out = {};
  for (const [name, b] of _breakers) out[name] = b.snapshot();
  return out;
}

/**
 * Run one attempt-producing function with bounded retry.
 *
 * `attempt()` performs a SINGLE try and returns a classified result:
 *   { ok:true, ... }                                  -> success, returned as-is
 *   { ok:false, retryable, breakerFault, retryAfterMs?, outcome?, reason?, ... }
 * or it may throw (a network drop / abort) — we classify the throw ourselves.
 *
 * Options: retries (after the first try), baseMs, capMs, deadlineMs (overall wall-clock
 * budget), breaker (a Breaker or null), and injectable now/sleep/rng/onRetry for tests.
 * Returns the last result. When the breaker is open we fail fast with a transient result
 * (the caller routes it to "try again shortly" / queue-for-later — never a fake success).
 */
async function runWithRetry(attempt, opts = {}) {
  const {
    retries = 4, baseMs = 500, capMs = 20000, deadlineMs = 90000,
    now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    rng = Math.random, onRetry = null, breaker = null, label = 'the service',
  } = opts;

  const deadline = now() + deadlineMs;
  if (breaker && !breaker.canRequest(now())) {
    return { ok: false, retryable: true, outcome: 'transient', breakerOpen: true,
      reason: `${label} is temporarily paused after repeated failures — it will retry automatically shortly` };
  }

  let attemptNo = 0;
  let last;
  for (;;) {
    // Never START a new attempt once the wall-clock budget is spent (a retry loop's total time
    // is bounded by the deadline plus at most one in-flight attempt's own timeout).
    if (attemptNo > 0 && now() >= deadline) return last;
    try { last = await attempt(); }
    catch (e) { last = classifyThrown(e); }

    if (last && last.ok) { if (breaker) breaker.onSuccess(); return last; }

    // Feed the breaker: transient/auth/config faults count; document-specific 4xx are neutral.
    if (breaker) { if (last && last.breakerFault) breaker.onFailure(now()); else breaker.onNeutral(); }

    const retryable = !!(last && last.retryable);
    if (!retryable || attemptNo >= retries) return last;

    let wait = backoffMs(attemptNo, { baseMs, capMs, rng });
    if (last && last.retryAfterMs != null) wait = Math.max(wait, last.retryAfterMs);
    if (now() + wait >= deadline) return last;   // no budget left — stop, surface the failure

    attemptNo += 1;
    if (onRetry) { try { onRetry({ attempt: attemptNo, wait, outcome: last && last.outcome, reason: last && last.reason }); } catch (_) {} }
    await sleep(wait);
  }
}

module.exports = {
  classifyStatus, classifyThrown, retryAfterMs, backoffMs, runWithRetry,
  Breaker, breakerFor, snapshotBreakers, _resetBreakers,
  RETRYABLE_STATUS, TRANSIENT_ERR,
};
