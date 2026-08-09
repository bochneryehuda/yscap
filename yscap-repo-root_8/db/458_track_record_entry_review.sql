-- ============================================================================
-- 458 — A TRACK RECORD SOMEBODY TYPED IS PENDING REVIEW, AND WE RECORD WHO TYPED IT
--       (owner-directed 2026-08-03).
--
-- The owner, on a live file: "The borrower entered his entire track record, and
-- everything came back as verified already. If the borrower is entering the
-- track record, it should go to the processing queue to review the track record
-- that the borrower imported, and this should be pending review. It should not
-- be automatically entered as verified. Anyone that enters the track record
-- first should be pending review till they review it and they provide
-- documentation, then it should go for verified."
--
-- WHAT WAS ACTUALLY WRONG. No write path ever set `is_verified` — every door
-- (borrower, staff, ClickUp, Encompass) inserts the column default, false — so
-- nothing was silently marking a deal verified in the database. What the borrower
-- SAW was the Track Record tool's own headline: it ranks the portfolio
-- ("Experienced", "Seasoned", "Expert") and prints "N of N deals count as
-- qualifying exits" off the deals as TYPED, with no mention anywhere of review.
-- A borrower who has just entered ten deals and is told they are an Expert with
-- ten qualifying exits has been told, in every way that matters to them, that it
-- all went through. The tool's wording is fixed alongside this migration; this
-- file is the part that has to be true in the data.
--
-- TWO COLUMNS, both about WHO SAID SO — the thing the row never recorded:
--
--   entered_by_kind  'borrower' | 'staff' | 'clickup' | 'encompass' | 'system'
--                    Written by every door on create AND on edit, so it always
--                    names whoever last put these figures on the row rather than
--                    whoever first created it. This is what makes a review queue
--                    possible at all: "self-reported, waiting on us" was not a
--                    state the schema could express.
--   entered_at       when that happened. `updated_at` moves for reasons nobody
--                    typed (an address heal, a dedupe re-key, a boot backfill),
--                    so it cannot answer "how long has this been waiting on us".
--
-- NOT A NEW STATUS. `verification_status` already carries pending / docs /
-- verified / limited and `is_verified` already gates every experience count, the
-- sign-off gate and the tier. Adding a second notion of "reviewed" is how two
-- screens end up disagreeing; the queue reads the status that already exists.
--
-- PREVIOUS AND FUTURE. Existing rows get their kind from what they already carry:
-- `origin` names the automated importers exactly (db/082 'clickup_backfill',
-- 'encompass', the funded-file writer), and everything else was typed by a human
-- through the portal. We cannot tell a borrower's typing from a staffer's on a
-- historical row — nobody recorded it — so those are left NULL rather than
-- guessed, and NULL is read as "we don't know who entered this", never as
-- "reviewed". Going forward every door stamps it.
-- ============================================================================

ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS entered_by_kind text,
  ADD COLUMN IF NOT EXISTS entered_at      timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'track_records_entered_by_kind_check'
  ) THEN
    ALTER TABLE track_records ADD CONSTRAINT track_records_entered_by_kind_check
      CHECK (entered_by_kind IS NULL OR entered_by_kind IN
             ('borrower','staff','clickup','encompass','system'));
  END IF;
END $$;

COMMENT ON COLUMN track_records.entered_by_kind IS
  'Who last put these figures on the line — borrower | staff | clickup | encompass | system. NULL on rows that predate db/458 (nobody recorded it; never read as reviewed).';
COMMENT ON COLUMN track_records.entered_at IS
  'When that happened. Separate from updated_at, which moves for automated repairs nobody typed. (db/458)';

-- The importers NAME THEMSELVES in `origin` (db/044). Everything else carries the
-- column default 'portal', which means "a human typed it through the portal" and
-- says nothing about WHICH human — so those rows stay NULL rather than being
-- guessed into a kind the queue would then act on.
UPDATE track_records
   SET entered_by_kind = CASE
         WHEN origin LIKE 'clickup%' THEN 'clickup'
         WHEN origin = 'encompass'   THEN 'encompass'
         ELSE 'system'
       END,
       entered_at = COALESCE(entered_at, created_at)
 WHERE entered_by_kind IS NULL
   AND origin IS NOT NULL
   AND origin NOT IN ('portal', '');

-- The queue reads "self-reported, still pending" — index exactly that.
CREATE INDEX IF NOT EXISTS idx_track_records_pending_review
  ON track_records (borrower_id, entered_at DESC)
  WHERE entered_by_kind = 'borrower' AND is_verified = false;
