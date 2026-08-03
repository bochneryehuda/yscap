-- 437 — WHERE A COMPARABLE CAME FROM, WHAT IT LOOKS OUT ON, AND WHAT IS DOWNSTAIRS
--
-- Three gaps, each measured across the 152 real appraisals in the corpus rather
-- than assumed.
--
-- 1. THE DATA SOURCE WAS BLANK ON 43% OF REPORTS BECAUSE OF WHERE WE LOOKED.
--    "Where did this comparable come from?" — an MLS number, tax records, an
--    exterior inspection — is the first thing an underwriter asks of a comp they
--    did not pick. It was read from ONE place: the UAD extension attribute
--    `COMPARISON_DETAIL/@GSEDataSourceDescription`. Only 79 of the 152 reports
--    carry a UAD extension block at all. But 135 state the source on the
--    `COMPARABLE_SALE` element itself and 145 state how it was verified — so on
--    66 files (43%) the fact was sitting in the XML and we filed silence.
--
--    That silence was not neutral: it read as a VENDOR trait. Two firms —
--    Value Appraisals, LLC and Spartan Property — showed 100% missing on this
--    column and fifteen others, which looks exactly like "this firm delivers
--    thin reports". They do deliver non-UAD reports, and most of those fifteen
--    really are absent. This one was ours. Measured after: 769 of 769
--    comparables now state their source.
--
-- 2. A BASEMENT BEDROOM IS NOT A BEDROOM. Fannie separates above- and
--    below-grade rooms on the form for exactly that reason, and the grid's
--    headline bed/bath counts are the ABOVE-grade ones. So a 3-bed comparable
--    with two more bedrooms downstairs and a 3-bed comparable with a boiler room
--    were stored identically. The below-grade AREA was already read, and area
--    alone cannot tell those apart — 800 finished square feet is two bedrooms or
--    it is a rec room. 115 of 769 comparables state the breakdown.
--
--    Stored with 0 KEPT, not dropped. "No bedrooms in the basement" is an answer;
--    the money/area helper the first cut used refuses 0, which would have filed
--    every stated zero as silence (31 comparables instead of 115).
--
--    The bath count is UAD `full.half` — "0.1" is no full baths and one half
--    bath, NOT a tenth of a bathroom — so it is stored as its two halves through
--    the same decoder the grid's own bath line uses, and a single numeric column
--    is deliberately avoided: it would have to choose between storing 0.1 (which
--    reads as a decimal) and 0.5 (a convention the report never used).
--
-- 3. THE VIEW RATING IS ONE APPRAISER'S VERDICT; THE VIEW TYPE IS THE FACT.
--    `view_rating` holds Beneficial / Neutral / Adverse. Two appraisers rate the
--    same outlook differently and neither is wrong, so a rating alone can never
--    be re-judged later. The type says what is actually there — and the corpus's
--    `Other` descriptions are where the useful ones live: Cemetery, Creek,
--    Warehse, Comm. 409 of 769 comparables state it.
--
-- `basement_exit` (WalkOut / WalkUp / InteriorOnly, 312 of 769) is the difference
-- between a basement that can be a legal unit and one that cannot.
--
-- PREVIOUS AND FUTURE: `COMP_PARSE_VERSION` goes 6 → 7, which is the only thing
-- that heals a parser gap — it re-reads each report's STORED SOURCE XML. Every
-- column here is in `REPARSED`, so the back book gains them on the next boots.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS view_type text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS basement_exit text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_beds integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_baths_full integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_baths_half integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_rec_rooms integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS below_grade_other_rooms integer;

COMMENT ON COLUMN appraisal_comparables.view_type IS
  'WHAT the comparable looks out on, as the appraiser stated it (UAD GSEViewType, '
  'or their own words when the code is ''Other'' — Cemetery, Creek, Warehse). '
  'Distinct from view_rating, which is their Beneficial/Neutral/Adverse verdict on '
  'it. Unrecognised codes are kept verbatim: the GSE list is long and open, and a '
  'whitelist here would silently drop every value nobody thought of.';

COMMENT ON COLUMN appraisal_comparables.basement_exit IS
  'WalkOut / WalkUp / InteriorOnly — the difference between a basement that can be '
  'a legal dwelling unit and one that cannot.';

COMMENT ON COLUMN appraisal_comparables.below_grade_beds IS
  'Bedrooms BELOW grade. The grid''s own bed count is the above-grade one, so this '
  'is the fact that tells a 3-bed house with two more downstairs from a 3-bed house '
  'with a boiler room. 0 is a stated answer, not a missing one.';

COMMENT ON COLUMN appraisal_comparables.below_grade_baths_full IS
  'Full bathrooms below grade. UAD writes the pair as `full.half` ("0.1" = no full, '
  'one half), which is why this is two integer columns and not one numeric — 0.1 '
  'reads as a decimal and 0.5 is a convention the report never used.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appraisal_comparables_basement_exit_ck') THEN
    ALTER TABLE appraisal_comparables
      ADD CONSTRAINT appraisal_comparables_basement_exit_ck
      CHECK (basement_exit IS NULL OR basement_exit IN ('WalkOut', 'WalkUp', 'InteriorOnly'));
  END IF;
END $$;

-- The warehouse carries the same facts per OBSERVATION (what one report said about
-- one property on one date) and rolls the best-sourced answer onto the property.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS view_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS basement_exit text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS below_grade_beds integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS below_grade_baths_full integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS below_grade_baths_half integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS below_grade_rec_rooms integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS below_grade_other_rooms integer;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS view_type text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS basement_exit text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS below_grade_beds integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS below_grade_baths_full integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS below_grade_baths_half integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS below_grade_rec_rooms integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS below_grade_other_rooms integer;

COMMENT ON COLUMN properties.below_grade_beds IS
  'Bedrooms below grade, rolled up from the best-sourced observation. Read together '
  'with `beds` (which is the ABOVE-grade count, as the appraisal grid states it) — '
  'they are never added together, because the whole point of the separation is that '
  'the two are not the same thing.';
