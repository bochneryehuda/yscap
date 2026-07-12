-- 083_condition_review.sql — a lighter "reviewed" stamp on first-class loan
-- conditions (audit S3-01, owner-directed 2026-07-12).
--
-- Two-tier control: a LOAN OFFICER may mark a first-class condition REVIEWED
-- ("I looked at it / I believe it's done") but may NOT clear it. CLEARING
-- (signing a condition off, which lets the file advance to funding) stays with
-- processors / underwriters / admins (the sign_off_conditions capability).
-- The review stamp NEVER changes the condition's status — it stays 'open' (a
-- blocker) until a sign-off holder clears or waives it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); new nullable columns, so no backfill.
ALTER TABLE conditions ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE conditions ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
