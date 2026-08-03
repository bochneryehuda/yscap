-- 440 — THE ADJUSTMENT CORPUS, AS ROWS
--
-- `property_observations.adjustments` is a jsonb array of every line the appraiser
-- wrote on that comparable — `{type, description, amount}`. Across the 152 real
-- reports in hand that is **16,724 lines, 3,273 of them carrying a real non-zero
-- dollar figure**, and it is the one dataset here that NO DATA VENDOR HAS: real
-- appraiser adjustments, in our own markets, from reports we paid for.
--
-- As jsonb it can only be read one comparable at a time. As rows keyed by line
-- code it is one `GROUP BY`: "what are appraisers actually paying for a bathroom
-- in Paterson?" The design document names this as the single highest-value
-- follow-up to the warehouse, and it is what turns the valuation tool's suggested
-- adjustments from a median-of-ratios guess into a peer benchmark — an answer
-- grounded in what appraisers in that market have actually done.
--
-- WHAT IS AND IS NOT STORED, and why:
--
-- · The MARKET KEYS are denormalised onto the row (state, city, zip, observed_on).
--   The whole point is a market-scoped aggregate, and joining back through
--   `property_observations` to `properties` for every one of a million rows to
--   discover a town is the difference between an index scan and a sort.
--
-- · A NULL amount is kept, and it is NOT the same as zero. An appraiser writing a
--   line with no figure has said "I looked at this and made no adjustment"; a line
--   that is absent means the form never asked. Both are information about how the
--   grid was worked, and collapsing them would make every average wrong.
--
-- · The DESCRIPTION rides along because on a non-UAD report it is the only thing
--   that says WHAT was adjusted ("Full/988 Sq.Ft.", "IG POOL", "Infer-2beds").
--
-- WHAT THIS DELIBERATELY DOES NOT CLAIM. A median adjustment is NOT a rate. A
-- -$5,000 room-count adjustment says nothing per room without knowing how many
-- rooms apart the two properties were, and that delta needs the subject paired
-- with the comparable. The rows make that computable; this migration does not
-- pretend to have computed it. A figure labelled "what a bathroom is worth" that
-- is really "the median of every bathroom adjustment regardless of size" is worse
-- than no figure, because it gets believed.

-- `CREATE TABLE IF NOT EXISTS` IS A NO-OP ON AN EXISTING TABLE, so a column added
-- to this file later is never added to a database that already ran it — the
-- migration then dies on the first statement naming that column, and
-- `migrate-boot` classifies a 23505 "… is duplicated" by regex and records the
-- file as APPLIED. That is the db/436 trap, one file later. Every column is
-- therefore also added explicitly below, and duplicates are removed before the
-- unique index that would otherwise refuse to build over them.
CREATE TABLE IF NOT EXISTS property_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES property_observations(id) ON DELETE CASCADE,
  property_id    uuid REFERENCES properties(id) ON DELETE SET NULL,
  -- The line's POSITION in the grid, which is what makes a row identifiable.
  -- A comparable legitimately carries several lines of the SAME type (two
  -- `OtherFeature` rows, two `Other` rows), so the type alone cannot key it; the
  -- position is stable for a given reading of a given report.
  seq            integer NOT NULL,
  -- The grid line: 'GrossLivingArea', 'RoomCount', 'Condition', 'BasementArea' …
  line_type      text NOT NULL,
  description    text,
  -- The dollar figure the appraiser wrote. NULL = the line was written with no
  -- figure, which is NOT zero. Signed: a negative adjustment means the comparable
  -- was superior and its price was adjusted DOWN toward the subject.
  amount         numeric(14,2),
  -- Denormalised market keys, so the benchmark query needs no join.
  state          text,
  city           text,
  zip            text,
  observed_on    date,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The columns again, for a database that created the table under an earlier
-- version of this file. `ADD COLUMN IF NOT EXISTS` is the pattern db/439 and
-- db/441 use and the one this file should have used from the start.
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS seq integer;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS property_id uuid;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS amount numeric(14,2);
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS zip text;
ALTER TABLE property_adjustments ADD COLUMN IF NOT EXISTS observed_on date;

-- A row with no `seq` predates the keyed version and cannot take part in the
-- unique index; number them by their own insertion order so nothing is lost.
UPDATE property_adjustments a SET seq = n.rn - 1
  FROM (SELECT id, row_number() OVER (PARTITION BY observation_id ORDER BY created_at, id) AS rn
          FROM property_adjustments WHERE seq IS NULL) n
 WHERE a.id = n.id AND a.seq IS NULL;

-- And remove the duplicates the pre-keyed writer could produce, keeping the
-- oldest of each group.
DELETE FROM property_adjustments a
 USING property_adjustments b
 WHERE a.observation_id = b.observation_id AND a.seq = b.seq
   AND (a.created_at, a.id) > (b.created_at, b.id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'property_adjustments' AND column_name = 'seq'
                AND is_nullable = 'YES')
     AND NOT EXISTS (SELECT 1 FROM property_adjustments WHERE seq IS NULL) THEN
    ALTER TABLE property_adjustments ALTER COLUMN seq SET NOT NULL;
  END IF;
END $$;

-- ONE ROW PER LINE PER OBSERVATION — and this index is the only thing that makes
-- it true under concurrency. The writer replaces a report's lines on every
-- re-ingest, and `fireResearchIngest` is called from several places (the import,
-- the photo pass, the comparable re-parse, the boot backfill), so two ingests of
-- one report genuinely overlap. Delete-then-insert is not atomic against an
-- identical concurrent operation: both delete, both insert, and the corpus keeps
-- BOTH copies — measured, a report seeded through two racing ingests stored 266
-- rows where it should hold 133, exactly double, and every median computed from
-- it would have been weighted twice for that report. With this index the second
-- writer's INSERT hits ON CONFLICT and converges instead.
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_adjustments_line
  ON property_adjustments (observation_id, seq);

-- THE BENCHMARK QUERY'S OWN INDEX: "this line, in this town, recently".
CREATE INDEX IF NOT EXISTS ix_property_adjustments_market
  ON property_adjustments (line_type, state, lower(city), observed_on DESC)
  WHERE amount IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_property_adjustments_zip
  ON property_adjustments (line_type, zip, observed_on DESC)
  WHERE amount IS NOT NULL AND zip IS NOT NULL;

-- Re-ingesting a report REPLACES its lines rather than adding a second copy, so
-- the writer deletes by observation first; this index is what makes that cheap.
CREATE INDEX IF NOT EXISTS ix_property_adjustments_observation
  ON property_adjustments (observation_id);

COMMENT ON TABLE property_adjustments IS
  'One row per adjustment line an appraiser wrote on a comparable — the corpus no '
  'data vendor has: real adjustments, in our markets, from reports we paid for. '
  'A NULL amount means the line was written with no figure, which is NOT zero. '
  'A median of `amount` is NOT a per-unit rate: that needs the subject-vs-comp '
  'delta, which these rows make computable but do not themselves state.';
