-- ============================================================================
-- db/665 — the landlord memory points at no RTL table, and losing a person
--          never deletes it
--
-- WHAT THIS FIXES, AND IT IS MINE. db/662 gave `lt_borrower_landlords` two
-- foreign keys, and both break a rule this repository states plainly:
--
--   · `service_contact_id → service_contacts ON DELETE CASCADE` is a LONG-TERM
--     table declaring a database-level reference to a table outside the `lt_*`
--     space. CLAUDE.md rule 4: *"No LT table may reference an RTL table."* The
--     only exceptions are the shared IDENTITY tables — `borrowers` and
--     `staff_users` — and the vendor directory is not one of them.
--   · both were `ON DELETE CASCADE`, so deleting a person or a vendor card
--     silently deleted long-term rows. The long-term schema's rule is the
--     opposite: an identity link is `ON DELETE SET NULL`, because losing a
--     person must never take a loan's records with it.
--
-- db/662's own comment claimed the precedent was `lt_loan_vendors.service_
-- contact_id`, and the precedent is exactly the reverse: that column carries NO
-- foreign key at all. It holds the id and joins to the directory when it reads.
-- Written down here because a wrong precedent quoted in a migration is how the
-- next one gets written the same way.
--
-- WHY DROPPING THE VENDOR KEY COSTS NOTHING. Its stated purpose was that a card
-- somebody deletes in the directory must not leave a memory pointing at nothing.
-- That already holds without it: `landlord-memory.suggestForLoan` INNER JOINs
-- `service_contacts`, so a memory whose card is gone matches nothing and
-- pre-fills nothing. The row is dead weight, not a wrong answer, and a boot pass
-- can tidy it if that ever matters.
--
-- WHY THE BORROWER KEY IS KEPT AND RESHAPED RATHER THAN DROPPED. `borrowers` IS
-- an authorized identity table and every other long-term link to it is a real
-- foreign key (`lt_loans.borrower_id`, `lt_parties.borrower_id`) — so keeping it
-- is the consistent answer. It could not be `SET NULL` while `borrower_id` sat
-- in the primary key, so the key moves to a surrogate `id` with a UNIQUE INDEX
-- on the same pair. The index name is what `ON CONFLICT (borrower_id,
-- address_key)` infers, so `landlord-memory.rememberForLoan` is unchanged.
--
-- A ROW WHOSE BORROWER IS GONE IS HARMLESS: every read is keyed BY borrower, so
-- a NULL matches nothing and pre-fills nothing — the same shape as a memory
-- whose vendor card was deleted.
--
-- ORDERING IS THE MECHANISM. db/662 replays on every boot and its `DO $$` block
-- re-adds both keys whenever they are absent, so this file is numbered ABOVE it
-- and is the final word each boot: 662 re-adds, 665 removes and reshapes. That
-- is the db/374-over-db/177 pattern, and it is why every statement below is
-- guarded and idempotent rather than written once.
--
-- NO DATA MOVES. The table is new in this same unshipped batch; the columns, the
-- values and the uniqueness rule are all exactly what they were.
--
-- PRODUCT SEPARATION: after this file the ONLY table `lt_borrower_landlords`
-- points at is `borrowers`, which is the shared identity zone.
-- ============================================================================

-- ── 1. THE VENDOR KEY GOES. The column stays; the reference does not. ────────
ALTER TABLE lt_borrower_landlords
  DROP CONSTRAINT IF EXISTS lt_borrower_landlords_contact_fkey;

COMMENT ON COLUMN lt_borrower_landlords.service_contact_id IS
  'The landlord''s card in the shared vendor directory. A plain id and NOT a foreign key, exactly like lt_loan_vendors.service_contact_id: a long-term table may not declare a reference to a table outside lt_* (CLAUDE.md rule 4). A card somebody deletes simply stops matching — every read INNER JOINs the directory.';

-- ── 2. THE BORROWER KEY BECOMES SET NULL, which needs a surrogate key ───────
ALTER TABLE lt_borrower_landlords
  DROP CONSTRAINT IF EXISTS lt_borrower_landlords_borrower_fkey;

ALTER TABLE lt_borrower_landlords
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

-- The pair stays unique — as an INDEX, which is what `ON CONFLICT (borrower_id,
-- address_key)` infers, so the writer does not change.
CREATE UNIQUE INDEX IF NOT EXISTS lt_borrower_landlords_pair_uk
  ON lt_borrower_landlords (borrower_id, address_key);

DO $$
BEGIN
  -- Only after the unique index exists, or the pair would be unprotected for
  -- the moment between the two statements.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_landlords_pkey')
     AND EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'lt_borrower_landlords_pair_uk') THEN
    ALTER TABLE lt_borrower_landlords DROP CONSTRAINT lt_borrower_landlords_pkey;
    ALTER TABLE lt_borrower_landlords ADD CONSTRAINT lt_borrower_landlords_pkey PRIMARY KEY (id);
  END IF;

  -- SET NULL needs the column to admit one.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'lt_borrower_landlords' AND column_name = 'borrower_id'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE lt_borrower_landlords ALTER COLUMN borrower_id DROP NOT NULL;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_landlords_borrower_fk') THEN
    ALTER TABLE lt_borrower_landlords
      ADD CONSTRAINT lt_borrower_landlords_borrower_fk
      FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN lt_borrower_landlords.borrower_id IS
  'Whose memory this is. ON DELETE SET NULL, never CASCADE: losing a person must not delete long-term records. A NULL matches nothing and pre-fills nothing, because every read is keyed by borrower.';
