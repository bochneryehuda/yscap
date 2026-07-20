-- ============================================================================
-- 174 — SECURITY backfill: force every appraisal source document (the raw MISMO XML and the
-- appraisal PDF) to STAFF-ONLY visibility (deep end-to-end audit finding, 2026-07-20).
--
-- The manual appraisal-import route (POST /api/appraisal/:appId/import) inserted the source XML/PDF
-- WITHOUT a visibility column, so they defaulted to visibility='borrower' (db/014) and a borrower
-- could list + download the whole raw appraisal — lender_name, amc_name, owner_of_record,
-- lender_address, the appraised value, and the full findings basis — bypassing the safeAppr /
-- SCRUTINY_CODES scrub. The route is now fixed to insert 'staff_only'; this migration closes the
-- exposure on ALL PREVIOUSLY-imported files (previous AND future). The source appraisal XML/PDF are
-- ALWAYS staff-only regardless of import path (the condition-slot path already stored them so via
-- audience='staff'); property PHOTOS use different doc_kinds and are intentionally borrower-visible,
-- so they are untouched. Idempotent (only flips rows not already staff_only).
-- ============================================================================
UPDATE documents
   SET visibility = 'staff_only'
 WHERE doc_kind IN ('appraisal_xml', 'appraisal_pdf')
   AND visibility IS DISTINCT FROM 'staff_only';
