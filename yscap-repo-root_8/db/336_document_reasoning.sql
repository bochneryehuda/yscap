-- 336_document_reasoning.sql
-- The per-document REASONING layer (owner-directed 2026-07-27, the tax-certificate incident).
--
-- The field extractor is slot-driven — it reads a document as whatever checklist condition it was
-- filed under. So a tax certificate filed under a "title" slot got read as a title report, its
-- current owner (the seller, pre-close) landed in a "buyer" field, and the tie-out compared that
-- owner to the vesting LLC — a guaranteed-nonsense fatal. A field map cannot tell a tax cert from a
-- title commitment; the AI reasoning pass (src/lib/underwriting/document-reasoning.js) can, and
-- records — per document — what it actually IS, what it's FOR, and WHO each party is (their role /
-- side). The comparison-gate consumes that to refuse a cross-side comparison.
--
-- ADVISORY ONLY: this column feeds nothing but the tie-out's suppression of nonsense comparisons.
-- NULL for every existing row and for any file with the layer switched off — so the tie-out behaves
-- exactly as before until a document is (re-)read with UW_DOC_REASONING_ENABLED=1. Idempotent.
ALTER TABLE document_extractions ADD COLUMN IF NOT EXISTS reasoning jsonb;

COMMENT ON COLUMN document_extractions.reasoning IS
  'Advisory per-document AI reasoning: {docNature, purpose, asOf, matchesFiledType, parties:[{name,role}], confidence}. Feeds only the tie-out comparison-gate (suppresses cross-side comparisons); never a number, never a block. NULL until read with UW_DOC_REASONING_ENABLED=1.';
