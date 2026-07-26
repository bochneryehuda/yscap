-- ============================================================================
-- 323_borrower_merges.sql
--
-- MERGING TWO DUPLICATE BORROWER PROFILES INTO ONE (owner-directed 2026-07-26).
--
-- The system deliberately OVER-SPLITS rather than risk a wrong merge (an email
-- it can't corroborate creates a distinct profile), so genuine duplicates do
-- occur — and until now there was no way to put them back together. Merging is
-- the single most destructive thing a staffer can do to a borrower record: it
-- re-points every loan file, document, condition and message from one person to
-- another and then removes a profile. So the audit trail is not optional.
--
-- `borrower_merges` keeps the WHOLE losing profile as a jsonb snapshot (plus its
-- contacts, entities and officer links), which side won each conflicting field,
-- and how many rows moved per table. Nothing a merge destroys is unrecoverable
-- from this row.
--
-- Additive + idempotent: safe to re-run on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS borrower_merges (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The profile that SURVIVED. Cascades: if the survivor is ever deleted the
    -- history goes with it (there is nothing left to explain).
    survivor_id    uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    -- The profile that was ABSORBED. Deliberately NOT a foreign key — that row
    -- no longer exists, and the whole point of this table is to remember it.
    merged_id      uuid NOT NULL,
    merged_name    text,
    merged_email   text,
    -- The complete losing record (borrowers row + contacts + llc ids + officers)
    -- so a mistaken merge can be reconstructed by a human.
    merged_snapshot jsonb NOT NULL,
    -- Which side won each field the two profiles disagreed on: {field: 'survivor'|'merged'}.
    field_choices  jsonb,
    -- Rows moved per table: {applications: 3, documents: 41, ...}.
    moved          jsonb,
    merged_by      uuid REFERENCES staff_users(id),
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_borrower_merges_survivor ON borrower_merges(survivor_id);
-- Answers "where did this profile go?" for an id someone has bookmarked.
CREATE INDEX IF NOT EXISTS idx_borrower_merges_merged ON borrower_merges(merged_id);
