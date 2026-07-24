-- 296_trustpoint_money.sql
-- Idempotent. Physical-draw workflow phase 5 (blueprint §5C/D/E — the money mirror).
-- D2: Blue Lake/TrustPoint wires administered draws DIRECTLY; PILOT never moves this
-- money. The ledger row is a MIRROR of an observed release (poll-detected), so the
-- file's money picture (net, fees, dates) stays whole in one place.

-- Which TrustPoint draw a ledger row mirrors (NULL on PILOT's own rows).
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS trustpoint_draw_id text;
-- Who put the row here: 'pilot' = staff recorded a release PILOT is responsible for;
-- 'trustpoint' = observed from the administrator's system and mirrored automatically.
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pilot';
-- The administrator's fee lines, mirrored verbatim for the record (D6/D9 — the $250
-- Blue Lake physical fee is deducted from the net wire and is NOT YS revenue).
ALTER TABLE draw_disbursements ADD COLUMN IF NOT EXISTS fees jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_dd_source') THEN
    ALTER TABLE draw_disbursements ADD CONSTRAINT chk_dd_source CHECK (source IN ('pilot','trustpoint'));
  END IF;
END $$;
-- One mirror row per TrustPoint draw (the insert-once claim behind the single
-- borrower NET email — a poll re-read can never double-record or re-announce).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dd_tp_draw ON draw_disbursements (trustpoint_draw_id)
  WHERE trustpoint_draw_id IS NOT NULL;

-- Fee verification stamp (D6): each administered draw's fee lines are checked ONCE
-- against the rule's agreed per-draw fee; a mismatch alerts staff (the borrower's
-- net wire depends on it). NULL = not yet checked.
ALTER TABLE trustpoint_draws ADD COLUMN IF NOT EXISTS fee_check_at timestamptz;
