-- ============================================================================
-- 486 — TPO VIEW ("view as TPO") session register (owner-directed 2026-08-04;
-- TPO blueprint decision 6). db/486.
--
-- An internal account executive / account manager / admin steps INTO one of
-- their brokerage firm's users' logins and sees exactly what that broker sees —
-- the SAME machinery as staff "borrower view" (db/320), only the identity being
-- stepped into is an EXTERNAL staff_users row (a TPO broker) instead of a
-- borrower. So this is one more session register beside borrower_view_sessions,
-- with the same "never silent" contract: one row per view, who stepped in, as
-- which broker, from where, when it started, when it ended and why.
--
-- The impersonator stamp on the two audit trails
-- (request_audit_log.impersonator_staff_id / audit_log.impersonator_staff_id)
-- already exists (db/320) and is surface-agnostic — it records the real human
-- behind ANY impersonation, borrower-view or tpo-view — so this migration adds
-- only the session table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tpo_view_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The INTERNAL staffer who stepped in (an AE / AM / admin). Never external.
  staff_id         uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  -- The EXTERNAL broker (a staff_users row, is_external=true) being viewed.
  tpo_user_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  -- The broker's firm — the unit of trust the whole TPO portal is scoped by.
  tpo_firm_id      uuid NOT NULL REFERENCES tpo_firms(id) ON DELETE CASCADE,
  staff_role       text,                    -- the role the staffer held when they stepped in
  -- The file they entered from, when they used a per-file "View as broker"
  -- button (NULL when they picked the broker from the firm screen).
  application_id   uuid REFERENCES applications(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  -- 'exit' (they clicked "Back to my console") | 'expired' (the absolute cap ran
  -- out) | 'revoked' (staff account deactivated / role changed underneath them)
  -- | 'superseded' (they opened another view)
  end_reason       text,
  request_count    integer NOT NULL DEFAULT 0,
  ip_address       inet,
  user_agent       text
);

CREATE INDEX IF NOT EXISTS idx_tpoview_staff   ON tpo_view_sessions (staff_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpoview_broker  ON tpo_view_sessions (tpo_user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpoview_firm    ON tpo_view_sessions (tpo_firm_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpoview_started ON tpo_view_sessions (started_at DESC);
-- "Which tpo views are live right now" — the one-open-session-per-staffer
-- housekeeping reads this.
CREATE INDEX IF NOT EXISTS idx_tpoview_open    ON tpo_view_sessions (staff_id)
  WHERE ended_at IS NULL;
