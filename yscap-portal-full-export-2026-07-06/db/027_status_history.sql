-- =====================================================================
-- 027_status_history.sql — record every loan status transition so the file
-- has a real timeline (borrower-facing milestones + staff audit of who moved
-- it and whether the move was a forced override). The audit_log still records
-- the change for the internal trail; this table is the queryable timeline.
-- Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS application_status_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status     text,
  to_status       text NOT NULL,
  changed_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  forced          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_history_app ON application_status_history(application_id, created_at);
