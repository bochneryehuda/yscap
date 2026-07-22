-- Comments on a loan exception (owner-directed 2026-07-22).
--
-- A staff-only back-and-forth thread on an exception request: the super-admin
-- reviewer and the loan officer who requested it (plus any other staff who chime
-- in) can post comments and reply to each other, each attributed + timestamped.
-- The person who requested the exception is notified when someone comments so
-- they can reply directly on the request.
--
-- Deliberately a small dedicated table (not a chat conversation): the exception
-- thread is internal, has no borrower side, and must not collide with the chat
-- system's one-thread-per-file-per-kind invariant. NEVER borrower-facing.
--
-- Additive + idempotent; go-forward only (no backfill — a days-old feature).

CREATE TABLE IF NOT EXISTS loan_exception_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_exception_id uuid NOT NULL REFERENCES loan_exceptions(id) ON DELETE CASCADE,
  author_staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loan_exc_comments ON loan_exception_comments(loan_exception_id, created_at);
