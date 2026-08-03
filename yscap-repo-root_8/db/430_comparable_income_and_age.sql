-- 430 — THE FACTS A COMPARABLE GRID STATES AND WE WERE NOT READING
--
-- Phase 2 of the property-research build list. Each of these is written on the
-- grid the appraiser filled in, was parsed by nothing, and answers a question the
-- comp search is asked every day.
--
--   * PRICE PER UNIT (`SalesPricePerUnitAmount`) — on a 2-4 family this is the
--     number the market actually trades on, and it is stated per comparable.
--     Price per FOOT is the single-family measure; a 6-bed triplex and a 6-bed
--     house are not comparable per foot, they are comparable per door.
--
--   * THE COMPARABLE'S RENT (`RentalActualGrossMonthlyRentAmount` /
--     `…EstimatedGross…` on the comp's own MULTIFAMILY_RENTAL block) and the
--     GROSS RENT MULTIPLIER the appraiser derived from it. On a rental-exit loan
--     the GRM is the comparison; we hold the subject's and threw the comps' away,
--     which makes the subject's number impossible to check.
--
--   * THE STATED AGE IN YEARS. The grid's "Actual Age" line is written in YEARS,
--     and we derived a year built from it and stored only that — losing the
--     appraiser's own figure and its effective/actual distinction. Store what was
--     stated; the derived year is still there beside it.
--
-- ALL NULL UNLESS THE GRID SAYS SO. None of these is inherited from the subject,
-- computed from another figure, or defaulted — a comparable that states no rent
-- has no rent, which is a different thing from a rent of zero.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS price_per_unit  numeric(14,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS monthly_rent    numeric(12,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS grm             numeric(10,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS age_years       integer;

COMMENT ON COLUMN appraisal_comparables.price_per_unit IS
  'Sale price per dwelling, as the grid stated it. The 2-4 family measure — a '
  '6-bed triplex and a 6-bed house compare per door, not per foot.';
COMMENT ON COLUMN appraisal_comparables.age_years IS
  'The actual age in YEARS as the grid stated it. year_built is derived from this '
  'and kept beside it; this is the appraiser''s own figure.';

-- The warehouse side, so the comp search can reach them.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS price_per_unit numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS monthly_rent   numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS grm            numeric(10,2);

-- `monthly_rent` is a PROPERTY fact (what this building rents for) and rolls up.
-- `price_per_unit` and `grm` are facts about a TRANSACTION and a REPORT's own
-- arithmetic — they belong to the observation that stated them, exactly as
-- `price_per_gla` does, and are deliberately not given a properties column.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS monthly_rent numeric(12,2);

-- Previous reports: the change is in the PARSER, so `COMP_PARSE_VERSION` moves
-- and the boot re-parse rewrites these from each report's own stored source XML.
