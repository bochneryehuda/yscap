-- 168_underwriting_idempotency.sql
-- Analyze-once idempotency for the document-underwriting engine. Re-running an analysis on
-- a document whose CONTENT, doc-type, analyzer version, AND the file data it's checked against
-- are all unchanged is pure waste (a second paid Azure read + GPT call for a byte-identical
-- result). It also happens for free: a double-clicked "Analyze", a client retry, a re-open of
-- the desk. We stamp each extraction with the inputs that determine its output, so the route
-- can short-circuit to the stored result when nothing that matters has changed.
--
-- Why all FOUR inputs (not just the content hash): findings depend on the loan FILE, not only
-- the document. If the purchase price on the file changed, a byte-identical contract must be
-- re-checked — so the subject fingerprint is part of the key. And bumping the analyzer version
-- (a new model / prompt / schema) must force a fresh read even on identical bytes.
--
-- Idempotent (safe to re-run every boot).

ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS analyzed_sha256   text;  -- sha256 of the document bytes that were read
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS analyzer_version  text;  -- reader+analyzer+schema version tag
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS subject_hash      text;  -- fingerprint of the file data this was checked against

-- The lookup the route makes before analyzing: "is there already a CURRENT extraction of this
-- exact document, type, analyzer version, and file state?" Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_docextract_idem
  ON document_extractions (document_id, doc_type, analyzed_sha256)
  WHERE is_current;
