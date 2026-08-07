-- OUTBOUND API RATE LIMITS, SHARED ACROSS EVERY PROCESS (owner-directed 2026-08-07).
--
-- The owner: "ClickUp called me up with a warning about their API: we cannot ask them for
-- more than 100 requests per minute. Please set up this rule in our system: never allow
-- more than 100 requests within a minute. Also, look at our other APIs that were doing
-- too many requests. Set the limits for their allowance and look to see if this is causing
-- errors. We need to set certain limits. We shouldn't get throttled across all of our
-- APIs, but don't get the limits too aggressive."
--
-- ── WHY A TABLE, AND WHY CLICKUP WAS STILL OVER ─────────────────────────────────────
-- `src/clickup/client.js` HAS paced itself since WO-2: a token bucket at
-- CLICKUP_MAX_RPM (default 70), deliberately under ClickUp's 100/min. The bucket is a
-- MODULE-LEVEL variable, and its own comment names the hole: "Per-process (like the
-- volume breaker) — multiple instances each get their own budget; a shared DB-backed
-- limiter is a later refinement."
--
-- render.yaml runs TWO processes against the SAME ClickUp token: the `web` service
-- (ys-capital-portal, which also runs the sync when RUN_SYNC is on) and the `worker`
-- service (ys-capital-pipeline-worker). Each paces itself to 70/min in complete
-- ignorance of the other, so the token can legitimately see 140 requests in a minute —
-- comfortably over the 100 ClickUp phoned about. Raising or lowering a per-process
-- number cannot fix that; the budget has to be shared, and the only thing every process
-- shares is this database.
--
-- ── THE MECHANISM: A TOKEN BUCKET, IN ONE ATOMIC STATEMENT ──────────────────────────
-- One row per API. `tokens` refills continuously at `refill_per_min` up to `capacity`,
-- and a request consumes one. The refill and the consume happen in a SINGLE
-- `UPDATE … WHERE (refilled) >= 1 RETURNING`, so concurrent callers serialize on the
-- row lock and no two processes can spend the same token. Returning no row means "no
-- budget right now" and the caller waits.
--
-- A CONTINUOUS BUCKET, NOT A PER-MINUTE COUNTER, on purpose. A fixed one-minute counter
-- permits 100 requests at :59.9 and 100 more at :00.1 — 200 inside a fifth of a second,
-- which is exactly the burst a provider's limiter measures and rejects. The owner's
-- words are "never more than 100 requests within a minute", and only a smoothing bucket
-- delivers that.
--
-- ── THE NUMBERS, AND WHY THEY ARE NOT AGGRESSIVE ────────────────────────────────────
-- `capacity` is the largest burst allowed; `refill_per_min` is the sustained rate. Each
-- is set BELOW the provider's published ceiling, because the ceiling is where they start
-- refusing us, not a target:
--   clickup   90/min  — ClickUp's documented limit is 100/min per token. 90 leaves a
--                       10% margin for a retry and for the seconds either side of a
--                       process restart. Burst 90 so an ordinary sync pass is never
--                       slowed; the whole point is to stop the 140.
--   graph     600/min — Microsoft Graph throttles per app/tenant well above this; the
--                       SharePoint mirror is bursty (a closing package at once) and had
--                       NO pacing at all, so this is a ceiling, not a brake.
--   encompass 240/min — read-only, and the reader batches by design.
--   trustpoint 120/min, sitewire 120/min — modest vendor APIs; their real traffic is a
--                       poll every few minutes plus a burst on a draw.
--   osm        55/min — the KEYLESS OSM Nominatim fallback. Its published policy is ONE
--                       request per second and a breach blocks the user agent for
--                       everyone using it, so this is the one limit that is a real
--                       REQUIREMENT rather than a courtesy. 55 rather than 60 because the
--                       limit is measured at the far end (the same reasoning as
--                       lib/osm-gate's 1100ms gap).
--   google_geocode 600/min — Google's ceiling is orders of magnitude higher and this path
--                       backs the live address autocomplete, so it gets its OWN bucket.
--                       Sharing Nominatim's would make typing an address crawl, and the
--                       owner's instruction was explicitly "don't get the limits too
--                       aggressive".
-- Every one is env-overridable at runtime (see lib/api-rate-limit.js), so a number can
-- be changed without a deploy if a provider moves.
--
-- Idempotent: ON CONFLICT DO NOTHING, so an operator's tuned value is never overwritten
-- on the next boot.

CREATE TABLE IF NOT EXISTS api_rate_limits (
  api             text PRIMARY KEY,
  -- Largest burst permitted, and the sustained refill rate.
  capacity        double precision NOT NULL CHECK (capacity > 0),
  refill_per_min  double precision NOT NULL CHECK (refill_per_min > 0),
  -- Live bucket state. `tokens` may sit at 0 while callers wait.
  tokens          double precision NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  last_refill_at  timestamptz NOT NULL DEFAULT now(),
  -- Observability: how often did we actually have to hold a request back? A climbing
  -- number means the real traffic wants more than the cap allows, which is worth seeing
  -- BEFORE a provider phones again.
  waits           bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO api_rate_limits (api, capacity, refill_per_min, tokens) VALUES
  ('clickup',    90,  90,  90),
  ('graph',      600, 600, 600),
  ('encompass',  240, 240, 240),
  ('trustpoint', 120, 120, 120),
  ('sitewire',   120, 120, 120),
  ('osm',        55,  55,  55),
  ('google_geocode', 600, 600, 600)
ON CONFLICT (api) DO NOTHING;
