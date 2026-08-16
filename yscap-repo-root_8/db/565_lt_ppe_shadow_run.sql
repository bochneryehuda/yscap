-- ============================================================================
-- LONG-TERM (LT) — db/565 — PPE shadow RUN-RECORD store.
--
-- The durable home for the shadow validation loop's per-run measurements
-- (§10.5/§11 of docs/longterm/PPE-MEGA-PLAN.md). The canary (src/longterm/ppe/
-- canary.js) emits one runRecord per run — { dayMs, agreementRate, findingKeys,
-- summary } — and the scoreboard (src/longterm/ppe/scoreboard.js) aggregates a
-- SERIES of them into the daily agreement rate + new-findings trend the cutover
-- gate reads. finding-store.js (db/561) already persists the disagreements; this
-- table persists the RUN SERIES, which nothing did — so continuous measurement
-- (Phase 5) and the clean-day streak the cutover gate needs (Phase 7) finally
-- have a durable source. The pure LOGIC lives in scoreboard.js; this is its
-- durable home, and src/longterm/ppe/run-store.js is the bridge (it loads a
-- series and DELEGATES aggregation to scoreboard.assemble — one definition, no
-- SQL copy of the aggregation to drift).
--
-- IDENTITY: a run is keyed by (scope, investor, program, day_ms). A same-run
-- re-persist UPSERTs (the freshest measure of that run wins) — the finding-store
-- reconcile discipline. day_ms stores the runRecord's dayMs VERBATIM; bucketing
-- a run to a calendar day is scoreboard.dailySeries's job (ONE definition), so
-- this table never re-implements it.
--
-- NULL-SAFE UNIQUENESS: investor/program are NOT NULL DEFAULT '' here (unlike the
-- nullable columns on lt_ppe_finding, which key on a precomputed finding_key).
-- Because investor/program are PART OF this table's unique key, a NULL would make
-- two company-wide runs on the same day look distinct (SQL NULLs are distinct in
-- a UNIQUE), silently defeating the upsert. A company-wide run uses '' for both;
-- an investor-specific run carries the label. run-store.js normalizes null → ''
-- on write and filters on the same value on read.
--
-- SEPARATION: lt_ppe_* only; no RTL table read or written; no trigger or function
-- defined; the one FK references db/558's own lt_ppe_program. MULTI-TENANT +
-- SELLABLE: every row carries scope (default 'company'); nothing here is specific
-- to us.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtPpeShadowRun) + docs/schema/beyond-prisma.json. Model, migration and
-- snapshot land together.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_ppe_shadow_run (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           TEXT NOT NULL DEFAULT 'company',
    investor        TEXT NOT NULL DEFAULT '',           -- '' = a company-wide run (NULL-safe unique key)
    program         TEXT NOT NULL DEFAULT '',           -- '' = across all programs
    program_id      UUID REFERENCES lt_ppe_program(id) ON DELETE SET NULL,  -- anchor when resolvable
    day_ms          BIGINT NOT NULL,                    -- the runRecord.dayMs verbatim (scoreboard buckets to a day)
    agreement_rate  NUMERIC,                            -- shadow.summarize(...).agreementRate (0..1) or NULL
    finding_keys    JSONB NOT NULL DEFAULT '[]'::jsonb, -- the run's stable finding identities (for new-vs-recurring)
    summary         JSONB,                              -- the full shadow.summarize run summary
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_shadow_run_key_uk UNIQUE (scope, investor, program, day_ms)
);
CREATE INDEX IF NOT EXISTS lt_ppe_shadow_run_series_idx ON lt_ppe_shadow_run (scope, investor, program, day_ms);
