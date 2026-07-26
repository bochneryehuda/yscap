-- ============================================================================
-- 186 — Appraisal photos are SYSTEM-extracted, not human uploads: auto-accept them so they never
-- sit in the document-review queue requiring individual acceptance (owner-reported regression,
-- 2026-07-20).
--
-- extractAndStorePhotos inserts each subject/comp image pulled from the appraisal PDF as a
-- `documents` row. It never set review_status, so every photo defaulted to 'pending' (db/013) and
-- appeared on the file's Documents list with an "Accept" button — the owner had to accept each image
-- one by one. The insert now stores them 'accepted' + source_type='system'; this backfills EVERY
-- previously-extracted photo (previous AND future rule).
--
-- Scope: ONLY doc_kind='appraisal_photo' rows whose review_status is literally 'pending' (a photo
-- already 'rejected' or 'superseded' keeps that status). A retired old-appraisal photo (is_current=
-- false but still 'pending') is also flipped — harmless, since is_current=false rows are invisible
-- everywhere (the Documents list, the report GET join, and TPR all require is_current=true).
-- Idempotent. source_type is set to 'system' only where it's still the default 'borrower_upload' so
-- the UI treats them as system-generated (hides "Replace"). TPR inclusion is unchanged — the export
-- already counts every non-rejected doc, so these photos were already in it; this only removes the
-- manual-accept step.
-- ============================================================================
UPDATE documents
   SET review_status = 'accepted',
       reviewed_at   = COALESCE(reviewed_at, now()),
       source_type   = CASE WHEN source_type = 'borrower_upload' THEN 'system' ELSE source_type END
 WHERE doc_kind = 'appraisal_photo'
   AND review_status = 'pending';
