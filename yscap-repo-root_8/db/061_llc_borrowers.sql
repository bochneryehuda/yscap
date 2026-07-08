-- 061_llc_borrowers.sql
-- (#81) Subject vesting LLC owned by MORE THAN ONE borrower.
--
-- The `llcs` table has a single borrower_id + ownership_pct (the one member who
-- is our borrower), and `llc_members` holds the OTHER, non-borrower members. On
-- a co-borrower file the vesting entity is frequently owned by BOTH borrowers,
-- each with their own stake, and the entity must stay linked to both (so a future
-- file of either borrower already knows the LLC). This join table records exactly
-- that: which of OUR borrowers own an LLC, and each one's ownership %.
--
-- Additive only — the existing single-owner columns and verification math are
-- untouched, so nothing regresses. `llcs.borrower_id` remains the primary owner.

CREATE TABLE IF NOT EXISTS llc_borrowers (
  llc_id        uuid NOT NULL REFERENCES llcs(id) ON DELETE CASCADE,
  borrower_id   uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  ownership_pct numeric(5,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (llc_id, borrower_id)
);
CREATE INDEX IF NOT EXISTS idx_llc_borrowers_borrower ON llc_borrowers(borrower_id);

-- Backfill (a): every existing LLC's own borrower is a borrower-owner, carrying
-- their current stake. A track-record LLC therefore stays linked to exactly the
-- borrower whose track record it belongs to.
INSERT INTO llc_borrowers (llc_id, borrower_id, ownership_pct)
SELECT id, borrower_id, ownership_pct FROM llcs
ON CONFLICT (llc_id, borrower_id) DO NOTHING;

-- Backfill (b): where a file with a vesting LLC also has a co-borrower, link the
-- co-borrower to that vesting LLC too (stake to be filled in by staff).
INSERT INTO llc_borrowers (llc_id, borrower_id)
SELECT DISTINCT a.llc_id, a.co_borrower_id
  FROM applications a
 WHERE a.llc_id IS NOT NULL AND a.co_borrower_id IS NOT NULL
ON CONFLICT (llc_id, borrower_id) DO NOTHING;
