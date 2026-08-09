-- 468_lead_round_robin.sql
-- Idempotent. Lead-assignment queue — ROUND-ROBIN for inbound leads (#29, owner-directed message-3).
--
-- An inbound marketing lead that carries no officer (no ?lo= branded link) is assigned to the next
-- loan officer in FAIR rotation, so every lead gets an owner instead of sitting unowned on the sales
-- desk. `assigned_via` records HOW a lead got its officer:
--   'lo_link'     — the ?lo= branded link on the marketing page (the officer the visitor came in on)
--   'round_robin' — auto-assigned by the rotation below
--   'manual'      — a human set the owner by hand (a portal invite or a leads-desk officer pick)
-- The rotation counts ONLY its own ('round_robin') assignments, so an officer's ?lo= self-attributed
-- leads never rob them of their fair turn, and the desk can report the split.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_via text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_leads_assigned_via') THEN
    ALTER TABLE leads ADD CONSTRAINT chk_leads_assigned_via
      CHECK (assigned_via IS NULL OR assigned_via IN ('lo_link', 'round_robin', 'manual'));
  END IF;
END $$;

-- Back-fill (previous AND future). Two automatic writers set officer_id BEFORE this feature, and they
-- are told apart by officer_code — the ?lo= branded link is the ONLY path that stores an officer_code
-- (leads.js), while the two manual writers (a portal invite / a leads-desk edit in staff.js) set an
-- officer_id with NO officer_code. So:
--   officer_code present  → the visitor came in on that officer's branded link → 'lo_link'
--   officer_code absent    → a human picked the officer by hand                 → 'manual'
-- A lead with no officer stays NULL. The rotation's own leads already carry assigned_via='round_robin',
-- so the `assigned_via IS NULL` guard skips them and they are never mislabeled.
UPDATE leads SET assigned_via = 'lo_link'
 WHERE officer_id IS NOT NULL AND officer_code IS NOT NULL AND assigned_via IS NULL;
UPDATE leads SET assigned_via = 'manual'
 WHERE officer_id IS NOT NULL AND officer_code IS NULL AND assigned_via IS NULL;

-- The rotation reads each eligible officer's most-recent round-robin lead; this makes that lookup a
-- cheap index scan even as the leads table grows.
CREATE INDEX IF NOT EXISTS idx_leads_rr_rotation
  ON leads (officer_id, created_at DESC) WHERE assigned_via = 'round_robin';
