'use strict';
/**
 * SharePoint mirror — pure state-transition core (Phase 1, 2026-07-21).
 *
 * ZERO I/O. Every function here is a pure function of its inputs, so the entire
 * decision surface of the state machine (which state a row moves to on success /
 * throttle / transient failure / permanent failure / lease expiry, how long to
 * back off, and how to classify a Graph error) is exhaustively unit-testable
 * WITHOUT a database or a network. The worker (Phase 2) and the alert queries
 * (Phase 3) call these so the "what should happen" logic lives in exactly one
 * place and can never diverge between the code paths that read it.
 *
 * See docs/SHAREPOINT-MIRROR-QUEUE-DESIGN.md for the full model.
 *
 * States (documents.sharepoint_mirror_status):
 *   PENDING     needs work; claimable when next_attempt_at <= now()
 *   IN_PROGRESS claimed by a worker, lease held (attempts already incremented)
 *   DONE        mirrored & recorded                              (terminal)
 *   FAILED      transient failure, will retry (visible "retrying") — claimable
 *   DEAD        permanent / exhausted; the dead-letter, alert on it (terminal)
 *   SKIPPED     deliberately never mirrored (owner policy), reason set (terminal)
 */

const STATES = Object.freeze(['PENDING', 'IN_PROGRESS', 'DONE', 'FAILED', 'DEAD', 'SKIPPED']);
const TERMINAL = Object.freeze(new Set(['DONE', 'DEAD', 'SKIPPED']));
const CLAIMABLE = Object.freeze(new Set(['PENDING', 'FAILED']));

// Legal transitions (source of truth for the guard + tests). IN_PROGRESS is
// reachable ONLY from a claimable state (the atomic claim). A crash leaves a row
// IN_PROGRESS with an expired lease; the reaper moves it back to PENDING or to
// DEAD — both are listed. Terminal states have no outgoing edges EXCEPT the
// external-audit re-enqueue (DONE -> PENDING) that heals a deleted/drifted
// mirror, which is an explicit, deliberate transition.
const LEGAL = Object.freeze({
  PENDING:     new Set(['IN_PROGRESS', 'SKIPPED']),
  FAILED:      new Set(['IN_PROGRESS', 'SKIPPED']),
  IN_PROGRESS: new Set(['DONE', 'FAILED', 'PENDING', 'DEAD']),
  DONE:        new Set(['PENDING']),          // anti-entropy re-mirror (integrity/corrupt)
  DEAD:        new Set(['PENDING']),          // manual requeue from the dead-letter
  SKIPPED:     new Set(['PENDING']),          // un-skip (kind reclassified / forced)
});

// Backoff + attempt policy. Kept in one place; env overrides live in the worker.
const DEFAULTS = Object.freeze({
  baseBackoffMs: 1000,          // first transient retry ~1s
  capBackoffMs: 300000,         // 5 min ceiling
  maxAttempts: 8,               // matches the historical MAX_ATTEMPTS
  permanentConfirmations: 2,    // require 2 permanent verdicts before DEAD (1 if unambiguous)
});

function isTerminal(status) { return TERMINAL.has(status); }
function isClaimable(status) { return CLAIMABLE.has(status); }
function canTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false;
  return LEGAL[from] ? LEGAL[from].has(to) : false;
}

/**
 * AWS full-jitter capped exponential backoff:
 *   sleep = random(0, min(cap, base * 2^attempt))
 * `rng` is injectable so tests are deterministic; defaults to Math.random.
 * `attempt` is the (already-incremented) attempt count for this row.
 */
function backoffMs(attempt, { base = DEFAULTS.baseBackoffMs, cap = DEFAULTS.capBackoffMs, rng = Math.random } = {}) {
  const a = Math.max(0, attempt | 0);
  const ceiling = Math.min(cap, base * Math.pow(2, Math.min(a, 30))); // clamp exponent to avoid Infinity
  return Math.floor(rng() * ceiling);
}

/**
 * Parse the throttle delay from Graph/SharePoint response headers.
 * Honors the GREATER of Retry-After and RateLimit-Reset (both in seconds), as
 * Microsoft requires, and never returns less than a small floor. Header lookup
 * is case-insensitive and tolerant of a missing/garbage header.
 */
function throttleDelayMs(headers = {}, { jitterMs = 0, now = Date.now() } = {}) {
  const get = (name) => {
    if (!headers) return undefined;
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name) return headers[k];
    return undefined;
  };
  // Common case is delta-seconds ("10"). Also tolerate the HTTP-date form of
  // Retry-After ("Wed, 21 Oct 2015 07:28:00 GMT") by converting to seconds-from-
  // now, so a date-form header is honored rather than silently floored to 1s.
  const secs = (v) => {
    if (v == null) return 0;
    const s = String(v).trim();
    const n = parseInt(s, 10);
    if (Number.isFinite(n) && n >= 0 && s === String(n)) return n; // pure integer seconds
    const t = Date.parse(s);
    if (Number.isFinite(t)) { const d = Math.round((t - now) / 1000); return d > 0 ? d : 0; }
    return 0;
  };
  const ra = secs(get('retry-after'));
  const rl = secs(get('ratelimit-reset'));
  const base = Math.max(ra, rl, 1); // at least 1s
  return base * 1000 + Math.max(0, jitterMs);
}

