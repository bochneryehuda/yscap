-- ============================================================================
-- db/618 — ONE outbound-email rate budget, shared by every process that sends.
--
-- WHAT THIS FIXES. Owner-reported: *"On certain emails, I see a delivery error:
-- Resend 429, too many requests. You can only make 10 requests per second."*
-- The provider's limit is documented as **10 requests per second per team,
-- counted across every API key the team owns** — so it is not a per-connection
-- or per-process allowance that each sender may spend independently.
--
-- WHY A TABLE AND NOT A COUNTER IN MEMORY. This deployment runs the web service,
-- the pipeline worker and two cron services against the same Resend team (see
-- render.yaml). A limiter that lives in one process can only ever meter that
-- process's own sends. Four processes each politely holding themselves to 10/s
-- spend 40/s of a 10/s budget and the provider refuses three out of four —
-- which is exactly the failure being reported. An in-memory bucket is the cheap
-- shape here: it looks correct in a single-process test and is wrong in
-- production. The budget has to live where every sender can see the same copy of
-- it, and the only such place this system already has is the database.
--
-- WHAT IS STORED: exactly one row (`id = TRUE`, a one-row table by construction,
-- not by convention). It is a TOKEN BUCKET — `tokens` is the unspent allowance
-- at instant `updated_at`, refilling at `rps` per second and never exceeding
-- `burst`. A sender refills-and-spends in ONE atomic UPDATE, so two processes
-- can never both believe they took the last token.
--
-- WHY THE RATE IS A COLUMN AND NOT A CONSTANT. Two reasons, both real:
--   · Resend raises the limit for trusted senders on request. When it is raised,
--     the ceiling should move by changing one row — not by shipping a deploy.
--   · Resend answers every call with the IETF rate-limit headers
--     (`ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset`). The sender
--     LEARNS the real ceiling from the provider itself and writes it here, so the
--     budget converges on the truth rather than on a number somebody typed.
--
-- `paused_until` is the 429 cool-off. When the provider does refuse — because
-- another tenant of the same team burst, because our clock drifted, because the
-- limit was lowered — every process stops sending until that instant passes,
-- instead of each one independently discovering the refusal by being refused.
-- That is the difference between one rejected message and a stampede.
--
-- NOT A QUEUE OF MESSAGES. The ORDER of sends stays in the sending process (a
-- FIFO in src/lib/email/rate-limit.js); this table meters the RATE only. A
-- durable message queue is a much larger change to a send path that is currently
-- synchronous end-to-end, and it is not what the reported defect needs: nothing
-- is being lost today, it is being sent too fast.
--
-- FAIL-SAFE, NOT FAIL-OPEN: if this table cannot be read, the sender falls back
-- to its in-process bucket (see rate-limit.js). That is weaker than the shared
-- budget but is never *no* limit — a database blip must not turn into a burst.
--
-- PRODUCT SEPARATION: infrastructure shared by identity/RTL send paths; no LT
-- table is read or written, no trigger, no function, and nothing here implies an
-- Encompass write.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_rate_budget (
    -- A ONE-ROW TABLE BY CONSTRUCTION. `id` may only ever be TRUE, so a second
    -- budget row is impossible rather than merely discouraged — two rows would
    -- silently double the allowance, which is the exact bug this table exists to
    -- prevent.
    id            BOOLEAN     NOT NULL DEFAULT TRUE,
    -- Unspent allowance at `updated_at`. Fractional on purpose: a refill of
    -- 10/s over 40ms is 0.4 of a token, and rounding that to zero would make the
    -- bucket refill in visible steps instead of continuously.
    tokens        NUMERIC     NOT NULL DEFAULT 1,
    -- The instant `tokens` was last correct. Every spend recomputes the refill
    -- from this, so no ticker or background job is needed to keep it current.
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- Sustained sends per second. Seeded at the provider's documented default and
    -- then corrected from the provider's own `ratelimit-limit` header.
    rps           NUMERIC     NOT NULL DEFAULT 10,
    -- The most that may ever be spent in one instant. DEFAULT 1 — strict pacing,
    -- one send every 1/rps seconds — and that is deliberate, not conservative
    -- timidity. A bucket of capacity C refilling at R permits C + R*T calls in
    -- ANY window of length T, so the intuitive burst = rps = 10 allows up to
    -- TWENTY calls inside one sliding second while the sender believes it is
    -- holding ten. That is the exact shape of the reported 429. At burst = 1 the
    -- bound is R*T + 1: one call of slack instead of ten. A single interactive
    -- email still leaves immediately (an idle bucket always holds its one token);
    -- only a fan-out is paced, which is what a fan-out should be. Raise this only
    -- as a deliberate decision about how much slack to take against the ceiling.
    burst         NUMERIC     NOT NULL DEFAULT 1,
    -- Set when the provider actually answers 429; until it passes, NOBODY sends.
    paused_until  timestamptz,
    -- Why the pause was set, in the words the provider used. Kept so the reason a
    -- send waited is answerable after the fact instead of being inferred.
    pause_reason  TEXT,
    -- Running totals for the health surface. Not an audit trail — a cheap answer
    -- to "is this actually happening?" that costs nothing to keep.
    granted_count BIGINT      NOT NULL DEFAULT 0,
    waited_count  BIGINT      NOT NULL DEFAULT 0,
    refused_count BIGINT      NOT NULL DEFAULT 0,

    CONSTRAINT email_rate_budget_pkey PRIMARY KEY (id),
    CONSTRAINT email_rate_budget_single_row CHECK (id IS TRUE),
    CONSTRAINT email_rate_budget_rps_positive CHECK (rps > 0),
    CONSTRAINT email_rate_budget_burst_positive CHECK (burst > 0)
);

COMMENT ON TABLE email_rate_budget IS
  'The one outbound-email token bucket, shared by every process that sends. Exists because the provider''s 10 requests/second limit is per TEAM across all API keys, so a per-process limiter cannot honour it.';
COMMENT ON COLUMN email_rate_budget.tokens IS
  'Unspent allowance at updated_at. Refills at rps per second, capped at burst. Spent atomically.';
COMMENT ON COLUMN email_rate_budget.rps IS
  'Sends per second. Seeded at the provider default and corrected from the provider''s own ratelimit-limit header.';
COMMENT ON COLUMN email_rate_budget.paused_until IS
  'Set on a real 429. Every process holds off until this instant, so one refusal does not become a stampede.';

-- Seed the single row. ON CONFLICT DO NOTHING makes this replay-safe: every file
-- in db/ is re-run on EVERY boot, so a second INSERT must be a no-op rather than
-- a primary-key violation that breaks the whole chain for every future deploy.
INSERT INTO email_rate_budget (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
