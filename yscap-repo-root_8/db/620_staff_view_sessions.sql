-- ============================================================================
-- db/620 — STAFF VIEW: a super-admin steps into a team member's OWN console.
--
-- Owner-directed 2026-08-23: *"When I go to People, basically my team, I can
-- make myself see the screen that they see when they log into long-term view —
-- not only long-term: on this screen I switch from long-term view to short-term
-- view, whatever. I can test that out to see if everybody sees their own files
-- and make sure everything works properly."*
--
-- IT IS THE THIRD SIBLING of borrower_view_sessions and tpo_view_sessions, and
-- copies their architecture on purpose: the viewer is handed a REAL staff token
-- for the target person plus an impersonation envelope, so the SPA runs the
-- actual staff app against the actual permissions and there is no second
-- "preview" implementation to drift. This table is the register of those
-- sessions — who stood in whose console, when, and why it ended — because a
-- power this sharp is only tolerable while every use of it is on the record.
--
-- WHAT MAKES STAFF VIEW STRICTER THAN ITS SIBLINGS, recorded here because the
-- table is where an auditor starts: the session is READ-ONLY (the guard blocks
-- every write while the envelope is present). A borrower view may act because
-- the staffer is guiding a client through the client's own choices; a staffer
-- acting AS ANOTHER STAFFER would write audit rows in the wrong person's name,
-- and there is no honest attribution for that. Looking is the feature. And it
-- is SUPER-ADMIN ONLY to start — the owner's words: "when I'm going on as my
-- super admin".
--
-- IDENTITY ZONE, not a product table: one console spans both products (that is
-- the point — the owner flips the product switch INSIDE the view), so this is
-- deliberately not an lt_* table, exactly as its two siblings are not.
-- ============================================================================

CREATE TABLE IF NOT EXISTS staff_view_sessions (
    id               UUID        NOT NULL DEFAULT gen_random_uuid(),
    -- WHO IS BEING VIEWED — the target of the session.
    staff_id         UUID        NOT NULL,
    -- WHO IS LOOKING — the real human, always a super-admin at mint time.
    viewer_staff_id  UUID        NOT NULL,
    started_at       timestamptz NOT NULL DEFAULT now(),
    last_seen_at     timestamptz,
    ended_at         timestamptz,
    -- 'exited' (the button) | 'expired' (the absolute cap) | 'revoked' (the
    -- viewer's own session died). NULL while the session is live.
    ended_reason     TEXT,
    ip               TEXT,
    user_agent       TEXT,

    CONSTRAINT staff_view_sessions_pkey PRIMARY KEY (id),
    CONSTRAINT staff_view_sessions_not_self_chk CHECK (staff_id <> viewer_staff_id)
);

-- The auditor's two questions: "who has been inside X's console" and "what has
-- Y been looking at" — each answered off its own index, newest first.
CREATE INDEX IF NOT EXISTS staff_view_sessions_target_idx
  ON staff_view_sessions (staff_id, started_at DESC);
CREATE INDEX IF NOT EXISTS staff_view_sessions_viewer_idx
  ON staff_view_sessions (viewer_staff_id, started_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_view_sessions_staff_fkey') THEN
    ALTER TABLE staff_view_sessions ADD CONSTRAINT staff_view_sessions_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_view_sessions_viewer_fkey') THEN
    ALTER TABLE staff_view_sessions ADD CONSTRAINT staff_view_sessions_viewer_fkey
      FOREIGN KEY (viewer_staff_id) REFERENCES staff_users(id) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON TABLE staff_view_sessions IS
  'Every time a super-admin stood inside a team member''s own console (read-only), and how it ended. Sibling of borrower_view_sessions / tpo_view_sessions.';
