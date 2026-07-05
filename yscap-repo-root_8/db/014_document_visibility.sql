-- 014_document_visibility.sql — CRITICAL privacy fix.
--
-- Chat attachments are stored in the shared `documents` table (chat-attach.js)
-- with the file's borrower_id set. Internal (loan-officer <-> processor) chat
-- attachments were therefore surfaced in the borrower's document library
-- (GET /documents filtered only on borrower_id) AND were downloadable by the
-- borrower (download authorized any document on the borrower's application).
--
-- This adds an explicit source/visibility classification. Every borrower-facing
-- document query now filters on visibility='borrower'; chat attachments render
-- inside the conversation, never in the document library. Idempotent.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'borrower_upload'
    CHECK (source_type IN ('borrower_upload','staff_upload','chat_attachment',
      'document_request','condition','tpr','post_closing','system')),
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'borrower'
    CHECK (visibility IN ('borrower','staff_only','internal')),
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_visibility
  ON documents(application_id, visibility, source_type);

-- Backfill: classify every existing chat attachment by the channel of the
-- message that references it, and lock internal ones to staff_only. Only
-- touches rows not already classified, so it is safe to re-run every boot.
UPDATE documents d
   SET source_type = 'chat_attachment',
       message_id  = m.id,
       visibility  = CASE WHEN m.channel = 'borrower' THEN 'borrower' ELSE 'staff_only' END
  FROM messages m
 WHERE m.attachment_document_id = d.id
   AND d.source_type <> 'chat_attachment';
