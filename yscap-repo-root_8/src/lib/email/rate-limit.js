'use strict';
/* =====================================================================
   rate-limit.js — the ONE gate every outbound email passes through
   before it reaches a provider.

   THE DEFECT THIS CLOSES (owner-reported): *"On certain emails, I see a
   delivery error: Resend 429, too many requests. You can only make 10
   requests per second … We need to stick with this rate limit and set up a
   queue for the emails to be sent out according to the queue. It should not
   send too many requests, more than the limit that it's allowed."*

   THE SHAPE OF THE PROBLEM. Resend's documented limit is **10 requests per
   second per TEAM, counted across every API key the team holds**. Two facts
   follow, and both of them rule out the obvious fix:

     1. It is not a per-process allowance. This deployment runs a web service,
        a pipeline worker and two cron services against the same team
        (render.yaml). Four processes each holding themselves to 10/s spend
        40/s of a 10/s budget. So the meter cannot live in memory alone —
        it lives in `email_rate_budget` (db/619), one row every sender shares.
     2. It is a rate on REQUESTS, not on messages. A fan-out that sends 60
        notifications in a tight loop is 60 requests in well under a second
        however small each message is.

   WHAT THIS MODULE DOES, IN ORDER:

     · SERIALIZES. One in-process FIFO. Sends leave in the order they were
       asked for, and only one is in flight at a time per process, so a
       fan-out can never race itself into a burst.
     · METERS, SHARED. Each send spends one token from the shared bucket in a
       single atomic UPDATE (refill-and-spend in one statement, so two
       processes cannot both take the last token). No token → it computes the
       exact wait and sleeps, then asks again.
     · LEARNS. Every provider response carries the IETF headers
       `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset`. When the
       provider states a ceiling different from the one we hold, the bucket is
       corrected to what the provider actually said — so a raised (or lowered)
       limit needs no deploy.
     · BACKS OFF, TOGETHER. On a real 429 the bucket is PAUSED until the
       provider's own reset instant, for every process at once, and the
       refused message is retried rather than lost. One refusal must not
       become a stampede of refusals.

   FAIL-SAFE, NEVER FAIL-OPEN. If the database cannot be reached the limiter
   falls back to an in-process bucket at the same rate. That is weaker than
   the shared budget — but a database blip must never turn into an unmetered
   burst, which is the failure we are here to prevent.

   PURE-ISH BY DESIGN: the bucket arithmetic and the header parsing are
   exported and unit-tested with no database and no network
   (scripts/test-email-rate-limit-pure.js).
   ===================================================================== */

const cfg = require('../../config');

