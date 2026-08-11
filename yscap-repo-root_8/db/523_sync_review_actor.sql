-- PER-USER ATTRIBUTION on sync-review rows (owner-directed 2026-08-11: "every user
-- should have their OWN manual view of the stuff THEY changed that does not agree with
-- ClickUp"). The row already records who RESOLVED it (resolved_by) but never who CAUSED
-- it. This adds the staff member whose PILOT edit produced the disagreement, recovered
-- from the audit trail at queue time (see src/lib/sync-review.js + inbound-portal-edit-guard.js).
--
-- Additive + idempotent. NULL for an unattributed row — a borrower-door edit, a system
-- heal, or an edit the audit trail can't pinpoint to one person — and the "My changes"
-- view tolerates NULL (it simply won't include those rows). RTL-only infrastructure table.
ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS portal_actor_id uuid REFERENCES staff_users(id);

-- The "my open changes that disagree with ClickUp" lookup: filtered by actor, open only.
CREATE INDEX IF NOT EXISTS idx_sync_review_actor
  ON sync_review_queue(portal_actor_id)
  WHERE portal_actor_id IS NOT NULL AND status = 'open';

-- Supports the queue-aware inbound bounce-back guard (inbound-portal-edit-guard.js), which
-- asks on EVERY inbound pull whether a file has an UNDELIVERED outbound ClickUp push. Without
-- an index on entity_id that lookup would scan sync_queue (mostly 'done' rows) on every pull.
-- Partial so it stays tiny: only the small set of not-yet-delivered ClickUp push jobs.
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending_push
  ON sync_queue (entity_id)
  WHERE target = 'clickup' AND direction = 'push' AND status IN ('queued', 'processing', 'dead');
