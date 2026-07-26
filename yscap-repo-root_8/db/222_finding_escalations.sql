-- Per-finding escalation to the Super-Admin workload + processors / underwriters
-- (owner-directed 2026-07-21, batch Items 7 + 12).
--
-- When PILOT raises an underwriting finding a staffer can't decide (it can't read
-- a value, it can't find the guideline, the option isn't obvious), they no longer
-- have to guess. They ESCALATE the finding to a super-admin, a processor, or an
-- underwriter — creating a WORKLOAD item that carries a direct link to the file, a
-- link to the finding, the finding's full explanation (SNAPSHOT — so it survives
-- even if the finding is later resolved/superseded), and the framed action options.
-- The reviewer picks it up, advises how to proceed, and closes it.
--
-- Mirrors manual_program_escalations (db/207): a durable queue table + one OPEN row
-- per finding (a re-escalation supersedes the prior open one), read by a super-admin
-- review surface. Idempotent — safe to re-run on every boot.

CREATE TABLE IF NOT EXISTS finding_escalations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  finding_id       uuid,                    -- the stored document_findings row (NULL for a derived/computed finding with no row)
  document_id      uuid,
  borrower_id      uuid,
  -- Finding SNAPSHOT — captured at escalation time so the workload item stays
  -- readable even if the underlying finding is later resolved, superseded, or the
  -- document re-analyzed. Never joined back to document_findings for its content.
  code             text,
  severity         text,
  field            text,
  title            text,
  how_to           text,                    -- the finding's plain-language explanation
  doc_value        text,
  file_value       text,
  suggested_actions jsonb,                  -- the framed options (post_condition, request_document, …)
  -- Routing: who the finding was escalated to. target_role is one of
  -- 'super_admin' | 'processor' | 'underwriter'; assigned_to optionally pins it to
  -- ONE specific staffer (route to a particular processor/underwriter).
  target_role      text NOT NULL DEFAULT 'super_admin',
  assigned_to      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'open',   -- 'open' | 'resolved' | 'dismissed'
  question         text,                    -- the escalator's note ("explain the finding / what I need")
  requested_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decision         text,                    -- 'resolved' | 'dismissed'
  decision_note    text,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The workload queue reads by status; the file view reads by application.
CREATE INDEX IF NOT EXISTS finding_escalations_status_idx ON finding_escalations (status, created_at DESC);
CREATE INDEX IF NOT EXISTS finding_escalations_app_idx    ON finding_escalations (application_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS finding_escalations_assignee_idx ON finding_escalations (assigned_to) WHERE status = 'open';

-- At most ONE open escalation per stored finding — a re-escalation of the same
-- finding supersedes the prior open row (mirrors the manual-escalation one-open-
-- per-file rule). A derived finding (finding_id NULL) is not deduped this way
-- (there's no stable row id); the escalator confirms before re-sending.
CREATE UNIQUE INDEX IF NOT EXISTS finding_escalations_one_open_per_finding
  ON finding_escalations (finding_id) WHERE status = 'open' AND finding_id IS NOT NULL;
