-- 136_sitewire_perfile_lien_waivers.sql — per-project lien-waiver toggle.
-- Idempotent. Lien waivers stay OFF everywhere by default; an admin turns them on for a SPECIFIC
-- project (most projects don't use them) via this per-file override, or globally via the setting.
-- NULL = inherit the global `require_lien_waivers` setting (which itself defaults false).
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS require_lien_waivers boolean;
