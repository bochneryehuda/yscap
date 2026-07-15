-- 105_borrower_owning_officer.sql
-- #98 LO stickiness: make borrowers.primary_officer_id the durable "loan officer
-- of record" for a borrower. The column existed but was orphaned (only a manual
-- CRM edit ever wrote it), so every new application picked its officer fresh and
-- silently fell to Lead Capture, and a returning borrower's 2nd file lost the
-- relationship. Root fix, in two structural pieces that cover EVERY write path:
--   (a) a trigger that ESTABLISHES the owning officer the first time any of the
--       borrower's files is tied to an officer (staff create, borrower app,
--       reassignment, ClickUp inbound — all caught at one definition), and
--   (b) a deterministic idempotent BACKFILL for existing borrowers (previous AND
--       future rule) from their applications' officer of record.
-- The app layer then INHERITS this owner onto new files by default (Apply.jsx
-- prefill + the create paths) so the officer sticks. Idempotent; re-runnable.

-- (a) set-on-first-bind. Stamp the owning officer when a file first gets one and
--     the borrower has none yet. NEVER overwrites an established owner — changing
--     the owner of record is an explicit admin action on the borrower record, not
--     a side effect of assigning a single file. Fires on INSERT and on any change
--     to loan_officer_id (so a Lead-Capture file that later gets assigned an
--     officer establishes the borrower's owner too).
CREATE OR REPLACE FUNCTION trg_set_borrower_owning_officer() RETURNS trigger AS $$
BEGIN
  IF NEW.loan_officer_id IS NOT NULL THEN
    UPDATE borrowers
       SET primary_officer_id = NEW.loan_officer_id, updated_at = now()
     WHERE id = NEW.borrower_id
       AND primary_officer_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_owning_officer ON applications;
CREATE TRIGGER trg_set_owning_officer
  AFTER INSERT OR UPDATE OF loan_officer_id ON applications
  FOR EACH ROW EXECUTE FUNCTION trg_set_borrower_owning_officer();

-- (b) backfill previous borrowers: owner = the officer on their most-recent
--     application that HAS one. Only fills a NULL owner (never disturbs an owner
--     an admin already set). DISTINCT ON picks the newest-by-submit-then-create.
UPDATE borrowers b
   SET primary_officer_id = sub.loan_officer_id, updated_at = now()
  FROM (
    SELECT DISTINCT ON (borrower_id) borrower_id, loan_officer_id
      FROM applications
     WHERE loan_officer_id IS NOT NULL
     ORDER BY borrower_id,
              submitted_at DESC NULLS LAST,
              created_at DESC NULLS LAST
  ) sub
 WHERE b.id = sub.borrower_id
   AND b.primary_officer_id IS NULL;
