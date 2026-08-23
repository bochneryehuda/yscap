-- ============================================================================
-- db/617 — LONG-TERM: a loan number is a LABEL, not a key.
--
-- WHAT THIS CHANGES, AND WHY. The owner pressed "Pull everything from Encompass"
-- and the book stayed empty, with the new run log naming the reason:
--
--   Could not save the discovered loans:
--   duplicate key value violates unique constraint "lt_loans_loan_number_key"
--
-- db/549 declared `loan_number` UNIQUE beside `encompass_loan_guid`, as a pair,
-- as though the two were both identities. They are not. The GUID is Encompass's
-- own primary key for a loan and is genuinely unique. The loan NUMBER is a
-- human-assigned label: Encompass does not enforce it, a duplicated loan file
-- carries its source's number until somebody edits it, and a cancelled file that
-- is re-created routinely keeps the number it had. Two real, distinct loans
-- sharing one number is an ORDINARY state of that system, and this tenant has
-- them — the error above is the proof, not a theory.
--
-- WHAT THAT COST, and it is the reason this is urgent rather than tidy-up.
-- Discovery mirrors the whole discovered book inside ONE transaction, so the
-- collision did not lose the one loan it was about: it rolled back EVERY loan in
-- the pass. One duplicate label discarded the entire book, on every pass, which
-- is exactly the empty pipeline the owner has been asking about since this side
-- was switched on. THE CLASS: declaring a human LABEL to be an identity turns an
-- ordinary duplicate at the far end into a total refusal at ours.
--
-- WHY DROPPING THE UNIQUENESS IS SAFE, verified rather than assumed. Nothing in
-- this codebase treats the number as a key: there is no `ON CONFLICT
-- (loan_number)` anywhere, and every reader either DISPLAYS it
-- (`product-book.js`; `routes/conditions.js`, which looks the row up by id and
-- selects the number only to show it) or SEARCHES it (`pipeline.js`, a LIKE).
-- Not one query selects `WHERE loan_number = ...` and takes the first row. The
-- identity every writer and reader actually keys on is `encompass_loan_guid`,
-- whose unique index is LEFT IN PLACE and is what still makes one Encompass loan
-- exactly one row here.
--
-- WHY THE INDEX KEEPS ITS HISTORIC NAME, which is the load-bearing decision in
-- this file. Every migration replays on EVERY boot, so db/549 line 355 runs
-- again forever:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS lt_loans_loan_number_key ON lt_loans (loan_number);
--
-- `IF NOT EXISTS` tests the index NAME, not its shape. Drop this index and
-- re-create it under a NEW name and that statement finds its name free, tries to
-- build a unique index over data that now legitimately contains duplicates, and
-- FAILS — every boot, forever. db/549 runs as one implicit transaction, so the
-- whole file would roll back each time, taking with it the seventeen further
-- indexes and the entire foreign-key block that follow line 355. On today's
-- database those objects already exist so nothing would break, but it would log
-- a failure on every deploy and leave the next person a file that never applies:
-- precisely the quiet breakage the header of every migration here warns about.
-- Keeping the name and changing only the SHAPE makes that statement a permanent
-- no-op instead — PROVEN on a real Postgres, not assumed: with a non-unique
-- index of this name present, the db/549 statement emits `NOTICE: relation
-- already exists, skipping`, does not read the data, and leaves the index
-- non-unique. (Renaming is also forbidden here by standing rule; this is the
-- same conclusion arrived at from the other direction.)
--
-- WHY AN INDEX AT ALL RATHER THAN NONE. The pipeline SEARCHES this column, so it
-- wants an index either way; only the uniqueness was ever wrong.
--
-- WHY NOT DE-DUPLICATE INSTEAD. Choosing one of two real Encompass loans to
-- mirror and discarding the other would delete a live loan from the book with
-- nothing anywhere saying so — the confident wrong answer this side keeps
-- finding. Both are real loans and both are mirrored; a human who sees two rows
-- carrying one number can settle it in Encompass, which is where the duplicate
-- actually is.
--
-- BACKFILL: NONE, and none is possible or needed. This changes a constraint; it
-- writes no row and alters no stored value. The loans this was refusing were
-- never saved in the first place, so there is nothing to repair — the next pass
-- brings them in.
--
-- PRODUCT SEPARATION: `lt_*` only. No RTL table is read or written, no trigger
-- and no function is defined, and nothing here implies a write to Encompass.
-- ============================================================================

-- If an older database ever expressed this as a table CONSTRAINT rather than the
-- bare index db/549 creates, drop that first: its index cannot be dropped on its
-- own while the constraint owns it.
ALTER TABLE lt_loans DROP CONSTRAINT IF EXISTS lt_loans_loan_number_key;

-- Replace the index IN PLACE, keeping the name. Guarded on `indisunique` so this
-- is a true no-op from the second boot onward rather than a drop-and-rebuild of
-- a growing index on every deploy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'lt_loans_loan_number_key'
       AND n.nspname = current_schema()
       AND i.indisunique
  ) THEN
    EXECUTE 'DROP INDEX lt_loans_loan_number_key';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lt_loans_loan_number_key ON lt_loans (loan_number);

COMMENT ON COLUMN lt_loans.loan_number IS
  'Encompass''s human loan number. A LABEL, deliberately NOT unique: a duplicated or re-created Encompass file can carry another loan''s number. Identity is encompass_loan_guid.';

COMMENT ON INDEX lt_loans_loan_number_key IS
  'Non-unique despite the historic _key name (db/617). The name is kept so db/549''s CREATE UNIQUE INDEX IF NOT EXISTS stays a no-op on replay instead of failing forever on duplicate loan numbers.';


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
