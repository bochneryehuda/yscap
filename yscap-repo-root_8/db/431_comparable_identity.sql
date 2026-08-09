-- 431 — EVERY COMPARABLE KNOWS WHAT IT IS AND HOW MANY DOORS IT HAS
--
-- Owner-directed, 2026-08-03: "There shouldn't be a possibility that you should
-- see a comparable in your system that doesn't have how many units the property
-- is, what property type it is — if it's a single family or if it's a
-- multifamily. This is the most important part."
--
-- Those are the two facts a MISMO grid states least directly, and until now
-- `appraisal_comparables.units` and `.property_type` (db/409 §7) were written by
-- NOTHING — 0 of 83 rows. Three sources, strongest first, and the row records
-- WHICH one answered so a screen never shows an inference as a measurement:
--
--   grid   the appraiser wrote a room line PER UNIT, so the count is stated.
--
--   price  `SalesPricePerUnitAmount` and the sale price are both stated and the
--          price divides by the per-unit figure into a whole number inside the
--          form's own band. Accepted ONLY when it divides cleanly — the field
--          maps warn per-unit figures are rounded, so a ratio of 2.97 proves
--          nothing and is refused.
--
--   form   the owner's own reasoning, and it is not a guess: the sales-comparison
--          approach REQUIRES comparables of the same property type, and Fannie
--          publishes one form per type. A comparable on a 1004 is a one-unit
--          dwelling; on a 1073 a condo; on a 1025 a 2-4 family. So the form
--          decides the TYPE outright, and on a 1004/1073 the COUNT too (both are
--          one dwelling by definition). On a 1025 it gives the type and a 2-4
--          band; the exact door count still needs `grid` or `price`.
--
-- NEVER FROM THE SUBJECT. Two 2-4 families are not the same size, and copying the
-- subject's 3 onto a 4-family comp would be a wrong number wearing the authority
-- of a stated one.

ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS identity_basis text;
ALTER TABLE property_observations  ADD COLUMN IF NOT EXISTS identity_basis text;

COMMENT ON COLUMN appraisal_comparables.identity_basis IS
  'Where units/property_type came from: grid (the appraiser wrote a row per unit), '
  'price (the sale price divides cleanly by the stated price per unit), or form '
  '(the appraisal form itself — a 1004 comparable is one dwelling by definition). '
  'NULL means neither could be established.';

-- Previous reports: the change is in the PARSER, so `COMP_PARSE_VERSION` moves and
-- the boot re-parse rewrites these from each report's own stored source XML.
