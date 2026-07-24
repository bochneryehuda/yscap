-- 297_portal_closeout_claim.sql
-- Idempotent. Phase-4 audit hardening: the historical close-out gets a LEASE claim so
-- overlapping drivers (approval reaction, desk button, reconcile re-drive, writeback
-- sweep) can never double-create the Sitewire draw. A crashed claim self-releases
-- after 10 minutes; the recorded sitewire_draw_id (stamped IMMEDIATELY after the
-- create call) makes every retry a RESUME (finish the transition/ledger), never a
-- second create.
ALTER TABLE portal_draw_requests ADD COLUMN IF NOT EXISTS closeout_claimed_at timestamptz;
