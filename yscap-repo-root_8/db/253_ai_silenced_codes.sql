-- R4.8 — Portfolio-wide mute list for AI finding codes.
--
-- When a specific evidence.code (e.g. 'identity_name_variation' or a promoted
-- rule code) turns out to be a chronic false positive, a super_admin can MUTE
-- it portfolio-wide via /api/admin/insights/silenced-codes. Once muted, every
-- future ai_suggestions.record() call whose evidence.code is on the mute list
-- IS DROPPED SILENTLY. The record still counts toward AI cost telemetry
-- (already spent) but never lands on any file view or the AI Findings panel.
--
-- Belt-and-suspenders per HARD RULE — this is a super_admin escape hatch, not
-- an automatic silencer. A code must be explicitly added. Removing it lets
-- future finds surface again.

CREATE TABLE IF NOT EXISTS ai_silenced_codes (
  code            text PRIMARY KEY,
  reason          text NOT NULL,
  silenced_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  silenced_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_silenced_codes_at
  ON ai_silenced_codes (silenced_at DESC);
