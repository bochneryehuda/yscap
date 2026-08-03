-- 450 — PUTTING db/448'S FACTS WHERE THEY BELONG
--
-- db/448 carried 59 previously-dropped facts into the warehouse. A pre-merge
-- audit, run against a real database with real reports, proved that FIVE of the
-- placements were wrong and TWO of the columns can never hold anything. Every
-- defect below was REPRODUCED, not reasoned about. Nothing here re-litigates the
-- 47 placements that were right.
--
-- The one sentence that decides all of it: `properties` is billed as the best
-- known answer about a REAL HOUSE AS IT STANDS TODAY. A fact that is true of a
-- REPORT, of a FUTURE house, or of a WHOLE BUILDING is not that, however
-- convenient it is to have on the row.
--
-- WHY 450 AND NOT 424. This file exists to CORRECT db/448 and db/449, so it must
-- run after them. It was originally 424 — correctly, because those two were then
-- 422 and 423 — and when main's dashboards work (#985) collided on 421/422/423
-- and this branch's three were renumbered to 447/448/449, this one silently
-- inverted: it began running BEFORE the migration that CREATES
-- `market_observations`, so `ALTER TABLE market_observations …` failed with
-- 42P01 on every fresh database. `migrate-boot` logs a failed file and KEEPS
-- GOING (by design — a migration hiccup must not stop the service booting), so
-- `ensureSchema()` still returned cleanly and the only evidence was one
-- "FAILED … — continuing" line in the boot log. A renumber has to move the whole
-- dependent CHAIN, not just the colliding files.
--
-- ─── 1. THE BUILDING'S ABSORPTION STATISTICS WERE FILED PER UNIT ─────────────
--
-- The condo counts (units sold / completed / for sale / rented / owner-occupied,
-- plus developer control and concentrated ownership) come off the report's
-- DEVELOPMENT_STAGE block: a phase-level, as-of-the-report snapshot of the
-- BUILDING. Rule 6 of the warehouse never drops the unit from a property's
-- identity, so each unit is its own `properties` row — and each one was handed a
-- private copy of the building's statistics. Proven: one building, two units,
-- two reports two years apart, and the warehouse reported
--
--     unit 101   sold=40    completed=60    for_sale=20   developer_control=true
--     unit 102   sold=118   completed=120   for_sale=2    developer_control=false
--
-- for the same building, with a `condo_project` search returning both, disagreeing.
--
-- That is word for word the reason db/448 gave for DEFERRING the market grid:
-- "filing them on a property row would make every house in a town carry its own
-- private copy of the town's statistics, disagreeing with its neighbours by
-- whichever report happened to be newest." The same argument applies at building
-- scale, and `condo_developer_control` is an ELIGIBILITY flag — reporting it
-- stale, per unit, is the expensive direction.
--
-- The DURABLE project attributes stay on the property: the project's name, type,
-- total phases, units PLANNED, common elements, management type, parking and
-- commercial space do not move as the building sells out. The eight moving ones
-- go back to being observation-only, where each is correctly dated by the report
-- that said it. When the project gets its own table — keyed on project + period,
-- the shape `market_observations` already has — they belong there.
--
-- ─── 2. A LISTING NOTE CROSSED OVER WITHOUT ITS DATE ─────────────────────────
--
-- `listed_within_year` is deliberately observation-only, because "within the
-- previous year" is relative to the report's own date. db/448 rolled up its
-- DESCRIPTION and left the indicator behind. Proven: a 2019 report stating
-- "Listed 3/2018 at $310,000, expired 9/2018" put that note on the property, and
-- a 2026 report explicitly stating NOT listed in the past year could not displace
-- it — silence never blanks a roll-up, and the newer report's answer was a
-- boolean the property row has no column for. A stale listing note nothing can
-- clear is worse than no listing note.
--
-- ─── 3. THE COST SERVICE'S NAME IS NOT AN ATTRIBUTE OF THE HOUSE ────────────
--
-- `cost_data_source` is COST_ANALYSIS/DataSourceDescription — which cost service
-- the appraiser consulted ("Marshall & Swift 2024"). It is the exact analogue of
-- `contract_data_source`, which this warehouse already keeps observation-only,
-- and it sits inside db/448's own report-side definition. `cost_quality_rating`
-- STAYS on the property: that one grades the DWELLING's construction, which is a
-- fact about the house (and it joins AS_IS_ONLY in ingest.js, so an after-repair
-- report can no longer state it).
--
-- ─── 4. TWO COLUMNS THAT CAN ONLY EVER BE NULL ──────────────────────────────
--
-- db/448 claimed "every one of these was already parsed out of the XML". True of
-- 57; NOT true of `form_version` and `software_vendor`. The parser never assigns
-- either, `appraisalRowFrom` hard-codes `software_vendor: null` and omits
-- `form_version` from its column list, and nothing else in the repo updates them.
-- So both `appraisals` columns are always NULL and the two observation columns
-- are dead. The db/448 test only passed because it hand-INSERTs `form_version`
-- straight into `appraisals`, which no real import path does — it proved the
-- plumbing, not that any report will ever fill it. Dropped rather than shipped
-- as two permanently-empty columns implying we know something we do not. If a
-- vendor's XML turns out to carry them, they come back WITH a parser that reads
-- them.
--
-- ─── 5. THE ATTACHMENT STYLE HAD NOWHERE TO LAND ────────────────────────────
--
-- db/405 evicted Attached/Detached/SemiDetached out of `property_type`
-- SPECIFICALLY so the fact would not be lost — a building touching its neighbour
-- is a real, durable, searchable property fact, it simply is not a CATEGORY. It
-- then reached no warehouse table at all, and db/448's own accounting missed it.
-- It is added here, to both tables, as the property fact it always was.
--
-- ─── 6. THE APPRAISER'S OWN MARKET RESEARCH WAS STORED AS "[object Object]" ──
--
-- `appraisals.comp_research` is JSONB (the RESEARCH block's sales and listing
-- counts and price brackets). db/449 declared the market_observations column
-- `text` and wrote it through a string helper, so every row stored the literal
-- "[object Object]". Retyped to jsonb and re-bound properly. The column is
-- dropped and re-added rather than cast: every value it has ever held is that
-- same garbage string, so there is nothing to preserve.

