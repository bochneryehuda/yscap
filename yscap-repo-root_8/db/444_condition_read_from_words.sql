-- A WORDED CONDITION RATING BECOMES SOMETHING THE WAREHOUSE CAN ACTUALLY FILTER ON.
--
-- `properties.condition_rank` and `.quality_rank` are GENERATED columns: the
-- digits of `condition_uad` / `quality_uad`. That is right for a UAD code and it
-- is silent about everything else — and UAD was mandated for exactly four forms
-- (1004, 1073, 1075, 2055). The 1025 (2-4 unit) was explicitly left out, so its
-- grid condition is the appraiser's own words, which is the whole 2-4 unit book
-- for a lender whose book is 2-4 units.
--
-- Measured on the real 152-report corpus: 955 properties, 680 carrying a code,
-- **234 carrying words only** and 41 carrying nothing. A quarter of the
-- warehouse is invisible to every condition filter, to the facets, and to the
-- valuation's per-condition-grade rate. Quality is the same shape: 165 of the
-- worded ratings say "Average" or "Good" — and 21 of them say FRAME or BRICK,
-- which is exactly why the reading refuses far more than it accepts.
--
-- THE RESOLVED ANSWER GETS ITS OWN COLUMN rather than changing the generated
-- one. `condition_rank` keeps meaning "the code said so", which several
-- consumers rely on; `condition_rank_read` is THE one answer a filter should
-- use — populated from the code when there is one and from the words when there
-- is not — so nothing has to COALESCE across two columns and get it backwards.
--
-- THE READING ITSELF LIVES IN `src/lib/research/condition-scale.js`, in
-- JavaScript, deliberately: a PL/pgSQL twin of a rule that weighs relative
-- words, quality codes in the condition slot, work-not-condition words, spans
-- and modifiers would drift from the live one — the `pilot_term_norm` /
-- `pilot_property_type_norm` class this repo has already been bitten by twice.
-- The roll-up writes these columns, and `ROLLUP_VERSION` (8 -> 9) is what makes
-- that reach every property already stored.
--
-- Idempotent.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS condition_rank_read       smallint,
  ADD COLUMN IF NOT EXISTS condition_rank_low        smallint,
  ADD COLUMN IF NOT EXISTS condition_rank_high       smallint,
  ADD COLUMN IF NOT EXISTS condition_read_source     text,
  ADD COLUMN IF NOT EXISTS condition_read_confidence text,
  ADD COLUMN IF NOT EXISTS quality_rank_read         smallint,
  ADD COLUMN IF NOT EXISTS quality_rank_low          smallint,
  ADD COLUMN IF NOT EXISTS quality_rank_high         smallint,
  ADD COLUMN IF NOT EXISTS quality_read_source       text,
  ADD COLUMN IF NOT EXISTS quality_read_confidence   text,
  -- HOW THE ROLL-UP KNOWS THE UNIT COUNT AND THE PROPERTY TYPE. The roll-up
  -- already picks the BEST-SOURCED observation that stated a count
  -- (`identityRank`: a subject measurement beats a grid statement beats a
  -- design-style reading beats a form inference) and then threw that provenance
  -- away. The appraisal tab has to rank the warehouse's answer against the one
  -- the report in front of it states, and without this it cannot: 409 of 769
  -- real comparables get both facts from the FORM the appraiser happened to use,
  -- which proves one dwelling by definition and nothing more, and letting that
  -- silently overwrite a genuinely counted triplex is the exact trap
  -- `rollupProperty` has its own written rule against.
  ADD COLUMN IF NOT EXISTS units_basis               text;

COMMENT ON COLUMN properties.units_basis IS
  'How `units` / `property_type` were established: ''subject'' (an appraiser stood in the building), ''grid'' (stated on a sales grid), ''style'' / ''price'' (read from the stated design or the per-unit price), ''form'' (implied by the report form alone). NULL when nothing stated a count.';

COMMENT ON COLUMN properties.condition_rank_read IS
  'THE condition rank to filter and sort on: 1 (best) to 6 (worst), read from the UAD code when there is one and from the appraiser''s own words when there is not. `condition_rank` is the code alone and stays that way. Written by rollupProperty via research/condition-scale.js.';
COMMENT ON COLUMN properties.condition_read_source IS
  '''code'' when a literal C1-C6 was given, ''word'' when it was read from the appraiser''s words. NULL when nothing readable was stated — a relative word (similar / superior / inferior), a quality code in the condition slot, or a description of work rather than condition.';
COMMENT ON COLUMN properties.condition_rank_low IS
  'The best grade the rating supports. "Average" is not C4 — it is C3-or-C4 and we lean C4, so a filter can be honest about what it cannot separate.';

-- Partial, because a rank filter only ever asks about rows that HAVE one, and
-- roughly a quarter of the table does not.
CREATE INDEX IF NOT EXISTS idx_properties_condition_read
  ON properties(condition_rank_read) WHERE condition_rank_read IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_quality_read
  ON properties(quality_rank_read) WHERE quality_rank_read IS NOT NULL;

-- THE ONE THING SQL CAN DO HERE HONESTLY: seed the rows whose answer is the code
-- itself, which is a pure re-statement of a generated column and cannot disagree
-- with the JavaScript. Every WORDED rating is left for the roll-up, because that
-- is the reading no migration should be re-implementing. Guarded so a re-run,
-- or a roll-up that has already written a better answer, is untouched.
UPDATE properties
   SET condition_rank_read = condition_rank,
       condition_rank_low = condition_rank,
       condition_rank_high = condition_rank,
       condition_read_source = 'code',
       condition_read_confidence = 'definite'
 WHERE condition_rank IS NOT NULL AND condition_rank_read IS NULL;

UPDATE properties
   SET quality_rank_read = quality_rank,
       quality_rank_low = quality_rank,
       quality_rank_high = quality_rank,
       quality_read_source = 'code',
       quality_read_confidence = 'definite'
 WHERE quality_rank IS NOT NULL AND quality_rank_read IS NULL;
