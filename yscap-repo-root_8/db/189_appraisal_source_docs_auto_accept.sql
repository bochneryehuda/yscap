-- ============================================================================
-- 189 — The raw appraisal source documents (the MISMO XML + the appraisal PDF) are system/staff
-- artifacts stored during import, not human submissions to review — auto-accept them so they never
-- show a stray "Accept" button on the staff Documents list (owner-reported class, 2026-07-20; same
-- fix as db/186 for the extracted photos).
--
-- The manual-import route stored these WITHOUT a review_status, so they defaulted to 'pending'
-- (db/013) and the file-wide Documents panel rendered an "Accept" button on both the XML and the PDF.
-- The route now inserts them review_status='accepted'; this backfills EVERY previously-imported
-- appraisal_xml/appraisal_pdf still 'pending' (previous AND future rule).
--
-- Scope: ONLY doc_kind IN ('appraisal_xml','appraisal_pdf') rows literally 'pending' (a rejected or
-- superseded source doc keeps its status). source_type is LEFT as-is ('staff_upload') — unlike the
-- photos, the staff "Replace" action on the source files is intentionally preserved. These docs are
-- visibility='staff_only', so this is a staff-UI cleanup only, never a borrower exposure. Idempotent.
-- ============================================================================
UPDATE documents
   SET review_status = 'accepted',
       reviewed_at   = COALESCE(reviewed_at, now())
 WHERE doc_kind IN ('appraisal_xml', 'appraisal_pdf')
   AND review_status = 'pending';
