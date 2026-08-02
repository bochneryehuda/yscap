-- ============================================================================
-- 409 — THE RESEARCH DATABASE: every APPRAISER and every PROPERTY we have ever
--       seen in an appraisal XML, lifted out of the per-file tables into a
--       cross-file, searchable warehouse (owner-directed 2026-08-02).
--
-- WHY THIS EXISTS. Everything the appraiser wrote is already stored — but it is
-- stored PER FILE (db/137 + rounds): `appraisals` and `appraisal_comparables`
-- hang off one `application_id`, so the only question they can answer is "what
-- did THIS report say?". The owner's questions are the other direction:
--
--   * "Show me this appraiser — his licence, his phone, his email, and every
--      file he has ever appraised for us."
--   * "Show me every comparable we have ever been handed, with its picture and
--      every fact the appraiser stated about it."
--   * "Find me 3-bed, 2-bath sales in Paterson NJ between $300k and $450k that
--      closed in the last 9 months, 1,200–1,700 sqft."
--
-- That is an MLS/RPR-shaped question, and it needs an MLS/RPR-shaped store: an
-- entity per PROPERTY (deduped across every report that ever mentioned it), an
-- OBSERVATION per (property × report) that keeps each report's own statement of
-- the facts, and a SALE per distinct transaction. See
-- docs/PROPERTY-COMP-DATABASE-RESEARCH.md for the full design rationale.
--
-- SHAPE (the four ideas):
--   1. `appraisers`            — one row per human appraiser, deduped on the
--                               licence (state + id) and falling back to
--                               name+company. `appraiser_licenses` /
--                               `appraiser_contacts` accumulate EVERY licence,
--                               phone, email and company we have ever seen for
--                               them, so nothing is overwritten by the next
--                               report that spells it differently.
--   2. `properties`            — one row per real-world address, deduped on a
--                               PURE normalized key (no network, no API). Its
--                               columns are a ROLL-UP: the best-known current
--                               answer for each fact, always sourced from the
--                               most recent report that stated it.
--   3. `property_observations` — one row per (report × property × role). This is
--                               the ledger: what THAT appraiser said about that
--                               property on that date. Never overwritten, never
--                               merged — the roll-up above is derived from it.
--   4. `property_sales`        — one row per distinct transaction (date+price),
--                               gathered from comps' sales, comps' prior sales,
--                               the subject's prior sale and the contract price.
--
-- NEVER-GUESS, exactly like the parser that feeds it: a fact is stored only when
-- a report stated it. Nothing here is estimated, interpolated or averaged at
-- write time. The comparable search and the internal value indication read this
-- data at QUERY time and always show their work (how many comps, which ones).
--
-- NOT AN OVERWRITE PATH. This migration adds tables and one nullable FK column;
-- it changes no existing behaviour and the ingest that fills it is best-effort
-- and fire-and-forget, so a failure here can never break an appraisal import.
--
-- Additive + idempotent (safe to re-run on every boot).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. APPRAISERS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appraisers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The dedupe key, computed by src/lib/research/identity.js. Two shapes:
    --   'lic:NJ:42RG00123400'      — a state licence, the strongest identity
    --   'name:john q appraiser|acme appraisal llc'
    --   'name:john q appraiser'    — no company on the report
    identity_key      text UNIQUE NOT NULL,
    name              text NOT NULL,
    name_key          text NOT NULL,
    company           text,
    company_key       text,
    -- The CURRENT best-known contact set (the most recent report that stated
    -- it); the full history lives in appraiser_contacts / appraiser_licenses.
    phone             text,
    email             text,
    company_address   text,
    license_id        text,
    license_state     text,
    license_type      text,
    license_exp       date,
    supervisor_name   text,
    -- Roll-ups, recomputed on every ingest (cheap: one grouped query per row).
    appraisal_count   integer NOT NULL DEFAULT 0,
    file_count        integer NOT NULL DEFAULT 0,
    first_seen_at     timestamptz,
    last_seen_at      timestamptz,
    first_report_date date,
    last_report_date  date,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisers_name_key ON appraisers(name_key);
