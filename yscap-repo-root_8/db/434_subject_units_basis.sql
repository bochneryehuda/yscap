-- 434 — A SUBJECT'S UNIT COUNT SAYS WHETHER IT WAS COUNTED OR MERELY IMPLIED
--
-- db/431 gave every COMPARABLE an `identity_basis` so a screen and the warehouse
-- roll-up could tell a measurement from an inference. The SUBJECT had no such
-- column, and the roll-up therefore treated every subject observation as
-- measured — "the appraiser stood in the building and counted the doors".
--
-- Usually true, and not always. `extract.js` IMPLIES the count from the form
-- when a 1004 or 1073 leaves `LivingUnitCount` blank:
--
--     if (subject.units == null && (form === 'FNM1004' || form === 'FNM1073')) subject.units = 1;
--
-- so a form-implied 1 ranked ABOVE a grid-COUNTED 3 on the same property, and a
-- triplex another report had actually counted could be rolled back to a house.
-- The same line is what refills the count after `test-appraisal-overflow-guards`
-- nulls an out-of-range `LivingUnitCount`, so the inference is reachable by a
-- second route as well.
--
-- Two values only, matching the comparable column's vocabulary:
--   grid   the report stated a unit count (`LivingUnitCount`) and we read it.
--   form   the report stated none and the FORM implied it (1004/1073 → 1).
--
-- NULL is the honest legacy state and is deliberately NOT back-filled to either
-- value: a stored row cannot say which it was, and guessing 'form' would demote
-- real measurements across the whole back book while guessing 'grid' would
-- promote real inferences. `identityRank` reads NULL as measured, which is what
-- it was before db/434 — every subject count then came only from
-- `LivingUnitCount`, because the implication is applied inside the parser and
-- the parser is what the version-gated re-ingest re-runs.

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS subject_units_basis text;

COMMENT ON COLUMN appraisals.subject_units_basis IS
  'How the subject''s unit count was established: grid (the report stated '
  'LivingUnitCount) or form (it stated none and a 1004/1073 implies one '
  'dwelling). NULL on any report read before db/434.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appraisals_subject_units_basis_ck') THEN
    ALTER TABLE appraisals
      ADD CONSTRAINT appraisals_subject_units_basis_ck
      CHECK (subject_units_basis IS NULL OR subject_units_basis IN ('grid', 'form'));
  END IF;
END $$;
