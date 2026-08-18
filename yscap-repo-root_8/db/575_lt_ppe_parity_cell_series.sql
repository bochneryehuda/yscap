-- ============================================================================
-- db/575 — lt ppe parity cell series
--
-- WHAT THIS CHANGES, AND WHY. The parity MATRIX (P9) measures where our engine
-- and Lender Price disagree — per FICO band, per state, per DSCR band — but only
-- for the run in front of you. `lt_ppe_shadow_run` (db/565) stores ONE aggregate
-- agreement rate per (scope, investor, program, day), so per-cell history cannot
-- be reconstructed from it at any later date: the question the cutover decision
-- actually turns on — "has THIS band been off for three weeks, or was that one
-- bad afternoon?" — is unanswerable, and a band that quietly regressed after a
-- rate-sheet change looks identical to one that has never worked.
--
-- This is the series that makes it answerable: one row per cell per run.
--
-- IT IS A MEASUREMENT LOG, NOT A DECISION. Nothing here says what counts as
-- "clean enough"; the thresholds are the owner's (master plan Part 4.2/4.3) and
-- live in the cutover gate. A row records what was measured on a day.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. Re-persisting the
-- same run UPSERTs on the natural key rather than duplicating, exactly as
-- `lt_ppe_shadow_run` does — the freshest measure of a given run wins.
--
-- A MISSING ROW MEANS "NOT MEASURED", NEVER "MEASURED BADLY". A run whose
-- scenarios happened to include no loans in the 640–660 band writes no row for
-- it that day, and a reader must treat that gap as an absence of evidence, not
-- as a zero. The reader (`parity-cell-store`) is written that way and says so.
--
-- BACKFILL: NONE, and none is possible. Per-cell measures were never captured
-- (the scenario FACTS were being discarded before the matrix existed, which is
-- the defect P9 had to fix first), so there is no history to reconstruct — and
-- inventing one from the daily aggregate would fabricate per-band numbers nobody
-- measured. The series starts at the first canary run after this lands.
--
-- PRODUCT SEPARATION: Long-Term only (`lt_ppe_*`). Touches no RTL table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_parity_cell (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope           TEXT NOT NULL DEFAULT 'company',
    investor        TEXT NOT NULL DEFAULT '',   -- '' = a company-wide run (NULL-safe unique key)
    program         TEXT NOT NULL DEFAULT '',   -- '' = across all programs
    program_id      UUID REFERENCES lt_ppe_program(id) ON DELETE SET NULL,
    day_ms          BIGINT NOT NULL,            -- the run's day, verbatim from the canary

    -- WHICH cell. `dimension` is the fact sliced on ('fico'); `cell_key` is the stable identity
    -- ('700:760' for a band, the value itself for a category) and is what a trend query joins on
    -- across days; `cell_label` is display text ('700–760') and must never be joined on — a sheet
    -- reprice can change a label's punctuation without changing which loans the cell holds.
    dimension       TEXT NOT NULL,
    cell_key        TEXT NOT NULL,
    cell_label      TEXT NOT NULL,
    kind            TEXT NOT NULL,              -- band | category

    -- WHAT was measured there. Counts are NOT NULL because "none" and "not measured" must never
    -- render the same; the RATES are nullable because a cell with no comparable scenarios genuinely
    -- has no rate, and a 0 there would read as total disagreement.
    total           INTEGER NOT NULL DEFAULT 0,
    agreed          INTEGER NOT NULL DEFAULT 0,
    disagreed       INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    incomparable    INTEGER NOT NULL DEFAULT 0,
    overlay         INTEGER NOT NULL DEFAULT 0, -- a D29 reasoned override: never a defect, never hidden
    agreement_rate  NUMERIC,

    -- The price gap. `price_scenarios` counts LOANS with a gap and `price_samples` the individual
    -- COUPONS — different questions, and one reported under the other's name makes a single scenario
    -- disagreeing on eight coupons read as eight bad loans.
    price_scenarios INTEGER NOT NULL DEFAULT 0,
    price_samples   INTEGER NOT NULL DEFAULT 0,
    worst_abs_milli BIGINT,                     -- how bad it gets, regardless of direction
    mean_milli      NUMERIC,                    -- SIGNED: uniformly light is not the same as scattered

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_parity_cell_key_uk UNIQUE (scope, investor, program, day_ms, dimension, cell_key),
    CONSTRAINT lt_ppe_parity_cell_kind_chk CHECK (kind IN ('band','category'))
);

-- The trend query: one cell's history for one series, oldest first.
CREATE INDEX IF NOT EXISTS lt_ppe_parity_cell_series_idx
    ON lt_ppe_parity_cell (scope, investor, program, dimension, cell_key, day_ms);
-- The "what did this run look like" query, and the window bound on a sweep.
CREATE INDEX IF NOT EXISTS lt_ppe_parity_cell_day_idx
    ON lt_ppe_parity_cell (scope, investor, program, day_ms);
