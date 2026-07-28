-- 358_trustpoint_draw_media.sql
-- Idempotent. Owner-directed 2026-07-27: "pull the photos and loop it in directly into our
-- draw so draw 1 should have the pictures of draw 1 and draw 2 the pictures of draw 2 … all
-- the pictures should also be put into our designed PDF report."
--
-- draw_media (db/170) is the durable photo archive the branded draw report embeds from, but
-- it was built for Sitewire only: `sitewire_draw_id bigint NOT NULL`, uniqueness on
-- (sitewire_draw_id, source_key). A TrustPoint draw is identified by a UUID, so its photos
-- had nowhere to live. This widens the SAME table rather than adding a parallel one, so the
-- existing report builder (attachPhotoBytes → doc.addImage) picks TrustPoint photos up with
-- no change to how a report is rendered.
--
-- Why this matters operationally: TrustPoint hands us documents as PRE-SIGNED S3 links that
-- expire in roughly a day (X-Amz-Expires≈86400). Anything not pulled promptly is gone.

ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS trustpoint_draw_id text;

-- The Sitewire id becomes optional — a TrustPoint-administered draw has no numeric id.
-- Existing Sitewire rows are untouched and still carry theirs.
ALTER TABLE draw_media ALTER COLUMN sitewire_draw_id DROP NOT NULL;

-- Exactly one durable copy per (TrustPoint draw, source). Partial so it never collides with
-- the Sitewire uniqueness rule, which stays exactly as db/170 defined it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_media_tp_src
  ON draw_media (trustpoint_draw_id, source_key)
  WHERE trustpoint_draw_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_draw_media_tp ON draw_media (trustpoint_draw_id)
  WHERE trustpoint_draw_id IS NOT NULL;

-- A row must be anchored to exactly one side — never floating, never both.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_draw_media_owner') THEN
    ALTER TABLE draw_media ADD CONSTRAINT chk_draw_media_owner CHECK (
      (sitewire_draw_id IS NOT NULL AND trustpoint_draw_id IS NULL) OR
      (sitewire_draw_id IS NULL     AND trustpoint_draw_id IS NOT NULL)
    );
  END IF;
END $$;

-- Which TrustPoint document each archived item came from, so a re-inspection's second report
-- is traceable to its own photo set rather than blurring into the first (owner-directed: keep
-- BOTH sets, labelled, and show the newest — a revision must be visible, never silent).
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS tp_document_type text;
ALTER TABLE draw_media ADD COLUMN IF NOT EXISTS tp_document_at   timestamptz;
