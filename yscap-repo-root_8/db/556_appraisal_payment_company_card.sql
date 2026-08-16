-- 556_appraisal_payment_company_card.sql
--
-- WIDEN THE RECORDED PAYMENT INSTRUCTION TO COVER "PAY WITH OUR OWN CARD".
--
-- db/555 wrote the CHECK from the owner's three ways (2026-08-16): the payment
-- link, the card on file, and a card typed in. On the same day, and from the same
-- owner instruction read from the other end, the Richer Values A-to-Z audit
-- (#1198) added a FOURTH that only exists there -- COMPANY_CARD, the card YS
-- Capital keeps on its own Richer Values account. It is the one card route their
-- Stripe does not refuse, because no card number is ever sent.
--
-- WHY THIS MIGRATION EXISTS AT ALL, AND IT IS NOT TIDINESS. The Richer Values pay
-- route records what a payment was made with, best-effort, so the Orders desk can
-- say how each order was paid:
--
--     lib/appraisal/payment-intent.record({ ..., method })
--
-- With the narrow CHECK, a COMPANY_CARD payment raises 23514 there. That call is
-- deliberately wrapped -- a failed NOTE must never be reported as a failed PAYMENT
-- -- so nothing would break and nothing would be logged to a user: the money would
-- move and the desk would go on showing the order as unpaid, for ever, silently.
-- That is the shape of bug this repository keeps naming: a swallowed error turning
-- a real event into a confident "nothing here".
--
-- WIDENED IN PLACE, UNDER THE CONSTRAINT'S OWN NAME -- the db/527 lesson recorded
-- in CLAUDE.md. Re-adding it under a NEW name would leave db/555's name gone, and
-- any later replay that re-asserted the narrow definition would fail against a
-- COMPANY_CARD row and silently skip whatever followed it in that file. Here the
-- name is Postgres's own for db/555's inline column CHECK.
--
-- NO REPLAY HAZARD FROM db/555 ITSELF: its constraint is inline on a
-- CREATE TABLE IF NOT EXISTS, so once the table exists that statement is skipped
-- whole and the narrow CHECK is never re-added underneath us.
--
-- IDEMPOTENT AND ORDER-INDEPENDENT: it drops whatever definition is there and adds
-- the wide one, so it converges whether it runs before or after any other pass,
-- and re-running it on every boot is a no-op in effect.
--
-- DATA-SAFE: this only ever WIDENS what is allowed, so no existing row can be
-- invalidated by it and the ALTER cannot fail on the back book.

ALTER TABLE appraisal_payment_intents
  DROP CONSTRAINT IF EXISTS appraisal_payment_intents_method_check;

ALTER TABLE appraisal_payment_intents
  ADD CONSTRAINT appraisal_payment_intents_method_check
  CHECK (method IN ('PAYMENT_LINK', 'CARD_ON_FILE', 'NEW_CARD', 'COMPANY_CARD'));
