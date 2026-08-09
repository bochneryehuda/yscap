'use strict';
/**
 * OUTBOUND API RATE LIMITING, SHARED BY EVERY PROCESS.
 *
 * Owner-directed 2026-08-07: "ClickUp called me up with a warning about their API: we
 * cannot ask them for more than 100 requests per minute. Please set up this rule in our
 * system: never allow more than 100 requests within a minute. Also, look at our other
 * APIs that were doing too many requests. Set the limits for their allowance… We
 * shouldn't get throttled across all of our APIs, but don't get the limits too
 * aggressive."
 *
 * ── WHY CLICKUP WAS OVER, DESPITE ALREADY BEING PACED ───────────────────────────────
 * `clickup/client.js` has had a token bucket since WO-2, set to 70/min to sit under
 * ClickUp's 100. But the bucket is a MODULE-LEVEL variable, and its own comment names
 * the hole: "Per-process… multiple instances each get their own budget; a shared
 * DB-backed limiter is a later refinement." `render.yaml` runs TWO processes against the
 * SAME ClickUp token — the web service (which also runs the sync when RUN_SYNC is on) and
 * the pipeline worker — so each paced itself to 70 in ignorance of the other and the
 * token could see 140 in a minute. No per-process number can fix that. This is that
 * refinement: the budget lives in the one thing every process shares.
 *
 * THE CLASS, worth stating because it is not only ClickUp: a per-process limiter is not a
 * rate limit, it is a rate limit DIVIDED BY however many processes happen to be running —
 * a number nothing in the code knows.
 *
 * ── TWO LAYERS, AND THE FALLBACK IS THE POINT ───────────────────────────────────────
 *  1. the SHARED bucket in `api_rate_limits` (db/482) — refill and consume in ONE atomic
 *     `UPDATE … RETURNING`, so concurrent callers serialize on the row and no two
 *     processes spend the same token;
 *  2. a per-process bucket, ALWAYS also applied, sized to the same rate.
 * If the database is unreachable the shared layer is skipped and layer 2 still paces us —
 * which is exactly today's behaviour, so a DB blip degrades to the status quo instead of
 * stopping every integration. FAILING OPEN is deliberate: a limiter that halts all
 * outbound sync during a database hiccup causes a worse outage than the throttling it
 * prevents.
 *
 * ── A CONTINUOUS BUCKET, NOT A PER-MINUTE COUNTER ───────────────────────────────────
 * A fixed one-minute counter permits 100 requests at :59.9 and 100 more at :00.1 — 200
 * inside a fifth of a second, which is precisely the burst a provider's limiter measures.
 * "Never more than 100 within a minute" needs smoothing, so both layers are buckets.
 *
 * NEVER THROWS. `acquire()` resolves; the worst it does is wait.
 */

const db = require('../db');

/** Per-API defaults, each env-overridable so a provider's change needs no deploy.
 *  Every number sits BELOW the provider's published ceiling — a ceiling is where they
 *  start refusing us, not a target. The reasoning per API is in db/482. */
const DEFAULTS = {
  clickup:    { rpm: 90,  env: 'CLICKUP_MAX_RPM' },      // ClickUp's documented limit is 100/min/token
  graph:      { rpm: 600, env: 'GRAPH_MAX_RPM' },        // SharePoint mirror — bursty, had NO pacing
  encompass:  { rpm: 240, env: 'ENCOMPASS_MAX_RPM' },    // read-only, batched
  trustpoint: { rpm: 120, env: 'TRUSTPOINT_MAX_RPM' },
  sitewire:   { rpm: 120, env: 'SITEWIRE_MAX_RPM' },
  // Nominatim's published policy is ONE request per second, and a breach blocks the user
  // agent for everyone using it — the one limit here that is a requirement, not a
  // courtesy. 55 because the limit is measured at the far end (see lib/osm-gate).
  osm:        { rpm: 55,  env: 'OSM_MAX_RPM' },
  // Google's ceiling is far higher and this path backs the LIVE address autocomplete, so
  // it gets its own bucket: sharing Nominatim's would make typing an address crawl.
  google_geocode: { rpm: 600, env: 'GOOGLE_GEOCODE_MAX_RPM' },
};

/** Turn the limiter off entirely (an incident escape hatch). The per-process buckets
    still apply, so this never means "unlimited". */
const DISABLED = () => process.env.API_RATE_LIMIT_DISABLED === '1';

