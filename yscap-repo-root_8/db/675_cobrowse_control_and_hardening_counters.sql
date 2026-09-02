-- ============================================================================
-- db/675 — CO-BROWSING Phase B (take control) + Phase C (hardening counters).
--
-- Owner-directed 2026-09-02: "Build everything in one big phase." db/674 reserved
-- the three control timestamps; this file adds the STATE the hub keys on and the
-- counters the register needs to say what a session DID — still metadata only,
-- never the screen and never a keystroke.
--
--   control_status          none → requested → granted → released | refused
--                           (a viewer may drive the guest's page ONLY while it
--                           reads 'granted'; the hub re-reads it on every attach).
--   control_grants          how many times control was handed over in this session.
--   control_events          how many input events the viewer sent while in control
--                           (a COUNT — what was clicked or typed is never stored).
--   control_release_reason  who took it back: 'guest_moved' (the watched person
--                           moved their own mouse or typed), 'guest_stop',
--                           'viewer_release', 'request_expired', 'session_ended'.
--   redaction_drops         batches the hub REFUSED to relay because a secret-shaped
--                           value slipped past the browser-side mask (Phase C belt).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the CHECK is added only when absent.
-- BACKFILL: none — every existing row is 'none' / 0, which is the truth about it.
-- ============================================================================

ALTER TABLE cobrowse_sessions ADD COLUMN IF NOT EXISTS control_status          TEXT    NOT NULL DEFAULT 'none';
ALTER TABLE cobrowse_sessions ADD COLUMN IF NOT EXISTS control_grants          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cobrowse_sessions ADD COLUMN IF NOT EXISTS control_events          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cobrowse_sessions ADD COLUMN IF NOT EXISTS control_release_reason  TEXT;
ALTER TABLE cobrowse_sessions ADD COLUMN IF NOT EXISTS redaction_drops         INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrowse_sessions_control_status_chk') THEN
    ALTER TABLE cobrowse_sessions ADD CONSTRAINT cobrowse_sessions_control_status_chk
      CHECK (control_status IN ('none','requested','granted','released','refused'));
  END IF;
END $$;

COMMENT ON COLUMN cobrowse_sessions.control_status IS
  'Take-control state (Phase B): none | requested | granted | released | refused. The viewer may drive the page only while granted.';
COMMENT ON COLUMN cobrowse_sessions.control_events IS
  'Count of input events relayed while control was granted. Metadata only — what was clicked or typed is never stored.';
COMMENT ON COLUMN cobrowse_sessions.redaction_drops IS
  'Batches the hub refused to relay because a secret-shaped value (SSN / card / OTP) slipped past the browser mask.';
