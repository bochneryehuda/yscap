-- ============================================================================
-- LONG-TERM (LT) — db/560 — PPE rate-sheet store (versions, grids, LLPAs, limits).
--
-- The price-bearing layer of the MEGA Product & Pricing Engine (docs/longterm/
-- PPE-MEGA-PLAN.md §3.1), hanging off the db/558 anchors (investor, program). A
-- rate sheet is an EFFECTIVE-DATED, APPEND-ONLY VERSION that is never mutated:
-- publishing a new version closes the prior's effective_to; an intraday reprice
-- is a first-class event (reprice_seq), never an overwrite. This is the unit
-- that ships daily.
--
-- INTEGER BASIS POINTS, NEVER FLOATS. Price is stored in MILLI-POINTS
-- (102.850 points -> 102850; par -> 100000) exactly as src/longterm/ppe/pricing.js
-- and settings.js speak it. Note rate is milli-percent (7.125% -> 7125). Every
-- adjustment is a SIGNED integer.
--
-- HALF-OPEN [min,max) BANDS. Adjustment bands are stored as plain integer
-- min/max columns with the half-open convention (min inclusive, max exclusive;
-- NULL = unbounded) — the same convention src/longterm/ppe/rules.js enforces at
-- evaluation time. GiST exclusion constraints + a publish-time tiling check are
-- a later hardening migration; overlap/gap detection lives in the app publish
-- path for now, and the open-ended long tail rides `predicate jsonb`.
--
-- MULTI-TENANCY + SELLABLE: every configurable row carries `scope` (default
-- 'company'); no value here is specific to us (the sheet content is a tenant's
-- data, not code). SEPARATION: every table is lt_ppe_*; no RTL table is read or
-- written; no trigger or function is defined; FKs reference only db/558's own
-- lt_ppe_* tables. `approved_by`/`created_by` are plain UUIDs (no FK).
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma (the LtPpe*
-- rate-sheet models) + docs/schema/beyond-prisma.json. Model, migration and
-- snapshot land in the same commit.
-- ---------------------------------------------------------------------------

-- lt_ppe_rate_sheet_version — THE effective-dated, versioned container.
--   status  — draft | pending | published | superseded (publish lifecycle).
--   channel — correspondent | wholesale | retail (a channel splits the sheet).
--   effective_from/_to — half-open valid time; effective_to NULL = current.
--   recorded_at — transaction time (bitemporal: "what did we believe on the 14th").
--   content_hash — dedupe a byte-identical re-import to one version header.
--   reprice_seq — an intraday reprice is its own event, never an overwrite.
CREATE TABLE IF NOT EXISTS lt_ppe_rate_sheet_version (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope          TEXT NOT NULL DEFAULT 'company',
    program_id     UUID NOT NULL REFERENCES lt_ppe_program(id) ON DELETE CASCADE,
    version_no     INTEGER NOT NULL,
    reprice_seq    INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'draft',
    channel        TEXT NOT NULL DEFAULT 'correspondent',
    effective_from timestamptz,
    effective_to   timestamptz,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    content_hash   TEXT,
    source_format  TEXT,            -- excel | pdf | website | api (how it arrived)
    approved_by    UUID,
    approved_at    timestamptz,
    meta           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by     UUID,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_rsv_scope_prog_ver_seq_uk UNIQUE (scope, program_id, version_no, reprice_seq),
    CONSTRAINT lt_ppe_rsv_status_chk  CHECK (status IN ('draft','pending','published','superseded')),
    CONSTRAINT lt_ppe_rsv_channel_chk CHECK (channel IN ('correspondent','wholesale','retail'))
);
CREATE INDEX IF NOT EXISTS lt_ppe_rsv_program_idx ON lt_ppe_rate_sheet_version (program_id);
CREATE INDEX IF NOT EXISTS lt_ppe_rsv_current_idx ON lt_ppe_rate_sheet_version (program_id, status, effective_from);

