-- ============================================================================
-- 081_borrower_dedup_candidates.sql
--
-- "Possible duplicate — please check" queue. When the inbound ClickUp sync
-- declines to auto-merge two borrowers that share an email but lack a
-- corroborating 2nd identity field (see resolveBorrower / identity
-- .emailMatchCorroborated), it now SAFELY creates a distinct profile — but it
-- also records the pair here so a human is told "these two might be the same
-- person" instead of the split happening silently. Surfaced read-only in the
-- admin ClickUp Control Center; resolving just records the human's verdict (the
-- actual record merge is a separate, deliberate manual step).
--
-- Additive + idempotent: safe to re-run on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS borrower_dedup_candidates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id         uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,   -- the newly-created (possible-duplicate) profile
    matched_borrower_id uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,   -- the existing profile it might duplicate
    reason              text NOT NULL DEFAULT 'shared_email_uncorroborated',
    source_task_id      text,                                                        -- the ClickUp task that triggered it
    status              text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','distinct','duplicate','reviewed')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    resolved_at         timestamptz,
    resolved_by         uuid REFERENCES staff_users(id)
);

-- One open row per (new, existing) pair — makes the recording idempotent so a
-- re-ingest of the same task never piles up duplicate alerts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_borrower_dedup_pair
  ON borrower_dedup_candidates(borrower_id, matched_borrower_id);
CREATE INDEX IF NOT EXISTS idx_borrower_dedup_open
  ON borrower_dedup_candidates(created_at DESC) WHERE status='open';