-- ---------------------------------------------------------------------------
-- 1. THE BUILDING'S MOVING STATISTICS GO BACK TO BEING OBSERVATION-ONLY.
--    They remain on `property_observations`, dated by the report that said them.
-- ---------------------------------------------------------------------------
ALTER TABLE properties DROP COLUMN IF EXISTS condo_units_completed;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_units_sold;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_units_rented;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_units_for_sale;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_owner_occupied;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_developer_control;
ALTER TABLE properties DROP COLUMN IF EXISTS condo_concentrated_ownership;
-- `condo_units_planned` is the count the project was DESIGNED for and does not
-- move as it sells; it stays. So do name / type / total_phases / common_elements
-- / management_type / parking_spaces / commercial_space.

-- ---------------------------------------------------------------------------
-- 2 + 3. REPORT-RELATIVE FACTS GO BACK TO THE REPORT.
-- ---------------------------------------------------------------------------
ALTER TABLE properties DROP COLUMN IF EXISTS listing_history;
ALTER TABLE properties DROP COLUMN IF EXISTS cost_data_source;

-- ---------------------------------------------------------------------------
-- 4. THE TWO COLUMNS NOTHING CAN EVER FILL.
-- ---------------------------------------------------------------------------
ALTER TABLE property_observations DROP COLUMN IF EXISTS form_version;
ALTER TABLE property_observations DROP COLUMN IF EXISTS software_vendor;

-- ---------------------------------------------------------------------------
-- 5. THE ATTACHMENT STYLE, ON BOTH SIDES.
-- ---------------------------------------------------------------------------
ALTER TABLE property_observations ADD COLUMN IF NOT EXISTS attachment_type text;
ALTER TABLE properties            ADD COLUMN IF NOT EXISTS attachment_type text;
COMMENT ON COLUMN properties.attachment_type IS
  'Attached / Detached / SemiDetached — the MISMO attachment STYLE, which db/405 '
  'deliberately kept out of property_type because it is not a category. Rolled up '
  'newest-wins like every other durable property fact.';

-- ---------------------------------------------------------------------------
-- 6. THE APPRAISER'S OWN MARKET RESEARCH, AS THE JSON IT ACTUALLY IS.
--    Every value ever written here is the string "[object Object]" (db/449 typed
--    it text and bound it through a string helper), so a cast would preserve
--    nothing. `writeMarket` is idempotent per report and refills it on re-ingest.
-- ---------------------------------------------------------------------------
--    THE GUARD IS NOT DECORATION. `migrate-boot` runs every numbered file's FULL
--    TEXT on EVERY BOOT, so a bare `DROP COLUMN IF EXISTS` + `ADD COLUMN IF NOT
--    EXISTS` pair only LOOKS idempotent: the column always exists, so the DROP
--    always fires, and every deploy would drop the freshly-populated jsonb column
--    and re-add it empty. Measured before this guard: one `ensureSchema()` took a
--    real `{salesCount:26,…}` to NULL, and nothing repopulates it (`writeMarket`
--    runs on ingest, and the back-fill skips reports already logged ok). That is
--    strictly WORSE than the "[object Object]" this exists to fix. It also burns a
--    `pg_attribute` slot per boot against Postgres's hard 1600-column ceiling.
--    So: retype ONLY while it is still text.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'market_observations'
                AND column_name = 'comp_research'
                AND data_type <> 'jsonb') THEN
    ALTER TABLE market_observations DROP COLUMN comp_research;
  END IF;
END $$;
ALTER TABLE market_observations ADD COLUMN IF NOT EXISTS comp_research jsonb;
COMMENT ON COLUMN market_observations.comp_research IS
  'The appraiser''s OWN researched market bracket for this report — sales and '
  'listing counts with their price ranges. jsonb: {salesCount,salesLow,salesHigh,'
  'listingsCount,listingsLow,listingsHigh}.';

-- ---------------------------------------------------------------------------
-- PREVIOUS AND FUTURE. Dropping a column does not repair the ROWS: a property
-- rolled up at version 3 carries after-repair depreciation figures in the columns
-- that survive, and carries no attachment style. `ROLLUP_VERSION` moves to 4 in
-- ingest.js and the boot sweep re-rolls every row behind through the one
-- definition of the roll-up. Nothing is recomputed here in SQL — a PL/pgSQL twin
-- of the roll-up would drift from the live one, which this codebase has been
-- bitten by before.
-- ---------------------------------------------------------------------------