/* ── A HEALTH PROBE NEVER QUEUES ────────────────────────────────────────────────────
 *
 * THE BUG THIS EXISTS TO KILL (owner-reported 2026-08-09: "why is everything going down
 * every day a few times and getting back up so soon?"). Nothing was going down. The API
 * Health probes wrap each call in an 8-SECOND deadline, and `acquire()` deliberately WAITS
 * — up to a minute — when a bucket is empty. So during any busy period the probe sat in
 * OUR OWN queue, blew its 8 seconds, and reported a perfectly healthy vendor as "not
 * reachable"; minutes later the bucket refilled and it reported a recovery. Two emails per
 * blip, several times a day, about an outage that never happened. The probe was measuring
 * our own pacing, not the vendor.
 *
 * A health check is ONE request every few minutes — utterly negligible against a 90/min
 * budget — and its whole job is to report what the far end is doing. So inside this
 * context the limiter does not hold it: no wait, and no `waits` increment either, because
 * that counter is the owner's signal that a real cap is biting and a probe must not
 * pollute it.
 *
 * AsyncLocalStorage rather than an argument: the wait happens deep inside six different
 * vendor clients (ClickUp, Encompass, Sitewire, TrustPoint, SharePoint/Graph, OSM), and
 * threading an option through every one of them would be six chances to miss one — and the
 * one missed would keep flapping. The context follows the call automatically, so a client
 * added next year is covered without knowing this rule exists. It is scoped to the probe's
 * own async tree, so concurrent real traffic is completely unaffected.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const probeCtx = new AsyncLocalStorage();
/** Run `fn` as a health probe: the limiter will never make it wait. */
function runAsHealthProbe(fn) { return probeCtx.run({ probe: true }, fn); }
/** Are we inside a health probe right now? */
function inHealthProbe() { const s = probeCtx.getStore(); return !!(s && s.probe); }

function rpmFor(api) {
  const d = DEFAULTS[api];
  const raw = d && d.env ? process.env[d.env] : null;
  const n = raw != null ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return (d && d.rpm) || 60;
}

/* ── Layer 2: the per-process bucket, one per API ──────────────────────────────── */
const local = new Map();   // api -> { tokens, at, rpm }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `deadline` bounds this layer too, not only the shared one. A limiter that advertises a
 * maximum wait must honour it EVERYWHERE — otherwise a very low cap (an operator dialling
 * one down during an incident) stalls the caller here for up to a minute while
 * `maxWaitMs` looks like it is in charge. At production rates this never binds: 90/min
 * refills in under a second.
 * @returns {Promise<boolean>} true = a token was taken; false = the deadline passed.
 */
async function takeLocal(api, deadline) {
  const rpm = rpmFor(api);
  let b = local.get(api);
  if (!b || b.rpm !== rpm) { b = { tokens: rpm, at: Date.now(), rpm }; local.set(api, b); }
  for (;;) {
    const now = Date.now();
    b.tokens = Math.min(b.rpm, b.tokens + ((now - b.at) / 60000) * b.rpm);
    b.at = now;
    if (b.tokens >= 1) { b.tokens -= 1; return true; }
    const wait = Math.max(5, Math.ceil((1 - b.tokens) * (60000 / b.rpm)));
    if (deadline != null && Date.now() + wait > deadline) return false;
    await sleep(wait);
  }
}

/* ── Layer 1: the shared bucket ────────────────────────────────────────────────── */

/**
 * Try to spend one shared token.
 * @returns {Promise<{ok:true} | {ok:false, waitMs:number} | {ok:'unavailable'}>}
 *   `unavailable` = the shared layer could not be consulted (no row, DB error). The
 *   caller then relies on the per-process bucket alone — today's behaviour.
 */
