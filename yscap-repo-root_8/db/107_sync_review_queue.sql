-- ============================================================================
-- 107_sync_review_queue.sql — human review gate for suspicious sync changes
--
-- Owner-directed (2026-07-15 date incident): a cross-system change that looks
-- like corruption must COME UP FOR REVIEW instead of being silently applied or
-- silently dropped. Rows land here from:
--   * outbound: the DOB one-day-shift block (the corruption signature) — the
--     push is refused and queued; an approver applies it deliberately.
--   * inbound: a ClickUp date with an out-of-range year (mid-typing / 2-digit
--     "26" artifacts) — never persisted; queued with the auto-pivoted proposal.
--   * inbound: a ClickUp DOB that DIFFERS from the portal's existing DOB —
--     fill-only semantics drop it; the queue makes the disagreement visible.
-- Approving applies the proposed value through the normal audited write path;
-- rejecting closes the row. Bidirectional sync stays on — this gates only the
-- suspicious cases.
--
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_review_queue (
  id              bigserial PRIMARY KEY,
  application_id  uuid REFERENCES applications(id) ON DELETE SET NULL,
  borrower_id     uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  task_id         text,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  field_key       text NOT NULL,               -- portal column name (e.g. 'date_of_birth')
  current_value   text,                        -- value on the DESTINATION side today
  proposed_value  text,                        -- what the source side wants to write
  raw_value       text,                        -- raw source value (e.g. the bad epoch), for forensics
  reason          text NOT NULL,               -- machine-readable slug + human hint
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES staff_users(id),
  resolved_at     timestamptz,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS idx_sync_review_open ON sync_review_queue(created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_sync_review_app  ON sync_review_queue(application_id);
-- One OPEN row per (task, field, direction, proposal): a sync pass every 5
-- minutes must not spam the queue with duplicates of the same disagreement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_review_open
  ON sync_review_queue(coalesce(task_id,''), field_key, direction, coalesce(proposed_value,''))
  WHERE status = 'open';
