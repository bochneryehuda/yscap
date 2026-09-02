-- ============================================================================
-- db/674 — CO-BROWSING: the consent register for "watch my live screen".
--
-- Owner-directed 2026-09-02. Next to the existing "See their view" (which hands a
-- super admin a real token for the other person and needs no consent), a second
-- action: CO-BROWSE — watch a teammate's or a borrower's LIVE screen as they use
-- it, with their cursor, and later (Phase B) drive it. The owner's rules, in
-- their words: co-browsing "should only be able to do it for other users WITH
-- consent"; the super admin "can view as anybody without consent" but co-browse
-- "still needs consent"; team members "do not have the view as feature between
-- themselves, but they have the co-browsing feature as long as it's with
-- consent"; loan officers co-browse their own borrowers with consent.
--
-- WHY A TABLE AND NOT A TOKEN. The three view-as siblings mint an impersonation
-- token because the viewer RUNS the other person's app. Co-browsing runs
-- nothing: the watched person's own browser streams a masked copy of its page
-- to the viewer over a WebSocket, so there is no token to mint — what has to be
-- durable is the CONSENT (asked, accepted or declined, by whom, when) and the
-- session's lifetime, because a power that lets one person watch another's
-- screen is tolerable only while every use of it is on the record.
--
-- WHAT IS DELIBERATELY NOT STORED: the screen. Retention is who / whom / when /
-- what was done (owner-directed 2026-09-02) — the event stream is relayed and
-- discarded; only a batch COUNT is kept so an auditor can tell a 3-second look
-- from a 2-hour session. The control columns exist now so Phase B (take control)
-- adds no schema change; they stay NULL until then.
--
-- IDENTITY ZONE, not a product table (one console spans both products), exactly
-- like borrower_view_sessions / tpo_view_sessions / staff_view_sessions.
-- BACKFILL: none — there is no history to fill; every row is a new session.
-- ============================================================================

CREATE TABLE IF NOT EXISTS cobrowse_sessions (
    id                    UUID        NOT NULL DEFAULT gen_random_uuid(),
    -- WHO IS WATCHING — always an internal staff user.
    viewer_staff_id       UUID        NOT NULL,
    -- WHO IS BEING WATCHED — exactly one of the two ids, matching watched_kind.
    watched_kind          TEXT        NOT NULL,
    watched_staff_id      UUID,
    watched_borrower_id   UUID,
    -- The loan file the viewer came from, when they came from one (register only).
    application_id        UUID,
    -- requested → active | declined | expired ; active → ended
    status                TEXT        NOT NULL DEFAULT 'requested',
    requested_at          timestamptz NOT NULL DEFAULT now(),
    -- The guest's answer. NULL while the request is open.
    responded_at          timestamptz,
    consented_at          timestamptz,
    -- First moment the guest's browser actually connected and began streaming.
    started_at            timestamptz,
    last_seen_at          timestamptz,
    ended_at              timestamptz,
    -- 'stopped_by_guest' | 'stopped_by_viewer' | 'guest_left' | 'viewer_left' |
    -- 'expired' (the absolute cap) | 'request_expired' | 'signed_out' | 'revoked'
    end_reason            TEXT,
    -- Phase B (take control) — reserved, NULL until built.
    control_requested_at  timestamptz,
    control_granted_at    timestamptz,
    control_revoked_at    timestamptz,
    -- Metadata only, never the screen.
    event_batches         INTEGER     NOT NULL DEFAULT 0,
    viewer_ip             TEXT,
    viewer_user_agent     TEXT,

    CONSTRAINT cobrowse_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT cobrowse_sessions_kind_chk CHECK (watched_kind IN ('staff','borrower')),
    CONSTRAINT cobrowse_sessions_status_chk
      CHECK (status IN ('requested','active','declined','expired','ended')),
    CONSTRAINT cobrowse_sessions_target_chk CHECK (
      (watched_kind = 'staff'    AND watched_staff_id IS NOT NULL AND watched_borrower_id IS NULL) OR
      (watched_kind = 'borrower' AND watched_borrower_id IS NOT NULL AND watched_staff_id IS NULL)),
    CONSTRAINT cobrowse_sessions_not_self_chk
      CHECK (watched_staff_id IS NULL OR watched_staff_id <> viewer_staff_id)
);

-- The auditor's questions: "who watched X", "what has Y watched", and the
-- hub's own: "what is live right now".
CREATE INDEX IF NOT EXISTS cobrowse_sessions_viewer_idx
  ON cobrowse_sessions (viewer_staff_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS cobrowse_sessions_watched_staff_idx
  ON cobrowse_sessions (watched_staff_id, requested_at DESC) WHERE watched_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cobrowse_sessions_watched_borrower_idx
  ON cobrowse_sessions (watched_borrower_id, requested_at DESC) WHERE watched_borrower_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cobrowse_sessions_open_idx
  ON cobrowse_sessions (status) WHERE status IN ('requested','active');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrowse_sessions_viewer_fkey') THEN
    ALTER TABLE cobrowse_sessions ADD CONSTRAINT cobrowse_sessions_viewer_fkey
      FOREIGN KEY (viewer_staff_id) REFERENCES staff_users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrowse_sessions_watched_staff_fkey') THEN
    ALTER TABLE cobrowse_sessions ADD CONSTRAINT cobrowse_sessions_watched_staff_fkey
      FOREIGN KEY (watched_staff_id) REFERENCES staff_users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrowse_sessions_watched_borrower_fkey') THEN
    ALTER TABLE cobrowse_sessions ADD CONSTRAINT cobrowse_sessions_watched_borrower_fkey
      FOREIGN KEY (watched_borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrowse_sessions_application_fkey') THEN
    ALTER TABLE cobrowse_sessions ADD CONSTRAINT cobrowse_sessions_application_fkey
      FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE cobrowse_sessions IS
  'Every co-browsing request: who asked to watch whose live screen, whether they consented, and how the session ended. The screen itself is never stored.';
