-- Super-admin Scope-of-Work line-item editing unlock (owner-directed 2026-07-21).
-- Editing a line's wording/description is NOT allowed by default. A SUPER-ADMIN must first UNLOCK
-- the file's SOW line editing (like the structural unlock), then a line's wording (label) + description
-- can be changed — updating the real Scope of Work + regenerating its Excel, and pushing the new WORDING
-- to Sitewire. Idempotent, additive columns only.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sow_edit_unlocked_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sow_edit_unlocked_by uuid;
