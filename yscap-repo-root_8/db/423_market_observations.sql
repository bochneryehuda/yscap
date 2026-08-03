-- 423 — WHAT OUR APPRAISERS HAVE SAID ABOUT THE MARKETS WE LEND IN
--
-- db/422 carried 59 facts across the last hop and deliberately left the 1004MC
-- market grid and the neighbourhood block behind, with a written reason: they
-- describe a MARKET OVER A PERIOD, not a property. Filing them on a property row
-- would give every house in a town its own private copy of the town's statistics,
-- disagreeing with the house next door depending on whose report was newest.
-- This is the table they belong in.
--
-- ─── WHAT THIS DATA ACTUALLY IS, AND THE HONESTY THAT FOLLOWS ────────────────
--
-- Fannie Mae Form 1004MC is the appraiser's OWN read of a market area THEY drew
-- the boundary of. Two reports on neighbouring streets can define different
-- areas, use different comparable criteria, and disagree — and neither is wrong.
-- So this is NOT "the market", and nothing built on it may present it that way.
-- It is: **what N appraisers told us about the market around here, and when**.
--
-- That single sentence decides the whole schema:
--
--   * it is an OBSERVATION, exactly like `property_observations` — one row per
--     report, never overwritten, never merged into a single "answer";
--   * it is tagged with the SUBJECT'S geography, because the appraiser's own
--     boundary is unknowable but the address they were standing on is not. The
--     subject's state/city/ZIP/county/coordinates are what make two reports
--     comparable at all — "reports about properties in this ZIP", not "reports
--     about the same polygon", which we can never claim;
--   * every aggregate MUST carry its sample size. An average months-of-supply
--     over two reports and over two hundred are different claims.
--
-- ─── THE PERIODS BECOME REAL DATES, AND THAT IS THE POINT ────────────────────
--
-- The form reports three windows — "Prior 7–12 Months", "Prior 4–6 Months",
-- "Current – 3 Months" — which are MEANINGLESS without knowing from when. A
-- report effective March 2026 and one effective September 2025 both say "last 3
-- months" about completely different quarters. Stored as the form words them,
-- they can never be put on one axis.
--
-- So each window is resolved against the report's own effective date into a real
-- `period_start`/`period_end`, non-overlapping and contiguous backwards:
--
--     last3     [E-3mo,  E)
--     prior46   [E-6mo,  E-3mo)
--     prior712  [E-12mo, E-6mo)
--
-- That is what turns a pile of reports into a time series: fifty appraisals
-- written over two years produce overlapping windows that stack into a real
-- month-by-month picture of a ZIP — from data we already paid for.
--
-- ─── TWO TABLES, BECAUSE THERE ARE GENUINELY TWO THINGS ──────────────────────
--
-- `market_observations` — ONE ROW PER REPORT. The geography, the effective date,
-- the appraiser's per-metric trend conclusions, their market narrative, and the
-- page-1 NEIGHBOURHOOD description (built-up, growth, value trend, demand/supply,
-- marketing time, the price and age ranges, present land use). None of these have
-- periods; they are the appraiser's single read of the area.
--
-- `market_periods` — ONE ROW PER (REPORT × WINDOW), carrying the nine grid
-- metrics. Repeating the trends and the narrative onto each of these would be
-- denormalization for its own sake, and the join is one line.