CREATE INDEX IF NOT EXISTS idx_appraisers_company_key ON appraisers(company_key);
CREATE INDEX IF NOT EXISTS idx_appraisers_license ON appraisers(license_state, license_id);
CREATE INDEX IF NOT EXISTS idx_appraisers_last_seen ON appraisers(last_seen_at DESC NULLS LAST);

-- Every licence this appraiser has ever shown us (a multi-state appraiser is
-- normal; the `appraisers` row only carries the most recent one).
CREATE TABLE IF NOT EXISTS appraiser_licenses (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraiser_id   uuid NOT NULL REFERENCES appraisers(id) ON DELETE CASCADE,
    license_state  text,
    license_id     text,
    license_type   text,
    license_exp    date,
    first_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_seen_at   timestamptz NOT NULL DEFAULT now(),
    times_seen     integer NOT NULL DEFAULT 1
);
-- COALESCE in the key so a licence with no state (or no id) still dedupes
-- instead of inserting a fresh row on every single import.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appraiser_license
    ON appraiser_licenses(appraiser_id, COALESCE(license_state,''), COALESCE(license_id,''));

-- Every phone / email / company / address / supervisor ever seen, with counts.
-- Mirrors `borrower_contacts` (db/… borrower CRM): a new spelling ADDS a row,
-- it never overwrites the one the file already knows.
CREATE TABLE IF NOT EXISTS appraiser_contacts (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraiser_id       uuid NOT NULL REFERENCES appraisers(id) ON DELETE CASCADE,
    kind               text NOT NULL,          -- email | phone | company | address | supervisor
    value              text NOT NULL,
    value_key          text NOT NULL,          -- lowercased/stripped, the dedupe key
    times_seen         integer NOT NULL DEFAULT 1,
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    last_appraisal_id  uuid REFERENCES appraisals(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appraiser_contact
    ON appraiser_contacts(appraiser_id, kind, value_key);
CREATE INDEX IF NOT EXISTS idx_appraiser_contacts_appraiser ON appraiser_contacts(appraiser_id);

-- The link from a report to its appraiser. Nullable: a report whose appraiser we
-- cannot identify (no name at all) simply stays unlinked, it is never invented.
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS appraiser_id uuid REFERENCES appraisers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_appraisals_appraiser ON appraisals(appraiser_id);

-- ---------------------------------------------------------------------------
-- 2. PROPERTIES — one row per real-world address
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS properties (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- PURE, deterministic, offline. src/lib/research/property-key.js:
    --   "26 s 10th st|piscataway|nj|08854"   (unit folded in when present)
    -- Google canonicalization (lib/address-canon) is deliberately NOT used here:
    -- the warehouse must dedupe with no network and no API key, and an address
    -- that only differs by "Ave"/"Avenue" already normalizes to one key.
    address_key       text UNIQUE NOT NULL,
    display_address   text NOT NULL,
    street            text,
    unit              text,
    city              text,
    state             text,
    zip               text,
    county            text,
    apn               text,
    latitude          numeric(9,6),
    longitude         numeric(9,6),

    -- ---- roll-up of the FACTS (most recent report that stated each one) -----
    property_type     text,
    property_category text,
    units             integer,
    year_built        integer,
    gla               numeric(12,2),
    lot_area          text,
    beds              integer,
    baths_full        integer,
    baths_half        integer,
    baths_text        text,
    total_rooms       integer,
    stories           text,
    design_style      text,
    basement_sqft     numeric(12,2),
    below_grade_sqft  numeric(12,2),
    below_grade_finished_sqft numeric(12,2),
    garage_type       text,
    garage_spaces     integer,
    condition_uad     text,
    condition_text    text,        -- the appraiser's WORDED rating when it is not a UAD code
    quality_uad       text,
    quality_text      text,
    view_rating       text,
    location_rating   text,
    location_type     text,
    neighborhood      text,
    census_tract      text,
    flood_zone        text,
    zoning_id         text,
    zoning_desc       text,
    market_rent       numeric(12,2),
    owner_of_record   text,
    hoa_fee_amount    numeric(12,2),
    hoa_fee_period    text,
    effective_age     integer,
    heating_type      text,
    cooling           text,
    foundation_type   text,
    -- Free text on the report ("0.17 ac", "50x100"), so a searchable number is
    -- parsed out of it on the way in (src/lib/research/property-key.lotSqft).
    lot_sqft          numeric(14,2),

    -- ---- roll-up of the TRANSACTIONS ---------------------------------------
    last_sale_price   numeric(14,2),
    last_sale_date    date,
    last_sale_type    text,        -- ArmsLengthSale | REOSale | EstateSale | Listing | …
    last_sale_status  text,        -- closed | active | pending
    last_list_price   numeric(14,2),
    sale_count        integer NOT NULL DEFAULT 0,

    -- ---- what WE know about it ---------------------------------------------
    subject_count     integer NOT NULL DEFAULT 0,   -- times it was OUR subject property
    comp_count        integer NOT NULL DEFAULT 0,   -- times it was used as a comparable
    -- "Was this used on an ARV grid / an As-Is grid?" is a question about the
    -- OBSERVATION, and answering it with an EXISTS against property_observations
    -- costs a semi-join on every search. These two counters denormalize it so the
    -- filter becomes a plain indexed comparison that can join a BitmapAnd with the
    -- other filters. They are recomputed by the same roll-up that writes the rest.
    arv_comp_count    integer NOT NULL DEFAULT 0,
    asis_comp_count   integer NOT NULL DEFAULT 0,
    observation_count integer NOT NULL DEFAULT 0,
    photo_count       integer NOT NULL DEFAULT 0,
    first_seen_at     timestamptz,
    last_seen_at      timestamptz,
    first_observed_on date,                          -- earliest report effective date
    last_observed_on  date,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
-- ---- the three columns a range filter CANNOT use as they stand -------------
-- Baths live in two columns; UAD condition/quality are TEXT codes on an ordinal
-- scale where C1/Q1 is the BEST. Generated columns turn all three into plain
-- indexable numbers, which removes the single most likely bug in this feature:
-- "condition C3 or better" means rank <= 3, NOT `condition_uad >= 'C3'`.
-- A half bath counts 0.5 — UAD "2.1" is two full and one half, i.e. 2.5.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS baths_total numeric(5,2)
  GENERATED ALWAYS AS (
    CASE WHEN baths_full IS NULL AND baths_half IS NULL THEN NULL
         ELSE COALESCE(baths_full,0) + COALESCE(baths_half,0) * 0.5 END) STORED;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS condition_rank smallint
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(condition_uad,''), '\D', '', 'g'), '')::smallint) STORED;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS quality_rank smallint
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(quality_uad,''), '\D', '', 'g'), '')::smallint) STORED;

