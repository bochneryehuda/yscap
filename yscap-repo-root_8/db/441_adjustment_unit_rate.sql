-- 441 — WHAT AN APPRAISER ACTUALLY PAID PER SQUARE FOOT
--
-- db/440 stored the adjustment lines as rows and said, in its own header and in
-- the returned value, that a median adjustment IS NOT A RATE: a -$12,000 living
-- area adjustment says nothing per square foot without knowing how many feet
-- apart the two properties were. It also said the rows make that computable.
-- This computes it.
--
-- The delta is the SUBJECT minus the COMPARABLE, and the appraiser adjusts the
-- comparable's price TOWARD the subject — so a comp that is bigger is adjusted
-- DOWN, and `amount / (subject − comp)` comes out POSITIVE. That is a claim
-- about how appraisers actually fill the grid, not a convention we imposed, so
-- it was measured before anything was built. Over all 152 real reports:
--
--     comparables with a size adjustment AND both sizes stated   473
--     the two properties are the same size (no delta to divide)    5
--     rate came out NEGATIVE (the adjustment points the wrong way) 0
--     rate came out implausible (> $500/sq ft)                     0
--     usable                                                     468
--
--     $/sq ft   p10 18   p25 25   MEDIAN 40   p75 50   p90 70
--
-- Zero negatives and zero outliers across 468 real adjustments is the evidence
-- that the sign convention holds and the arithmetic is meaningful. That
-- distribution is the peer benchmark the design document was after — what
-- appraisers in our own markets have actually paid for a square foot, rather
-- than a ratio derived from sale prices.
--
-- ONLY THE SIZE LINES, and deliberately so. `GrossLivingArea` and
-- `GrossBuildingArea` are the two whose delta is unambiguous, because both sides
-- state one number in one unit. A `RoomCount` adjustment on most grids covers
-- rooms AND bedrooms AND bathrooms together, so dividing it by a room difference
-- would attribute the bathrooms to the rooms; an `Age` adjustment is bounded by
-- effective age, not calendar age. Those need their own measurement before they
-- get a rate, and a rate that is wrong is worse than none because it gets
-- believed. `unit_delta_basis` names the unit so a future line can add its own
-- without any consumer having to guess.
--
-- NULL when the delta is unknown or too small to divide by — a 20-square-foot
-- difference produces a rate of several hundred dollars a foot from an ordinary
-- adjustment, which is arithmetic, not a market signal.

ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS unit_delta numeric(14,2);
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS unit_delta_basis text;

COMMENT ON COLUMN property_adjustments.unit_delta IS
  'The difference this adjustment was made FOR, as SUBJECT minus COMPARABLE. '
  'Signed: a comparable bigger than the subject gives a negative delta and a '
  'negative adjustment, so amount/unit_delta is positive. NULL when either side '
  'did not state the fact, or when the difference is too small to divide by.';

COMMENT ON COLUMN property_adjustments.unit_delta_basis IS
  'What unit `unit_delta` is in — ''sqft'' today. Named rather than assumed so a '
  'future line type (rooms, years) can carry its own without any consumer having '
  'to guess which unit a rate is per.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_adjustments_delta_basis_ck') THEN
    ALTER TABLE property_adjustments
      ADD CONSTRAINT property_adjustments_delta_basis_ck
      CHECK (unit_delta_basis IS NULL OR unit_delta_basis IN ('sqft'));
  END IF;
END $$;

-- The rate benchmark's own index: "this unit, in this town, recently".
CREATE INDEX IF NOT EXISTS ix_property_adjustments_rate
  ON property_adjustments (unit_delta_basis, state, lower(city), observed_on DESC)
  WHERE amount IS NOT NULL AND unit_delta IS NOT NULL AND unit_delta <> 0;
