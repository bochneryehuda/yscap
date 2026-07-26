-- ============================================================================
-- 213 — THE WORKFLOW, phase two: automation & aging (owner-directed 2026-07-21).
--
-- Makes the workflow a first-class participant in the whole file instead of a
-- manual overlay:
--   · SLA / due dates per hand-off, so a queue item can read on-time / at-risk /
--     overdue and a scheduled nudge can chase overdue work.
--   · `auto` marks a hand-off the SYSTEM created (e.g. Draw Setup auto-raised the
--     moment a file funds) vs. one a person submitted — so the UI + reporting can
--     tell them apart.
--
-- Idempotent — safe to re-run on every boot. Go-forward (existing live items get
-- no due date until their next submit; that's fine — SLA is a forward promise).
-- ============================================================================

ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS due_at    timestamptz;
ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS sla_hours smallint;
ALTER TABLE workflow_items ADD COLUMN IF NOT EXISTS auto      boolean NOT NULL DEFAULT false;

-- Aging queries scan a recipient's live items by due date.
CREATE INDEX IF NOT EXISTS idx_wf_due
  ON workflow_items(to_staff_id, due_at)
  WHERE status IN ('open','in_progress');
