-- 360_trustpoint_draw_comments.sql
-- Idempotent. Owner-directed 2026-07-27: "if you can bring into our system that we should also be
-- able to see the real messages in our system related to each and every draw — all the messages
-- going back and forth."
--
-- The draw administrator and our coordinator hold a real conversation on each draw inside
-- TrustPoint ("Please update the ZIP code, it is missing a 0 and the draw request has failed" →
-- "Working on fixing this. Once ready I will get the Trinity inspection ordered." → "Inspection has
-- been ordered."). None of it was visible in PILOT, so the draw desk could see WHAT a draw was
-- doing but never WHY — and the answer to "why is this draw stuck?" lived in another system.
--
-- Mirrored READ-ONLY, exactly like the draws and service orders. PILOT never posts a comment back
-- (the public API's comment endpoints are reads for us; a reply belongs in TrustPoint where the
-- administrator will actually see it).

CREATE TABLE IF NOT EXISTS trustpoint_draw_comments (
  tp_comment_id     text PRIMARY KEY,
  application_id    uuid REFERENCES applications(id) ON DELETE CASCADE,
  tp_project_id     text,
  tp_draw_id        text,
  parent_id         text,                    -- a reply threads under its parent comment
  author            text,                    -- display name when TrustPoint supplies one
  body              text,                    -- plain text, HTML stripped on the way in
  tags              jsonb,                   -- e.g. ["Draw #2"]
  is_pinned         boolean NOT NULL DEFAULT false,
  commented_at      timestamptz,             -- TrustPoint's own created_at
  edited_at         timestamptz,
  raw               jsonb,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpdc_app  ON trustpoint_draw_comments (application_id, commented_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpdc_draw ON trustpoint_draw_comments (tp_draw_id, commented_at);
