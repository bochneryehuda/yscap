-- =====================================================================
-- 010_chat.sql — rich chat: attachments (images, video, audio/voice notes,
-- PDFs, any file) carried by messages, stored through the documents table so
-- chat media lives on the same persistent disk + authz as everything else.
-- read_at (already present) powers read receipts. Idempotent.
-- =====================================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attachment_kind text
      CHECK (attachment_kind IN ('image','video','audio','pdf','file'));

CREATE INDEX IF NOT EXISTS idx_messages_attachment ON messages(attachment_document_id)
  WHERE attachment_document_id IS NOT NULL;
