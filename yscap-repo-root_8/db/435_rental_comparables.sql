-- 435 — THE RENT SCHEDULE IS A SECOND COMPARABLE GRID, AND WE READ NONE OF IT
--
-- Task-list item 2.4. A small-income appraisal (a 1025, or a 1004 with a 1007
-- attached) carries a whole second grid beside the sales one:
-- `MULTIFAMILY_RENTALS`. Sequence 0 is the SUBJECT; every sequence after it is a
-- RENTAL comparable — a different building, with its own address, its own gross
-- monthly rent, its own size and a per-unit breakdown.
--
-- Measured across 149 real production reports pulled out of SharePoint: 95 carry
-- the grid, and the parser read it for NOTHING but a count. Extracted properly
-- it yields **290 rental comparables**, and the coverage is extraordinary:
--
--     address                     290 / 290   (100%)
--     a per-unit breakdown        290 / 290   (100%)
--       …of which per-unit SQFT   289 / 290   (99.7%)
--     condition                   289 / 290   (99.7%)
--     year built                  284 / 290   (97.9%)
--     gross monthly rent          203 / 290   (70%)
--     gross building area         199 / 290   (68.6%)
--     rent-control status         203 / 290   (70%)
--
-- That is ~290 more real properties, with what somebody is actually PAYING to
-- live in them, sitting in files we already hold. On a 2-4 unit deal the rent
-- roll IS the underwriting.
--
-- WHY ITS OWN TABLE, and not a flag on `appraisal_comparables`. A rental
-- comparable has no sale price, no sale date, no adjustment grid and no net
-- adjustment — its headline figure is a RENT. Folding it in would put rows with
-- a NULL price into every sales-comparable query, the price-per-foot maths, the
-- ARV/as-is split and the valuation comp scorer, none of which mean anything for
-- a rental. Kept apart, both grids stay exactly what they are.
--
-- PER-UNIT SQUARE FOOTAGE IS THE FACT THE SALES GRID CANNOT GIVE. A sales
-- comparable's unit mix is mined from `ROOM_ADJUSTMENT`, which states rooms,
-- beds and baths and NEVER an area. `RENTAL_UNIT` states the area. That is why
-- the owner's "each and every unit how many square footage" was answerable for
-- the subject and not for a comparable — and it is why this table also feeds
-- item 2.4b, where a rental row and a sales row describing the SAME address let
-- the area be carried across.

CREATE TABLE IF NOT EXISTS appraisal_rental_comparables (
  id                  bigserial PRIMARY KEY,
  appraisal_id        uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
  seq                 text,
  -- Sequence 0 is the SUBJECT's own rental summary, not a comparable. Kept in
  -- the same table because it is the same shape and the same grid, and flagged
  -- so no reader ever counts it as somebody else's building.
  is_subject          boolean NOT NULL DEFAULT false,

  address             text,
  city                text,
  state               text,
  zip                 text,
  proximity           text,

  monthly_rent        numeric(12,2),
  rent_per_gba        numeric(10,2),
  gba_sqft            numeric(12,2),
  rent_controlled     boolean,
  data_source         text,
  lease_terms         text,
  utilities_included  text,
  location_code       text,

  condition_uad       text,
  condition_text      text,
  age_years           integer,
  year_built          integer,

  units               integer,
  -- [{unit, rooms, beds, baths_full, baths_half, baths, sqft, monthly_rent}]
  -- Through `bindable()` on write: a jsonb column reads back as a JS array and
  -- binding it raw makes node-postgres send a Postgres array literal — the
  -- roll-up wipe of #974.
  unit_mix            jsonb,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rental_comps_appraisal ON appraisal_rental_comparables (appraisal_id);
-- One row per (report, sequence) — a re-import inserts a fresh appraisal row, so
-- this only ever guards a double-insert within one import.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rental_comps_seq
  ON appraisal_rental_comparables (appraisal_id, COALESCE(seq, ''));

COMMENT ON TABLE appraisal_rental_comparables IS
  'The appraiser''s RENT schedule (MULTIFAMILY_RENTALS): the subject''s rental '
  'summary at sequence 0 and every rental comparable after it. A rental '
  'comparable is a real property with an in-place rent and a per-unit '
  'breakdown INCLUDING square footage, which the sales grid never states.';

-- The warehouse's own copy. `property_observations.role` is plain text with no
-- CHECK, so 'rental_comparable' needs no schema change — but the two facts a
-- rental row leads with do need columns of their own: the gross monthly rent for
-- the WHOLE property (distinct from `market_rent`, which is the appraiser's
-- opinion of what it SHOULD earn) and whether the rent is controlled, which
-- decides whether that number can ever move.
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS actual_monthly_rent numeric(12,2);
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_controlled boolean;
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS rent_per_gba numeric(10,2);
ALTER TABLE properties           ADD COLUMN IF NOT EXISTS actual_monthly_rent numeric(12,2);
ALTER TABLE properties           ADD COLUMN IF NOT EXISTS rent_controlled boolean;

COMMENT ON COLUMN property_observations.actual_monthly_rent IS
  'What the building was ACTUALLY renting for when this report was written — '
  'from the rent schedule. Distinct from market_rent, which is the appraiser''s '
  'opinion of what it should earn.';
COMMENT ON COLUMN property_observations.rent_controlled IS
  'Whether the rent is controlled/stabilised, as the rent schedule states it. '
  'NULL means the report did not say — never "no".';

-- THE PIVOT A RE-INGEST DEDUPES ON. `upsertObservation` infers its conflict
-- target from the row: a subject keys on the report, a sales comparable on its
-- `appraisal_comparables` row. A RENTAL comparable has no such row — its
-- `comparable_id` is NULL — so without an index of its own the ON CONFLICT
-- clause matches nothing and every re-ingest inserts a fresh copy, doubling the
-- rent comps on a property each time a report is re-read. It keys on the report
-- plus its own sequence within that grid, which is exactly what identifies it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_rental_by_appraisal
  ON property_observations (appraisal_id, comp_seq)
  WHERE role = 'rental_comparable' AND appraisal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_obs_rental_by_import
  ON property_observations (import_id, comp_seq)
  WHERE role = 'rental_comparable' AND import_id IS NOT NULL;
