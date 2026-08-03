-- 429 — THE SUBJECT'S CONDITION, IN THE APPRAISER'S OWN WORDS
--
-- THE SPLIT IS BY FORM, NOT BY PROPERTY TYPE, and that is why this gap is the
-- whole 2-4 unit book rather than an edge case. UAD was mandated for exactly four
-- forms — 1004, 1073, 1075 and 2055 — and the **1025 (2-4 unit) was explicitly
-- left out**. So a condo on a 1073 carries `C3` exactly like a house, the same
-- 2-4 family used as a COMPARABLE on a 1004 carries `C3` too, and only the 1025's
-- own grid carries the appraiser's words: "Average", "Avg-Good", "Good". One
-- building can be `C4` on one report and "Average" on another, and both are
-- correct.
--
-- `extract.js` tested the subject's rating against the UAD whitelist and DROPPED
-- anything that failed it. The whitelist is right — the review checks compare
-- those codes and must never see free text — but the word was discarded instead
-- of being kept beside the code. The COMPARABLE path has kept it since the
-- non-UAD vendor fix; the subject path never did, and `appraisals` had no column
-- to keep it in, so `ingest.js` wrote `condition_text: null` for every subject,
-- always. The single most important fact about a property after its price was
-- simply blank on the 2-4 book.
--
-- ─── AND THE ONE PLACE AN AS-IS RATING EXISTS ON A RENOVATION FILE ───────────
--
-- On a subject-to-repairs report the grid's condition describes the FINISHED
-- house, so the roll-up refuses it (`AS_IS_ONLY`, db/450) and those properties
-- end up with no current condition at all. But the appraiser routinely writes
-- BOTH ratings into the condition narrative —
--
--     "C4 for as-is value. C3 for As repaired value."
--
-- — which is present on roughly nine of ten 1025s and was read by nothing.
-- `condition_uad_as_is` holds what a STRICT reader could prove from that
-- sentence, and `condition_comment` keeps the sentence itself as the evidence.
--
-- The reader is deliberately hard to satisfy, because a wrong condition grade
-- moves real money — one grade over 1,500 sq ft at a $12-18/sqft rate is
-- $18,000-27,000 on a single comparable. It works CLAUSE BY CLAUSE (a clause is
-- the unit an appraiser writes one basis in), ignores any clause that also names
-- the repaired or complete basis, and REFUSES outright when a clause offers two
-- codes ("C4 or C5 as is depending on the inspection") or when two clauses
-- disagree. Silence beats a confident guess.

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condition_text        text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS quality_text          text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condition_comment     text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condition_uad_as_is   text;

COMMENT ON COLUMN appraisals.condition_text IS
  'The subject''s condition as the appraiser WORDED it, when it is not a UAD code '
  '(a 1025 was never brought into UAD). Kept beside condition_uad, never instead '
  'of it — the review checks compare codes and must never see free text.';
COMMENT ON COLUMN appraisals.condition_uad_as_is IS
  'The AS-IS condition code proven from the condition narrative on a subject-to '
  'report, where the grid states the finished house. NULL unless one clause '
  'names exactly one code against explicit as-is language.';

-- Previous reports: the change is in the PARSER, so re-ingesting the warehouse
-- cannot help (it re-reads the stored row). `COMP_PARSE_VERSION` moves and the
-- boot re-parse rewrites these from each report's own stored source XML.

-- The observation needs its own copy, because the ROLL-UP is what consumes it.
-- It is deliberately NOT written into `property_observations.condition_uad`, and
-- the observation's `condition_basis` is deliberately NOT flipped to 'as_is' to
-- let it through: that flag gates the WHOLE of `AS_IS_ONLY`, so flipping it would
-- carry this report's after-repair DEPRECIATION and COST figures onto the
-- property too — re-opening the exact db/450 defect ("condition C5" beside "zero
-- physical depreciation, replacement cost as-if-new") one commit after fixing it.
-- The roll-up consults this column explicitly, for the condition CODE only.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condition_uad_as_is text;
