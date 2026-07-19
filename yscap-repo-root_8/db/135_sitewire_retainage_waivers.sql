-- 135_sitewire_retainage_waivers.sql — retainage/holdback + lien-waiver tracking (roadmap).
-- Idempotent. Off by default: retainage_pct defaults to 0 (no holdback) and lien-waiver gating
-- defaults off, so behavior is unchanged until an admin turns them on. Money is integer cents;
-- nothing is guessed — retainage % and each waiver's status are explicit, admin/staff-entered.

-- ---- retainage: held from each approved draw until completion ----
-- default % (admin-tunable) + optional per-file override; the held amount is recorded per release.
INSERT INTO sitewire_settings (key, value) VALUES ('retainage_pct', '0'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO sitewire_settings (key, value) VALUES ('require_lien_waivers', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS retainage_pct numeric(5,2);   -- NULL = use the global default
ALTER TABLE draw_disbursements   ADD COLUMN IF NOT EXISTS retainage_held_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE draw_disbursements   ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'draw' CHECK (kind IN ('draw','retainage_release'));

-- ---- lien-waiver register (PILOT tracks; Sitewire owns the document bytes) ----
-- The #1 real-world cause of draw delays is a missing/incorrect waiver. We track them per draw
-- and (optionally) GATE the release on the required ones being received/waived — never guessed.
CREATE TABLE IF NOT EXISTS draw_lien_waivers (
  id                   bigserial PRIMARY KEY,
  application_id       uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id     bigint,
  kind                 text NOT NULL DEFAULT 'conditional' CHECK (kind IN ('conditional','unconditional')),
  scope                text NOT NULL DEFAULT 'progress'    CHECK (scope IN ('progress','final')),
  tier                 text NOT NULL DEFAULT 'gc'          CHECK (tier IN ('gc','subcontractor','supplier')),
  party_name           text,
  amount_cents         bigint NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'required'    CHECK (status IN ('required','received','waived','na')),
  document_id          uuid REFERENCES documents(id) ON DELETE SET NULL,
  note                 text,
  received_at          timestamptz,
  created_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lien_waivers_app ON draw_lien_waivers (application_id);
CREATE INDEX IF NOT EXISTS idx_lien_waivers_draw ON draw_lien_waivers (sitewire_draw_id);
