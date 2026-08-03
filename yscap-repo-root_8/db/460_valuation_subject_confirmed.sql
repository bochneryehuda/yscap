-- ---------------------------------------------------------------------------
-- "THE SYSTEM SAYS" → "I CHECKED" — who confirmed the subject's facts, and what
-- they were at the moment they said so.
--
-- A build-your-own valuation reads its subject out of the warehouse, and the
-- warehouse read it out of somebody's appraisal. That is usually right and is
-- never CONFIRMED, so a number an officer is about to quote rests on facts nobody
-- has looked at — living area, condition, unit count — several of which silently
-- REMOVE an adjustment when they are missing rather than making a wrong one.
--
-- THE SNAPSHOT IS THE POINT, NOT THE TIMESTAMP. A stamp saying "checked" that
-- survives the fact being changed afterwards is worse than no stamp at all: it
-- launders an unchecked number as a checked one. So the values as they stood at
-- the moment of confirmation are stored alongside the stamp, and every read
-- compares them to the current ones (`lib/research/subject-facts.confirmationStale`)
-- — the screen can then say "this was confirmed, and the living area has changed
-- since", which is the only honest thing to say in that state.
--
-- Deliberately NOT a column per fact: what a confirmation covers is decided by
-- `subject-facts.FACTS`, and adding one there must not need a migration or the
-- list and the record will drift.
-- ---------------------------------------------------------------------------

ALTER TABLE property_valuations
  ADD COLUMN IF NOT EXISTS subject_confirmed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS subject_confirmed_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- The values at the moment somebody said "checked". Compared to the live ones
  -- on every read, so the confirmation can go stale instead of quietly persisting.
  ADD COLUMN IF NOT EXISTS subject_confirmed_snapshot  jsonb,
  -- What the confirmation CHANGED, if anything. A confirmation that corrected the
  -- living area is a different event from one that agreed with everything, and the
  -- difference is worth keeping: it is the evidence that the check does work.
  ADD COLUMN IF NOT EXISTS subject_confirmed_changes   jsonb;

COMMENT ON COLUMN property_valuations.subject_confirmed_snapshot IS
  'The subject facts as they stood when a person confirmed them. Compared to the current ones on every read so the confirmation can go STALE — a "checked" stamp that survives the fact changing launders an unchecked number as a checked one.';
