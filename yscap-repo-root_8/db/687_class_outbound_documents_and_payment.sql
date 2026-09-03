-- 687 — Class Valuation: documents going OUT to the appraiser, and the money picture.
--
-- Two of the three "AMC has it, Class does not" gaps the owner named on 2026-09-02
-- (the third — a fee before ordering — has no Class endpoint; see src/class/payment.js).
--
-- 1. OUTBOUND DOCUMENTS. `class_attachments` (db/490) was a one-way WORK LIST of what
--    Class announced to us. AppraisalScope's `amc_order_documents` carries a
--    `direction` so the same table records what WE sent up (the scope of work, the
--    purchase contract — pushed automatically on every poll, plus a staff picker).
--    Class's `POST /{orderId}/attachments/{category}` is the upload; this gives it a
--    row to land in. Existing rows are inbound (the default), so nothing that reads
--    the table today changes meaning; the readers themselves are scoped to
--    direction='inbound' in the same change (src/class/documents.js).
--
--    The (order, name) uniqueness stays an INBOUND rule — their retries re-announce
--    the same name — and an outbound row is unique per (order, document) instead,
--    which is what "already sent" means on the picker.
--
-- 2. THE MONEY PICTURE. Class has NO API card charge (their guide: payment is
--    `Invoice` to the account, a hosted `PaymentLink` Class emails the borrower, or
--    `Prepay`; `add-creditcard-payment` only RECORDS a charge taken elsewhere). What
--    the API does give is `GET /orders/{id}/payment-details` — fee, total, paid,
--    outstanding — and the `PaymentLinkSentToBorrower` callback. These columns hold
--    that picture so the desk can show a balance and a "link sent" fact instead of
--    only "paid ✓" after the fact.
ALTER TABLE class_attachments
  ADD COLUMN IF NOT EXISTS direction     text NOT NULL DEFAULT 'inbound',
  ADD COLUMN IF NOT EXISTS category      text,            -- Class's own category (SalesContract, PlansAndSpecs, …)
  ADD COLUMN IF NOT EXISTS uploaded_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uploaded_at   timestamptz,
  ADD COLUMN IF NOT EXISTS upload_error  text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_attachments_direction_check') THEN
    ALTER TABLE class_attachments
      ADD CONSTRAINT class_attachments_direction_check CHECK (direction IN ('inbound', 'outbound'));
  END IF;
END $$;

-- The inbound uniqueness rule, now saying so; the outbound one alongside it.
DROP INDEX IF EXISTS uq_class_attach_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_attach_name
  ON class_attachments (class_order_row, name) WHERE name IS NOT NULL AND direction = 'inbound';
CREATE UNIQUE INDEX IF NOT EXISTS uq_class_attach_outbound_doc
  ON class_attachments (class_order_row, document_id) WHERE direction = 'outbound' AND document_id IS NOT NULL;

ALTER TABLE class_orders
  ADD COLUMN IF NOT EXISTS payment_method          text,          -- Invoice | PaymentLink | Prepay, as sent at order time
  ADD COLUMN IF NOT EXISTS payment_recipient_email text,          -- who Class emailed the payment link to
  ADD COLUMN IF NOT EXISTS payment_link_sent_at    timestamptz,   -- their PaymentLinkSentToBorrower callback
  ADD COLUMN IF NOT EXISTS total_cents             bigint,        -- payment-details.totalAmount
  ADD COLUMN IF NOT EXISTS paid_cents              bigint,        -- payment-details.paidAmount
  ADD COLUMN IF NOT EXISTS outstanding_cents       bigint,        -- payment-details.outstandingBalance
  ADD COLUMN IF NOT EXISTS additional_fees         jsonb,         -- payment-details.additionalFees[]
  ADD COLUMN IF NOT EXISTS payment_checked_at      timestamptz,   -- when payment-details was last read
  ADD COLUMN IF NOT EXISTS payment_recorded_at     timestamptz;   -- when we told Class a card was charged elsewhere
