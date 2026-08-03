-- 427 — WHICH FOOT THAT PRICE PER FOOT IS
--
-- Price per square foot was DEAD on every 2-4 unit comparable. A Form 1025
-- measures the BUILDING rather than the living area, so it states the same fact
-- under a different attribute — `SalesPricePerGrossBuildingAreaAmount` — and only
-- the living-area spelling was ever read. Same file, one word changed: a 1004
-- read $154.59 and a 1025 read null, on a field the owner named specifically.
--
-- THE TWO ARE NOT INTERCHANGEABLE, which is why reading the second one is only
-- half the fix. $150 a foot of living area and $150 a foot of gross building area
-- describe different properties: gross building area includes space the living
-- area does not, so the same house is a smaller number per foot. Comparing them
-- silently would be a wrong answer of exactly the kind this warehouse already
-- guards against for the AREA itself — `gla_basis` (db/409 §7) exists for that
-- reason, and this is its price-side twin.
--
-- The living-area spelling wins when a file carries both. NULL means the grid
-- stated no price per foot at all, never "assume living area".

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS price_per_gla_basis text;

COMMENT ON COLUMN appraisal_comparables.price_per_gla_basis IS
  'Which area measure price_per_gla is per: gla (living area, a 1004) or gba '
  '(gross building area, a 1025). NULL when the grid stated no price per foot — '
  'never a default.';

-- The parser change is what fills it, so previous reports have to be READ AGAIN.
-- `INGEST_VERSION` moves in `research/ingest.js`, and the boot sweep re-reads the
-- corpus oldest-first, bounded per boot and self-draining.

-- ---------------------------------------------------------------------------
-- AND THE THING THAT MAKES ANY PARSER FIX REACH THE BACK BOOK.
--
-- `INGEST_VERSION` re-reads a REPORT — but `ingestAppraisal` reads the STORED
-- `appraisals` and `appraisal_comparables` rows, not the XML. So a bug in the
-- PARSER cannot be healed by re-ingesting the warehouse: it would faithfully
-- re-read the same wrong number. db/426's own note said the sweep would fix the
-- room counts, and it would not have — the rows it re-reads are the ones the
-- parser wrote wrong.
--
-- What fixes it is re-PARSING the stored source XML and rewriting the comparable
-- rows, which `backfillAppraisalCompSplitOnce` has done for `comp_set` since the
-- split shipped. `comp_parse_version` is the drain marker for the general case:
-- a current appraisal behind the parser's version is re-parsed at boot, bounded,
-- oldest-first, and stamped so it leaves the queue. A report whose XML can no
-- longer be recovered is NOT stamped, so a transient storage failure retries
-- rather than draining a file out of the repair forever.
-- ---------------------------------------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS comp_parse_version smallint;

COMMENT ON COLUMN appraisals.comp_parse_version IS
  'Which version of the comparable-grid parser last wrote this report''s '
  'appraisal_comparables rows. NULL = before the marker existed. Behind the '
  'current version means the stored comps are re-parsed from the source XML at '
  'boot — the only thing that can heal a PARSER bug on a report already imported.';

CREATE INDEX IF NOT EXISTS ix_appraisals_comp_parse_version
  ON appraisals(comp_parse_version) WHERE superseded = false;
