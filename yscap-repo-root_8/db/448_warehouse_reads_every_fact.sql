-- 448 — THE FACTS THE REPORTS ALREADY STATED AND THE WAREHOUSE THREW AWAY
--
-- An audit of the appraisal → warehouse pipeline counted SEVENTY-TWO columns on
-- `appraisals` that reached no warehouse table at all — not as a column, not even
-- in the observation's `facts` jsonb. Every one of them was already parsed out of
-- the XML, already validated, and already stored per loan file. They simply had
-- no way across the last hop, so nothing could ever search them.
--
-- This adds them. There is NO new parsing in this migration or the code that
-- feeds it: it is the same read, filed somewhere it can be used.
--
-- ─── THE SPLIT, WHICH IS THE WHOLE DESIGN ───────────────────────────────────
--
-- The warehouse's governing rule (handoff §2) is that `properties` holds facts
-- about the PROPERTY and `property_observations` holds facts about the REPORT.
-- Getting a fact on the wrong side is not cosmetic:
--
--   * a REPORT fact rolled onto the property would let the newest appraisal
--     overwrite a durable answer with something that was only ever true of one
--     report — e.g. `lender_name`, which says who ordered THAT appraisal and
--     nothing whatever about the house;
--   * a PROPERTY fact left on the observation is invisible to `search.js`, which
--     queries `properties` — which is exactly why these were unreachable.
--
-- So they are sorted, deliberately, one at a time:
--
--   PROPERTY (both tables, and they roll up) — the tax bill, the cost approach
--   and its depreciation, the condo PROJECT (unit counts, phases, management,
--   commercial space), the FEMA panel date, the listing history, the building
--   status, the off-site improvements and included utilities, and the physical
--   deficiency / zoning notes. These describe the house or the building it sits
--   in, and the newest report that states one wins.
--
--   REPORT (observation only, NEVER rolled up) — who ordered it (lender, AMC),
--   what form and software produced it, the USPAP report type, the inspection
--   type, the supervisor's licence, the narratives (reconciliation, conditions,
--   addendum, sales-agreement analysis), and the facts about THIS transaction:
--   seller-is-owner, the concessions, whether the contract was reviewed, and
--   whether this report's own comps had prior sales.
--
-- ─── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
--
-- The 1004MC market grid and the neighbourhood block (`market_trends`,
-- `mc_months_supply`, `mc_median_dom`, `mc_sale_to_list_pct`, `mc_price_trend`,
-- `present_land_use`, `nbhd_*`, and the two market comments) are NOT added here
-- and that is not an oversight. They describe a MARKET over a period, not a
-- property — filing them on a property row would make every house in a town
-- carry its own private copy of the town's statistics, disagreeing with its
-- neighbours by whichever report happened to be newest. They need their own
-- table keyed on a geography and a period, and choosing that geography is a real
-- decision (the report's own neighbourhood boundary? the ZIP? the town?), not
-- something to settle inside a migration. Recorded as the next build.
--
-- PREVIOUS AND FUTURE: `ROLLUP_VERSION` is bumped to 3 in ingest.js, so the boot
-- sweep re-rolls every existing property through the ONE definition of the
-- roll-up. The observations themselves are re-populated by the ordinary backfill
-- when a report is re-ingested; until then these columns are NULL, which honestly
-- means "not read across yet" and never a wrong value.


-- ── PROPERTY facts: on the observation AND on the property ─────────────────
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS property_tax_amount numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS property_tax_amount numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS property_tax_year integer;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS property_tax_year integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS site_improvements_value numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS site_improvements_value numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS dwelling_cost_new numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS dwelling_cost_new numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS dwelling_sqft numeric(12,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS dwelling_sqft numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS dwelling_price_per_sqft numeric(10,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS dwelling_price_per_sqft numeric(10,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS cost_new_total numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS cost_new_total numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciated_cost_improvements numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS depreciated_cost_improvements numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_physical numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS depreciation_physical numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_functional numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS depreciation_functional numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_external numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS depreciation_external numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS depreciation_total numeric(14,2);
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS depreciation_total numeric(14,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS cost_data_source text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS cost_quality_rating text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS cost_quality_rating text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS listing_history text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS building_status text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS building_status text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS off_site_improvements jsonb;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS off_site_improvements jsonb;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_included_utilities jsonb;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS rent_included_utilities jsonb;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS physical_deficiency_note text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS physical_deficiency_note text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS zoning_compliance_note text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS zoning_compliance_note text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS fema_panel_date date;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS fema_panel_date date;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_project_name text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_project_name text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_project_type text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_project_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_units_planned integer;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_units_planned integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_units_completed integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_units_sold integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_units_rented integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_units_for_sale integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_owner_occupied integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_total_phases integer;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_total_phases integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_parking_spaces integer;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_parking_spaces integer;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_common_elements text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_common_elements text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_commercial_space boolean;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_commercial_space boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_management_type text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS condo_management_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_developer_control boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS condo_concentrated_ownership boolean;

-- ── REPORT facts: on the observation ONLY. Never roll these up. ────────────
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS appraisal_purpose text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS appraisal_purpose_other text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS uspap_report_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS inspection_type text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS lender_name text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS amc_name text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS lender_address text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS supervisor_license_id text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS supervisor_license_state text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS supervisor_license_exp date;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS seller_is_owner boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS concession_indicator boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS concession_description text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS contract_reviewed boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS contract_review_comment text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS has_prior_sale boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS comps_have_prior_sales boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS reconciliation_comment text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS conditions_comment text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS addendum_text text;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS sales_agreement_analysis text;

-- The tax bill is the single most-asked question of this set, so it gets an index
-- the same way every other searchable fact on `properties` has one. Partial: the
-- overwhelming majority of rows will hold NULL until their report is re-ingested,
-- and there is no reason to index an absence.
CREATE INDEX IF NOT EXISTS idx_properties_tax_amount
  ON properties(property_tax_amount) WHERE property_tax_amount IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_condo_project
  ON properties(lower(condo_project_name)) WHERE condo_project_name IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ELEVEN COLUMNS THIS FILE USED TO ADD ARE GONE — AND REMOVING THEM HERE IS THE
-- FIX, not tidying.
--
-- `migrate-boot` runs every numbered file's FULL TEXT on EVERY boot. So an ADD
-- here and a DROP in db/424 do not settle: db/448 re-adds what db/424 removed,
-- db/424 removes it again, and the pair CHURNS ELEVEN COLUMNS PER BOOT. A dropped
-- column keeps its `pg_attribute` slot forever, and Postgres allows 1600 per
-- table — so the loop is a countdown. MEASURED on a database this branch had been
-- booted against: 1,476 dropped attributes on `properties` and 328 on
-- `property_observations` — exactly 9 and 2 per boot over 164 boots — and
-- `properties` had reached attnum 1600, so the next migration failed with
-- "tables can have at most 1600 columns" and the table was permanently dead.
--
-- The nine `properties` columns (the condo absorption counts, the listing note,
-- the cost service) and the two dead `property_observations` columns
-- (`form_version` / `software_vendor`, which nothing has ever been able to fill)
-- are simply never created now. db/424 KEEPS its DROPs so a database where the
-- old version of this file already ran is still cleaned up once — after which
-- both files are stable no-ops. `check-migrations` now refuses this shape.
-- ---------------------------------------------------------------------------
