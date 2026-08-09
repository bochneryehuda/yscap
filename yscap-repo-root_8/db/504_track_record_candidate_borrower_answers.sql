-- db/504 — A BORROWER CAN ANSWER A STAGED CANDIDATE, AND WE RECORD THAT IT WAS THEM.
--
-- Phase 8 of the track-record rebuild (blueprint §9.4). db/496 gave the staging
-- area exactly one decider: `decided_by uuid REFERENCES staff_users(id)`. So a
-- borrower confirming their own property had nowhere to be recorded, and the
-- obvious shortcut — writing their id into that column — is a foreign-key
-- violation, which is the schema doing its job.
--
-- ── WHY A BORROWER'S "NO" IS NOT A STAFFER'S "NO" ─────────────────────────
-- db/496's decline is DURABLE ON PURPOSE: the partial unique index only stops a
-- second row while the first is still `staged`, so without a recorded decline
-- the next search raises the property again — the one thing "not this
-- borrower's" exists to prevent. That reasoning was written for a STAFFER, who
-- is looking at the whole file.
--
-- A borrower is answering from memory, at speed, often on a phone, about a
-- property they may have held years ago under a company they barely remember.
-- If their mistaken "not mine" suppressed the property the same way, it would
-- silently cost them experience — and experience sets the tier, and the tier
-- sets the leverage. So the DECIDER IS RECORDED, and the staff queue can tell
-- the two apart and overturn one of them. The suppression still works (the
-- borrower is not re-asked); what changes is that a human on our side can still
-- see it.
--
-- ── decided_by_kind IS BACK-FILLED, NOT DEFAULTED ─────────────────────────
-- Every row that already carries a decision was decided by a staffer, because
-- until this migration there was no other possibility. Stating that explicitly
-- is what lets the staff queue's "who said this?" question be answered for the
-- back book instead of only going forward.

ALTER TABLE track_record_candidates
  ADD COLUMN IF NOT EXISTS decided_by_borrower uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_by_kind      text,
  -- When the borrower was first shown this candidate. Drives "3 of 8" without
  -- making the progress bar depend on a client-side counter.
  ADD COLUMN IF NOT EXISTS borrower_seen_at     timestamptz;

-- A separate guarded statement so a pre-existing row carrying an unexpected
-- value cannot fail the whole boot (the db/493 / db/495 pattern).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trc_decided_by_kind_check') THEN
    ALTER TABLE track_record_candidates
      ADD CONSTRAINT trc_decided_by_kind_check
      CHECK (decided_by_kind IS NULL OR decided_by_kind IN ('staff','borrower')) NOT VALID;
  END IF;
END $$;

/* EXACTLY ONE DECIDER, the `checklist_items.chk_one_owner` discipline applied
   here: a row may name a staffer or a borrower, never both. Without it the two
   columns could disagree with `decided_by_kind` and "who said this property is
   not theirs?" would have two answers. NOT VALID so an existing row can never
   fail a boot; the back-fill below makes it true in practice. */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trc_one_decider_check') THEN
    ALTER TABLE track_record_candidates
      ADD CONSTRAINT trc_one_decider_check
      CHECK (NOT (decided_by IS NOT NULL AND decided_by_borrower IS NOT NULL)) NOT VALID;
  END IF;
END $$;

-- Back-fill: anything already decided was decided by a staffer.
UPDATE track_record_candidates
   SET decided_by_kind = 'staff'
 WHERE decided_by_kind IS NULL
   AND decided_at IS NOT NULL;

/* The staff queue's new question: "what did the borrower say?" — the confirmed
   ones to check and, more importantly, the DECLINED ones to sanity-check, since
   that is the answer that quietly costs them experience if it is wrong. */
CREATE INDEX IF NOT EXISTS idx_trc_borrower_answered
  ON track_record_candidates(borrower_id, status)
  WHERE decided_by_kind = 'borrower';

COMMENT ON COLUMN track_record_candidates.decided_by_borrower IS
  'db/504. The BORROWER who answered this candidate, when it was answered from the borrower portal '
  'rather than the staff queue. Separate from decided_by (a staff_users FK) because the two are not '
  'interchangeable: a borrower answers from memory about their own history, a staffer answers from '
  'the file. Their "not mine" is recorded so a staffer can still see and overturn it.';

COMMENT ON COLUMN track_record_candidates.decided_by_kind IS
  'db/504. staff | borrower — which of the two decider columns is meant. Back-filled to ''staff'' for '
  'every row decided before Phase 8, because until then there was no other possibility.';

COMMENT ON COLUMN track_record_candidates.borrower_seen_at IS
  'db/504. When the borrower was first shown this candidate. The denominator of "3 of 8" comes from '
  'the server, so the progress a borrower sees survives closing the tab.';
