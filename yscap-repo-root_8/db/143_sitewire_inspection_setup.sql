-- 143_sitewire_inspection_setup.sql — inspection-method policy + coordinator draw-setup.
-- Idempotent. Extends the per-capital-partner/per-program rules so an admin can say, per program:
--   · which method it is AUTOMATICALLY set up as     → inspection_method ('mobile'=virtual / 'traditional'=physical)  [existing]
--   · which methods are ALLOWED (and thus switchable) → allow_virtual / allow_physical (both = coordinator may switch)
--   · the fee for each                                → fee_cents_virtual / fee_cents_physical  [existing]
-- And records the coordinator's per-FILE choice + who/when started the draw setup.

ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS allow_virtual  boolean NOT NULL DEFAULT true;
ALTER TABLE sitewire_inspection_rules ADD COLUMN IF NOT EXISTS allow_physical boolean NOT NULL DEFAULT true;

-- per-file: the coordinator's chosen method (NULL = use the rule's default), and who started setup.
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS inspection_method text
  CHECK (inspection_method IS NULL OR inspection_method IN ('mobile','traditional'));
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS draw_setup_started_at timestamptz;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS draw_setup_started_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
