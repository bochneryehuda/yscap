-- ============================================================================
-- db/621 — lt: an ARCHIVED Encompass record with a live twin leaves the book
--
-- Owner-reported 2026-08-23 (loan YSCAP258134474): the pipeline showed a stale
-- copy of the loan — wrong milestone, wrong amount, wrong value — while the
-- owner could only see ONE copy in Encompass ("I only see one copy … Get rid of
-- the other one"). Measured with the /probe diagnostic: the loan exists TWICE in
-- Encompass, and the stale copy is ARCHIVED there — it appears in a pipeline
-- search only with `includeArchivedLoans` (which discovery needs so a WITHDRAWN
-- file stays visible) and is invisible in the owner's normal Encompass view.
-- That is why the owner "only sees one": Encompass hides it from them too.
--
-- Two columns, both maintained by the sync (src/longterm/sync/loans.js), which
-- diffs a with-the-flag discovery against a flag-less one:
--
--   encompass_archived   — this record is archived inside Encompass (present
--                          only with the flag). A fact, not a judgement.
--   archived_duplicate   — archived AND a live record carries the same loan
--                          number, so this copy is superseded. These rows are
--                          retired into the archive (src/longterm/trash.js
--                          widens trashSql over this column) and leave every
--                          pipeline read, exactly like Encompass's trash.
--
-- A withdrawn file that is archived-only (no live twin) is NOT touched — that
-- is the case `includeArchivedLoans` exists for.
--
-- BACKFILL: none. The sync computes both columns on its next pass; until then
-- every row reads false and the book behaves exactly as before this file.
--
-- PRODUCT SEPARATION: `lt_*` only.
-- ============================================================================

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_archived boolean NOT NULL DEFAULT false;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS archived_duplicate boolean NOT NULL DEFAULT false;

-- Tiny partial index: every pipeline WHERE now tests NOT archived_duplicate.
CREATE INDEX IF NOT EXISTS lt_loans_archived_duplicate_idx
    ON lt_loans (archived_duplicate) WHERE archived_duplicate;
