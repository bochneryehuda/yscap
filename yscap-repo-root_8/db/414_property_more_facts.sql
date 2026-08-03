-- 414 — THE FACTS WE ALREADY READ BUT COULD NOT SEARCH ON
--
-- db/409 records a great deal more about each property than the search can reach.
-- `property_observations` is the content — what ONE report said — and `properties`
-- is the roll-up the search actually queries. A fact that lives only on the
-- observation is stored, provable and completely invisible to anyone looking for
-- it: `search.js` reads `properties` alone, so "show me the two-family houses with
-- a finished basement in a flood zone" cannot be asked, even though every one of
-- those facts is already in the database from the day the report was read.
--
-- The XML field-expansion study (docs/research/XML-FIELD-EXPANSION-RESEARCH.md)
-- calls this the best value-for-risk change available: no new parsing, no new
-- extraction, nothing that can be read wrong — the values are already validated and
-- stored. They simply need somewhere on the property row to roll up to.
--
-- WHAT IS DELIBERATELY NOT HERE. A fact about the REPORT does not belong on the
-- property, however useful it is: `proximity`, `days_on_market`, `price_per_gla`,
-- `gla_basis`, `net_adj_pct`, `comp_set`, `data_source` and the adjustment lines are
-- all one appraiser's statement about one sale on one date. Rolling those up would
-- print the last report's opinion as though it were a property characteristic. They
-- stay on the observation, which is where the property page already shows them.

-- ---- the structure ---------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS basement_finished_pct  numeric(5,2);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS attic                  boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS has_adu                boolean;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS heating_fuel           text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS remaining_economic_life integer;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS condo_floor            text;

-- ---- the land --------------------------------------------------------------
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_shape              text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS lot_dimensions         text;

-- ---- how it is held and used ----------------------------------------------
-- Fee simple vs leasehold changes what is being bought and therefore what it is
-- worth; occupancy is the latest report's statement about who is in it.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_rights        text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS occupancy_status       text;

-- ---- flood -----------------------------------------------------------------
-- `flood_zone` (the appraiser's stated zone) already rolls up. These two are the
-- FEMA determination itself, which is the one a lender acts on.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS fema_flood_zone        text;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS sfha                   boolean;

-- ---- the rent roll ---------------------------------------------------------
-- The per-unit mix off a 1025 rent schedule: rooms, beds, baths, size and rent per
-- unit. `market_rent` (the whole-property figure) already rolls up; this is the
-- breakdown behind it, and it is the fact that makes a 2-4 comparable usable.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS unit_mix               jsonb;

-- ---- searching on them -----------------------------------------------------
-- Partial indexes only: each of these is null on most rows (a fact is recorded when
-- a report happened to state it), so a full index would be mostly empty pages.
CREATE INDEX IF NOT EXISTS ix_properties_sfha ON properties(sfha) WHERE sfha IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_properties_rights ON properties(property_rights) WHERE property_rights IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_properties_occupancy ON properties(occupancy_status) WHERE occupancy_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_properties_adu ON properties(has_adu) WHERE has_adu IS TRUE;

-- ---------------------------------------------------------------------------
-- PREVIOUS AND FUTURE — how the properties already in the database get these
-- ---------------------------------------------------------------------------
-- `properties` is DERIVED: `ingest.rollupProperty` recomputes every column from the
-- observations. But it only runs when a report TOUCHES a property, and the boot
-- back-fill only reads reports it has not read before — so without this, every
-- property already in the database would keep a NULL in each new column forever and
-- the new filters would quietly return almost nothing.
--
-- The re-roll is written in JAVASCRIPT, not here. A SQL twin of the roll-up would be
-- a second copy of the rule in a second language, and this repo has been bitten by
-- exactly that drift before (pilot_term_norm, pilot_property_type_norm) — the roll-up
-- also has to skip an after-repair condition rating, which is a judgement, not a
-- COALESCE. So this column is the QUEUE, and `ingest.rerollStaleProperties` (booted,
-- bounded, self-draining) does the work through the one definition that already
-- exists.
--
-- Any future change to what rolls up bumps `ROLLUP_VERSION` in ingest.js and the
-- whole warehouse re-rolls itself over the following boots. Nothing else to write.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rollup_version smallint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ix_properties_rollup_version
  ON properties(rollup_version, observation_count DESC)
  WHERE rollup_version < 2;
