-- 225_esign_lo_role.sql — allow the loan-officer role on esign_recipients so the
-- term-sheet package can seat the LO as a signer at routingOrder 1 alongside the
-- borrower(s) (owner-directed 2026-07-21).
--
-- The original constraint (db/140_esign_recipients.sql:40) whitelisted only
-- ('borrower','co_borrower','admin'), so every INSERT the new LO flow tries —
-- both the initial seed in createOrClaimEnvelope and the late splice in
-- buildDefinition — was rejected by the check-violation, which meant no
-- term-sheet envelope could send on a file with an assigned loan officer.
-- Widen the allow-list to include 'loan_officer'. Idempotent: drops the old
-- constraint if present and re-adds under the same name.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_esign_recipient_role'
  ) THEN
    ALTER TABLE esign_recipients DROP CONSTRAINT chk_esign_recipient_role;
  END IF;
  ALTER TABLE esign_recipients
    ADD CONSTRAINT chk_esign_recipient_role
    CHECK (role IN ('borrower','co_borrower','loan_officer','admin'));
END$$;
