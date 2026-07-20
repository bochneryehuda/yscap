-- ============================================================================
-- 171_draw_report_unique.sql — DB backstop against a duplicate draw report row
--
-- The PILOT-branded inspection reports (Draw Management phase 2b) are stored as
-- `documents` rows under a DETERMINISTIC, version-hashed filename
-- (pilot-<scope>-<mode>-<label>-<hash>.pdf, doc_kind='draw_inspection_report').
-- Two concurrent report generations of the SAME unchanged draw compute the same
-- filename; the in-code idempotency is a check-then-insert, which two interleaving
-- requests can both pass and duplicate the row. This PARTIAL unique index is the
-- real backstop; storeDrawReport catches the violation and reuses the winner's row
-- (mirrors the esign uq_documents_esign_signed pattern in db/142).
--
-- Partial (only the report kind) so it never constrains ordinary uploads.
-- Idempotent. No existing rows for this kind yet, so creating it can never fail
-- on a pre-existing duplicate.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_draw_report
  ON documents(application_id, doc_kind, filename)
  WHERE doc_kind = 'draw_inspection_report';
