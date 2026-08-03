-- 436 — THE AREA'S BASIS TRAVELS WITH IT, AND A LIVING AREA OUTRANKS A BUILDING AREA
--
-- `property_observations.gla_basis` has recorded, per observation, whether an
-- area is gross LIVING area (a 1004 grid) or gross BUILDING area (a 1025 grid,
-- and every rent schedule) since db/427 — because "$150 a foot of living area"
-- and "$150 a foot of building area" describe different properties.
--
-- `properties` had no such column. So the roll-up picked a `gla` by recency,
-- wrote the number, and DROPPED the one fact that says what the number means.
-- Everything downstream then reads it blind: the search screen labels it "Gross
-- living area", sorts on it and divides the sale price by it; the valuation
-- engine derives its per-square-foot adjustment and its ±25% size bracket from
-- it.
--
-- Measured inside ONE report — 766 Winchester Ave, New Haven: the sales grid
-- states 2,247 (living) and the rent schedule states 2,747 (building), same
-- appraisal, same date. The rental observation is written last, so on a tie it
-- won and the property rolled up to 2,747 labelled as living area. The class
-- PRE-DATES the rent schedule (51 of 112 winning `gla` observations in a 25-file
-- sample were already a 1025's building area); db/435 widened it, because a rent
-- schedule is ALWAYS building area.
--
-- Two halves, and the second is the one that matters:
--   · the basis is carried onto the property, so a reader can tell;
--   · and the roll-up PREFERS an observation that states a living area, falling
--     back to a building area only when nothing measured a living one. Recency
--     breaks the tie within a basis, exactly as before.
--
-- Nothing is converted. A building area is not a living area times a constant —
-- the difference is the stairwells, the shared halls and the basement, and it
-- varies per building. The honest answer is to say which one you have.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS gla_basis text;

COMMENT ON COLUMN properties.gla_basis IS
  'What `gla` is a measure of: ''gla'' = gross LIVING area (a 1004 grid), '
  '''gba'' = gross BUILDING area (a 1025 grid or a rent schedule, which includes '
  'the stairwells, shared halls and basement). The roll-up prefers a living area '
  'and falls back to a building area only when no report measured a living one. '
  'NULL on any property rolled up before db/436.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_gla_basis_ck') THEN
    ALTER TABLE properties
      ADD CONSTRAINT properties_gla_basis_ck
      CHECK (gla_basis IS NULL OR gla_basis IN ('gla', 'gba'));
  END IF;
END $$;

-- THE DEDUPE PIVOT FOR A RENTAL OBSERVATION HAS TO SURVIVE A NULL SEQUENCE.
-- db/435 indexed `(appraisal_id, comp_seq)` with no COALESCE, and NULLs are
-- DISTINCT in a unique index — so a rental row with no sequence matched no
-- conflict target and every re-ingest inserted another copy. Proven: two
-- sequence-less rentals, `writeReport` run twice on one import, four rows. The
-- same migration got it right one table over (`uq_rental_comps_seq` uses
-- `COALESCE(seq,'')`). Rebuilt with the COALESCE, and the ON CONFLICT clauses in
-- `upsertObservation` are written to match.
DROP INDEX IF EXISTS uq_obs_rental_by_appraisal;
DROP INDEX IF EXISTS uq_obs_rental_by_import;
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_rental_by_appraisal
  ON property_observations (appraisal_id, COALESCE(comp_seq, ''))
  WHERE role = 'rental_comparable' AND appraisal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_rental_by_import
  ON property_observations (import_id, COALESCE(comp_seq, ''))
  WHERE role = 'rental_comparable' AND import_id IS NOT NULL;

-- The rent schedule's comparables are counted in their own right. `properties`
-- carries `comp_count` (sales comparables) and `observation_count` (everything),
-- and adding a third role made those two disagree by a number nothing explained.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rental_comp_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN properties.rental_comp_count IS
  'How many times this property has appeared as a RENTAL comparable on somebody '
  'else''s rent schedule. Counted apart from comp_count (sales comparables) so '
  'the two, plus subject_count, add up to observation_count.';
