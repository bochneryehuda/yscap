-- 064 — Internal notes timeline on a borrower (staff CRM).
-- A core CRM feature for the borrower profile hub: staff log a call, a
-- preference, or a heads-up against the person (not a specific file). Author +
-- timestamp captured; staff-only, never borrower-facing.
CREATE TABLE IF NOT EXISTS borrower_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id      uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  author_staff_id  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_borrower_notes_borrower ON borrower_notes(borrower_id, created_at DESC);
