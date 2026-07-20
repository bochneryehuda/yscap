-- ============================================================================
-- 158 — Appraisal report ENRICHMENT (owner-directed 10-agent XML deep-dive, 2026-07-20).
--
-- A 10-agent sweep of the MISMO 2.6 appraisal XML found a large set of fields that
-- are consistently present across the 37-file corpus but were never extracted or
-- shown. This migration adds the columns to store them. Every value is read with a
-- never-guess rule in extract.js (enum whitelists, unit-aware readers, Y/N→bool,
-- placeholder rejection); nothing here is estimated. Additive + idempotent.
--
-- Two existing columns are simply populated by the new extractor (no ALTER needed):
--   appraisals.appraisal_purpose         (existed since db/137, shipped empty)
--   appraisal_units.rooms/beds/baths/sqft/lease_status (existed, only rents written)
-- ============================================================================

-- ---- SUBJECT: neighborhood & market (exit analysis) ------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_value_trend        text;   -- Increasing|Stable|Declining
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_demand_supply      text;   -- Shortage|InBalance|OverSupply
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_marketing_time     text;   -- UnderThreeMonths|ThreeToSixMonths|OverSixMonths
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_location_type      text;   -- Urban|Suburban|Rural
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_builtup            text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_growth             text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_price_low          numeric(14,2);  -- normalized to dollars (XML is $000s)
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_price_high         numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_price_predominant  numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_age_predominant    integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_adverse_financing  boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS nbhd_foreclosure_activity boolean;

-- ---- SUBJECT: site / location / occupancy ----------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS occupancy_status        text;   -- Vacant|TenantOccupied|OwnerOccupied
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS physical_deficiency     boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS physical_deficiency_note text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS adverse_site_conditions boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS view_rating             text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS lot_shape               text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS lot_dimensions          text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS zoning_compliance_note  text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_panel_id           text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS fema_panel_date         date;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS special_flood_hazard    boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS property_rights         text;   -- FeeSimple|Leasehold|...
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS owner_of_record         text;   -- STAFF-ONLY display
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS utilities               jsonb;  -- [{type,public,note}]

-- ---- SUBJECT: structure / improvements / systems ---------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS effective_age           integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS remaining_economic_life integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS updated_last_15yr       boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS heating_type            text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS heating_fuel            text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS cooling                 text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS roof_description        text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS foundation_type         text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS basement_sqft           numeric(12,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS basement_finished_pct   integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS garage_type             text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS garage_spaces           integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS below_grade_sqft        numeric(12,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS below_grade_finished_sqft numeric(12,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS attic                   boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS has_adu                 boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS updates                 jsonb;  -- [{area,level,timeframe}]
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS amenities               jsonb;  -- [{type,count,description}]

-- ---- SUBJECT: sales contract / concessions / listing -----------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS sale_type               text;   -- ArmsLengthSale|REOSale|ShortSale|EstateSale|Listing
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS concession_amount       numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS concession_indicator    boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS concession_description  text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS contract_reviewed       boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS contract_review_comment text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS seller_is_owner         boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS contract_data_source    text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS listed_within_year      boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS listing_history         text;

-- ---- SUBJECT: cost approach detail -----------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS depreciation_physical   numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS depreciation_functional numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS depreciation_external   numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS depreciation_total      numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS cost_new_total          numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS depreciated_cost_improvements numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS site_improvements_value numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS dwelling_cost_new       numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS dwelling_sqft           numeric(12,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS dwelling_price_per_sqft numeric(10,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS cost_data_source        text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS cost_quality_rating     text;

-- ---- SUBJECT: income / rent ------------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS est_market_monthly_rent numeric(12,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS rent_included_utilities jsonb;

-- ---- SUBJECT: reconciliation / conditions / scope --------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS appraisal_purpose_other text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS reconciliation_comment  text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS conditions_comment      text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS addendum_text           text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS uspap_report_type       text;

-- ---- SUBJECT: appraiser / parties / inspection -----------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS appraiser_company_address text;  -- BOTH audiences
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS inspection_type         text;   -- None (desktop) | ...
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS supervisor_license_id   text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS supervisor_license_state text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS supervisor_license_exp  date;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS lender_address          text;   -- STAFF-ONLY

-- ---- CONDO / PUD project ---------------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_units_planned     integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_units_completed   integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_units_sold        integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_units_rented      integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_units_for_sale    integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_owner_occupied    integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_total_phases      integer;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_common_elements   text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_commercial_space  boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_management_type   text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_developer_control boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_concentrated_ownership boolean;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS condo_parking_spaces    integer;

-- ---- Prior-sales research flag ---------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS comps_have_prior_sales  boolean;

-- ---- COMPARABLES: per-comp grid facts --------------------------------------
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS beds         integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS baths        text;   -- UAD "2.1" (full.half)
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS baths_full   integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS baths_half   integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS total_rooms  integer;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS sale_type    text;   -- ArmsLengthSale|REOSale|EstateSale|Listing
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS concession_amount numeric(14,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS financing_type text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS prior_sale_amount numeric(14,2);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS prior_sale_date text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS latitude     numeric(9,6);
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS longitude    numeric(9,6);
