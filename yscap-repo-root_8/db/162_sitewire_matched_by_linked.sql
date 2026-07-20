-- 162_sitewire_matched_by_linked.sql
-- Owner-directed 2026-07-20: allow a HUMAN-CONFIRMED link/adopt of an existing Sitewire property.
--
-- The "only-ours" rule stays: PILOT auto-creates + auto-tracks only what it made (matched_by='created'),
-- and NEVER silently/automatically adopts the pre-existing hand-entered Sitewire back-catalog. But when a
-- loan-number collision is a GENUINE same-property match (same loan number AND same address), a coordinator
-- may explicitly LINK the file to that existing Sitewire property via the Sync-review "Link" action. Such a
-- row is recorded with matched_by='linked'. This migration widens the CHECK to permit that value and adds a
-- small audit trail (who linked it, when). Idempotent.

ALTER TABLE sitewire_property_links DROP CONSTRAINT IF EXISTS sitewire_property_links_matched_by_check;
ALTER TABLE sitewire_property_links
  ADD CONSTRAINT sitewire_property_links_matched_by_check
  CHECK (matched_by IN ('created', 'manual', 'linked'));

ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS linked_by uuid;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS linked_at timestamptz;
