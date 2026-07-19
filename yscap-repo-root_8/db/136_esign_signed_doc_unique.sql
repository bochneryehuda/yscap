-- ============================================================================
-- 136_esign_signed_doc_unique.sql — DB backstop against a duplicate signed doc
--
-- The completion drainer stores each signed PDF + the Certificate of Completion
-- under a DETERMINISTIC filename (<doc_kind>_<envelopeId>.pdf). Its in-code
-- idempotency is a check-then-insert, which two interleaving drains (the poller
-- tick + a manual /esign/drain in the same process) can both pass, duplicating
-- the row + the condition push. This PARTIAL unique index is the real backstop;
-- storeSignedDocument now also catches the violation and reuses the winner's row.
--
-- Partial (only the esign signed kinds) so it never constrains ordinary uploads.
-- Idempotent. No existing rows for these kinds yet (nothing has been sent), so
-- creating it can never fail on a pre-existing duplicate.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_esign_signed
  ON documents(application_id, doc_kind, filename)
  WHERE doc_kind IN ('term_sheet_signed','application_signed','bp_disclosure_signed','heter_iska_signed','esign_certificate');
