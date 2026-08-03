-- ---------------------------------------------------------------------------
-- THE HOUSE PRICE INDEX — a defensible basis for a time adjustment.
--
-- A comparable that sold fourteen months ago sold in a different market, and the
-- grid's "date of sale" line corrects for that. Until now the rate came from our
-- OWN sales, and that is exactly where this build's most dangerous wrong answer
-- came from: a trend read off sales bunched into a single month produced
-- 3.95% A MONTH and pre-filled +$190,750 on a $400,000 comparable. Fifty
-- properties in one town cannot measure a market; the FHFA's can, because it is
-- built from every conforming repeat sale in the state.
--
-- WHY A TABLE AND NOT A FILE IN THE REPO. The index is republished every
-- quarter. A vendored copy would go stale silently and keep answering with
-- total confidence — the single failure mode this whole build is written to
-- refuse. It lives in the database, is refreshed by an explicit action, carries
-- the date it was loaded, and the module that reads it REFUSES when the period
-- it is asked about is not covered.
--
-- BOTH SERIES ARE KEPT. The seasonally adjusted one is the right basis for
-- measuring change between two arbitrary months (a March-to-June move is partly
-- just spring), and the unadjusted one is what the FHFA headlines quote, so a
-- reviewer checking our figure against a press release needs it to be here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS hpi_index (
  id            bigserial PRIMARY KEY,
  -- 'state' today. 'msa' and 'zip3' are the obvious next rungs, and having the
  -- column from the start means adding one is data rather than a migration.
  region_type   text NOT NULL,
  region        text NOT NULL,
  year          int  NOT NULL,
  quarter       int  NOT NULL,
  index_nsa     numeric(12,4),
  index_sa      numeric(12,4),
  -- Named so a figure can be traced to a publication, not just to "the index".
  source        text NOT NULL DEFAULT 'FHFA HPI (purchase-only, state)',
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hpi_index_quarter_ck CHECK (quarter BETWEEN 1 AND 4),
  CONSTRAINT hpi_index_year_ck    CHECK (year BETWEEN 1900 AND 2200)
);

-- One row per (region, period). A refresh UPSERTS onto this, so re-running the
-- loader is idempotent and a revised quarter overwrites rather than duplicates —
-- the FHFA does revise, and two rows for one quarter would make every reader
-- pick one arbitrarily.
CREATE UNIQUE INDEX IF NOT EXISTS hpi_index_period_uk
  ON hpi_index (region_type, region, year, quarter);

-- The one query the reader makes: a region's whole series, in order.
CREATE INDEX IF NOT EXISTS hpi_index_region_idx
  ON hpi_index (region_type, region, year, quarter);
