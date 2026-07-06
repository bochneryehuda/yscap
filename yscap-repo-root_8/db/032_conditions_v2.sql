-- =====================================================================
-- 032_conditions_v2.sql
--   (a) Applications: REO experience count + refinance fields (payoff,
--       original purchase price, acquisition date) from the static
--       loan-application logic.
--   (b) Appraisal payment card: the borrower enters the card for the
--       appraisal order as a condition; stored encrypted (AES-256-GCM via
--       the SSN key), decryptable by staff to place the order.
--   (c) New borrower conditions: "Products & pricing" (open until the
--       borrower registers a product) and "Credit card for appraisal".
--   (d) Vendor directory: service_contacts become platform-wide manageable
--       (admin add/edit/delete), so borrower_id becomes optional and rows
--       carry staff attribution + notes.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================

-- (a) refinance + REO fields on the application
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS requested_exp_reo        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payoff_amount            numeric(14,2),
  ADD COLUMN IF NOT EXISTS original_purchase_price  numeric(14,2),
  ADD COLUMN IF NOT EXISTS acquisition_date         date;

-- (b) appraisal payment card (one current card per application)
CREATE TABLE IF NOT EXISTS application_payment_cards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  borrower_id     uuid REFERENCES borrowers(id) ON DELETE CASCADE,
  card_encrypted  text NOT NULL,          -- AES-256-GCM json {number, cvc}
  last4           text,
  brand           text,
  exp_month       integer,
  exp_year        integer,
  billing_zip     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_card_app ON application_payment_cards(application_id);

-- (c) new borrower conditions
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, applies_loan_type,
   role_scope, phase, sort_order, hint, borrower_hint, is_gate, is_milestone, tool_key)
SELECT 'rtl_p1_product',
       'Products & pricing — product registered',
       'Products & pricing — register your product',
       'application', 'both', 'task', 'rtl',
       'loan_officer', '1', 105,
       'Open until a product is registered on the file (Term Sheet Studio)',
       'Price your deal in the Term Sheet Studio and register your product — your terms, cash to close and liquidity requirement all come from it.',
       false, false, 'product_pricing'
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_p1_product');

INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, applies_loan_type,
   role_scope, phase, sort_order, hint, borrower_hint, is_gate, is_milestone, tool_key)
SELECT 'rtl_p1_apprcard',
       'Credit card for appraisal collected',
       'Credit card for the appraisal',
       'application', 'both', 'task', 'rtl',
       'loan_officer', '1', 225,
       'Card the appraisal is ordered on — visible to the team when placing the order',
       'Enter the card we should use to order your appraisal. It is stored encrypted and only used for the appraisal.',
       false, false, 'appraisal_card'
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_p1_apprcard');

-- (d) platform-wide vendor directory on top of service_contacts
ALTER TABLE service_contacts
  ALTER COLUMN borrower_id DROP NOT NULL;
ALTER TABLE service_contacts
  ADD COLUMN IF NOT EXISTS added_by_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes             text;
