-- ============================================================================
-- db/668 — the condition rules run by themselves (owner-directed 2026-09-02)
--
-- WHAT THIS CHANGES, AND WHY. The owner: *"all the conditions that we build —
-- we need to click a rule to re-run the condition rules that the condition
-- should post. Please make sure that it runs automatically on everything. You
-- don't need to click this button; that populates automatically on all the
-- files and always re-checks if stuff and rules were updated, so it needs to
-- rerun itself."*
--
-- WHAT WAS OBSERVED. `engine.evaluateLoan` — the one thing that decides which
-- conditions a long-term file carries — had three callers: the "Re-check the
-- rules" button, the flood-zone switch, and the loan sync when the VESTING
-- classification moved. Nothing swept the book, nothing ran on a template
-- edit, and a loan mirrored from Encompass carried NO conditions until somebody
-- opened it and pressed the button. Anything that counted or chased outstanding
-- conditions without opening the file counted a stale list.
--
-- THE TWO STAMPS THIS ADDS, both on the loan, both written only by the engine:
--
--   conditions_evaluated_at     the START of the last CLEAN pass — one that
--                               read every table it needed and wrote everything
--                               it decided. A pass that could not read a table
--                               leaves it alone, so the loan stays due and is
--                               tried again rather than being believed.
--   conditions_evaluate_tried_at  the last ATTEMPT, clean or not. The sweep
--                               orders its batch on this, oldest first, so one
--                               file that cannot be read cannot hold the front
--                               of the queue and starve the rest of the book.
--
-- WHAT MAKES A LOAN DUE is ONE predicate, in `conditions-center/sweep.js`,
-- read by the background pass and by the file's own screen: never evaluated;
-- the Encompass mirror moved since (`encompass_synced_at`, which the loan read
-- stamps after the parties, residences, liabilities and property are written);
-- or the LIBRARY moved since — `checklist_templates.updated_at` for the
-- long-term scope, which every template edit and every seed already bumps. So
-- a rule edited on the settings screen reaches every file on the next pass
-- without anybody pressing anything.
--
-- The stamp is the START of the pass, not the end, so a mirror write that lands
-- while the pass is running still reads as newer and the loan is re-run.
--
-- BACKFILL: none, deliberately. NULL means "never evaluated by the sweep",
-- which is exactly the state every loan is in today, and the first pass works
-- through the book in bounded batches from there.
--
-- PRODUCT SEPARATION. Two columns on `lt_loans` — a Long-Term table — read and
-- written only by Long-Term code. Nothing RTL is touched.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS conditions_evaluated_at timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS conditions_evaluate_tried_at timestamptz;

COMMENT ON COLUMN lt_loans.conditions_evaluated_at IS
  'Start of the last CLEAN condition-rules pass over this loan (engine.evaluateLoan). NULL = never. The sweep re-runs a loan whose mirror or whose library moved after this.';
COMMENT ON COLUMN lt_loans.conditions_evaluate_tried_at IS
  'Last ATTEMPTED condition-rules pass, clean or not — the sweep orders its batch on it so an unreadable file cannot starve the rest.';

-- The sweep asks "which loans are due" on every tick; the order it walks them
-- in is this column, oldest attempt first.
CREATE INDEX IF NOT EXISTS lt_loans_conditions_tried_idx
  ON lt_loans (conditions_evaluate_tried_at NULLS FIRST);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
