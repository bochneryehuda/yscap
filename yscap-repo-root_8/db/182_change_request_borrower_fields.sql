-- Extend the borrower change-request sandbox to PERSONAL identity fields
-- (owner-directed 2026-07-20): after a file is ACCEPTED (a product is registered),
-- the borrower can no longer change ANYTHING on their side directly — not the deal
-- economics (already governed since S5-03) and now not their personal identity
-- either. Every personal edit becomes a pending `change_requests` row the loan team
-- approves before it is written, exactly like the economics fields.
--
-- The original change_requests model only wrote the `applications` table. Personal
-- fields (name / DOB / SSN / phone / FICO / citizenship) live on `borrowers`, so a
-- request now records WHICH table + row it targets:
--   target_table  — 'applications' (economics, the existing behavior) or 'borrowers'
--   target_id     — the borrowers.id for a 'borrowers' request; NULL for an
--                   'applications' request (which uses application_id)
-- SSN is never stored in the clear: for an ssn request `new_value`/`old_value` carry
-- only the MASKED display (•••-••-1234) and the real new value rides ENCRYPTED in
-- new_value_encrypted (applied straight onto borrowers.ssn_encrypted on approval).
--
-- Idempotent. Existing rows default to target_table='applications' / target_id=NULL,
-- so the economics workflow is byte-identical.
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS target_table text NOT NULL DEFAULT 'applications';
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS target_id uuid;
-- bytea (not text): the SSN payload is the raw AES-GCM binary (iv+tag+ciphertext),
-- copied straight onto borrowers.ssn_encrypted (also bytea) on approval — no encoding
-- round-trip, and binary can't sit in a text column ("invalid byte sequence for UTF8").
ALTER TABLE change_requests ADD COLUMN IF NOT EXISTS new_value_encrypted bytea;

DO $$ BEGIN
  ALTER TABLE change_requests
    ADD CONSTRAINT change_requests_target_table_chk CHECK (target_table IN ('applications', 'borrowers'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The pending-supersede lookup now also scopes by target_id so two co-borrowers on
-- the same file editing the SAME personal field don't supersede each other's request.
CREATE INDEX IF NOT EXISTS idx_change_requests_pending_target
  ON change_requests(application_id, field, target_id) WHERE status = 'pending';
