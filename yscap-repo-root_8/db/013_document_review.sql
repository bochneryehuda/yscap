-- =====================================================================
-- 013_document_review.sql
-- Document review layer: every uploaded document gets a review lifecycle
-- (pending → accepted / rejected), a version chain, and a "current" flag so a
-- rejected/superseded document is never treated as part of the file. This is
-- the foundation the clean-file / TPR export builds on: only accepted+current
-- documents ever count.
-- Idempotent: safe to re-run. Existing documents default to pending review.
-- =====================================================================

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS review_status       text NOT NULL DEFAULT 'pending'
      CHECK (review_status IN ('pending','accepted','rejected','superseded')),
  ADD COLUMN IF NOT EXISTS rejection_reason    text,
  ADD COLUMN IF NOT EXISTS reviewed_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS replaces_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_current          boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(application_id, review_status);
CREATE INDEX IF NOT EXISTS idx_documents_item   ON documents(checklist_item_id);