CREATE TABLE IF NOT EXISTS market_observations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHERE IT CAME FROM. ON DELETE SET NULL on every one of these, never CASCADE:
  -- `appraisals.application_id` cascades, so a CASCADE here would mean deleting
  -- ONE loan file erases everything that report ever taught us about its market.
  appraisal_id             uuid REFERENCES appraisals(id) ON DELETE SET NULL,
  import_id                uuid REFERENCES research_imports(id) ON DELETE SET NULL,
  application_id           uuid REFERENCES applications(id) ON DELETE SET NULL,
  property_id              uuid REFERENCES properties(id) ON DELETE SET NULL,
  appraiser_id             uuid REFERENCES appraisers(id) ON DELETE SET NULL,

  -- WHERE THE MARKET IS. The SUBJECT's geography — see the header: we cannot know
  -- the appraiser's own boundary, but we know the address they were describing.
  state                    text,
  city                     text,
  zip                      text,
  county                   text,
  latitude                 numeric(9,6),
  longitude                numeric(9,6),

  -- WHEN. `effective_date` anchors every window in `market_periods`.
  effective_date           date,
  form_type                text,

  -- THE APPRAISER'S CONCLUSIONS — per-metric Increasing / Stable / Declining,
  -- keyed by the MISMO metric name, exactly as `extract.js` records them.
  trends                   jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- THE PAGE-1 NEIGHBOURHOOD DESCRIPTION. One read per report, no periods.
  nbhd_location_type       text,
  nbhd_builtup             text,
  nbhd_growth              text,
  nbhd_value_trend         text,
  nbhd_demand_supply       text,
  nbhd_marketing_time      text,
  nbhd_price_low           numeric(14,2),
  nbhd_price_high          numeric(14,2),
  nbhd_price_predominant   numeric(14,2),
  nbhd_age_predominant     integer,
  nbhd_boundaries          text,
  nbhd_adverse_financing   text,
  nbhd_foreclosure_activity text,
  present_land_use         jsonb,

  -- THE NARRATIVE.
  market_conditions_comment      text,
  market_reconciliation_comment  text,
  comp_research                  text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ONE ROW PER REPORT, whichever door it came through. Partial unique indexes
-- rather than a table constraint because a report has EITHER an appraisal id
-- (the loan-file door) OR an import id (the standalone upload) — never both.
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_obs_appraisal
  ON market_observations(appraisal_id) WHERE appraisal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_obs_import
  ON market_observations(import_id) WHERE import_id IS NOT NULL;

-- The two questions this table exists to answer: "what do we know about the
-- market HERE" and "how has it moved".
CREATE INDEX IF NOT EXISTS idx_market_obs_where
  ON market_observations(state, lower(city), effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_market_obs_zip
  ON market_observations(zip, effective_date DESC) WHERE zip IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_market_obs_property
  ON market_observations(property_id) WHERE property_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_periods (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id           uuid NOT NULL REFERENCES market_observations(id) ON DELETE CASCADE,

  -- WHICH WINDOW, and the real dates it resolves to. `period_label` is the form's
  -- own word; the dates are what make two reports comparable.
  period_label             text NOT NULL CHECK (period_label IN ('last3','prior46','prior712')),
  period_start             date,
  period_end               date,

  -- THE NINE GRID METRICS. Ranges follow the source columns on `appraisals`; a
  -- cell the appraiser left as "N/A" is NULL, which honestly means "the report
  -- did not state it" and never zero.
  total_sales              integer,
  total_listings           integer,
  absorption_rate          numeric(10,3),
  months_supply            numeric(10,3),
  median_sale_price        numeric(14,2),
  median_list_price        numeric(14,2),
  median_sale_dom          integer,
  median_list_dom          integer,
  median_sale_to_list_pct  numeric(8,2),

  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_market_period
  ON market_periods(observation_id, period_label);
-- The time-series query: everything in a window, newest first.
CREATE INDEX IF NOT EXISTS idx_market_period_window
  ON market_periods(period_start DESC, period_end DESC);

COMMENT ON TABLE market_observations IS
  'One 1004MC / neighbourhood read per appraisal report. NOT "the market" — the '
  'appraiser''s own read of an area they drew themselves, tagged with the SUBJECT''S '
  'geography because their boundary is unknowable. Every aggregate built on this '
  'must report how many reports it averaged.';
COMMENT ON TABLE market_periods IS
  'The 1004MC grid, one row per report per window, with the form''s relative '
  'windows resolved against the report''s effective date into real dates — which '
  'is what lets reports written months apart stack into one time series.';
