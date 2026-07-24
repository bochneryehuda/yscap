-- Reopen an AUTO-CLEARED credit condition when the co-borrower changes
-- (IG-W2, owner-directed 2026-07-24).
--
-- src/lib/credit/completeness.js may auto-clear the "Credit report" condition
-- (rtl_cond_credit) once every borrower it covers has a report + PDF on file. If
-- the co-borrower is later replaced or unlinked, that auto-clear stood in for a
-- borrower who is no longer (or differently) on the file — the NEW co-borrower's
-- credit was never imported, so the condition must not stay satisfied.
--
-- Structural chokepoint: an AFTER UPDATE trigger on `applications` that fires on
-- ANY path which changes co_borrower_id (staff unlink/replace, ClickUp inbound
-- sync, a borrower edit) and reopens the file's credit condition(s) to 'received'.
--
-- SCOPE: only conditions we cleared OURSELVES are reopened — status='satisfied'
-- with signed_off_by IS NULL and an '[auto]' note. A credit condition a human
-- signed off is left untouched (their attestation is theirs to revisit), exactly
-- as the auto-clear never overrode a human sign-off in the first place. The
-- reopen mirrors checklist-evidence.reopenConditionEvidence (clears the sign-off
-- stamps) and leaves a fresh '[auto]' note.

CREATE OR REPLACE FUNCTION reopen_credit_on_coborrower_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id THEN
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The co-borrower on the file changed — re-import credit so every borrower''s report is on file.',
           updated_at=now()
      FROM checklist_templates t
     WHERE t.id = ci.template_id AND t.code='rtl_cond_credit'
       AND ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%';
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_credit_on_coborrower_change ON applications;
CREATE TRIGGER trg_reopen_credit_on_coborrower_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_credit_on_coborrower_change();