-- lt_ppe_base_price — the rate-sheet GRID: coupon x lock_days x price.
--   note_rate_milli_pct — the coupon, milli-percent (7.125% -> 7125).
--   price_milli — the cell's price, milli-points (102.850 -> 102850; par 100000).
--   product — '' = the sheet's single product; else the product column label.
CREATE TABLE IF NOT EXISTS lt_ppe_base_price (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope              TEXT NOT NULL DEFAULT 'company',
    version_id         UUID NOT NULL REFERENCES lt_ppe_rate_sheet_version(id) ON DELETE CASCADE,
    note_rate_milli_pct INTEGER NOT NULL,
    lock_days          INTEGER NOT NULL,
    product            TEXT NOT NULL DEFAULT '',
    price_milli        INTEGER NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_base_price_cell_uk UNIQUE (version_id, note_rate_milli_pct, lock_days, product)
);
CREATE INDEX IF NOT EXISTS lt_ppe_base_price_version_idx ON lt_ppe_base_price (version_id);

-- lt_ppe_adjustment — an LLPA / price adjustment as a FLAT row (never a nested
-- JSON cube). Bands are half-open [min,max) integer pairs (NULL = unbounded);
-- the open-ended long tail rides `predicate` (a rules.js predicate tree,
-- validated at write time).
--   adj_milli — SIGNED, in the `unit` below (cost-positive on points).
--   adjustment_target — price | rate (most are price; retain the original).
--   unit — points | price (the pricing.js normalization axis).
CREATE TABLE IF NOT EXISTS lt_ppe_adjustment (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope             TEXT NOT NULL DEFAULT 'company',
    version_id        UUID NOT NULL REFERENCES lt_ppe_rate_sheet_version(id) ON DELETE CASCADE,
    dimension         TEXT NOT NULL,
    fico_min          INTEGER,
    fico_max          INTEGER,
    ltv_min           INTEGER,
    ltv_max           INTEGER,
    dscr_min          INTEGER,
    dscr_max          INTEGER,
    predicate         JSONB,          -- the long-tail condition tree (nullable)
    adj_milli         INTEGER NOT NULL,
    adjustment_target TEXT NOT NULL DEFAULT 'price',
    unit              TEXT NOT NULL DEFAULT 'points',
    sign_convention   TEXT NOT NULL DEFAULT 'cost_positive',
    cumulative        BOOLEAN NOT NULL DEFAULT true,
    priority          INTEGER NOT NULL DEFAULT 0,
    reason            TEXT,
    code              TEXT,
    meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_adjustment_target_chk CHECK (adjustment_target IN ('price','rate')),
    CONSTRAINT lt_ppe_adjustment_unit_chk   CHECK (unit IN ('points','price'))
);
CREATE INDEX IF NOT EXISTS lt_ppe_adjustment_version_idx ON lt_ppe_adjustment (version_id);
CREATE INDEX IF NOT EXISTS lt_ppe_adjustment_dim_idx ON lt_ppe_adjustment (version_id, dimension);

-- lt_ppe_price_limit — the floor / ceiling / rounding for a version (one row per
-- version). cap_tiers is [{ uptoLoanAmount, capMilli }] (the loan-size ceilings).
CREATE TABLE IF NOT EXISTS lt_ppe_price_limit (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope                   TEXT NOT NULL DEFAULT 'company',
    version_id              UUID NOT NULL REFERENCES lt_ppe_rate_sheet_version(id) ON DELETE CASCADE,
    min_price_milli         INTEGER,
    rounding_increment_milli INTEGER NOT NULL DEFAULT 125,
    rounding_mode           TEXT NOT NULL DEFAULT 'nearest_eighth',
    cap_tiers               JSONB NOT NULL DEFAULT '[]'::jsonb,
    on_exceed               TEXT NOT NULL DEFAULT 'cap_and_keep_eligible',
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_price_limit_version_uk UNIQUE (scope, version_id)
);
