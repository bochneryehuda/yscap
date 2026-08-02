-- 403 — THE FACTS THE APPRAISAL STATES NOW LIVE ON THE FILE (owner-directed 2026-08-02).
--
-- The owner, reading the Appraisal page's data-comparison table: "Occupancy /
-- Year built / Living area / Market rent (1007) / Seller … all these things
-- that he's getting from the appraisal, [our file has] nothing to compare.
-- Please add this field in our file and that field should automatically be
-- tabulated once you import the XML of the appraisal … we have a seller's name
-- on file, so we can do stuff with it to make sure it matches other
-- documentation, and we can use all of it to match and enhance data comparison."
--
-- Until now the loan file had NO column for any of them, so `facts.js` read them
-- as `file: () => null` and every one of those rows read "· Nothing to compare".
-- The appraisal was the only party that ever spoke to them, which also meant the
-- SELLER — the single most useful cross-document identity on a purchase — had no
-- value of record the contract, the title report and the settlement statement
-- could all be measured against.
--
-- FOUR COLUMNS, and they are FILLED BY THE APPRAISAL IMPORT, never asked of a
-- human (`src/lib/appraisal/import.js`). Explicitly NOT part of application
-- completeness (`applicationCompleteness` in src/routes/staff.js is an explicit
-- list and is untouched), not in the Condition Center's field registry, and not
-- on any missing-info panel — the owner's rule: "this field should not be a
-- requirement for us to fill anywhere, should not be missing … it should just be
-- a slot in our file where we can import."
--
-- OCCUPANCY IS DELIBERATELY NOT ONE OF THEM (owner-directed, same message): "the
-- one thing you shouldn't import is if the appraisal says owner occupied.
-- Because even if the appraisal is owner occupied it means that the current
-- owner is living in the property. But our file shouldn't say owner occupied
-- because we are only doing non-owner-occupied. He's purchasing it from the
-- seller who is now owner occupied and it's going to be an investment — so the
-- occupancy, skip." The appraisal's occupancy describes the SELLER's use TODAY;
-- `applications.occupancy` is the BORROWER's use after closing. Two different
-- facts about two different people, so the appraisal must never write it.
--
-- NOTHING RE-PRICES AND NO CONDITION REOPENS. Every trigger on `applications`
-- guards on its own columns (db/072, 096, 179, 198, 269, 286…), and none of them
-- watches these four, so ordinary imports never wake them. The one-time backfill
-- below still disables user triggers for its duration — the same belt-and-braces
-- db/399 uses — so a whole-back-book UPDATE cannot flag registrations stale.
-- The whole file runs as ONE implicit transaction (migrate-boot's `db.query` on a
-- multi-statement string), so the re-enable cannot be skipped.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS seller_name      text,
  ADD COLUMN IF NOT EXISTS year_built       integer,
  ADD COLUMN IF NOT EXISTS living_area_sqft integer,
  ADD COLUMN IF NOT EXISTS market_rent      numeric(14,2);

COMMENT ON COLUMN applications.seller_name IS
  'Who the property is being bought FROM — the owner of record as the appraisal states it (appraisals.owner_of_record). Filled by the appraisal import when blank; never asked of a human and never part of application completeness. It is the file value the tie-out measures the purchase contract, the title report and the settlement statement against (facts.js seller_name).';
COMMENT ON COLUMN applications.year_built IS
  'The year the improvements were built, per the appraisal. Filled by the appraisal import when blank; display + data-comparison only — never a requirement, never a finding.';
COMMENT ON COLUMN applications.living_area_sqft IS
  'Gross living area in square feet, per the appraisal (appraisals.gla). Filled by the appraisal import when blank; display + data-comparison only. NOT sqft_pre/sqft_post, which are the rehab''s before/after square footage and drive pricing.';
COMMENT ON COLUMN applications.market_rent IS
  'The appraiser''s opinion of MONTHLY market rent (the 1007 / 1025 rent schedule) — appraisals.est_market_monthly_rent, else the summed per-unit market rents. Filled by the appraisal import when blank. Distinct from applications.estimated_rental_income (what an officer projects, db/313), applications.rental_income (ClickUp pull-only, db/047) and applications.appraised_rental_value (ClickUp pull-only).';

-- ---------------------------------------------------------------------------
-- BACKFILL — previous AND future. Every file that already carries an appraisal
-- gets these four facts now, so the comparison stops reading "nothing to
-- compare" on the back book instead of only on the next import.
--
-- Blank-only (COALESCE), so it can never overwrite a value already on a file,
-- and re-running it on every boot (migrate-boot re-applies every numbered file)
-- matches zero rows once it has run — the WHERE clause only selects files that
-- are still missing something the appraisal can supply.
-- ---------------------------------------------------------------------------
ALTER TABLE applications DISABLE TRIGGER USER;

UPDATE applications a
   SET seller_name      = COALESCE(a.seller_name,      x.seller_name),
       year_built       = COALESCE(a.year_built,       x.year_built),
       living_area_sqft = COALESCE(a.living_area_sqft, x.living_area_sqft),
       market_rent      = COALESCE(a.market_rent,      x.market_rent)
  FROM (
    SELECT DISTINCT ON (ap.application_id)
           ap.application_id,
           ap.owner_of_record AS seller_name,
           -- appraisals.year_built is TEXT (db/137). Only a clean 4-digit year
           -- becomes an integer; anything else stays NULL rather than erroring
           -- the whole migration on one odd row.
           CASE WHEN ap.year_built ~ '^[0-9]{4}$' THEN ap.year_built::int END AS year_built,
           -- gla is numeric(12,2); round to whole square feet and refuse anything
           -- that could not fit an int4 column.
           CASE WHEN ap.gla > 0 AND ap.gla < 1000000000 THEN round(ap.gla)::int END AS living_area_sqft,
           -- The SAME resolution src/lib/underwriting/run.js uses: the subject's
           -- estimated monthly market rent, else the summed per-unit rents off a
           -- 1025/1007 rent schedule. NULLIF drops a zero sum (no rents at all).
           COALESCE(ap.est_market_monthly_rent,
                    NULLIF((SELECT sum(u.market_rent) FROM appraisal_units u WHERE u.appraisal_id = ap.id), 0))
             AS market_rent
      FROM appraisals ap
     WHERE ap.superseded = false
     ORDER BY ap.application_id, ap.imported_at DESC
  ) x
 WHERE x.application_id = a.id
   AND ((a.seller_name      IS NULL AND x.seller_name      IS NOT NULL)
     OR (a.year_built       IS NULL AND x.year_built       IS NOT NULL)
     OR (a.living_area_sqft IS NULL AND x.living_area_sqft IS NOT NULL)
     OR (a.market_rent      IS NULL AND x.market_rent      IS NOT NULL));

ALTER TABLE applications ENABLE TRIGGER USER;
