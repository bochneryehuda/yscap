-- 439 — HOW WELL THE LAYOUT WORKS, AND THE GRID ROW AS THE FALLBACK FOR EVERY
--       VENDOR WITHOUT THE UAD BLOCK
--
-- 73 of the 152 real appraisals carry NO UAD extension block. Everything read
-- from `COMPARISON_DETAIL` was therefore blank on half the corpus, and that
-- blankness read as a VENDOR trait — two firms measured 100% missing across
-- fifteen columns and looked like they deliver thin reports. Some of it really is
-- absent. This was not.
--
-- A Fannie grid has a ROW PER FACT — View, Location, Functional Utility,
-- Financing Concessions — and a non-UAD vendor states the value as that row's own
-- description. The rows were already being parsed (they are stored verbatim in
-- `adjustments`); nothing read them for the columns they answer. Measured before
-- and after over all 769 comparables:
--
--     view_type          409 -> 769   (100%)
--     location_type      409 -> 769   (100%)
--     financing_type     343 -> 620   ( 81%)
--     functional_utility   0 -> 769   (100%)   <- this column
--
-- FUNCTIONAL UTILITY is the appraiser's judgement of whether the layout works —
-- "Conforms", "Average", "Superior-4beds", "Inferior-2beds". A three-bedroom
-- house whose third bedroom is only reachable through the second is worth less
-- than one where it is not, and this is the line that says so. Stored as the
-- appraiser's OWN WORDS: there is no code for it, the phrasings vary by vendor,
-- and a whitelist would silently drop every one nobody anticipated — the trap the
-- worded condition and quality fields already fell into.
--
-- A NUMBER IS NOT A DESCRIPTION. These rows carry an adjustment AMOUNT beside the
-- label, and several vendors put the amount, or a bare separator, in the
-- description slot — the real corpus holds ";0", ";", "0" and "-25000" where a
-- word belongs. A value is taken only when it contains an actual letter, so a
-- person never reads "0" as a property's financing type.
--
-- PREVIOUS AND FUTURE: `COMP_PARSE_VERSION` 9 -> 10, which re-reads each report's
-- stored source XML; the column is in `REPARSED`, so the back book gains it.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS functional_utility text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS functional_utility text;
ALTER TABLE properties           ADD COLUMN IF NOT EXISTS functional_utility text;

COMMENT ON COLUMN appraisal_comparables.functional_utility IS
  'The appraiser''s own words for whether the layout works — "Conforms", '
  '"Average", "Inferior-2beds". Free text on purpose: there is no code for it and '
  'the phrasings vary by vendor, so a whitelist would drop every one nobody '
  'anticipated.';

COMMENT ON COLUMN properties.functional_utility IS
  'Functional utility, rolled up from the best-sourced observation. Free text — '
  'the appraiser''s own words, never normalised into a code the report did not use.';
