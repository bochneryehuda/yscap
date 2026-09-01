-- ============================================================================
-- db/659 — lt price snapshot
--
-- WHAT THIS CHANGES, AND WHY. The owner asked for a daily report telling loan
-- officers how much every program moved: *"it should calculate by price, not by
-- rate … how much more expensive every single program is."* Nothing in PILOT
-- records what a program cost yesterday, so there was nothing to compare
-- against — and there is no way to go back and get it, because a rate sheet is
-- gone the moment it is replaced. This table is the record, and it ships BEFORE
-- the reports on purpose: a report has nothing to say on its first day by
-- construction, and building it the other way round produces a first email that
-- says nothing and looks broken. The research, and the owner's own words, are
-- docs/longterm/PRICING-RATE-MOVEMENT-REPORTS.md.
--
-- ⛔ MILLI-INTEGERS, NEVER FLOATS. The engine's convention (ppe/README.md:
-- "Never introduce a float price/rate on a stored or compared value"), and it
-- is not fussiness here: a half-cent of float drift accumulated across a
-- 365-day series is a movement report that reports movement which did not
-- happen. A rate of 7.125% is 7125; a price of 99.875 is 99875.
--
-- ⛔ THE SERIES IS KEYED ON A HASH OF THE SCENARIO, and that is the whole reason
-- the numbers mean anything. A price is a price FOR A SCENARIO, so comparing
-- today's 75% LTV / 760 FICO quote against yesterday's 80% / 720 quote measures
-- our own inconsistency and calls it the market. An edited benchmark therefore
-- starts a NEW series rather than silently comparing apples to oranges, and the
-- first report after a change says so. `scenario` is stored beside the hash so
-- a row is self-describing a year later, when the setting has moved on.
--
-- ⛔ ONE ROW PER INVESTOR × PROGRAM × SHEET. Two channels of one lender can
-- share a programme name with different ladders — measured on ResiCentral, and
-- already why the rate sheet's name rides the staff board. Collapsing them
-- would average two real sheets into one figure that describes neither.
--
-- `taken_for_day` is the NEW YORK calendar day the snapshot represents, not the
-- UTC one: the job runs at 1:00 PM Eastern, which is the next UTC day for
-- nobody, but the DAY a report compares against has to be the day an officer
-- means. It is a plain date, so "the previous business day" is date arithmetic
-- rather than a timestamp window.
--
-- IDEMPOTENT: CREATE ... IF NOT EXISTS only, and the writer upserts on the
-- unique key, so a job that runs twice on one day replaces rather than doubles.
--
-- BACKFILL: none, and none is possible. A rate sheet that has been replaced is
-- gone; history starts the day this ships.
--
-- RETENTION: none, deliberately. A ladder is a few kB and a year of it is what
-- makes "how did this programme trend" answerable later. Nothing anywhere may
-- prune this table on a timer without the owner asking for it.
--
-- PRODUCT SEPARATION. lt_* only. No RTL table is referenced, and there is no
-- FK to anything — a snapshot is a fact about the market on a day, not about a
-- person or a loan.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_price_snapshot (
    id             UUID NOT NULL DEFAULT gen_random_uuid(),
    -- The series key: the canonical hash of the benchmark this was priced on.
    scenario_hash  TEXT NOT NULL,
    -- The benchmark itself, so the row still says what it measured after the
    -- setting has been edited. A figure with no scenario attached cannot be
    -- checked by anybody.
    scenario       JSONB NOT NULL DEFAULT '{}'::jsonb,
    taken_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The NEW YORK calendar day this snapshot represents. See the header.
    taken_for_day  DATE NOT NULL,
    -- The canonical investor key, plus what the vendor itself called the lender
    -- and the programme. The key is what a report groups by; the vendor's own
    -- words are kept because an investor we cannot key yet must still be
    -- recorded rather than dropped.
    investor_key   TEXT,
    lender         TEXT,
    program        TEXT NOT NULL,
    rate_sheet     TEXT,
    -- [{ rateMilli, bestPriceMilli }], sorted by rate, one row per rate at its
    -- best price. Integers, per the header.
    ladder         JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- The interpolated rate at price 100.000, or NULL when this ladder does not
    -- straddle par. NEVER extrapolated: a rate the vendor did not quote is not
    -- a fact about their sheet.
    par_rate_milli INTEGER,
    rung_count     INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT lt_price_snapshot_pkey PRIMARY KEY (id)
);

-- ONE ROW PER (series, day, investor, programme, sheet). COALESCE on the two
-- nullable parts of the key: in Postgres two NULLs are DISTINCT, so a unique
-- index over a raw nullable column does not constrain the rows that matter —
-- a programme with no rate-sheet name would be insertable twice a day, forever,
-- and the report would count it twice.
CREATE UNIQUE INDEX IF NOT EXISTS lt_price_snapshot_day_key
    ON lt_price_snapshot (scenario_hash, taken_for_day, COALESCE(investor_key, ''), program, COALESCE(rate_sheet, ''));

-- The read every report makes: one series, one day, in one pass.
CREATE INDEX IF NOT EXISTS lt_price_snapshot_series_idx
    ON lt_price_snapshot (scenario_hash, taken_for_day DESC);

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
