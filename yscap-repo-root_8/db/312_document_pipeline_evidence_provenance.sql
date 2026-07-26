-- Pipeline V2 (owner-directed 2026-07-26) — VSLICE-3: page-level provenance on evidence candidates.
--
-- The evidence ledger (db/309) recorded WHAT value a reader produced and how much we trust it, but
-- not WHERE on the document it came from. "Click a fact → see the exact page/spot it was read from"
-- needs page-level provenance. This adds two nullable columns to document_pipeline_evidence:
--
--   page_number    — the 1-based page the value was read from (NULL = page not known)
--   evidence_span  — structured provenance detail (bounding polygon / segment page-range / the raw
--                    span the reader returned), e.g. { page: 2, polygon: [...], source: 'field' }
--
-- Both NULLABLE + additive, so every existing row and every code path that doesn't set them is
-- unchanged. Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run on every boot. Touches no
-- frozen number, no borrower surface; the evidence ledger stays advisory (records evidence only,
-- never gates or clears a condition).

ALTER TABLE document_pipeline_evidence ADD COLUMN IF NOT EXISTS page_number   integer;
ALTER TABLE document_pipeline_evidence ADD COLUMN IF NOT EXISTS evidence_span jsonb NOT NULL DEFAULT '{}'::jsonb;
