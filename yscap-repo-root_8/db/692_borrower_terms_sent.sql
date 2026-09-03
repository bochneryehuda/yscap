-- ============================================================================
-- db/692 — what terms the borrower was LAST TOLD, so the same terms are never
--          announced twice
--
-- WHAT THIS CHANGES, AND WHY. Owner-reported 2026-09-03, RTL: *"processor
-- adjusted the experience from 4 to 3 and borrower received an email that
-- product has been registered. We need to be a little bit more careful about
-- this, because technically, for certain programs, it's not even changing
-- anything … If you didn't re-register the product, why are you getting an
-- email that it was re-registered just because we changed the experience? …
-- if it's fully registered, then yes."*
--
-- Every borrower "your loan terms" email goes through ONE door
-- (`src/lib/terms-notify.js sendBorrowerTerms`), reached from four places (the
-- staff register, the borrower register, an accepted counter-offer, a
-- super-admin approval). Each caller had its own guard against re-announcing
-- unchanged terms, keyed on the PREVIOUS REGISTRATION — and a re-register whose
-- borrower-visible numbers did not move could still slip past one of them (a
-- prior registration with no comparable quote, a program-label change, a door
-- with no guard at all). This table is the door's own memory: the key of the
-- borrower-visible numbers the borrower was last SENT, per file. The door
-- compares against THAT, whatever the caller thinks, and sends only when a
-- number the borrower would notice has actually changed — or when a person
-- explicitly asks for a re-send.
--
-- IDEMPOTENT. CREATE TABLE IF NOT EXISTS.
--
-- BACKFILL: none — there is no record of what earlier emails carried. The
-- first send after this lands writes the row; from then on the rule holds.
-- The door FAILS OPEN when this table cannot be read (it sends, as it always
-- did): a missed suppression is the old behaviour, a wrongly withheld terms
-- email would hide the deal from the borrower.
--
-- PRODUCT SEPARATION. RTL only (`applications`).
-- ============================================================================

CREATE TABLE IF NOT EXISTS borrower_terms_sent (
  application_id  uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  -- The borrower-visible numbers as one string (terms-notify.borrowerSentTermsKey).
  terms_key       text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  send_count      integer NOT NULL DEFAULT 1,
  -- Why the last send went out: 'changed' (a number moved), 'first', 'forced'.
  last_reason     text
);