async function takeShared(api) {
  const rpm = rpmFor(api);
  try {
    // Refill and consume in ONE statement. The `WHERE` recomputes the refilled balance,
    // so a caller that finds less than one token changes nothing and gets no row back.
    // `capacity`/`refill_per_min` are kept in step with the env so a runtime change to
    // the cap takes effect without editing the row by hand.
    const r = await db.query(
      `UPDATE api_rate_limits
          SET tokens = LEAST($2::float8, tokens + (EXTRACT(EPOCH FROM (now() - last_refill_at)) / 60.0) * $2::float8) - 1,
              last_refill_at = now(),
              capacity = $2::float8,
              refill_per_min = $2::float8,
              updated_at = now()
        WHERE api = $1
          AND LEAST($2::float8, tokens + (EXTRACT(EPOCH FROM (now() - last_refill_at)) / 60.0) * $2::float8) >= 1
        RETURNING tokens`,
      [api, rpm]);
    if (r.rows.length) return { ok: true };
    // No budget. How long until one token is back? Read the row to size the wait rather
    // than spinning; a missing row means this API is not managed here.
    const s = await db.query(
      `SELECT tokens, EXTRACT(EPOCH FROM (now() - last_refill_at)) AS since FROM api_rate_limits WHERE api = $1`, [api]);
    if (!s.rows.length) return { ok: 'unavailable' };
    const have = Number(s.rows[0].tokens) + (Number(s.rows[0].since) / 60) * rpm;
    const need = Math.max(0, 1 - (Number.isFinite(have) ? have : 0));
    // A floor of 25ms and a ceiling of 2s: never a hot spin, never a long unresponsive
    // stall (the caller re-checks, so a short ceiling just means another cheap look).
    return { ok: false, waitMs: Math.min(2000, Math.max(25, Math.ceil(need * (60000 / rpm)))) };
  } catch (_) {
    return { ok: 'unavailable' };
  }
}

/** Record that we had to hold a request back — a climbing count is the signal that real
    traffic wants more than the cap allows, worth seeing BEFORE a provider phones. */
async function noteWait(api) {
  try { await db.query(`UPDATE api_rate_limits SET waits = waits + 1 WHERE api = $1`, [api]); }
  catch (_) { /* observability only */ }
}

/**
 * WAIT UNTIL IT IS THIS PROCESS'S TURN TO CALL `api`.
 *
 * Both layers, always. Never throws, and never waits forever: `maxWaitMs` (default 60s)
 * bounds the hold, after which the request proceeds — a provider's own 429 handling (and
 * the durable queue behind these writes) is a better place to lose than a silently
 * abandoned sync.
 *
 * @param {string} api one of DEFAULTS' keys
 * @param {{maxWaitMs?:number}} [opts]
 * @returns {Promise<{waitedMs:number, capped:boolean, shared:boolean}>}
 */
async function acquire(api, { maxWaitMs = 60000 } = {}) {
  // A health probe is one request every few minutes and its job is to report on the FAR
  // END — so it takes its token if one is free and otherwise proceeds immediately, rather
  // than queueing and timing out against its own caller's deadline. See runAsHealthProbe.
  const probe = inHealthProbe();
  if (probe) maxWaitMs = 0;
  const started = Date.now();
  const deadline = started + Math.max(0, maxWaitMs);
  // A local-bucket timeout is the SAME outcome as a shared-bucket one: we held the
  // request as long as we said we would and now proceed, rather than dropping the work.
  const localOk = await takeLocal(api, deadline);
  if (DISABLED() || !DEFAULTS[api]) return { waitedMs: Date.now() - started, capped: !localOk, shared: false };
  if (!localOk) {
    // A hold is a hold whichever layer imposed it — counting only the shared one would
    // understate exactly when the cap is biting hardest. A PROBE is never counted: `waits`
    // is the owner's signal that a real cap is squeezing real work, and a health check
    // inflating it would send them raising a limit that is not actually in anyone's way.
    if (!probe) await noteWait(api);
    return { waitedMs: Date.now() - started, capped: true, shared: false };
  }
  let noted = false;
  for (;;) {
    const r = await takeShared(api);
    if (r.ok === true) return { waitedMs: Date.now() - started, capped: false, shared: true };
    if (r.ok === 'unavailable') return { waitedMs: Date.now() - started, capped: false, shared: false };
    if (Date.now() - started >= maxWaitMs) {
      // Held as long as we are willing to. Proceed rather than drop the work.
      return { waitedMs: Date.now() - started, capped: true, shared: true };
    }
    if (!noted) { noted = true; await noteWait(api); }
    await sleep(r.waitMs);
  }
}

/** Current state of every managed bucket — for the API-health screen. Never throws. */
async function status() {
  try {
    const r = await db.query(
      `SELECT api, capacity, refill_per_min, tokens, waits, last_refill_at FROM api_rate_limits ORDER BY api`);
    return r.rows.map((x) => ({
      api: x.api,
      limitPerMin: rpmFor(x.api),
      storedCapacity: Number(x.capacity),
      tokensAvailable: Math.max(0, Math.min(Number(x.capacity), Number(x.tokens))),
      waits: Number(x.waits),
      lastRefillAt: x.last_refill_at,
    }));
  } catch (_) { return []; }
}

module.exports = {
  acquire, status, rpmFor, DEFAULTS, runAsHealthProbe, inHealthProbe,
  _internals: { takeLocal, takeShared, DISABLED },
};
