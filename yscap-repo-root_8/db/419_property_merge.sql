-- 419 — MERGING TWO PROPERTY ROWS THAT ARE THE SAME HOUSE
--
-- The owner's rule, in their own words: "if you find two appraisals with the same
-- comparable it shouldn't open up two data lines for it — it should merge them
-- together as one property and it should add the missing information, one appraisal
-- had it, the other didn't … there shouldn't be duplicate properties."
--
-- Almost all of that is already true. `propertyKey` folds two spellings of one
-- address into ONE row, and `properties` is a ROLL-UP recomputed from every report
-- that ever described the house — so the merge, the gap-filling and the conflict
-- resolution all happen on their own, and are tested.
--
-- THIS FILE IS FOR THE REMAINDER: two rows that are genuinely the same house but
-- whose address KEY differs, so the key could never fold them. The research
-- (docs/research/PROPERTY-DEDUPE-AND-MERGE.md) confirmed each cause against the real
-- code; the two that matter are structural rather than exotic:
--
--   1. A comparable that named no CITY keys on its ZIP (`z07103`) while the same
--      house on a report that DID name the city keys on the city. About a third of
--      files lean on the city fallback, so this is the biggest bucket. Its fix is at
--      the ingest and ships with this — a comp with no city inherits the SUBJECT's
--      city, gated on the ZIPs matching. Pure, offline, and monotone: if the ZIPs
--      differ nothing changes.
--   2. One report carries a unit and another does not. That one CANNOT be fixed by a
--      rule — the unit is never dropped on purpose, because unit 2 and unit 5 of one
--      building sell for different prices — so it needs a human.
--
-- WHY MERGING A PROPERTY IS SO MUCH SIMPLER THAN MERGING A PERSON (db/323): a
-- borrower row is AUTHORED, so every field the two disagree on is a decision and the
-- merge refuses rather than guess. A property row is DERIVED. Move the observations
-- and re-roll, and every fact resolves itself by the rule that was already reviewed:
-- the most recent report that STATED a fact wins, and a report that was silent never
-- blanks it. There is no field choice to make, and therefore none to get wrong.

-- ---------------------------------------------------------------------------
-- 1. WHERE A MERGED PROPERTY WENT
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_merges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_id     uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- DELIBERATELY NOT A FOREIGN KEY. That row is gone — remembering the id it used to
  -- have is the entire point, so a bookmarked or emailed link to it can be redirected
  -- to the survivor instead of dying.
  merged_id       uuid NOT NULL,
  merged_key      text NOT NULL,
  merged_address  text,
  -- The whole losing row before it went, plus what moved. A merge deletes a row; the
  -- only honest way to do that is to be able to say exactly what was there.
  merged_snapshot jsonb NOT NULL,
  cause           text,
  moved           jsonb,
  -- NULL when a deterministic re-key did it rather than a person.
  merged_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_merges_survivor ON property_merges(survivor_id);
CREATE INDEX IF NOT EXISTS idx_property_merges_merged   ON property_merges(merged_id);

-- ---------------------------------------------------------------------------
-- 2. "I CHECKED — THESE TWO ARE NOT THE SAME HOUSE"
-- ---------------------------------------------------------------------------
-- Without this the detector would offer the same pair back every week and the list
-- would train people to ignore it. A property pair has no direction (unlike a
-- borrower access grant, which genuinely runs one way), so it is ONE canonically
-- ordered row — which also means a detector written either way round cannot miss it
-- and a second person cannot file the mirror image.
--
-- ON DELETE CASCADE on both sides is load-bearing: if either row is later merged into
-- some THIRD property, this record is about a row that no longer exists and cleans
-- itself up.
CREATE TABLE IF NOT EXISTS property_not_duplicates (
  property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  other_property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  reason            text,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, other_property_id),
  CHECK (property_id < other_property_id)
);
