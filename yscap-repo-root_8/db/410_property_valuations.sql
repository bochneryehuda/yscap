-- ============================================================================
-- 410 — BUILD YOUR OWN VALUATION (owner-directed 2026-08-02: "make a thing that
--       you can also build up yourself an AVM on a certain property by searching
--       which comps you want to add on your AVM and then adjust those comps
--       however you want … and you can run a report how your property may be
--       going to be appraised").
--
-- A saved run of the sales-comparison grid: a SUBJECT, the comparables a human
-- picked out of the research warehouse (db/409), the dollar adjustments they
-- made to each one, and the reconciled indicated value — kept so it can be
-- re-opened, re-run, printed and defended months later.
--
-- THE ONE DESIGN DECISION THAT MATTERS: EVERY VALUATION CARRIES ITS OWN COPY OF
-- THE FACTS. `subject_snapshot` and each comp's `snapshot` are the facts AS THEY
-- STOOD when the valuation was made, copied in, not referenced. The warehouse
-- keeps learning — a later appraisal restates a comp's condition, a roll-up
-- moves, a property is re-keyed — and a valuation whose numbers silently change
-- underneath it is not a record of anything. The `property_id` /
-- `observation_id` links are still there so the screen can jump through to the
-- live property; they just never feed the arithmetic of a saved grid.
--
-- Nothing here is an appraisal. The engine stamps a disclaimer into every result
-- (src/lib/research/valuation.js DISCLAIMER) and every surface renders it with
-- the number — an internal value indication, not USPAP work product.
--
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS property_valuations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title              text,
    -- WHAT is being valued. A valuation can hang off a property in the
    -- warehouse, off a loan file's subject, off both, or off neither (a typed
    -- address nobody has appraised yet) — so both links are nullable and the
    -- address is always stored as text.
    property_id        uuid REFERENCES properties(id) ON DELETE SET NULL,
    application_id     uuid REFERENCES applications(id) ON DELETE SET NULL,
    subject_address    text,
    subject_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- WHY. An as-is opinion and an after-repair opinion use different comps, and
    -- the research warehouse records which grid each comp came off, so the two
    -- must be distinguishable here too.
    purpose            text NOT NULL DEFAULT 'research',   -- as_is | arv | research
    effective_date     date,                               -- "as of" — the date the comps are measured against

    -- ---- the answer --------------------------------------------------------
    method             text NOT NULL DEFAULT 'weighted',   -- weighted | median | mean
    indicated_value    numeric(14,2),
    value_low          numeric(14,2),
    value_high         numeric(14,2),
    likely_low         numeric(14,2),
    likely_high        numeric(14,2),
    price_per_sqft     numeric(12,2),
    confidence_label   text,                               -- strong | fair | weak | very weak
    confidence         jsonb NOT NULL DEFAULT '{}'::jsonb,
    warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The adjustment rates the grid was pre-filled from, copied in for the same
    -- reason the snapshots are: "where did $119 a square foot come from?" has to
    -- stay answerable after the underlying sales have moved.
    market_rates       jsonb NOT NULL DEFAULT '{}'::jsonb,
    reconciliation_note text,

    -- ---- housekeeping ------------------------------------------------------
    status             text NOT NULL DEFAULT 'draft',      -- draft | final
    version            integer NOT NULL DEFAULT 1,
    supersedes_id      uuid REFERENCES property_valuations(id) ON DELETE SET NULL,
    created_by         uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    finalized_at       timestamptz,
    finalized_by       uuid
);
CREATE INDEX IF NOT EXISTS idx_pval_property ON property_valuations(property_id);
CREATE INDEX IF NOT EXISTS idx_pval_application ON property_valuations(application_id);
CREATE INDEX IF NOT EXISTS idx_pval_created_by ON property_valuations(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pval_recent ON property_valuations(created_at DESC);

CREATE TABLE IF NOT EXISTS property_valuation_comps (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valuation_id    uuid NOT NULL REFERENCES property_valuations(id) ON DELETE CASCADE,
    -- Live links (navigation only — never the source of the stored numbers).
    property_id     uuid REFERENCES properties(id) ON DELETE SET NULL,
    observation_id  uuid REFERENCES property_observations(id) ON DELETE SET NULL,
    source_appraisal_id uuid REFERENCES appraisals(id) ON DELETE SET NULL,

    comp_order      integer NOT NULL DEFAULT 0,
    included        boolean NOT NULL DEFAULT true,
    weight          numeric(8,4),          -- null = let the engine weight it
    -- The comp AS IT WAS: address, sale price, sale date, GLA, beds, baths,
    -- condition, quality, distance, photo — everything the grid renders.
    snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
    sale_price      numeric(14,2),
    sale_date       date,
    -- The grid: [{key,label,amount,note,source:'suggested'|'user'}]
    adjustments     jsonb NOT NULL DEFAULT '[]'::jsonb,
    adjusted_price  numeric(14,2),
    net_adjustment  numeric(14,2),
    gross_adjustment numeric(14,2),
    net_adj_pct     numeric(8,2),
    gross_adj_pct   numeric(8,2),
    distance_miles  numeric(8,3),
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One row per property per valuation: adding the same comp twice is a mistake,
-- not a feature, and the upsert relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pval_comp
    ON property_valuation_comps(valuation_id, COALESCE(property_id::text, id::text));
CREATE INDEX IF NOT EXISTS idx_pval_comps_valuation ON property_valuation_comps(valuation_id, comp_order);
