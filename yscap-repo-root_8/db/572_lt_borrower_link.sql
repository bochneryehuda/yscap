-- ============================================================================
-- db/572 — lt borrower link
--
-- WHAT THIS CHANGES, AND WHY.
--
-- `lt_loans.borrower_id` has existed since db/549 and NOTHING HAS EVER WRITTEN
-- IT. Every long-term loan we mirror is therefore attached to no person, so a
-- borrower signing in cannot see their long-term file at all — which is exactly
-- what the owner asked for (2026-08-16): *"We need to make sure we are mapping
-- it to the correct borrower profile so the borrower can also see it on their
-- login."*
--
-- Two things were missing, and this file adds both.
--
--   1. THE FACTS TO MATCH ON. Nothing about the borrower was mirrored — not a
--      name, not an email. Discovery has always READ `Loan.BorrowerName` and
--      thrown it away, and the borrower's email sits on the loan JSON we already
--      fetch. So four columns on `lt_loans`, filled from the read we already do.
--      The email is the one that matters: field 1240
--      (`$.applications[0].borrower.emailAddressText`) is filled on 92.4% of the
--      DSCR cohort per the live field dictionary (772 loans, 2026-08-14).
--
--   2. A PLACE TO RECORD A DECISION. `lt_borrower_links` is the borrower twin of
--      `lt_staff_links` (db/553) and follows the SAME owner-directed rule the
--      staff roster follows — *auto-match by email, a human confirms.* PILOT
--      never adopts a borrower profile on its own.
--
-- WHY THE LINK IS KEYED ON THE EMAIL AND NOT ON THE LOAN. A borrower has many
-- long-term loans, and confirming the same person once per loan across a
-- 500-loan book is not a workflow anybody would finish — so the decision is
-- recorded about the PERSON, exactly as the staff link records a decision about
-- a login id, and every loan carrying that address inherits it. That also makes
-- a REJECTION durable: a match a human turned down never comes back on the next
-- loan, which is the trap the RTL finding-decisions ledger exists to close.
--
-- BACKFILL: NONE, DELIBERATELY. Not one row is linked here. The whole point of
-- the owner's rule is that a person decides, and a migration that guessed 500
-- borrower profiles at once would be the single most damaging thing in this
-- build — a borrower shown somebody else's loan. The columns land empty and the
-- sync fills the FACTS; the LINKS wait for a human.
--
-- PRODUCT SEPARATION. Long-Term only: `lt_loans`, `lt_borrower_links`. The one
-- reference outside the LT zone is `borrowers(id)`, the SHARED IDENTITY record
-- the charter authorizes Long-Term to READ (ledger 2026-08-03, "same login same
-- borrower record"). Nothing here writes a borrower profile.
-- ============================================================================

-- ── 1. The facts the match is made on ───────────────────────────────────────
-- All four are mirrored from Encompass and are never authored here. They exist
-- so an admin can SEE who a loan says its borrower is while deciding, and so the
-- matcher has an address to compare. Name parts are stored separately as well as
-- whole because the pipeline gives one string and the loan gives the parts, and
-- the two disagree in spacing far too often to reconcile after the fact.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS borrower_name TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS borrower_first_name TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS borrower_last_name TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS borrower_email TEXT;

-- The matcher groups the book by address, so this is the index it reads. Stored
-- lowercased by the sync, so no expression index is needed.
CREATE INDEX IF NOT EXISTS lt_loans_borrower_email_idx ON lt_loans (borrower_email);

-- ── 2. The decision ──────────────────────────────────────────────────────────
-- `lt_link_status` ('suggested' | 'confirmed' | 'rejected') already exists from
-- db/553 and is reused deliberately: one vocabulary for "has a human decided
-- this?" across the long-term side.
CREATE TABLE IF NOT EXISTS lt_borrower_links (
    -- The normalised Encompass borrower email. NOT a loan id and NOT a person's
    -- name — see the header.
    encompass_email TEXT NOT NULL,
    -- The SHARED borrower profile this address belongs to. NULL while a row is
    -- only a suggestion, and NULL forever on a rejection.
    borrower_id     UUID,
    status          lt_link_status NOT NULL DEFAULT 'suggested',
    match_method    TEXT,
    -- The name Encompass had on the loan when the link was made. Kept so the
    -- screen can show what was decided even after Encompass is re-read and the
    -- spelling moves.
    encompass_name  TEXT,
    confirmed_by    UUID,
    confirmed_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_borrower_links_pkey PRIMARY KEY (encompass_email)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_links_borrower_id_fkey') THEN
    ALTER TABLE lt_borrower_links ADD CONSTRAINT lt_borrower_links_borrower_id_fkey
      FOREIGN KEY (borrower_id) REFERENCES borrowers (id) ON DELETE SET NULL;
  END IF;
END $$;

-- A CONFIRMED row must name somebody, and a REJECTED row must not. Without this
-- a rejection could carry a borrower id, and the sync — which applies confirmed
-- links by address — would be one typo away from applying a refusal.
ALTER TABLE lt_borrower_links DROP CONSTRAINT IF EXISTS lt_borrower_links_status_chk;
ALTER TABLE lt_borrower_links ADD CONSTRAINT lt_borrower_links_status_chk CHECK (
  (status = 'confirmed' AND borrower_id IS NOT NULL)
  OR (status = 'rejected' AND borrower_id IS NULL)
  OR status = 'suggested'
);

-- DELIBERATELY NOT UNIQUE ON borrower_id. The staff link carries a
-- one-confirmed-link-per-staff-member index because a person has one Encompass
-- login. A borrower legitimately has more than one address — a personal one and
-- an entity one — and both are the same human, so refusing the second would make
-- the true state unrecordable.
CREATE INDEX IF NOT EXISTS lt_borrower_links_borrower_id_idx ON lt_borrower_links (borrower_id);
CREATE INDEX IF NOT EXISTS lt_borrower_links_status_idx ON lt_borrower_links (status);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
