-- ============================================================================
-- db/662 — the landlord a borrower had, remembered against the HOME
--
-- WHAT THIS CHANGES, AND WHY. Owner-directed 2026-08-31:
--
--   *"We need to make the landlord contact information also be saved directly to
--   the borrower's profile for next time to pre-fill. As long as he is still
--   living at the same primary address — if his primary address has been updated
--   in Encompass, then you should not automatically populate his landlord,
--   because probably the landlord changed. Add this logic."*
--
-- HALF OF THIS ALREADY EXISTED and is not rebuilt here. A landlord card created
-- on a long-term file is written as a `service_contacts` row carrying the
-- borrower's id, so it is already on their profile and already offered in the
-- type-ahead on their next file. What did not exist is the only fact that makes
-- a landlord safe to fill in BY ITSELF: which home they are the landlord of.
--
-- A person who moves keeps their profile and gets a new landlord. A memory keyed
-- on the person alone would post a verification of rent to their last landlord
-- asking about an address that landlord has never heard of — and it comes back
-- as evidence on a loan. So the key is (borrower, the address they were
-- renting), and the owner's rule falls out of the key rather than out of a check
-- somebody has to remember to write: a moved borrower produces a different key
-- and matches nothing. There is deliberately no "has the address changed?" test
-- anywhere in this feature.
--
-- `address_key` is computed by `src/longterm/landlord-memory.js` and is stored
-- rather than derived in SQL for the reason this repo has been bitten by twice
-- (`pilot_term_norm`, `pilot_property_type_norm`): a PL/pgSQL twin of a
-- normalizer drifts from the live one, and the copy that drifts is the one that
-- decides. The readable form is kept beside it so a screen can name the home
-- instead of showing a key.
--
-- ONE LANDLORD PER (BORROWER, HOME). A borrower whose building changes managing
-- agent has a NEW landlord at the SAME address, and the newest answer is the
-- right one — so the primary key is the pair and a later record replaces.
--
-- NO BACKFILL IN SQL, DELIBERATELY. What is worth remembering is every landlord
-- already linked to a long-term loan, keyed by that loan's own current residence
-- — and both halves of that are the JavaScript normalizer's to decide. The boot
-- pass `landlord-memory.backfillOnce` does it, bounded and idempotent, so the
-- rule has exactly one definition.
--
-- PRODUCT SEPARATION. `lt_*` only. `borrower_id` and `service_contact_id` point
-- at the SHARED identity and vendor-directory rows every long-term table already
-- points at (`lt_loans.borrower_id`, `lt_loan_vendors.service_contact_id`);
-- nothing here reaches an RTL product table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_borrower_landlords (
    borrower_id        UUID NOT NULL,
    address_key        TEXT NOT NULL,
    service_contact_id UUID NOT NULL,
    address_text       TEXT,
    last_loan_id       UUID,
    first_seen_at      timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_borrower_landlords_pkey PRIMARY KEY (borrower_id, address_key)
);

COMMENT ON TABLE lt_borrower_landlords IS
  'The landlord a borrower had AT ONE ADDRESS. Keyed on the pair so a borrower who moves matches nothing and is never pre-filled with their old landlord (owner-directed 2026-08-31). address_key is computed by src/longterm/landlord-memory.js.';
COMMENT ON COLUMN lt_borrower_landlords.address_key IS
  'The normalized home this landlord belongs to. Written by landlord-memory.addressKey — never re-derived in SQL, or the two definitions drift and the copy that drifts is the one that decides.';
COMMENT ON COLUMN lt_borrower_landlords.address_text IS
  'The same address as a person writes it, so a screen can say WHICH home rather than show a key.';

-- The card is the shared directory's, and a card a human deletes there must not
-- leave a memory pointing at nothing: the row goes with it, and the borrower is
-- simply asked for their landlord again. (The sibling `lt_loan_vendors`
-- deliberately has NO such key, and that is not an inconsistency: a LOAN's record
-- of who it sent to must survive the card, so the desk can say "the company on
-- this file is no longer in the directory". A MEMORY of a deleted card has no
-- such value — it can only ever pre-fill something that is not there.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_landlords_contact_fkey') THEN
    ALTER TABLE lt_borrower_landlords
      ADD CONSTRAINT lt_borrower_landlords_contact_fkey
      FOREIGN KEY (service_contact_id) REFERENCES service_contacts(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_landlords_borrower_fkey') THEN
    ALTER TABLE lt_borrower_landlords
      ADD CONSTRAINT lt_borrower_landlords_borrower_fkey
      FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lt_borrower_landlords_contact_idx
  ON lt_borrower_landlords (service_contact_id);

-- ── THE SWEEP'S DRAIN ────────────────────────────────────────────────────────
-- The boot pass has to know which landlord links it has already considered, and
-- the memory rows cannot tell it: two loans for one borrower at one address share
-- ONE memory row, so a "has this loan written a row?" test re-selects the first
-- loan for ever once the second one overwrites it — a pass that never empties.
-- Stamping the LINK is the drain, and it is stamped on a real answer only
-- (including "this loan has no renting borrower", which IS an answer); a pass
-- that failed to read leaves it NULL and is retried, so one bad minute cannot
-- drop a real landlord out of the sweep for good.
ALTER TABLE lt_loan_vendors ADD COLUMN IF NOT EXISTS remembered_at timestamptz;

COMMENT ON COLUMN lt_loan_vendors.remembered_at IS
  'When the landlord-memory sweep last considered this link (src/longterm/landlord-memory.js). NULL = not yet considered. Nothing but that sweep reads it.';

CREATE INDEX IF NOT EXISTS lt_loan_vendors_landlord_unremembered_idx
  ON lt_loan_vendors (loan_id) WHERE kind = 'landlord' AND remembered_at IS NULL;
