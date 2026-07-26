-- Reopen an AUTO-CLEARED liquid-assets condition when the co-borrower changes
-- (IG-W5, owner-directed 2026-07-24). Mirror of db/286 (credit) / db/287 (gov-id).
--
-- src/lib/underwriting/assets-autoclear.js may auto-clear the "Bank statements /
-- liquid assets" condition (rtl_p3_assets) once PILOT has AI-read the statements
-- and the borrower's (and verified entity's) accounts provably cover the deal's
-- required liquidity. The set of accounts that COUNT depends on who is on the file
-- (a statement's holder is "tied" only when it matches the borrower / co-borrower /
-- a verified entity). So swapping or removing the co-borrower can change which
-- accounts count — an [auto] clear that verified the OLD set of people must be
-- undone and re-checked. A human sign-off (signed_off_by NOT NULL) is left alone,
-- exactly as the auto-clear never overrode one.
--
-- Structural chokepoint: an AFTER UPDATE trigger on `applications` that fires on
-- ANY path which changes co_borrower_id (portal edit, ClickUp inbound sync,
-- re-register) and reopens the file's auto-cleared assets condition to 'received'.

CREATE OR REPLACE FUNCTION reopen_assets_on_coborrower_change() RETURNS trigger AS $$
BEGIN
  IF NEW.co_borrower_id IS DISTINCT FROM OLD.co_borrower_id THEN
    UPDATE checklist_items ci
       SET status='received',
           signed_off_at=NULL, signed_off_by=NULL,
           reviewed_at=NULL, reviewed_by=NULL,
           notes='[auto] The people on this file changed — re-check the bank statements / liquid assets so the accounts still count for the borrower.',
           updated_at=now()
     WHERE ci.application_id = NEW.id
       AND ci.status='satisfied'
       AND ci.signed_off_by IS NULL
       AND COALESCE(ci.notes,'') LIKE '[auto]%'
       AND ci.template_id = (SELECT id FROM checklist_templates WHERE code='rtl_p3_assets');
  END IF;
  RETURN NULL;  -- AFTER trigger: return value is ignored.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reopen_assets_on_coborrower_change ON applications;
CREATE TRIGGER trg_reopen_assets_on_coborrower_change
  AFTER UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION reopen_assets_on_coborrower_change();
