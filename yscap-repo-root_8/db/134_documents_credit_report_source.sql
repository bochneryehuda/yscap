-- ============================================================================
-- 134 — Allow 'credit_report' as a document source_type (owner-directed 2026-07-19)
--
-- The imported Xactus PDF is stored in `documents` (viewing only; the XML is the
-- data). It needs its own source_type so it is queryable and never mixed into
-- the borrower upload / condition document libraries. Extends the existing
-- documents_source_type_check enum with 'credit_report'. Idempotent.
-- ============================================================================
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_type_check
  CHECK (source_type = ANY (ARRAY[
    'borrower_upload','staff_upload','chat_attachment','document_request',
    'condition','tpr','post_closing','system','credit_report'
  ]));