// The provider's documented default. Overridable by env for a team whose limit
// Resend has raised, and then CORRECTED at runtime from the provider's own
// `ratelimit-limit` header — the env value is only the starting belief.
const DEFAULT_RPS = (() => {
  const n = Number(process.env.EMAIL_MAX_RPS);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

/* BURST = 1, AND THAT IS THE POINT — not an oversight.
   A token bucket of capacity C refilling at R permits C + R·T requests in ANY
   window of length T. With the intuitive C = R = 10 that is up to 20 calls
   inside one sliding second while the process believes it is holding 10/s. The
   first draft of this module did exactly that, and its own test caught it: 24
   sends against a 6/second budget put ELEVEN into one second.
   That is not a limiter, it is a limiter-shaped burst, and it is precisely the
   shape that produces the reported 429.

   The owner's instruction is unambiguous — *"It should not send too many
   requests, more than the limit that it's allowed"* — so the default is STRICT
   PACING: one token, refilling at `rps`, i.e. one send every 1/rps seconds. The
   bound becomes R·T + 1, which for one second is one call of slack instead of
   ten. A single interactive email still leaves immediately (the idle bucket
   always holds its one token); only a fan-out is paced, which is what a fan-out
   should be. A team that has had its ceiling raised and wants burst tolerance
   back raises `burst` on the row — a decision somebody makes deliberately,
   never the default nobody chose. */
const DEFAULT_BURST = (() => {
  const n = Number(process.env.EMAIL_BURST);
  return Number.isFinite(n) && n > 0 ? Math.min(n, DEFAULT_RPS) : 1;
})();

/* HOW LONG A CALLER MAY WAIT FOR ITS TURN. Most sends are already
   fire-and-forget or run inside a background worker, but some are awaited
   inside an HTTP request. A queue with no ceiling would turn a 400-message
   digest into a 40-second page load. When the wait would exceed this, the
   send is REFUSED with a plain, retryable error rather than silently held —
   an honest refusal the caller can log beats a request that appears to hang. */
const MAX_WAIT_MS = (() => {
  const n = Number(process.env.EMAIL_QUEUE_MAX_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120000;
})();

// Bound the queue itself so a runaway loop cannot grow it without limit and
// exhaust the heap. At 10/s a 5,000-deep queue is already an 8-minute backlog.
const MAX_QUEUE = (() => {
  const n = Number(process.env.EMAIL_QUEUE_MAX_DEPTH);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

// How many times one message is re-offered after the provider answers 429.
// Each retry waits for the provider's stated reset, so this is a count of
// cool-offs, not a tight spin.
const MAX_429_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// PURE: the token-bucket arithmetic.
// ---------------------------------------------------------------------------

/**
 * Refill a bucket to `now` and try to spend one token.
 *
 * Returns { tokens, granted, waitMs } — the bucket's state after the attempt,
 * whether a token was taken, and (when it was not) exactly how long until one
 * exists. Deliberately total: it never throws, and `waitMs` is always a finite
 * non-negative number, so a caller can act on the answer without guarding it.
 */
function refillAndSpend(state, now) {
  const rps = Number(state && state.rps) > 0 ? Number(state.rps) : DEFAULT_RPS;
  const burst = Number(state && state.burst) > 0 ? Number(state.burst) : rps;
  const last = Number(state && state.updatedAt) || now;
  const elapsedSec = Math.max(0, (now - last) / 1000);
  const held = Number.isFinite(Number(state && state.tokens)) ? Number(state.tokens) : burst;
  const tokens = Math.min(burst, held + elapsedSec * rps);
  if (tokens >= 1) return { tokens: tokens - 1, granted: true, waitMs: 0 };
  // Not enough yet — the wait is the time to accumulate the shortfall at `rps`.
  // Rounded UP to a whole millisecond: rounding down would wake a hair early and
  // spin, which is how a "wait" becomes a hot loop.
  return { tokens, granted: false, waitMs: Math.ceil(((1 - tokens) / rps) * 1000) };
}

/**
 * Read the IETF rate-limit headers off a provider response.
 *
 * Resend answers every call with `ratelimit-limit`, `ratelimit-remaining` and
 * `ratelimit-reset` (seconds until the window resets). `retry-after` is the
 * older, broader convention and may be seconds or an HTTP-date, so both forms
 * are handled. Anything unreadable comes back null rather than as a guess —
 * a fabricated ceiling is worse than no ceiling, because it would be believed.
 *
 * Accepts a `fetch` Headers object or a plain lower-cased object, so the parser
 * is testable without a network.
 */
function readRateHeaders(headers) {
  const get = (k) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(k);
    return headers[k] != null ? headers[k] : headers[k.toLowerCase()];
  };
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  let resetSec = num(get('ratelimit-reset'));
  if (resetSec == null) {
    const ra = get('retry-after');
    const asNum = num(ra);
    if (asNum != null) resetSec = asNum;
    else if (ra) {
      // HTTP-date form: the wait is the distance from now to that instant.
      const t = Date.parse(ra);
      if (Number.isFinite(t)) resetSec = Math.max(0, (t - Date.now()) / 1000);
    }
  }
  return {
    limit: num(get('ratelimit-limit')),
    remaining: num(get('ratelimit-remaining')),
    resetSec,
  };
}

/**
 * Is this error the provider refusing us for rate? Recognized from a typed
 * `status`/`statusCode` of 429 first, and only then from the message text —
 * the code is the fact, the text is the fallback for a provider (or a wrapper)
 * that lost it.
 */
function isRateLimitError(e) {
  if (!e) return false;
  const status = Number(e.status || e.statusCode);
  if (status === 429) return true;
  const m = String(e.message || '');
  return /\b429\b/.test(m) || /too many requests/i.test(m) || /rate[_ -]?limit/i.test(m);
}

// ---------------------------------------------------------------------------
// The shared bucket (Postgres), with an in-process fallback.
// ---------------------------------------------------------------------------

// The fallback bucket. Used when the shared budget is unreachable, and it is
// ALSO spent on the shared path — belt and braces, so a bug in the SQL path can
// still not produce an unmetered burst from this process.
const local = { tokens: DEFAULT_BURST, updatedAt: Date.now(), rps: DEFAULT_RPS, burst: DEFAULT_BURST };

// Set when the shared bucket is unreachable, so we log the degradation ONCE
// rather than on every message.
let sharedWarned = false;
// Learned from the provider's headers; written through to the shared row when it
// disagrees with what is stored. null until the provider has told us something.
let learnedRps = null;

const stats = { granted: 0, waited: 0, waitedMs: 0, refused: 0, retried: 0, paused: 0, queuePeak: 0 };

function db() {
  // Required lazily: this module is imported by the email chokepoint, which the
  // pure tests load with no database configured. A top-level require would open
  // a pool just to parse a header.
  try { return require('../../db'); } catch (_) { return null; }
}

/**
 * Spend one token from the SHARED bucket in a single statement.
 *
 * The whole point is that refill, the pause check and the spend are ONE atomic
 * UPDATE. Read-then-write across two statements would let two processes both
 * read "1 token left" and both spend it — which is the burst we are preventing,
 * reintroduced by the fix.
 *
 * Returns { granted, waitMs, paused } or null when the shared bucket could not
 * be reached (caller falls back to the local bucket).
 */
async function spendShared() {
  const d = db();
  if (!d || typeof d.query !== 'function') return null;
  try {
    /* ONE STATEMENT, AND IT MUST STAY ONE STATEMENT.
       `cur` reads the row FOR UPDATE, so a second process arriving at the same
       instant blocks there and — under READ COMMITTED — re-reads the row the
       first one just wrote instead of acting on a stale copy. Read-then-write as
       two statements is the classic lost update, and here a lost update is two
       processes both spending the same last token: the exact burst this table
       exists to prevent, reintroduced by the fix for it.

       `granted` is decided in SQL and RETURNED, rather than inferred in JS from
       the resulting token count — the grant and the refusal leave overlapping
       remainders (both can land in [0,1)), so inferring it would be a guess. */
    const r = await d.query(
      `WITH cur AS (
         SELECT id, rps, burst, paused_until,
                LEAST(burst, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * rps) AS refilled,
                (paused_until IS NOT NULL AND paused_until > now())                   AS paused
           FROM email_rate_budget WHERE id = TRUE FOR UPDATE
       ), decided AS (
         SELECT c.*, (NOT c.paused AND c.refilled >= 1) AS granted FROM cur c
       )
       UPDATE email_rate_budget b
          SET tokens        = CASE WHEN d.granted THEN d.refilled - 1 ELSE d.refilled END,
              updated_at    = now(),
              granted_count = b.granted_count + CASE WHEN d.granted THEN 1 ELSE 0 END,
              waited_count  = b.waited_count  + CASE WHEN d.granted THEN 0 ELSE 1 END
         FROM decided d
        WHERE b.id = d.id
        RETURNING d.granted, d.paused, d.refilled, b.rps, b.burst,
                  GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(b.paused_until, now()) - now()))) AS pause_secs`,
      []);
    const row = r.rows[0];
    if (!row) return null;                       // no seeded row → treat as unreachable
    sharedWarned = false;
    const rps = Number(row.rps) > 0 ? Number(row.rps) : DEFAULT_RPS;
    // Keep the local mirror honest so the fallback path starts from the real rate
    // rather than the compile-time default if the shared row later goes away.
    local.rps = rps;
    local.burst = Number(row.burst) > 0 ? Number(row.burst) : DEFAULT_BURST;
    if (row.granted) return { granted: true, waitMs: 0 };
    if (row.paused) {
      stats.paused++;
      // +25ms so we wake just AFTER the pause expires rather than exactly on it,
      // which would fail the `paused_until > now()` test again and spin.
      return { granted: false, paused: true, waitMs: Math.ceil(Number(row.pause_secs) * 1000) + 25 };
    }
    const refilled = Math.max(0, Number(row.refilled) || 0);
    return { granted: false, waitMs: Math.ceil(((1 - refilled) / rps) * 1000) };
  } catch (e) {
    if (!sharedWarned) {
      sharedWarned = true;
      console.warn('[email-rate] shared budget unreachable — falling back to a per-process limit:', e && e.message);
    }
    return null;
  }
}

/** Spend from the in-process bucket. Always available; never fails. */
function spendLocal() {
  const now = Date.now();
  const out = refillAndSpend(local, now);
  local.tokens = out.tokens; local.updatedAt = now;
  return out;
}

/**
 * Pause EVERY sender until `untilMs`. Called when the provider actually answers
 * 429, so the whole fleet holds off together instead of each process finding out
 * by being refused in turn.
 */
async function pauseAll(untilMs, reason) {
  const secs = Math.max(0, (untilMs - Date.now()) / 1000);
  local.tokens = 0; local.updatedAt = untilMs;   // the local bucket honours it too
  const d = db();
  if (!d || typeof d.query !== 'function') return;
  try {
    await d.query(
      `UPDATE email_rate_budget
          SET paused_until = GREATEST(COALESCE(paused_until, now()), now() + ($1 || ' seconds')::interval),
              pause_reason = $2,
              tokens = 0,
              updated_at = now(),
              refused_count = refused_count + 1
        WHERE id = TRUE`,
      [String(secs), String(reason || 'provider answered 429').slice(0, 500)]);
  } catch (_) { /* the pause is best-effort; the local bucket already holds */ }
}

/**
 * Correct the stored ceiling to what the provider actually says it is.
 *
 * Only writes when the provider's number DIFFERS from what is stored, so the
 * ordinary send does no extra write. `burst` is held equal to `rps` on purpose:
 * a bucket allowed to bank a quiet hour would spend it in one instant and be
 * refused while sitting far below its average limit.
 */
async function learnLimit(limit) {
  if (!(Number(limit) > 0)) return;
  const l = Number(limit);
  if (learnedRps === l) return;                 // already told the row
  learnedRps = l;
  // The RATE moves to what the provider says. The BURST does NOT — widening the
  // burst is a deliberate decision about how much slack to take against the
  // ceiling, and it must never happen as a side effect of reading a header.
  local.rps = l;
  const d = db();
  if (!d || typeof d.query !== 'function') return;
  try {
    await d.query(
      `UPDATE email_rate_budget SET rps = $1, tokens = LEAST(tokens, burst), updated_at = now()
        WHERE id = TRUE AND rps IS DISTINCT FROM $1`, [l]);
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// The queue.
// ---------------------------------------------------------------------------

let chain = Promise.resolve();   // the FIFO: each send links onto the previous
let depth = 0;

/**
 * Run `fn` (one provider call) under the rate limit.
 *
 * Order is preserved, one call is in flight at a time per process, and a 429
 * from the provider pauses the whole fleet and re-offers this message rather
 * than losing it.
 *
 * `fn` is handed a `note` callback so the caller can report the provider's
 * response headers back to the limiter without this module knowing anything
 * about a particular provider's client.
 */
function schedule(fn, opts = {}) {
  if (depth >= MAX_QUEUE) {
    stats.refused++;
    return Promise.reject(Object.assign(
      new Error(`Email queue is full (${depth} waiting) — the send was not attempted. It is safe to retry.`),
      { code: 'email_queue_full', retryable: true }));
  }
  depth++;
  if (depth > stats.queuePeak) stats.queuePeak = depth;
  const queuedAt = Date.now();
  const run = chain.then(() => attempt(fn, queuedAt, opts)).finally(() => { depth--; });
  // The chain must survive a rejection: if a failed send broke the link, every
  // later send in the queue would reject with someone else's error.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function attempt(fn, queuedAt, opts) {
  const maxWait = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : MAX_WAIT_MS;
  let retries = 0;
  for (;;) {
    // --- wait for a token -------------------------------------------------
    for (;;) {
      const waitedSoFar = Date.now() - queuedAt;
      if (waitedSoFar > maxWait) {
        stats.refused++;
        throw Object.assign(
          new Error(`Email was not sent: it waited ${Math.round(waitedSoFar / 1000)}s for the outbound rate limit `
            + `(${local.rps}/second, shared across every process) and gave up. It is safe to retry.`),
          { code: 'email_rate_wait_exceeded', retryable: true });
      }
      const shared = await spendShared();
      const grant = shared || spendLocal();
      // Spend the local bucket too when the shared one granted, so this process
      // can never exceed the rate on its own even if the shared path misbehaves.
      if (shared && shared.granted) spendLocal();
      if (grant.granted) { stats.granted++; break; }
      const waitMs = Math.min(Math.max(5, grant.waitMs || 25), 5000);
      stats.waited++; stats.waitedMs += waitMs;
      await sleep(waitMs);
    }

    // --- make the call ----------------------------------------------------
    try {
      const res = await fn((headers) => {
        const h = readRateHeaders(headers);
        if (h.limit) learnLimit(h.limit);
        return h;
      });
      return res;
    } catch (e) {
      if (!isRateLimitError(e) || retries >= MAX_429_RETRIES) throw e;
      // The provider refused us. Hold the WHOLE fleet until its stated reset,
      // then re-offer this same message. `e.rateHeaders` is attached by the
      // provider client; without it, back off a conservative second.
      const h = e.rateHeaders || {};
      if (h.limit) await learnLimit(h.limit);
      const waitMs = Math.min(60000, Math.max(1000, Math.ceil((Number(h.resetSec) || 1) * 1000) + 100));
      await pauseAll(Date.now() + waitMs, e.message);
      stats.retried++; retries++;
      console.warn(`[email-rate] provider answered 429 — pausing all senders ${Math.round(waitMs / 1000)}s, `
        + `then retrying (attempt ${retries}/${MAX_429_RETRIES}).`);
      await sleep(waitMs);
    }
  }
}

/** A snapshot for the health/admin surface. Never throws. */
function snapshot() {
  return {
    rps: local.rps, burst: local.burst, queueDepth: depth, maxQueue: MAX_QUEUE,
    maxWaitMs: MAX_WAIT_MS, learnedRps, sharedDegraded: sharedWarned,
    ...stats,
  };
}

/** Test seam: reset the in-process state so a unit test starts from a known bucket. */
function _resetForTest(rps, burst) {
  const r = Number(rps) > 0 ? Number(rps) : DEFAULT_RPS;
  const b = Number(burst) > 0 ? Number(burst) : DEFAULT_BURST;
  local.tokens = b; local.rps = r; local.burst = b; local.updatedAt = Date.now();
  learnedRps = null; sharedWarned = false; depth = 0; chain = Promise.resolve();
  for (const k of Object.keys(stats)) stats[k] = 0;
}

module.exports = {
  schedule, snapshot,
  // pure, exported for the unit test
  refillAndSpend, readRateHeaders, isRateLimitError,
  DEFAULT_RPS, DEFAULT_BURST, MAX_WAIT_MS, MAX_QUEUE,
  _resetForTest, _spendLocal: spendLocal, _local: local,
};