-- ADDRESS SEARCH WITHOUT AN EXTENSION. `pg_trgm` is contrib and cannot be assumed
-- on a managed database, but tsvector/GIN are CORE Postgres — so a word-order-free,
-- per-word-prefix address search ("main piscataway", "10th st") is available with
-- nothing to install. The 'simple' config is deliberate: an address is not English
-- prose and must not be stemmed ("Reading" is a town, not a verb).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple',
    COALESCE(display_address,'') || ' ' || COALESCE(city,'') || ' ' || COALESCE(state,'') || ' ' || COALESCE(zip,'') || ' ' || COALESCE(apn,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_properties_tsv ON properties USING GIN (address_tsv);

-- The search engine's indexes. Every filter the Property Research screen offers
-- is covered; `lower(city)` because the UI searches case-insensitively and a
-- functional index is what makes that sargable.
CREATE INDEX IF NOT EXISTS idx_properties_state_city ON properties(state, lower(city));
CREATE INDEX IF NOT EXISTS idx_properties_zip ON properties(zip);
CREATE INDEX IF NOT EXISTS idx_properties_sale_date ON properties(last_sale_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_properties_sale_price ON properties(last_sale_price);
CREATE INDEX IF NOT EXISTS idx_properties_beds ON properties(beds);
CREATE INDEX IF NOT EXISTS idx_properties_baths ON properties(baths_total);
CREATE INDEX IF NOT EXISTS idx_properties_gla ON properties(gla);
CREATE INDEX IF NOT EXISTS idx_properties_year_built ON properties(year_built);
CREATE INDEX IF NOT EXISTS idx_properties_condition ON properties(condition_rank);
CREATE INDEX IF NOT EXISTS idx_properties_latlng ON properties(latitude, longitude) WHERE latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_last_seen ON properties(last_seen_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_properties_arv_comps ON properties(id) WHERE arv_comp_count > 0;
CREATE INDEX IF NOT EXISTS idx_properties_asis_comps ON properties(id) WHERE asis_comp_count > 0;
CREATE INDEX IF NOT EXISTS idx_properties_subjects ON properties(id) WHERE subject_count > 0;

-- ---------------------------------------------------------------------------
-- 3. PROPERTY OBSERVATIONS — what ONE report said about ONE property
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_observations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id       uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    -- A CROSS-FILE WAREHOUSE MUST OUTLIVE THE FILE. `appraisals.application_id` is
    -- itself ON DELETE CASCADE (db/137), so a CASCADE here would mean that
    -- permanently deleting ONE loan file silently erases every comparable sale that
    -- report ever taught us — the exact opposite of what a research database is for.
    -- SET NULL instead, and the observation keeps its own copy of the address and
    -- the date (`address_as_stated`, `observed_on`) so a detached row still means
    -- something. Nothing borrower-identifying is stored here: an address, the
    -- property's characteristics, and what it sold for.
    appraisal_id      uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
    comparable_id     uuid REFERENCES appraisal_comparables(id) ON DELETE SET NULL,
    appraiser_id      uuid REFERENCES appraisers(id) ON DELETE SET NULL,
    role              text NOT NULL,          -- subject | comparable
    comp_seq          text,
    comp_set          text,                   -- arv | as_is | unknown
    -- HOW SURE THE ARV/AS-IS SPLIT IS. On a report with only ONE grid the parser
    -- stamps every comp with that grid's name — a DEFAULT, not a determination. A
    -- search for "As-Is comps" that ignores this silently includes comps nobody
    -- ever distinguished, so the provenance travels with the comp. (db/156)
    comp_set_confidence text,                 -- narrative | proximity | single_grid | undetermined
    comp_set_needs_review boolean,
    observed_on       date,                   -- the report's effective date
    address_as_stated text,                   -- the address exactly as this report wrote it
    form_type         text,

    -- ---- transaction as stated on this report ------------------------------
    sale_price        numeric(14,2),
    adjusted_price    numeric(14,2),
    sale_date         date,
    sale_date_text    text,
    sale_status       text,
    sale_type         text,
    concession_amount numeric(14,2),
    financing_type    text,
    days_on_market    text,
    data_source       text,
    prior_sale_amount numeric(14,2),
    prior_sale_date   date,

    -- ---- physical facts as stated on this report ---------------------------
    gla               numeric(12,2),
    beds              integer,
    baths_text        text,
    baths_full        integer,
    baths_half        integer,
    total_rooms       integer,
    year_built        integer,
    lot_area          text,
    units             integer,
    stories           text,
    design_style      text,
    property_type     text,
    property_category text,
    condition_uad     text,
    -- THE APPRAISER'S WORDED RATING. The parser only accepts C1..C6 / Q1..Q6 into
    -- the UAD columns and drops everything else on the floor — but real reports
    -- from non-UAD vendors say "Good" or "Avg-Good", and the owner called condition
    -- the single most important comparable fact. The raw string is kept beside the
    -- code so a worded rating is never silently lost.
    condition_text    text,
    quality_uad       text,
    quality_text      text,
    -- WHAT THE CONDITION IS THE CONDITION *OF*. On a renovation report the subject's
    -- rating describes the property AFTER the repairs — a future state. Rolling that
    -- up as "the current condition of this property" would be flatly wrong on every
    -- rehab file, so the basis travels with the rating and the roll-up ignores an
    -- as-repaired one. Comps are always as-they-sold.
    condition_basis   text,                   -- as_is | as_repaired
    view_rating       text,
    location_rating   text,
    location_type     text,
    below_grade_sqft  numeric(12,2),
    below_grade_finished_sqft numeric(12,2),
    basement_sqft     numeric(12,2),
    basement_finished_pct integer,
    garage_type       text,
    garage_spaces     integer,
    price_per_gla     numeric(12,2),
    -- A 1025 grid falls back from living area to GROSS BUILDING area under the same
    -- element, so a cross-form price-per-foot comparison is apples to oranges unless
    -- you know which one you have.
    gla_basis         text,                   -- gla | gba
    lot_sqft          numeric(14,2),
    proximity         text,
    neighborhood      text,
    census_tract      text,
    flood_zone        text,
    fema_flood_zone   text,
    sfha              boolean,
    zoning_id         text,
    zoning_desc       text,
    occupancy_status  text,
    market_rent       numeric(12,2),
    -- The per-unit rent roll off a 1025/1007 (rooms, beds, baths, sqft, actual and
    -- market rent per unit) — the whole reason a small-income property is worth
    -- researching, and it had nowhere else to live.
    unit_mix          jsonb,
    owner_of_record   text,
    property_rights   text,
    hoa_fee_amount    numeric(12,2),
    hoa_fee_period    text,
    condo_floor       text,
    effective_age     integer,
    remaining_economic_life integer,
    heating_type      text,
    heating_fuel      text,
    cooling           text,
    foundation_type   text,
    attic             boolean,
    has_adu           boolean,
    lot_shape         text,
    lot_dimensions    text,
    listed_within_year boolean,
    latitude          numeric(9,6),
    longitude         numeric(9,6),

    -- ---- adjustment grid + the subject-only value block --------------------
    net_adjustment    numeric(14,2),
    net_adj_pct       numeric(8,2),
    gross_adj_pct     numeric(8,2),
    adjustments       jsonb NOT NULL DEFAULT '[]'::jsonb,
    appraised_value   numeric(14,2),
    as_is_value       numeric(14,2),
    arv_value         numeric(14,2),
    contract_price    numeric(14,2),
    contract_date     date,

    facts             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prop_obs_property ON property_observations(property_id);
CREATE INDEX IF NOT EXISTS idx_prop_obs_appraisal ON property_observations(appraisal_id);
CREATE INDEX IF NOT EXISTS idx_prop_obs_application ON property_observations(application_id);
CREATE INDEX IF NOT EXISTS idx_prop_obs_appraiser ON property_observations(appraiser_id);
CREATE INDEX IF NOT EXISTS idx_prop_obs_sale_date ON property_observations(sale_date DESC NULLS LAST);
-- IDEMPOTENCE. Re-running the ingest for a report must UPDATE its rows, never
-- duplicate them. One subject per report; one row per comparable row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_obs_subject
    ON property_observations(appraisal_id) WHERE role = 'subject';
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_obs_comparable
    ON property_observations(comparable_id) WHERE comparable_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. PROPERTY SALES — the distinct transactions we have learned about
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS property_sales (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    sale_date          date NOT NULL,
    sale_price         numeric(14,2),
    sale_type          text,
    sale_status        text,          -- closed | active | pending
    -- WHERE we learned it: 'comp_sale' (the grid line), 'comp_prior_sale',
    -- 'subject_prior_sale', 'subject_contract'.
    source             text NOT NULL,
    source_appraisal_id uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    source_observation_id uuid REFERENCES property_observations(id) ON DELETE SET NULL,
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    times_seen         integer NOT NULL DEFAULT 1
);
-- A sale is the same sale when the property, the month and the price agree —
-- which is exactly the resolution the appraisal grid gives us (settled MM/YY).
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_sale
    ON property_sales(property_id, sale_date, COALESCE(sale_price, -1));
CREATE INDEX IF NOT EXISTS idx_property_sales_property ON property_sales(property_id, sale_date DESC);

-- ---------------------------------------------------------------------------
-- 5. PROPERTY PHOTOS — the picture that belongs to the property
-- ---------------------------------------------------------------------------
-- The pixels already exist: `appraisal_photos` → `documents` (extracted from the
-- report PDF, which the XML itself carries). This table is the LINK from a photo
-- to the PROPERTY it shows, which is what lets a comparable in the research
-- database carry its own picture rather than the subject's.
CREATE TABLE IF NOT EXISTS property_photos (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id    uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE, for the same reason as the observation above: the
    -- picture of a house does not stop being a picture of that house because the
    -- loan file it arrived on was purged. `document_id` DOES cascade — when the
    -- bytes are gone there is nothing left to point at — and is NOT NULL so the
    -- uniqueness below actually bites (a unique index treats NULLs as distinct,
    -- so a nullable column there would let a re-run duplicate every row).
    appraisal_id   uuid REFERENCES appraisals(id) ON DELETE SET NULL,
    photo_id       uuid REFERENCES appraisal_photos(id) ON DELETE SET NULL,
    document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    observation_id uuid REFERENCES property_observations(id) ON DELETE SET NULL,
    category       text,
    caption        text,
    sequence       integer,
    is_primary     boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_property_photo ON property_photos(property_id, document_id);
CREATE INDEX IF NOT EXISTS idx_property_photos_property ON property_photos(property_id, sequence);
CREATE INDEX IF NOT EXISTS idx_property_photos_appraisal ON property_photos(appraisal_id);

-- The appraiser's OWN slot label for a photo ("SubjectFront", "ComparablePhoto2")
-- was read by lib/appraisal/photo-meta but only its coarse category was stored.
-- Keeping the raw identifier — and the comparable number derived from it — is
-- what lets a comp photo be attached to the right COMP instead of the report.
ALTER TABLE appraisal_photos ADD COLUMN IF NOT EXISTS identifier text;
ALTER TABLE appraisal_photos ADD COLUMN IF NOT EXISTS comp_seq   text;

-- ---------------------------------------------------------------------------
-- 6. INGEST LEDGER — which reports have been folded into the warehouse
-- ---------------------------------------------------------------------------
-- The back-fill walks every appraisal we have ever imported (the owner's "open
-- and back date this database"). This ledger is how it knows what is done, and
-- how a failure on one report is recorded rather than silently skipped forever.
CREATE TABLE IF NOT EXISTS property_ingest_log (
    appraisal_id   uuid PRIMARY KEY REFERENCES appraisals(id) ON DELETE CASCADE,
    status         text NOT NULL,          -- ok | error | skipped
    properties_written integer NOT NULL DEFAULT 0,
    observations_written integer NOT NULL DEFAULT 0,
    sales_written  integer NOT NULL DEFAULT 0,
    photos_linked  integer NOT NULL DEFAULT 0,
    -- MAKE THE LOSS MEASURABLE. A comparable whose address the report wrote too
    -- thinly to identify (no house number, no city AND no ZIP) is skipped — which
    -- is right, but a silent skip is indistinguishable from a report that simply
    -- had no comps. Counting them, with the reason and the address as stated, is
    -- what turns "we might be dropping data" into a number somebody can look at.
    rows_skipped   integer NOT NULL DEFAULT 0,
    skip_reasons   jsonb NOT NULL DEFAULT '[]'::jsonb,
    error          text,
    ingest_version integer NOT NULL DEFAULT 1,
    ran_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_property_ingest_status ON property_ingest_log(status);
CREATE INDEX IF NOT EXISTS idx_property_ingest_skipped ON property_ingest_log(rows_skipped) WHERE rows_skipped > 0;

-- ---------------------------------------------------------------------------
-- 7. THE COMPARABLE FACTS THE PARSER WAS DROPPING
-- ---------------------------------------------------------------------------
-- Found by the fact-coverage audit (docs/research/APPRAISAL-FACT-COVERAGE-AUDIT.md)
-- while wiring this warehouse up. Each of these is a fact the appraisal states and
-- the per-file tables had nowhere to put, so it was being discarded at import:
--
--  * condition_text / quality_text — the parser accepts ONLY the UAD codes C1..C6
--    and Q1..Q6 and silently drops anything else. Non-UAD vendors write "Good" or
--    "Avg-Good", so on those reports the owner's most important comparable fact
--    was simply absent. The raw string now sits beside the code.
--  * gla_basis — a 1025 grid falls back from living area to gross BUILDING area
--    under the same element, and the difference is invisible downstream.
--  * property_type / units — the comparable's own type and unit count, where the
--    grid states them. NOTE: most MISMO 2.6 grids do NOT carry these per comp; the
--    warehouse's real answer is that the same address, appearing as the SUBJECT of
--    some other report, supplies them. Never inherited from the subject of the
--    report the comp is on — that would assert a fact nobody stated.
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS condition_text  text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS quality_text    text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS gla_basis       text;   -- gla | gba
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS property_type   text;
ALTER TABLE appraisal_comparables ADD COLUMN IF NOT EXISTS units           integer;
