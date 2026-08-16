-- ============================================================================
-- 566_appraisal_payment_charge.sql — THE RECEIPT, AND THE CLAIM THAT STOPS A
-- SECOND CHARGE.
--
-- db/562 recorded WHICH of the ways an appraisal was to be paid; db/563 widened
-- that list. Both were about an INSTRUCTION — on AppraisalScope and Class nothing
-- could actually be charged, so a row said what a person intended to do by hand.
--
-- Owner-directed 2026-08-16: *"I want to be a real vendor charge, yes. I want them
-- to charge the credit card that I'm importing."* AppraisalScope's own payment
-- calls are now built (`PaymentAuthCapture` / `PaymentCapture` / `SendInvoice`,
-- shaped from the vendor's own samples, saved at docs/vendor/appraisalscope/), so
-- pressing the button on a NAN order moves real money.
--
-- That changes what this row has to hold, in two ways.
--
-- 1. THE RECEIPT. A successful charge answers with a
--    `paymentTransactionId`, and that string is the ONLY handle anybody — us, the
--    vendor, the card processor — has for the money afterwards. Not recording it
--    would mean a refund or a dispute starts with a phone call and a guess.
--    `payment_reference` is the other half: OUR OWN identifier for the payment,
--    which we generate and which a later `PaymentCapture` against their PCI vault
--    is addressed to. Without it, a card vaulted today cannot be charged tomorrow.
--
-- 2. THE CLAIM. A charge is the one action in this feature that cannot be undone
--    by pressing the button again — two presses is two charges on a borrower's
--    card. `charge_started_at` is claimed with an `IS NULL`-guarded UPDATE before
--    anything is sent, so a double click, a retried request or two staffers on the
--    same order can only ever have ONE winner. It is RELEASED (set back to NULL)
--    when the send fails outright, because a charge that never reached the vendor
--    must be retryable — but it is deliberately NOT released when the vendor
--    answered anything at all, including an answer we could not read: "we do not
--    know whether that went through" is a question for a human, never a reason to
--    try again automatically.
--
-- `charge_error` is the vendor's own words for the last failure, kept so the desk
-- can say WHY rather than "something went wrong".
--
-- ADDITIVE AND IDEMPOTENT. Every column is nullable with no default, so every
-- existing instruction row is untouched and still means exactly what it meant.
-- Nothing here charges anything; it is where a charge is written down.
-- ============================================================================

ALTER TABLE appraisal_payment_intents
  ADD COLUMN IF NOT EXISTS payment_reference     text,
  ADD COLUMN IF NOT EXISTS vendor_transaction_id text,
  ADD COLUMN IF NOT EXISTS charge_started_at     timestamptz,
  ADD COLUMN IF NOT EXISTS charge_error          text;

-- "Has this order's money already moved?" — asked before every charge, so it is
-- indexed. Partial: a settled receipt is the exception, not the population.
CREATE INDEX IF NOT EXISTS ix_appr_pay_intent_txn
  ON appraisal_payment_intents (vendor_transaction_id)
  WHERE vendor_transaction_id IS NOT NULL;
