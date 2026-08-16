-- ============================================================================
-- HOW IS THIS APPRAISAL BEING PAID FOR? — the recorded instruction
--
-- Owner-directed 2026-08-16: *"We're gonna keep it manual. We're gonna have all
-- the options over there … send the payment link … use the card on file … use the
-- card manually. We should keep all the options open."*
--
-- Payment on an appraisal is a HUMAN decision, every time, by standing rule
-- (2026-08-05, restated above). What was missing was never a charge button — the
-- owner does not want one. It was that nothing recorded WHICH of the three ways a
-- given order was meant to be paid, so a saved card was the entire instruction and
-- "send them a link", "put it on the card on file" and "she is paying it herself"
-- were indistinguishable from the outside. Somebody had to go and ask, per order.
--
-- This is that instruction, written down: one live row per appraisal order saying
-- which way was chosen, by whom, when, and — once it is actually paid — who
-- settled it.
--
-- WHY ITS OWN TABLE RATHER THAN A COLUMN ON EACH ORDER TABLE
--   Three vendors keep three separate order tables (amc_orders, class_orders,
--   rv_orders) by design, and this is one question asked identically of all three.
--   Three columns in three places is three chances for the vocabulary to drift,
--   and the desk reads all three through one projection already.
--
-- WHY NOT ON THE ORDERS-DESK ROW (file_orders)
--   That row is a PROJECTION, rebuilt from the vendors by a single writer
--   (src/lib/appraisal-order-mirror.js). A human's decision must never live in
--   something that is recomputed — the mirror READS this instead and shows it.
--
-- NOTHING HERE CHARGES ANYTHING. A row in this table is a note to a person on
-- the vendors that cannot carry it out, and a record of what was done on the one
-- that can. `settled_at` is only ever set by a human saying it is paid, or by the
-- vendor confirming it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS appraisal_payment_intents (
  id                bigserial PRIMARY KEY,

  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- WHICH appraisal company, and WHICH of their orders. The order id is the
  -- bigint primary key of that vendor's own order table (amc_orders /
  -- class_orders / rv_orders). Deliberately NOT a foreign key: three targets
  -- cannot be one FK, and an instruction outliving a deleted order row is a
  -- harmless orphan that the application_id cascade still cleans up with the file.
  vendor            text   NOT NULL CHECK (vendor IN ('nan', 'class', 'rv')),
  vendor_order_id   bigint NOT NULL,

  -- The owner's three. Kept in step with METHODS in
  -- src/lib/appraisal/payment-options.js — that array is the definition and this
  -- check is the database saying the same thing.
  method            text NOT NULL CHECK (method IN ('PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD')),

  -- WHO decided, so the back office can ask them rather than guess. Nullable and
  -- ON DELETE SET NULL: a departed staffer must not take the instruction with them.
  chosen_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  chosen_at         timestamptz NOT NULL DEFAULT now(),
  note              text,

  -- Did the vendor carry it out when the button was pressed, or is a person still
  -- to do it? Copied from the capability table at the moment of choosing, so the
  -- record says what was TRUE THEN — a vendor switching a payment API on later
  -- must not silently rewrite the history of orders somebody paid by hand.
  performed_by      text NOT NULL DEFAULT 'back_office'
                    CHECK (performed_by IN ('vendor', 'back_office')),

  -- PAID. Set by a human marking it settled, or by the vendor confirming payment.
  settled_at        timestamptz,
  settled_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  settled_note      text,

  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ONE LIVE INSTRUCTION PER ORDER. Changing your mind UPDATES this row rather than
-- stacking a second one — two open instructions on one order is exactly the
-- ambiguity this table exists to remove.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appr_pay_intent_order
  ON appraisal_payment_intents (vendor, vendor_order_id);

-- The desk's own question: what on this file is still waiting to be paid?
CREATE INDEX IF NOT EXISTS ix_appr_pay_intent_app
  ON appraisal_payment_intents (application_id);

-- The back office's question, across every file: what is waiting on ME? Partial,
-- because a settled instruction is history and the unsettled ones are the work.
CREATE INDEX IF NOT EXISTS ix_appr_pay_intent_open
  ON appraisal_payment_intents (chosen_at)
  WHERE settled_at IS NULL AND performed_by = 'back_office';

-- Keep updated_at honest without every writer having to remember.
CREATE OR REPLACE FUNCTION touch_appraisal_payment_intent() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_appr_pay_intent ON appraisal_payment_intents;
CREATE TRIGGER trg_touch_appr_pay_intent
  BEFORE UPDATE ON appraisal_payment_intents
  FOR EACH ROW EXECUTE FUNCTION touch_appraisal_payment_intent();
