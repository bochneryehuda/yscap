-- 148_disbursement_dedup.sql
-- Idempotent. A construction draw is released ONCE. Nothing previously stopped two
-- funded_status='released' draw-disbursement rows for the same Sitewire draw, and because the
-- retainage pool sums retainage_held_cents across every kind='draw' row, a duplicate silently
-- inflated the pool and let the completion payout release more retainage than was ever held.
-- This partial unique index makes a second draw-release ledger row for the same draw impossible
-- (the route also pre-checks and returns a friendly 409). Retainage-release rows (kind='retainage_release')
-- and manual entries with no draw id are excluded. (audit fix, 2026-07-19)
CREATE UNIQUE INDEX IF NOT EXISTS uq_disb_draw
  ON draw_disbursements (sitewire_draw_id)
  WHERE kind = 'draw' AND sitewire_draw_id IS NOT NULL;
