-- ============================================================================
-- 168 — Appraisal SUBJECT facts round 5 (renumbered from 165 to resolve a duplicate-number collision) (owner-directed "squeeze more from the XML", 2026-07-20).
-- A fresh coverage sweep of all 37 corpus files found these consistently-present fields still
-- unextracted. All never-guess (placeholder-rejected, enum-whitelisted, length-capped). Additive.
--
--  * property_tax_amount / property_tax_year: subject _TAX (_TotalTaxAmount / _YearIdentifier),
--    36–37/37 — the annual property-tax carrying cost (a real underwriting figure the report dropped).
--  * comp_research (jsonb): the appraiser's OWN researched market bracket — RESEARCH block's
--    comparable-sales / active-listing counts and price ranges (37/37). Independent context for the
--    concluded value ("22 comps ranged $330k–$655k").
--  * building_status: STRUCTURE BuildingStatusType (Existing / Proposed / UnderConstruction, 37/37)
--    — flags a to-be-built/renovation subject vs an existing one.
--  * nbhd_boundaries: NEIGHBORHOOD _BoundaryAndCharacteristicsDescription (37/37, concrete streets,
--    never "see 1004MC") — the neighborhood the collateral actually sits in.
--  * sales_agreement_analysis: SALES_COMPARISON _CurrentSalesAgreementAnalysisComment (36/37) — the
--    appraiser's transfer-history / contract note on the subject.
-- ============================================================================
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS property_tax_amount     numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS property_tax_year       integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS comp_research           jsonb;   -- {salesCount,salesLow,salesHigh,listingsCount,listingsLow,listingsHigh}
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS building_status         text;    -- Existing|Proposed|UnderConstruction
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_boundaries         text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS sales_agreement_analysis text;