/**
 * Classify a Graph attempt result into a verdict. Pure — takes the HTTP status
 * (or null for a network/timeout error) and the response headers.
 * Verdicts: SUCCESS | THROTTLE | TRANSIENT | PERMANENT | ADOPT | SESSION_RESTART
 *           | AUTH | BENIGN
 * `countsAttempt` tells the caller whether this consumes the retry budget
 * (throttle and benign do NOT).
 */
function classify(status, headers = {}) {
  if (status === 200 || status === 201 || status === 204) return { verdict: 'SUCCESS', countsAttempt: true };
  if (status === 429) return { verdict: 'THROTTLE', countsAttempt: false };
  if (status === 409) return { verdict: 'ADOPT', countsAttempt: true };
  if (status === 404) return { verdict: 'SESSION_RESTART', countsAttempt: true };
  if (status === 401) return { verdict: 'AUTH', countsAttempt: true };
  if (status === 412 || status === 416) return { verdict: 'BENIGN', countsAttempt: false };
  if (status === 400 || status === 403 || status === 405 || status === 411 || status === 413 || status === 415) {
    return { verdict: 'PERMANENT', countsAttempt: true };
  }
  if (status === 423) return { verdict: 'TRANSIENT', countsAttempt: true }; // locked — slow retry
  if (status === 500 || status === 502 || status === 503 || status === 504) return { verdict: 'TRANSIENT', countsAttempt: true };
  // null / undefined / network / DNS / TLS / timeout, and any other 5xx:
  if (status == null || status >= 500) return { verdict: 'TRANSIENT', countsAttempt: true };
  // Any other 4xx we don't specifically know: treat as permanent (won't self-heal).
  return { verdict: 'PERMANENT', countsAttempt: true };
}

/**
 * Decide the next persisted state after a mirror ATTEMPT completes.
 * Inputs:
 *   status   HTTP status (null = network/timeout)
 *   headers  response headers (for THROTTLE delay)
 *   attempts the row's attempt count AFTER the claim-time increment
 *   permanentStrikes  how many prior PERMANENT/AUTH verdicts already recorded
 *                     (persisted in documents.sharepoint_permanent_strikes)
 *   opts     { maxAttempts, base, cap, rng, unambiguousPermanent, adoptProvenance }
 *            adoptProvenance ∈ { 'match', 'foreign', undefined } — the result of
 *            the worker's provenance GET on a 409 (I/O the pure lib can't do).
 * Returns a decision object:
 *   { status, verdict, countsAttempt, delayMs?, deadReason?, restartUpload?,
 *     needsProvenanceCheck?, permanentStrikes }
 * The caller writes it with the fencing UPDATE (locked_by + IN_PROGRESS guard).
 *
 * THE INVARIANT: every verdict that consumes an attempt (SESSION_RESTART, AUTH,
 * PERMANENT, TRANSIENT) has a hard `attempts >= maxAttempts -> DEAD` backstop, so
 * NO row can loop forever regardless of strikes/persistence. Only THROTTLE and
 * BENIGN re-queue without consuming budget (throttle is bounded separately by a
 * wall-clock deadline the worker enforces).
 */
