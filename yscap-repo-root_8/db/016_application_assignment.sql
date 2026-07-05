-- 016_application_assignment.sql — persist assignment-purchase economics on the
-- application so the assignment document is only required when it actually is an
-- assignment, and staff can see the underlying price + assignment fee. Idempotent.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS is_assignment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS underlying_contract_price numeric(14,2),
  ADD COLUMN IF NOT EXISTS assignment_fee numeric(14,2);

-- The assignment document is now only generated for assignment purchases, so the
-- borrower-facing copy no longer needs the "(if the contract is assigned)" hedge.
UPDATE checklist_templates
   SET borrower_label = 'Assignment contract',
       borrower_hint  = 'Upload the signed assignment of contract for this purchase.'
 WHERE code = 'rtl_p5_assign';
