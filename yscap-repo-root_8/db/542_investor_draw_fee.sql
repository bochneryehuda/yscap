-- ============================================================================
-- 542_investor_draw_fee.sql — THE INVESTOR'S CUT OF OUR DRAW FEE, on the money
-- ledger only (owner-directed 2026-08-13).
--
-- THE PROBLEM. Our draw fee ($299 / $250 / $499, per the inspection rule) is the
-- fee that comes out of the borrower's approved draw — and that number is
-- correct everywhere it is shown today: the term sheet, the borrower's screen,
-- the draw emails, the investor delivery. What was missing is what actually
-- REACHES OUR BANK. Some note buyers charge their own fee for handling the
-- release and net it out of ours, so on a CorrFirst file our $299 fee deposits
-- $204, and on a Blue Lake file the $250 fee deposits nothing at all. The owner:
-- "the only change we need to make is to the actual ledger, which is the fee:
-- how much of the fee is actually going to be deposited in our bank account?"
--
-- WHAT THIS ADDS (all additive — no existing column changes meaning, and NOTHING
-- a borrower or a staff member sees on the file itself moves):
--
--   investor_fee_cents  what the note buyer keeps out of OUR fee on this
--                       release. 0 (the default) = they keep nothing, which is
--                       every existing row and every file with no such deal, so
--                       the ledger is byte-identical until somebody records one.
--   net_fee_cents       what is left for us — the deposit. GENERATED, so it can
--                       never drift from `fee_cents - investor_fee_cents`, on an
--                       old row or a new one, whichever path wrote it.
--   investor_fee_key    WHICH hard rule filled it in ('corrfirst' / 'bluelake'),
--                       or NULL when a human typed the figure themselves. The
--                       rates themselves live in ONE place in the code
--                       (src/sitewire/investor-fee.js) — never in this table.
--
-- `fee_cents` KEEPS ITS EXACT MEANING: the fee that comes off the borrower's
-- approved draw. It is what the borrower is charged and what every borrower- and
-- investor-facing surface already prints, so it must not move. The split is a
-- second question about the SAME fee — whose pocket it ends in — which is why
-- the investor's cut is its own column and the net is derived from the two.
--
-- THE CHECK. The investor's cut is part of our fee, so it can never exceed it
-- and can never be negative — a release that claimed otherwise would report a
-- deposit that never arrives. Guarded so re-running on every boot is a no-op.
-- ============================================================================

ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS investor_fee_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS investor_fee_key   text;

-- The deposit. GREATEST(0, …) as well as the CHECK below: a generated column is
-- the one figure nobody can hand-edit into a lie, and it must stay non-negative
-- even if a legacy row ever slipped past the constraint.
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS net_fee_cents bigint
  GENERATED ALWAYS AS (GREATEST(0, fee_cents - investor_fee_cents)) STORED;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='draw_disbursements_investor_fee_within_fee') THEN
    ALTER TABLE draw_disbursements
      ADD CONSTRAINT draw_disbursements_investor_fee_within_fee
      CHECK (investor_fee_cents >= 0 AND investor_fee_cents <= fee_cents);
  END IF;
END $$;

-- "What did each investor keep from us, and what did we actually bank?" is an
-- accounting question asked across files, not per file.
CREATE INDEX IF NOT EXISTS idx_disb_investor_fee ON draw_disbursements (investor_fee_key)
  WHERE investor_fee_cents > 0;