function decideAfterAttempt(status, headers, attempts, permanentStrikes = 0, opts = {}) {
  const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : DEFAULTS.maxAttempts;
  const permNeeded = opts.unambiguousPermanent ? 1
    : (opts.permanentConfirmations != null ? opts.permanentConfirmations : DEFAULTS.permanentConfirmations);
  const exhausted = attempts >= maxAttempts;   // the no-infinite-loop backstop
  const c = classify(status, headers);

  if (c.verdict === 'SUCCESS') {
    return { status: 'DONE', verdict: 'SUCCESS', countsAttempt: true, permanentStrikes: 0 };
  }
  if (c.verdict === 'ADOPT') {
    // 409 nameAlreadyExists: needs a provenance GET before we can decide.
    if (opts.adoptProvenance === 'match') {
      return { status: 'DONE', verdict: 'ADOPT', countsAttempt: true, permanentStrikes: 0 };
    }
    if (opts.adoptProvenance === 'foreign') {
      return { status: 'DEAD', verdict: 'ADOPT', countsAttempt: true, deadReason: 'path_collision', permanentStrikes: 0 };
    }
    // Unresolved: keep the row claimed (IN_PROGRESS) and signal the worker to
    // fetch provenance, then re-decide with opts.adoptProvenance set. No budget
    // consumed here — but if we've somehow exhausted attempts, fail closed to DEAD
    // rather than looping forever.
    if (exhausted) return { status: 'DEAD', verdict: 'ADOPT', countsAttempt: true, deadReason: 'path_collision_unresolved', permanentStrikes };
    return { status: 'IN_PROGRESS', verdict: 'ADOPT', countsAttempt: false, needsProvenanceCheck: true, permanentStrikes };
  }
  if (c.verdict === 'BENIGN') {
    // 412/416 — not a failure; re-queue immediately, no penalty, no budget.
    return { status: 'PENDING', verdict: 'BENIGN', countsAttempt: false, delayMs: 0, permanentStrikes };
  }
  if (c.verdict === 'THROTTLE') {
    return {
      status: 'PENDING', verdict: 'THROTTLE', countsAttempt: false,
      delayMs: throttleDelayMs(headers, { jitterMs: Math.floor((opts.rng || Math.random)() * 1000) }),
      permanentStrikes,
    };
  }
  if (c.verdict === 'SESSION_RESTART') {
    // 404 upload session gone: discard it and restart the upload from byte 0.
    // This COSTS one attempt (design §5) so a persistently-404ing row cannot
    // hot-loop — it DEADs at the cap like any transient.
    if (exhausted) return { status: 'DEAD', verdict: 'SESSION_RESTART', countsAttempt: true, deadReason: 'session_restart_exhausted', permanentStrikes: 0 };
    return { status: 'FAILED', verdict: 'SESSION_RESTART', countsAttempt: true, restartUpload: true,
      delayMs: backoffMs(attempts, opts), permanentStrikes: 0 };
  }
  if (c.verdict === 'AUTH') {
    // Refresh-and-retry once; a repeat OR budget exhaustion is a config problem -> DEAD.
    const strikes = permanentStrikes + 1;
    if (exhausted || strikes >= 2) return { status: 'DEAD', verdict: 'AUTH', countsAttempt: true, deadReason: 'auth', permanentStrikes: strikes };
    return { status: 'FAILED', verdict: 'AUTH', countsAttempt: true, delayMs: backoffMs(attempts, opts), permanentStrikes: strikes };
  }
  if (c.verdict === 'PERMANENT') {
    const strikes = permanentStrikes + 1;
    // Confirm N times before DEAD (fluke protection) — but the maxAttempts
    // backstop guarantees termination even if confirmations are never reached.
    if (exhausted || strikes >= permNeeded) {
      return { status: 'DEAD', verdict: 'PERMANENT', countsAttempt: true, deadReason: `permanent_http_${status}`, permanentStrikes: strikes };
    }
    return { status: 'FAILED', verdict: 'PERMANENT', countsAttempt: true,
      delayMs: backoffMs(attempts, opts), permanentStrikes: strikes };
  }
  // TRANSIENT
  if (exhausted) {
    return { status: 'DEAD', verdict: 'TRANSIENT', countsAttempt: true, deadReason: 'transient_exhausted', permanentStrikes: 0 };
  }
  return { status: 'FAILED', verdict: 'TRANSIENT', countsAttempt: true,
    delayMs: backoffMs(attempts, opts), permanentStrikes: 0 };
}

/**
 * Reaper decision for an orphaned IN_PROGRESS row whose lease expired.
 * attempts is the row's current attempt count.
 */
function decideOnLeaseExpiry(attempts, opts = {}) {
  const maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : DEFAULTS.maxAttempts;
  if (attempts >= maxAttempts) return { status: 'DEAD', deadReason: 'lease_exhausted' };
  return { status: 'PENDING', deadReason: null };
}

/**
 * Derive the initial status from the legacy columns — the JS twin of the
 * migration's backfill CASE, so the migration and any runtime backfill agree
 * exactly. `row` uses the legacy column names.
 */
function deriveStatus(row = {}, { maxAttempts = DEFAULTS.maxAttempts } = {}) {
  const attempts = Number(row.sharepoint_backup_attempts || 0);
  // Mirror the SQL backfill's null-tests EXACTLY: `IS NOT NULL`, not truthiness,
  // so an empty-string skipped_reason ('') derives SKIPPED in both places.
  if (row.sharepoint_backed_up_at != null) return { status: 'DONE', deadReason: null };
  if (row.sharepoint_skipped_reason != null) return { status: 'SKIPPED', deadReason: null };
  if (attempts >= maxAttempts) return { status: 'DEAD', deadReason: 'transient_exhausted' };
  if (attempts > 0) return { status: 'FAILED', deadReason: null };
  return { status: 'PENDING', deadReason: null };
}

module.exports = {
  STATES, TERMINAL, CLAIMABLE, LEGAL, DEFAULTS,
  isTerminal, isClaimable, canTransition,
  backoffMs, throttleDelayMs, classify,
  decideAfterAttempt, decideOnLeaseExpiry, deriveStatus,
};
