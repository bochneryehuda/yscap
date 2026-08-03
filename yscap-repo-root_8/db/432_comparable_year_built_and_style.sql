-- 432 — THE YEAR A COMPARABLE WAS BUILT, AND THE FOURTH WAY IT LEARNS ITS DOORS
--
-- Measured against 602 comparables read out of the real appraisal corpus in
-- SharePoint (262 production MISMO files), which is what turned three of these
-- from theory into arithmetic.
--
-- 1 — YEAR BUILT WAS NULL ON EVERY COMPARABLE, AND ALWAYS WOULD HAVE BEEN.
--     The owner asked for it by name ("unit count, property type, year built,
--     price per square foot, lot square footage, livable square footage"). The
--     warehouse ingest mines it out of the comparable's Age adjustment row with
--     a 4-digit-year regex — but the MISMO grid states an AGE IN YEARS there,
--     never a year: the corpus writes "106", "114 yrs", "76", "136". The regex
--     matches none of those, so the fact was silently 100% empty rather than
--     wrong, and nothing surfaced it. The report's own effective date supplies
--     the missing half, so the year is arithmetic (effective year − age), not a
--     guess, and stays null the moment either half is missing.
--
-- 2 — A 1004D IS NOT A 1004, AND READING IT AS ONE MANUFACTURED A WRONG FACT.
--     The 1004D is the Appraisal Update and/or Completion Report — a follow-up
--     attached to whatever the ORIGINAL appraisal was: a 1004, a 1025, a 1073 or
--     a 2055. It proves nothing about the category or the unit count.
--     `guessFromFormCode` mapped it to single-family, so the 1004D on a plainly
--     two-family property (1400-1402 Stratford — the address is a two-number
--     range) stored its subject and ALL THREE comparables as `units 1 /
--     SFR (1 unit)` while the appraiser's own grid read "2 Family" on every
--     line. A confident wrong answer is worse than an absent one.
--
-- 3 — THE APPRAISER'S OWN WORDS ARE A FOURTH SOURCE, ranked above arithmetic
--     because they are STATED rather than derived: the design-style line on each
--     comparable's grid column spells the count out — "2 Family", "3 FAMILY",
--     "3-PLEX", "4-PLEX", "Duplex". `identity_basis = 'style'`. It refuses far
--     more than it accepts: "1/2 Duplex" (9 comps in the corpus, all on 1004s)
--     is ONE side of a two-unit building, and "DOUBLE BLOCK" is used for both
--     the whole building and one side, so both are left unanswered.
--
-- 4 — THE COUNT NAMES THE TYPE WHENEVER THE COUNT IS KNOWN. Deriving the label
--     from the form unconditionally let the weakest source overrule the
--     strongest and produced rows that contradict themselves — 18 comparables in
--     the corpus were stored as `units 5 / Multi 2–4`, and a grid-stated 2-unit
--     on a 1004 came out `units 2 / SFR (1 unit)`.
--
-- After all four: 598 of 602 comparables state their unit count and 602 of 602
-- state their property type. The four that do not are 1025s whose grid, style
-- and price all stay silent — they still carry the form's honest "Multi 2–4".

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS year_built integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS design_style text;

COMMENT ON COLUMN appraisal_comparables.year_built IS
  'The year this comparable was built = the report''s effective year minus the age '
  'the grid states. The MISMO grid carries no year-built element for a comparable '
  '— the Age adjustment row states an age in YEARS ("106", "114 yrs"), so mining '
  'it for a 4-digit year returned NULL on every comparable in the real corpus.';

COMMENT ON COLUMN appraisal_comparables.design_style IS
  'The appraiser''s own design-style words for this comparable ("DT2;Colonial", '
  '"2 Family", "4-PLEX"), verbatim off its grid column. Also the source behind '
  'identity_basis = ''style''.';

-- The four values `compIdentity` can record, so a typo can never enter the
-- column and a reader can trust the set. NULL stays legal: it is what a
-- comparable whose identity could not be established honestly carries.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appraisal_comparables_identity_basis_ck') THEN
    ALTER TABLE appraisal_comparables
      ADD CONSTRAINT appraisal_comparables_identity_basis_ck
      CHECK (identity_basis IS NULL OR identity_basis IN ('grid', 'style', 'price', 'form'));
  END IF;
END $$;

-- NOTE — no new `property_observations` column here on purpose. The warehouse
-- already derives `design_style` from the same adjustment row (research/ingest
-- `fromAdjustments(…, 'design', …)`), and db/430/431 shipped five observation
-- columns that nothing wrote. A column no writer fills is worse than no column:
-- it reads as a fact the system has and does not.
