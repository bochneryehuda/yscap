-- Reopen an AUTO-CLEARED SSN-verification condition when the co-borrower OR the
-- note buyer changes (IG-W4, owner-directed 2026-07-24). Mirror of db/290 (assets),
-- db/287 (gov-id), db/286 (credit).
--
-- src/lib/underwriting/ssn-autoclear.js may auto-clear the "SSN verification"
-- condition (rtl_p1_ssn) — CorrFirst note buyer ONLY — once an imported credit
-- report's SSN provably matches the SSN on file for every borrower. Two file-level
-- changes can undo that verification and must reopen an [auto] clear so it never
-- stands stale:
--   • co_borrower_id — a co-borrower who was added (or swapped) has no matching
--     credit report yet, so the SSN condition no longer covers everyone; and a
--     removed co-borrower changes the covered set too.
--   • lender (the note buyer) — the auto-clear is CorrFirst-specific; if the file
--     moves off CorrFirst the credit-report SSN match is no longer the accepted
--     verification, so the clear must be undone and re-checked by a human.
-- A human sign-off (signed_off_by NOT NULL) is left alone, exactly as the auto-clear
-- never overrode one.
--
-- Structural chokepoint: an AFTER UPDATE trigger on `applications` that fires on ANY
-- path which changes co_borrower_id or lender (portal edit, ClickUp inbound sync,
-- re-register, note-buyer edit) and reopens the file's auto-cleared SSN condition to
-- 'received'.

CREATE OR REPLACE FUNCTION reopen_ssn_on_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id
     OR NEW.lender IS DISTINCT FROM OLD.lender THEN
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The Social Security number needs another look — please re-check it against the credit report on file.',
           updated_at=now()
     WHERE ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%'
       AND ci.template_id = (SELECT id FROM checklist_templates WHERE code='rtl_p1_ssn');
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_ssn_on_change ON applications;
CREATE TRIGGER trg_reopen_ssn_on_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_ssn_on_change();
