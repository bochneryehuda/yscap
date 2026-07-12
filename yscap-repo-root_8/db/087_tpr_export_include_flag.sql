-- 087_tpr_export_include_flag.sql — deliberate opt-in for the note-buyer export (S4-03).
--
-- The clean-file ZIP sent to a note buyer used to include EVERY accepted document
-- regardless of visibility, so a document marked staff_only / internal could ride
-- along. The export now defaults to borrower-visible documents only; this flag
-- lets staff DELIBERATELY opt a specific staff-only document's checklist item back
-- into the package (e.g. an internal appraisal the buyer actually needs). Off by
-- default, so the safe default is "internal stays internal". Idempotent.
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS tpr_include boolean NOT NULL DEFAULT false;
