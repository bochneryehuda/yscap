-- Durable inspector media (Draw Management phase 2a, owner-directed 2026-07-20).
--
-- Sitewire serves inspection photos/videos (and the per-draw PDF) as public, PRE-SIGNED, EXPIRING URLs
-- (draw_finding_lines.media[].src, sitewire_draws.pdf_src) — rendered raw in the browser today, so a
-- report or gallery built on them breaks when the link expires. This table records each media item PILOT
-- has pulled into its OWN durable storage (via src/lib/storage.js — storage_ref), so the branded reports
-- and the staff gallery never depend on a third-party URL. Photos are stored as durable BLOBS (not a
-- `documents` row) on purpose: a per-photo documents row would flood the file's SharePoint folder and the
-- borrower doc library. Only the generated branded REPORT (phase 2b) becomes a documents row.
CREATE TABLE IF NOT EXISTS draw_media (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id      bigint NOT NULL,
  sitewire_request_id   bigint,                 -- the draw line this media belongs to (null for the draw PDF)
  sow_line_key          text,
  kind                  text NOT NULL CHECK (kind IN ('image', 'video', 'draw_pdf')),
  source_url            text NOT NULL,          -- the original (expiring) Sitewire URL we pulled from
  source_key            text NOT NULL,          -- sha256(source_url) — the dedup/unique key (URLs can be long)
  storage_provider      text,                   -- from storage.save (local/s3/sharepoint)
  storage_ref           text,                   -- the durable ref to stream back
  content_type          text,
  bytes                 integer,
  sha256                text,                    -- of the stored bytes (integrity / cross-item dedup)
  captured_at           timestamptz,
  lat                   double precision,
  lng                   double precision,
  note                  text,
  archived_at           timestamptz NOT NULL DEFAULT now()
);
-- One durable copy per (draw, source URL). Re-archiving a draw is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_media_src ON draw_media (sitewire_draw_id, source_key);
CREATE INDEX IF NOT EXISTS idx_draw_media_app ON draw_media (application_id);
CREATE INDEX IF NOT EXISTS idx_draw_media_draw ON draw_media (sitewire_draw_id);
