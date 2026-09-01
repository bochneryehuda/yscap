-- ============================================================================
-- db/658 — lt pricer saved scenarios
--
-- WHAT THIS CHANGES, AND WHY. Re-running yesterday's DSCR search meant retyping
-- twenty-one fields and the three party fields on top of them, because NOTHING
-- in PILOT stored the pricing engine's INPUTS: the saved investor groups
-- (db/634) hold a display overlay, the cart (db/649) holds priced members, and
-- an issued term sheet holds a document. The owner asked for a saved scenario
-- and the research is docs/longterm/SAVED-SCENARIOS-RESEARCH.md; this table is
-- its home.
--
-- ⛔ A SAVED SCENARIO IS INPUTS. IT IS NOT A PRICE, AND THAT DECIDES THE SHAPE
-- OF THIS TABLE. Rates move daily and the board is a live answer from Lender
-- Price, so a scenario re-run tomorrow is a DIFFERENT board — the same question,
-- a new answer. The most expensive mistake available here is to store a scenario
-- in a way that lets somebody believe they saved a price. PILOT already has the
-- honest version of that and it is called a term sheet: it is stamped, it
-- expires, it says on its face when its pricing dies, and it carries a code.
--
-- `saved_board` is the ONE stored figure and it is a dated HEADLINE, not a
-- quote (D4 — the owner asked to be told what MOVED since a scenario was
-- saved, and there has to be something to compare against). Everything that
-- reads it must show it dated and worded as what it was ON THAT DAY.
--
-- WHY THE SCENARIO IS jsonb AND NOT TWENTY-ONE COLUMNS. The form is the
-- vendor's question and it has changed four times this month; a column per
-- field turns every new pricing input into a migration and a back-fill. It is
-- written by ONE function (scenarioFields.toScenario) and read by one, so the
-- shape is governed in code, where it already is.
--
-- ⛔ AND WHY IT STORES THE FORM AS WELL AS THE SCENARIO. `toScenario`
-- deliberately DROPS what was not typed — that is what keeps the server the
-- single authority on the third figure when somebody types an LTV instead of a
-- loan amount. But a saved scenario has to come BACK INTO THE BOXES, and a
-- scenario that has been through that filter cannot: re-loading it would
-- silently move somebody from LTV mode into loan mode and re-price a different
-- deal. So `form` is what was typed and `scenario` is re-derived from it by
-- that same one function on the way out. This is the single easiest thing to
-- get wrong in the whole feature.
--
-- IDEMPOTENT. Same shapes as every other lt_* table here.
--
-- BACKFILL: none — the feature is new, so there is nothing to back-date.
--
-- ⛔ NO AGEING COLUMN, ON PURPOSE (D5). The owner was shown the usual worry that
-- an unpruned list stops being useful and accepted the trade in their own words:
-- a scenario lives until its owner deletes it. Nothing in PILOT may archive or
-- remove one on a timer, so there is deliberately no `expires_at` here for a
-- future sweep to find and act on. If the list ever gets long the answer is
-- search and sort, never expiry.
--
-- PRODUCT SEPARATION. lt_* only. The one cross-product reference is the
-- `staff_users` FK — the shared-identity crossing authorized in writing
-- 2026-08-03 and recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md. ON DELETE SET
-- NULL like EVERY identity link on the long-term side (test-lt-loan-schema-db
-- holds that as one uniform invariant: losing a person never deletes a loan),
-- so `staff_id` is NULLABLE and a scenario whose owner's row is deleted keeps
-- its row and simply stops appearing — every read is scoped `staff_id = <me>`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_pricer_scenarios (
    id            UUID NOT NULL,
    staff_id      UUID,
    -- OPTIONAL, and auto-derived when blank (D6). A required name is the field
    -- people abandon a save on.
    name          TEXT,
    -- The three party facts a term sheet needs that a price does not. All
    -- optional; none of them is sent to Lender Price.
    borrower_name TEXT,
    entity_name   TEXT,
    property_address TEXT,
    -- What was TYPED (restores the boxes) and what was SENT (what was priced).
    -- Both, for the reason in the header.
    form          JSONB NOT NULL DEFAULT '{}'::jsonb,
    scenario      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The calculator's own boxes. Inputs too — re-typing the rent is exactly as
    -- annoying as re-typing the FICO — and never sent to the vendor.
    calc          JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- A DATED HEADLINE of the board at save time, or NULL when the scenario was
    -- built without pricing it. Never a quote. See the header.
    saved_board   JSONB,
    saved_board_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- SOFT delete, by hand only (D5). Nothing may set this on a timer.
    deleted_at    timestamptz,

    CONSTRAINT lt_pricer_scenarios_pkey PRIMARY KEY (id)
);

-- The list a person sees: their own, newest first, the deleted ones gone. A
-- PARTIAL index because a deleted scenario is never listed and there is no
-- reason to carry it in the index every read walks.
CREATE INDEX IF NOT EXISTS lt_pricer_scenarios_mine_idx
    ON lt_pricer_scenarios (staff_id, updated_at DESC)
    WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_pricer_scenarios_staff_fkey') THEN
    ALTER TABLE lt_pricer_scenarios ADD CONSTRAINT lt_pricer_scenarios_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
