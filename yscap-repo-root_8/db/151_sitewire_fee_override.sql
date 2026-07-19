-- 151_sitewire_fee_override.sql
-- Idempotent. A per-file DRAW FEE the coordinator can set on the "Start the draw process" screen,
-- overriding the rule's fee for THIS file only (integer cents). NULL = use the rule's fee (the normal
-- case). The coordinator may change the fee unless a rule forbids the chosen method — the method's
-- allow flags still gate what they can pick; the fee itself is a free amount they own per file.
-- (owner-directed 2026-07-19)
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS fee_cents_override bigint;
