-- R5.1 / R5.10 — Packet splitter: page-bounded logical children.
--
-- The old "Split + File" action created child `documents` rows that pointed at
-- the FULL original PDF's storage_ref, so a "bank statement child" split out of
-- a 40-page package was still analyzed against the whole package (contaminating
-- classification / extraction / facts / condition proofs — the P0-A gap).
--
-- These two columns record, on every child, (a) which SOURCE document it was
-- split from and (b) which 1-indexed pages of that source it covers. The split
-- action now physically slices the source PDF to exactly those pages and points
-- the child at its OWN sliced storage object — so downstream analysis is
-- structurally page-bounded. The columns give us the provenance + a durable
-- record of the boundary even when (rarely) the physical slice can't be built.
--
-- Additive + idempotent. NULL on every existing / non-split document.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_range int[];
-- When true, the child points at its OWN physically page-bounded bytes (safe to
-- analyze). When false, the split fell back to referencing the source bytes and
-- the child must NOT be auto-analyzed as if it were the whole document.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS page_bounded boolean;

CREATE INDEX IF NOT EXISTS idx_documents_source_document
  ON documents (source_document_id)
  WHERE source_document_id IS NOT NULL;
