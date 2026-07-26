-- 217 — Runtime integration flags (the "working switches" behind the API Health page).
--
-- Each on/off switch on the API Health page (Sitewire writing, ClickUp sync, the
-- document mirror, e-sign sending, the flood check, …) is an env var read at boot
-- today, so changing it needs a redeploy. This table holds a runtime OVERRIDE per
-- switch: when a row exists, it wins over the env default; when it doesn't, the env
-- value is used (so behavior is unchanged until an admin flips something).
--
-- The app reads these through src/lib/flags.js (cached, env-seeded). Toggles are
-- admin-only, confirmed for dangerous ones, and audited. Idempotent create.
CREATE TABLE IF NOT EXISTS integration_flags (
  key         text PRIMARY KEY,          -- the env var name, e.g. 'SITEWIRE_OUTBOUND_ENABLED'
  enabled     boolean NOT NULL,          -- the override value
  updated_by  uuid,                      -- staff_users.id who flipped it
  updated_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
