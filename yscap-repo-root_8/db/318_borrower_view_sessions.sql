-- ============================================================================
-- 318 — BORROWER VIEW (staff "view as borrower") session register + the
-- impersonator stamp on both audit trails (owner-directed 2026-07-26).
--
-- A loan officer / processor / admin can step INTO a borrower's portal and see
-- exactly the screens that borrower sees, so they can walk them through a
-- condition live. That is a real, powerful capability, so it is never silent:
--
--   • `borrower_view_sessions` — one row per "view as" session: who stepped in,
--     as whom, from where, when it started, when it ended and why. This is the
--     human-readable register an admin reviews ("who looked at whose portal").
--
--   • `request_audit_log.impersonator_staff_id` / `.impersonator_role` — the
--     request firehose already records one row per HTTP call; while a borrower
--     view is active the row ALSO carries the real human behind it, so every
--     click made inside a borrower's portal is attributable. Without this the
--     firehose would record the BORROWER as the actor for a staffer's clicks.
--
--   • `audit_log.impersonator_staff_id` — the same stamp on the semantic
--     (GLBA/PII business action) trail, for the same reason.
--
-- All three additions are additive + nullable, so every existing row and every
-- ordinary (non-impersonated) request is completely unchanged.
-- ============================================================================

CREATE TABLE IF NOT EXISTS borrower_view_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  borrower_id      uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  staff_role       text,                    -- the role the staffer held when they stepped in
  -- The file they entered from, when they used the "Borrower view" button on a
  -- loan file (NULL when they picked the borrower from the Borrower view screen).
  application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  -- 'exit' (they clicked "Back to my console") | 'expired' (the absolute cap ran
  -- out) | 'revoked' (staff account deactivated / role changed underneath them)
  end_reason       text,
  request_count    integer NOT NULL DEFAULT 0,
  ip_address       inet,
  user_agent       text
);

CREATE INDEX IF NOT EXISTS idx_bview_staff    ON borrower_view_sessions (staff_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bview_borrower ON borrower_view_sessions (borrower_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bview_started  ON borrower_view_sessions (started_at DESC);
-- "Which borrower views are live right now" — the admin monitor + the
-- one-open-session-per-staffer housekeeping both read this.
CREATE INDEX IF NOT EXISTS idx_bview_open     ON borrower_view_sessions (staff_id)
  WHERE ended_at IS NULL;

-- The impersonator stamp on the automatic request firehose.
ALTER TABLE request_audit_log ADD COLUMN IF NOT EXISTS impersonator_staff_id uuid;
ALTER TABLE request_audit_log ADD COLUMN IF NOT EXISTS impersonator_role     text;
CREATE INDEX IF NOT EXISTS idx_req_audit_impersonator
  ON request_audit_log (impersonator_staff_id, at DESC)
  WHERE impersonator_staff_id IS NOT NULL;

-- The same stamp on the semantic business-action trail. Deliberately NOT a FK:
-- audit rows must survive a staff row being removed.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS impersonator_staff_id uuid;
CREATE INDEX IF NOT EXISTS idx_audit_impersonator
  ON audit_log (impersonator_staff_id, created_at DESC)
  WHERE impersonator_staff_id IS NOT NULL;
