-- 231_draw_media_document_kind.sql — Widen draw_media.kind to include 'document' (audit finding
-- C-6, 2026-07-21). The old CHECK IN ('image','video','draw_pdf') was written when only image +
-- video inspection media were expected; Sitewire also emits PDF/document media entries. Rather
-- than silently coercing them to 'image' (the pre-fix behavior — which then broke the borrower
-- gallery and the draw report PDF), classify them explicitly as 'document'.
--
-- Idempotent (safe to re-run every boot). No data change: the old rows are all 'image'/'video'/
-- 'draw_pdf' which are still allowed by the new constraint.

ALTER TABLE draw_media DROP CONSTRAINT IF EXISTS draw_media_kind_check;
ALTER TABLE draw_media ADD CONSTRAINT draw_media_kind_check
  CHECK (kind IN ('image', 'video', 'document', 'draw_pdf'));
