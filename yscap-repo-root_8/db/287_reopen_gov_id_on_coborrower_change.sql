-- Reopen an AUTO-CLEARED government-ID condition when the co-borrower changes
-- (IG-W3, owner-directed 2026-07-24). Mirror of db/286 for credit.
--
-- src/lib/underwriting/gov-id-autoclear.js may auto-clear a "Government-issued ID"
-- condition once PILOT has AI-read the ID on the file and it checks out. The
-- co-borrower's ID condition is an application-scoped item marked
-- field_key='cob_gov_id' (src/lib/co-borrower.js) that is RENAMED in place when the
-- co-borrower is swapped — so an auto-cleared cob_gov_id item would otherwise keep
-- standing for a DIFFERENT person whose ID was never verified. The file-level
-- rtl_p1_id item can likewise cover the co-borrower (when no cob_gov_id item
-- exists). Either way, a co-borrower change must undo an auto-clear that verified
-- the OLD person.
--
-- Structural chokepoint: an AFTER UPDATE trigger on `applications` that fires on
-- ANY path which changes co_borrower_id and reopens the file's gov-ID condition(s)
-- to 'received'. SCOPE: only conditions we cleared OURSELVES are reopened —
-- status='satisfied' with signed_off_by IS NULL and an '[auto]' note. A human
-- sign-off is left untouched (exactly as the auto-clear never overrode one).

CREATE OR REPLACE FUNCTION reopen_gov_id_on_coborrower_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id THEN
    -- cob_gov_id items carry no template_id (co-borrower.js inserts them directly),
    -- so match them by field_key; the file-level item by the rtl_p1_id template.
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The people on this file changed — re-check the government ID(s) so each one is verified.',
           updated_at=now()
     WHERE ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%'
       AND (
         ci.field_key='cob_gov_id'
         OR ci.template_id = (SELECT id FROM checklist_templates WHERE code='rtl_p1_id')
       );
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_gov_id_on_coborrower_change ON applications;
CREATE TRIGGER trg_reopen_gov_id_on_coborrower_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_gov_id_on_coborrower_change();
