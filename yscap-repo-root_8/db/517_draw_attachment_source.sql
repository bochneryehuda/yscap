-- ============================================================================
-- 517_draw_attachment_source.sql — WHERE a draw attachment came from
-- (owner-directed 2026-08-10: a PDF the borrower EMAILED to Sitewire as proof for
-- draw 1 — "CCF_000016.pdf, From inbound email" — sat in Sitewire's Documents tab
-- and never reached the PILOT draw, so it never reached the investor either.
-- "Anything like this should be included and attached to the draw as invoices and
-- additional proof.")
--
-- PILOT now PULLS those documents off the Sitewire property (they arrive on
-- `property.documents[]` carrying a `draw_id`) and files each one onto the right
-- draw through the ordinary draw-attachments door. Two columns make that safe:
--
--   source      — who put it on the draw: NULL = a person in PILOT (the existing
--                 rows), 'sitewire_property_doc' = pulled from Sitewire's
--                 Documents tab by the sync.
--   source_key  — the durable identity of the Sitewire-side document
--                 (draw + upload time + filename), so the poll can tell "already
--                 pulled" from "new" WITHOUT re-downloading everything every
--                 cycle. The partial unique index is the guarantee: the same
--                 Sitewire document can never be filed twice on one loan file,
--                 whatever races the poll gets into.
--
-- Idempotent.
-- ============================================================================

ALTER TABLE draw_attachments
  ADD COLUMN IF NOT EXISTS source     text,
  ADD COLUMN IF NOT EXISTS source_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_attach_source_key
  ON draw_attachments (application_id, source_key)
  WHERE source_key IS NOT NULL;
