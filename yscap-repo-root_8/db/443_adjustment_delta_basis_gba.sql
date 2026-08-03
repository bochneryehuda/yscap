-- 443 — A FOOT OF LIVING AREA AND A FOOT OF BUILDING AREA ARE NOT THE SAME FOOT
--
-- db/441 stored `unit_delta` as SUBJECT minus COMPARABLE and labelled every one
-- of them `unit_delta_basis = 'sqft'`, on the stated grounds that the two size
-- lines are "the two whose delta is unambiguous, because both sides state one
-- number in one unit". That is true of the LINE and false of the two SIDES.
--
-- `appraisals.gla` is always `GrossLivingAreaSquareFeetCount` — there is no basis
-- column on `appraisals` at all. A COMPARABLE's `gla` is whatever that grid
-- stated under the same element, and on a Fannie 1025 (2-4 unit) that is gross
-- BUILDING area; db/427 added `property_observations.gla_basis` precisely to
-- record which one it is, and db/436's header states the rule this file is
-- applying: "'$150 a foot of living area' and '$150 a foot of building area'
-- describe different properties."
--
-- Measured over the 557 delta-carrying rows in the corpus:
--
--     subject living area  vs  comparable living area      358
--     subject living area  vs  comparable BUILDING area    199   <-- all 1025s
--     subject building area vs anything                      0
--
-- So 36% of the rows subtracted a building area from a living area and then said
-- the answer was in the same unit as the other 64%. The two populations do not
-- agree:
--
--     comparable basis gla   n=290   q1 38.5   MEDIAN 45.0   q3 55.0
--     comparable basis gba   n=178   q1 20.0   MEDIAN 28.0   q3 50.0
--
-- Part of that gap is a real market difference — a 1004 single-family against a
-- 1025 2-4 unit — and part is the mixed measure. Which is which cannot be read
-- out of a median that blends them, and that is the point: the label erased the
-- one distinction the observation already carried.
--
-- THE ROWS ARE KEPT, NOT DROPPED. A building-area adjustment is real information
-- about how that grid was worked, and discarding all 199 would throw away the
-- owner's own 2-4 unit segment entirely. `unit_delta_basis` exists — in db/441's
-- own words — "so a future line can add its own without any consumer having to
-- guess which unit a rate is per". This is that case, arriving one file later.
--
-- `adjustmentRate` defaults to `'sqft'` (living area), so the published rate is
-- now single-measure; a caller that wants the building-area population asks for
-- it by name.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_adjustments_delta_basis_ck') THEN
    ALTER TABLE property_adjustments DROP CONSTRAINT property_adjustments_delta_basis_ck;
  END IF;
  ALTER TABLE property_adjustments
    ADD CONSTRAINT property_adjustments_delta_basis_ck
    CHECK (unit_delta_basis IS NULL OR unit_delta_basis IN ('sqft', 'sqft_gba'));
END $$;

-- PREVIOUS AND FUTURE. Re-label the rows already written, from the basis the
-- observation has carried all along. This is a RE-LABEL, never a recompute: the
-- delta itself is unchanged and no row is added or removed, so a row that was
-- right stays byte-identical. Only a size line can carry a delta at all, and only
-- a comparable whose own `gla_basis` says `gba` is moved.
UPDATE property_adjustments a
   SET unit_delta_basis = 'sqft_gba'
  FROM property_observations o
 WHERE o.id = a.observation_id
   AND a.unit_delta IS NOT NULL
   AND a.unit_delta_basis = 'sqft'
   AND lower(COALESCE(o.gla_basis, '')) = 'gba';

-- And the reverse, so a row mislabelled by a future writer heals rather than
-- sticking: a comparable stating LIVING area is 'sqft'. NULL means the row
-- predates db/427 and is living area by every convention this warehouse has had.
UPDATE property_adjustments a
   SET unit_delta_basis = 'sqft'
  FROM property_observations o
 WHERE o.id = a.observation_id
   AND a.unit_delta IS NOT NULL
   AND a.unit_delta_basis = 'sqft_gba'
   AND lower(COALESCE(o.gla_basis, 'gla')) <> 'gba';

COMMENT ON COLUMN property_adjustments.unit_delta_basis IS
  'What unit `unit_delta` is in. ''sqft'' = square feet of LIVING area on both '
  'sides. ''sqft_gba'' = the comparable stated gross BUILDING area (a 1025 grid), '
  'so the delta is living-area-minus-building-area and is NOT comparable with a '
  '''sqft'' row — kept apart rather than dropped, because how a 2-4 unit grid was '
  'worked is real information. Named rather than assumed so no consumer has to '
  'guess which unit a rate is per.';
