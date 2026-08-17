-- ============================================================================
-- LONG-TERM (LT) — db/570 — the PPE canary SCHEDULE (the saved battery + cadence).
--
-- WHAT PROBLEM THIS FIXES. Agreement between our engine and Lender Price is only
-- measured on the days somebody remembered to press "run canary now" — while the
-- cutover gate reads a clean-day STREAK and an agreement TREND off exactly that
-- series (§10.5/§11 of docs/longterm/PPE-MEGA-PLAN.md). An unfed streak does not
-- read as "unmeasured"; it reads as a LOW SCORE. So an investor can sit
-- permanently short of promotion for want of a cron rather than for want of
-- agreement. `src/longterm/ppe/canary-schedule.js` is the pure decision of WHEN
-- a canary runs and on WHAT; this table is where the answer is kept.
--
-- WHY A TABLE AND NOT A SETTING. The one rule that module enforces is that a
-- schedule NEVER INVENTS A BATTERY: WHICH scenarios are worth measuring is a
-- business judgement about the investor's book, and a made-up battery still
-- produces an agreement rate — a number that then feeds the promote gate. So the
-- battery a HUMAN saved has to be durable, per investor, and readable back
-- verbatim. That is a row, not an env var.
--
-- IT IS CONFIGURATION, NOT A GOVERNANCE TRAIL, so unlike db/566's append-only
-- ledger this table is UPDATEd in place and carries `updated_at`/`updated_by`.
-- The decisions that must survive editing (promote / rollback) live in the
-- ledger; changing the cadence or the battery is an ordinary edit, and the run
-- series records what was actually measured either way.
--
-- WHAT IS DELIBERATELY *NOT* HERE: a `last_run_at` column. "When did we last
-- measure this scope?" is already answered by the run series the canary writes
-- (db/565, read through `run-store.listRuns`), and a second stamp would be a
-- second answer — the one that drifts is the one the gate reads. Reading the run
-- series also means a canary an admin fired BY HAND counts toward the cadence,
-- which is right and would not be true of a private stamp.
--
-- ENABLED DEFAULTS TO FALSE. A saved schedule is PAUSED until somebody turns it
-- on, matching the module's fail-toward-not-running posture: the cost of a canary
-- that does not fire is a visible gap on the scoreboard, while the cost of one
-- that fires when it should not is N live vendor calls per tick, forever.
--
-- NULL-SAFE UNIQUENESS: `investor` is NOT NULL DEFAULT '' for the same reason as
-- db/565 and db/566 — it is PART of the unique key, and SQL NULLs are distinct in
-- a UNIQUE, so a NULL would let two company-wide schedules coexist and the tick
-- would run both. A company-wide schedule uses ''; the store normalizes
-- null → '' on write and filters on the same value on read.
--
-- THE CHECKs ARE THE BACKSTOP, NOT THE RULE. `canary-schedule.validateSchedule`
-- is the rule and the store refuses an invalid schedule before it reaches SQL;
-- these constraints exist so a row written by anything else (a repair script, a
-- restored dump, a future caller) still cannot express a cadence of zero or a
-- battery kind nothing knows how to run. They are deliberately LOOSER than the
-- module — the module's exact bounds are env-tunable, and a CHECK that duplicated
-- them would be a second copy of a rule that drifts.
--
-- BACKFILL: NONE, and that is the whole design — this table starts empty and
-- nothing is scheduled until a human saves a battery. There is no default
-- schedule to seed, because seeding one would BE the invented battery.
--
-- SEPARATION: lt_ppe_* only; no RTL table read or written; no trigger or function
-- defined. MULTI-TENANT + SELLABLE: every row carries scope (default 'company');
-- nothing here is specific to us.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS only, and every CHECK is
-- dropped before it is re-added, so a replay on every boot is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_canary_schedule (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                 TEXT NOT NULL DEFAULT 'company',
    investor              TEXT NOT NULL DEFAULT '',   -- '' = a company-wide schedule (NULL-safe unique key)
    enabled               BOOLEAN NOT NULL DEFAULT false,  -- saved ≠ running; a schedule is paused until switched on
    interval_ms           BIGINT NOT NULL,            -- the cadence, in ms (the module owns the bounds)
    battery_kind          TEXT NOT NULL,              -- scenarios | matrix — which shape `battery` holds
    battery               JSONB NOT NULL,             -- the battery a HUMAN saved, verbatim; never invented
    rate_sheet_version_id UUID,                       -- NULL = price against the CURRENT version (the ordinary case)
    concurrency           INTEGER,                    -- NULL = the runner's default
    note                  TEXT,                       -- why this battery, in the author's own words
    updated_by            TEXT NOT NULL,              -- who last saved it — a live vendor loop has an owner
    updated_at            BIGINT NOT NULL,            -- injected clock (epoch ms), matching the module's convention
    created_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_canary_schedule_scope_uk UNIQUE (scope, investor)
);

ALTER TABLE lt_ppe_canary_schedule DROP CONSTRAINT IF EXISTS lt_ppe_canary_schedule_kind_chk;
ALTER TABLE lt_ppe_canary_schedule ADD CONSTRAINT lt_ppe_canary_schedule_kind_chk
    CHECK (battery_kind IN ('scenarios', 'matrix'));

-- A cadence of zero or a negative one is not a slow schedule, it is a tick with no
-- floor. The module refuses far more than this; the database refuses the absurd.
ALTER TABLE lt_ppe_canary_schedule DROP CONSTRAINT IF EXISTS lt_ppe_canary_schedule_interval_chk;
ALTER TABLE lt_ppe_canary_schedule ADD CONSTRAINT lt_ppe_canary_schedule_interval_chk
    CHECK (interval_ms > 0);

ALTER TABLE lt_ppe_canary_schedule DROP CONSTRAINT IF EXISTS lt_ppe_canary_schedule_concurrency_chk;
ALTER TABLE lt_ppe_canary_schedule ADD CONSTRAINT lt_ppe_canary_schedule_concurrency_chk
    CHECK (concurrency IS NULL OR concurrency > 0);

-- The one read the tick performs: every ENABLED schedule for a scope, so the
-- worker can ask the pure decision which of them are due.
CREATE INDEX IF NOT EXISTS lt_ppe_canary_schedule_enabled_idx
    ON lt_ppe_canary_schedule (scope, enabled);
