-- ============================================================================
-- db/604 — a condition can carry a note the BORROWER and the TPO broker read
--
-- WHAT THIS CHANGES, AND WHY. Owner-reported 2026-08-21: "on the condition
-- center … Right now, I only see internal notes. We should also be able to put
-- external notes that should be visible for the borrowers and TPOs."
--
-- A condition has always had exactly one note field, `checklist_items.notes`,
-- and it is INTERNAL — the borrower checklist route says so in a comment and
-- refuses to select it, because it carries underwriting reasoning and capital-
-- partner names. So the only way to tell a borrower something about a specific
-- condition was to reject a document (which needs a document to reject) or to
-- send a message that is not attached to the condition at all. The result is
-- that the sentence a borrower most needs — "the August statement, not July" —
-- had nowhere to live next to the thing it is about.
--
-- This adds a SECOND note beside the first, deliberately the same shape (one
-- text field on the row) rather than a new notes TABLE: two mechanisms for one
-- idea is how they drift, and the internal note is the shape staff already
-- know. What the external one adds is WHO last wrote it and WHEN — a borrower
-- reading a note needs to know it is from their team and current, and staff
-- need to know whose words are on a borrower's screen.
--
-- IT IS NEVER THE SAME COLUMN AS `notes`, AND THAT IS THE SAFETY PROPERTY. The
-- internal note keeps its meaning exactly: staff-only, appended to by [auto]
-- messages, never selected by a borrower or TPO route. Nothing here changes
-- what is already on any file, so no existing note can become visible to
-- anybody it was not already visible to.
--
-- IDEMPOTENT — three ADD COLUMN IF NOT EXISTS and one index.
--
-- BACKFILL: NONE, deliberately. There is nothing to migrate: `notes` is
-- internal by definition and copying any of it across would publish staff
-- reasoning to borrowers, which is the exact opposite of the point. Every
-- existing condition starts with no external note, and reads as having none.
--
-- PRODUCT SEPARATION: RTL only. `checklist_items` is an RTL table; the
-- Long-Term condition centre is its own `lt_*` build and is untouched.
-- ============================================================================

ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS external_note      text;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS external_note_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS external_note_at   timestamptz;

-- The borrower's and the broker's checklist read one file's conditions at a
-- time and only need the note where there IS one, so the index is partial —
-- it stays tiny however many conditions the book carries.
CREATE INDEX IF NOT EXISTS idx_checklist_external_note
  ON checklist_items (application_id)
  WHERE external_note IS NOT NULL;
