-- ============================================================================
-- 172_sitewire_lifecycle.sql — the draw-project LIFECYCLE state on a managed file
--
-- The Draw Coordinator finishes a project ("finish the draw process") or closes it out
-- ("mark paid off") from the Draw-Management desk. That records a PILOT-side lifecycle state on
-- the property link AND (when writes are on) deactivates the property in Sitewire (`inactive=true`)
-- so no further draws can be submitted. A file can be re-opened back to 'active'.
--
-- Only a PILOT-MANAGED file (matched_by='created', a live created property) can carry a non-active
-- lifecycle — go-forward only. Idempotent ALTER; existing links default to 'active'.
-- ============================================================================
ALTER TABLE sitewire_property_links
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'finished', 'paid_off')),
  ADD COLUMN IF NOT EXISTS lifecycle_at   timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_by   uuid,
  -- Was the current lifecycle_state actually pushed to Sitewire (property deactivated/reactivated)? A change
  -- recorded while writes were OFF is 'skipped' → synced=false; a worker backfill (and a manual re-click)
  -- re-drives it once writing is on, so the "no further draws" guarantee actually holds. Default true:
  -- existing links are 'active' and need no Sitewire action.
  ADD COLUMN IF NOT EXISTS lifecycle_synced boolean NOT NULL DEFAULT true;

-- Dashboard filter: "show me the active projects" scans this a lot.
CREATE INDEX IF NOT EXISTS idx_sitewire_links_lifecycle
  ON sitewire_property_links(lifecycle_state)
  WHERE lifecycle_state <> 'active';
