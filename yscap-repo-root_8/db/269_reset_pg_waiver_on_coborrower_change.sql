-- Reset the co-borrower guaranty waiver whenever the co-borrower CHANGES
-- (owner-directed 2026-07-22; pre-merge-audit fix). The waiver
-- (applications.co_borrower_pg_waived) is a super-admin-APPROVED exception for a
-- SPECIFIC co-borrower. If that co-borrower is later unlinked or replaced with a
-- different person, the waiver must NOT silently transfer to the new/absent
-- co-borrower — otherwise a brand-new co-borrower would render on the term sheet
-- as a non-guarantor "(approved exception)" that was never approved for them.
--
-- Structural chokepoint: a BEFORE UPDATE trigger on `applications` that fires on
-- ANY path which changes co_borrower_id (staff unlink/replace, ClickUp inbound
-- sync, a borrower edit). It resets the flag inline and withdraws any still-open
-- guaranty-waiver request (it named the OLD co-borrower). Full recourse is always
-- preserved — the primary borrower guarantees regardless. Display/record only.
--
-- The approval route only ever updates co_borrower_pg_waived (never co_borrower_id),
-- so IS DISTINCT FROM is false there and the true value it sets persists.

CREATE OR REPLACE FUNCTION reset_pg_waiver_on_coborrower_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id THEN
    IF OLD.co_borrower_pg_waived THEN
      NEW.co_borrower_pg_waived := false;
    END IF;
    -- Withdraw any open guaranty-waiver request for this file (it referenced the
    -- co-borrower who just changed). loan_exceptions has no trigger, so no recursion.
    UPDATE loan_exceptions
       SET status='withdrawn', updated_at=now(),
           decision_note=COALESCE(decision_note, 'Withdrawn — the co-borrower on the file changed')
     WHERE application_id = NEW.id
       AND exception_type = 'guaranty_waiver'
       AND status = 'requested';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reset_pg_waiver_on_coborrower_change ON applications;
CREATE TRIGGER trg_reset_pg_waiver_on_coborrower_change
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reset_pg_waiver_on_coborrower_change();
