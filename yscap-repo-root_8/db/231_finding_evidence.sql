-- 226 — Finding EVIDENCE columns (owner-directed 2026-07-21, Sprint 1 Task 4).
--
-- Owner said "It's too vague. Give me the exact things that you see. Which page? Where do you see
-- it? Which line?" The two example findings (background subject mismatch, appraisal property-type
-- mismatch) had all the values — the UI just wasn't showing the source-page pointer.
--
-- This adds ONE column, `page_number integer`, to both finding tables. Populated going forward by
-- the reader/analyzer when Azure Document Intelligence's Layout model returns a page for the
-- extracted field (starts flowing once db/226 + the docint.js switch to prebuilt-layout land).
-- Existing rows stay NULL — the UI just shows "Open document" instead of "Open document, page 3"
-- until re-analyzed.
--
-- Idempotent + safe to re-run.

ALTER TABLE document_findings
  ADD COLUMN IF NOT EXISTS page_number integer;

ALTER TABLE finding_escalations
  ADD COLUMN IF NOT EXISTS page_number integer;
