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
-- CORRECTION (post-merge audit): the 766 Winchester Ave example this file
-- originally gave was WRONG, and is recorded here rather than quietly deleted.
-- That report is a 1025 whose sales grid states `_Type="GrossBuildingArea"`, so
-- BOTH its numbers are building areas (2,247 on the grid, 2,747 on the rent
-- schedule) and there was never a living area to prefer — the audit measured the
-- fix changing 0 properties in the corpus, because only 1 property of 954 holds
-- both bases at all and its two numbers agree.
--
-- The change is still right, and for the reason the rest of this file gives: 391
-- of 954 properties roll up a BUILDING area into a column the search screen
-- labels "Gross living area", and until now nothing recorded which one it was.
-- The preference rule is what makes a future mixed-basis property answer
-- correctly; the basis column is what makes today's 391 honest. What it is NOT
-- is a fix that moves a number today, and claiming otherwise was the error.
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
--
-- TWO THINGS THE FIRST CUT GOT WRONG HERE, both found by audit and both fixed
-- below:
--
-- (a) IT REBUILT BOTH INDEXES ON EVERY BOOT. `DROP INDEX IF EXISTS` followed by
--     `CREATE UNIQUE INDEX IF NOT EXISTS` never settles — the DROP guarantees the
--     IF NOT EXISTS is dead — so every deploy took an ACCESS EXCLUSIVE lock and
--     rebuilt them from scratch (index OIDs changed on every run). The drop now
--     fires ONLY when an index of that name exists with the OLD definition, i.e.
--     one that does not COALESCE the sequence.
--
-- (b) IT COULD NOT BE APPLIED TO THE DATABASE IT EXISTS TO REPAIR. The duplicates
--     described above are exactly what a sequence-less rental produced under
--     db/435's non-COALESCE index — and `CREATE UNIQUE INDEX` over them raises
--     23505. The whole file is one implicit transaction, so NOTHING in db/436
--     applied; worse, `migrate-boot` matches /already exists|duplicate/i against
--     the error text, which a 23505 `... is duplicated.` detail satisfies, so it
--     logged the failure as "already applied" and recorded it in the ledger. The
--     duplicates are therefore removed FIRST, keeping the oldest row of each
--     group (the original; the copies are re-ingest artefacts of the same
--     reading, so nothing is lost).
DELETE FROM property_observations a
 USING property_observations b
 WHERE a.role = 'rental_comparable' AND b.role = 'rental_comparable'
   AND a.appraisal_id IS NOT NULL AND a.appraisal_id = b.appraisal_id
   AND COALESCE(a.comp_seq, '') = COALESCE(b.comp_seq, '')
   AND (a.created_at, a.id) > (b.created_at, b.id);

DELETE FROM property_observations a
 USING property_observations b
 WHERE a.role = 'rental_comparable' AND b.role = 'rental_comparable'
   AND a.import_id IS NOT NULL AND a.import_id = b.import_id
   AND COALESCE(a.comp_seq, '') = COALESCE(b.comp_seq, '')
   AND (a.created_at, a.id) > (b.created_at, b.id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_obs_rental_by_appraisal'
               AND indexdef NOT LIKE '%COALESCE%') THEN
    DROP INDEX uq_obs_rental_by_appraisal;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_obs_rental_by_import'
               AND indexdef NOT LIKE '%COALESCE%') THEN
    DROP INDEX uq_obs_rental_by_import;
  END IF;
END $$;

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
