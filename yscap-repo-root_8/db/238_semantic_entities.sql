-- 233 — Semantic-entity layer on document extractions (Sovereign,
-- blueprint 2026-07-22). Beyond the schema-driven field extraction, PILOT
-- also scans the document's OCR text for PARTY MENTIONS, MONEY MENTIONS,
-- DATE MENTIONS, and ADDRESS MENTIONS the schema didn't capture — so a
-- guarantor named on page 8 of an operating agreement, an assignment fee
-- referenced in a purchase-contract addendum, or a lien amount buried in
-- title stipulations all become searchable / reasoning-visible facts.
--
-- Additive to the twin — every entity here can later feed the twin as a
-- supplementary observation (via a future promotion step) when the pattern-
-- based extractor evolves to a real NER model or a specialist LLM prompt.
--
-- Idempotent (safe to re-run every boot).

CREATE TABLE IF NOT EXISTS document_entities (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid REFERENCES applications(id) ON DELETE CASCADE,
  document_id              uuid REFERENCES documents(id) ON DELETE CASCADE,
  extraction_id            uuid REFERENCES document_extractions(id) ON DELETE CASCADE,
  entity_type              text NOT NULL
                           CHECK (entity_type IN ('person','entity','money','date',
                                                  'address','license','email','phone','id_number')),
  entity_value             text NOT NULL,          -- normalized form (dashed SSN, ISO date, cents, lowercased name)
  entity_display           text,                   -- friendly form for the UI
  context                  text,                   -- the surrounding sentence / role hint (e.g. "signed by", "notary:", "seller:", "purchase price")
  role_hint                text,                   -- 'signer' | 'notary' | 'seller' | 'buyer' | 'appraiser' | 'guarantor' | ... (may be NULL)
  page_number              integer,
  confidence               numeric,                -- 0-1, per-pattern
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_de_extraction ON document_entities(extraction_id);
CREATE INDEX IF NOT EXISTS idx_de_application ON document_entities(application_id);
CREATE INDEX IF NOT EXISTS idx_de_value ON document_entities(entity_value);
CREATE INDEX IF NOT EXISTS idx_de_type ON document_entities(entity_type);
