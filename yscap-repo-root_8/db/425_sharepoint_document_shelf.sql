-- ============================================================================
-- 425 — WHICH SHELF a document's SharePoint copy is filed on.
--
-- Owner-directed 2026-08-03, straight after db/424 stopped un-accepted documents
-- leaving the building: "yes do the SharePoint folder too … even though it gets
-- rejected, we should always still save copies in folders. So we should have a
-- folder with all old versions and old old versions to be placed in the old
-- version folder."
--
-- The mirror still saves EVERY document — it is the backup, and its standing
-- policy is that nothing is ever deleted. What changes is where each one sits:
--
--     <Category>/                     accepted + current  (what the export ships)
--     <Category>/Waiting for review/  nobody has decided on it yet
--     <Category>/Old Versions/        rejected, and superseded older copies
--
-- A document is mirrored within seconds of upload, long before anyone reviews
-- it, so its shelf is not knowable at mirror time. It is filed on "Waiting for
-- review" and MOVED when the verdict lands. This column is what makes that
-- cheap and safe: it records the shelf the copy is actually filed on, so the
-- re-file sweep can find the handful of documents whose shelf has changed with
-- one indexed query instead of asking SharePoint about every document we have
-- ever mirrored.
--
-- NULL means "filed before shelving existed" — the sweep works out where that
-- copy belongs and files it, exactly like any other mismatch. It deliberately
-- does NOT mean "leave alone": the whole point is that the back book gets tidied
-- too, a few documents per pass, without a single deletion.
-- ============================================================================
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_shelf text;

COMMENT ON COLUMN documents.sharepoint_shelf IS
  'Which shelf this document''s SharePoint copy is filed on: live | waiting | old. NULL = mirrored before db/425 (the re-file sweep will place it). See src/lib/sharepoint-shelf.js.';

-- The sweep asks exactly one question: "which mirrored documents are on the
-- wrong shelf?" That is a scan over mirrored rows, so it is indexed on the
-- columns the answer depends on. Partial — an un-mirrored document has no copy
-- to move, and there are far more of those over time than mirrored ones.
CREATE INDEX IF NOT EXISTS idx_documents_sharepoint_shelf
    ON documents (sharepoint_shelf, review_status, is_current)
 WHERE sharepoint_backup_ref IS NOT NULL;
