-- Sitewire document-push tracking (the website-upload workaround — no API upload endpoint exists).
-- One row per (file, document slot) records what PILOT uploaded to the Sitewire property's Documents
-- tab: the source document, the bytes' sha256 (so identical bytes are never re-uploaded), the
-- ActiveStorage blob signed_id, and whether the upload was VERIFIED present via the trusted API.
-- Idempotent; re-push updates the row in place. GO-FORWARD ONLY (only managed, PILOT-created props).
CREATE TABLE IF NOT EXISTS sitewire_document_links (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_property_id  text,
  which                 text NOT NULL,        -- 'appraisal_pdf' | 'sow_xlsx' | 'sow_pdf'
  source_document_id    uuid,                 -- our documents row the bytes came from (NULL if generated)
  filename              text NOT NULL,        -- the name we uploaded (used for read-after-write verify)
  sha256                text,                 -- dedup: identical bytes are not re-uploaded unless forced
  signed_id             text,                 -- the ActiveStorage blob signed_id we attached
  status                text NOT NULL DEFAULT 'pending',  -- pending | pushed | verified | failed
  sitewire_document_name text,                -- the doc name confirmed present in the property via the API
  last_error            text,
  pushed_by             uuid,
  pushed_at             timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- One current record per slot per file — re-push updates in place.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sitewire_document_links_app_which
  ON sitewire_document_links (application_id, which);
CREATE INDEX IF NOT EXISTS ix_sitewire_document_links_app
  ON sitewire_document_links (application_id);
