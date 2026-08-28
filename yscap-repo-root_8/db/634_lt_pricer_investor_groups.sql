-- ============================================================================
-- db/634 — lt pricer investor groups
--
-- WHAT THIS CHANGES, AND WHY. The Pricing Engine gained an INVESTOR FILTER
-- (owner-directed 2026-08-27): a person pricing a scenario can narrow the BOARD
-- to the investors they care about, and can save a named set of them — "my
-- three", "the condo buyers" — to apply with one press. The filter is a DISPLAY
-- OVERLAY on top of Lender Price (the search itself is never narrowed; the
-- vendor is always asked for everything), so the only thing that needs a home
-- is the named set itself. This table is that home: one row per group, owned by
-- the person who made it — the owner's words were "every user should be able to
-- set up by themselves groups", so unlike lt_pipeline_views there is no shared
-- (staff_id IS NULL) form and the column is NOT NULL.
--
-- `investors` holds CANONICAL investor keys (src/longterm/encompass/investors.js
-- — 'deephaven', 'verus', …), never a spelling: a stored spelling would rot the
-- day the vendor re-labels a lender, and the registry already resolves 151 ways
-- of writing thirty companies to one key each. Validation happens in
-- src/longterm/pricer-groups.js, the one writer.
--
-- IDEMPOTENT. Same shapes as every other lt_* table here.
--
-- BACKFILL: none — the feature is new, so there is nothing to back-date.
--
-- PRODUCT SEPARATION. lt_* only. The one cross-product reference is the
-- `staff_users` FK — the shared-identity crossing authorized in writing
-- 2026-08-03 and recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md (the same FK
-- lt_pipeline_views carries). ON DELETE SET NULL like EVERY identity link on
-- the long-term side — test-lt-loan-schema-db holds that as one uniform
-- invariant ("losing a person never deletes a loan"), and an invariant with a
-- convenience exception is how invariants stop being believed. The first cut
-- of this file tried CASCADE ("a group with no owner is unreachable anyway")
-- and that suite correctly refused it. So `staff_id` is NULLABLE: a group
-- whose owner's row is ever deleted keeps its row and simply stops appearing,
-- because every read is scoped `staff_id = <me>` — exactly the views' shape.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_pricer_investor_groups (
    id          UUID NOT NULL,
    staff_id    UUID,
    name        TEXT NOT NULL,
    investors   JSONB NOT NULL DEFAULT '[]'::jsonb,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_pricer_investor_groups_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS lt_pricer_investor_groups_staff_idx
    ON lt_pricer_investor_groups (staff_id, sort_order, name);

-- One name per person: "DSCR favourites" saved twice is two rows a person
-- cannot tell apart in a picker, so the second save UPDATES the first (the
-- writer upserts on this). Case-insensitive, because "My Three" and "my three"
-- are the same name to a human.
CREATE UNIQUE INDEX IF NOT EXISTS lt_pricer_investor_groups_name_uk
    ON lt_pricer_investor_groups (staff_id, lower(name));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_pricer_investor_groups_staff_fkey') THEN
    ALTER TABLE lt_pricer_investor_groups ADD CONSTRAINT lt_pricer_investor_groups_staff_fkey
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
