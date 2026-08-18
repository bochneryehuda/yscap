-- ============================================================================
-- db/577 — ITEMIZED CLOSING COSTS + the RATE-AND-TERM $2,000 CASH LIMIT'S
--          exception type (owner-directed 2026-08-18).
--
-- The owner: "You can't get more than $2,000 back in your pocket [on a
-- rate-and-term] … the initial loan amount cannot be more than $2,000 more than
-- the payoff and all the closing costs … A lot of times, the system is not
-- getting the closing costs correctly. If you're bringing up the closing costs,
-- then it's less cash to the borrower … we can add title fees over there … and
-- we should also be able to enter custom title fees, mortgage tax, transfer
-- tax, and other types of closing costs … He's going to pay attorney fees,
-- which will bring up his closing costs and bring down his cash to close. It
-- should still be possible to be a rate-and-term. You can always request an
-- exception from super admin … I don't want to block without a way out."
--
-- (1) closing_cost_items — the itemized closing-statement fees a staffer types
--     ("Validate closing costs"). They ADD to the registered quote's own
--     dueAtClosing figure in src/lib/rate-term-gate.js, reducing the computed
--     cash-to-borrower; the frozen engines are untouched (this is a layered
--     read, never a pricing input).
-- (2) the 'rate_term_cash' loan-exception type — the recorded way past the
--     term-sheet send gate when a super-admin approves the over-$2,000
--     rate-and-term anyway. The CHECK re-add follows the db/470 discipline:
--     re-asserted under its OWN constraint name, naming EVERY type every
--     lower-numbered file added, because those files replay each boot and a
--     narrower list would roll this one back the moment a row uses the value.
--
-- BACKFILL: none — the table starts empty (fees are typed per file as needed)
-- and the exception type has no historical rows to migrate.
-- ============================================================================

CREATE TABLE IF NOT EXISTS closing_cost_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- the fee's CATEGORY (a fixed list so reporting can group them; 'custom' for
  -- anything else, with the label carrying the name)
  kind           text NOT NULL DEFAULT 'custom' CHECK (kind IN
                   ('title_fee','mortgage_tax','transfer_tax','attorney_fee',
                    'recording_fee','escrow_fee','survey_fee','custom')),
  label          text NOT NULL,
  amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
  note           text,
  created_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_cost_items_app ON closing_cost_items(application_id);

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab','tape_encompass_override',
     'encompass_mismatch','credit_import_waiver','condition_waiver','rate_term_cash'));
