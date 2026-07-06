-- ============================================================================
-- 038_custom_fields.sql — Admin-defined custom fields for the Condition Center
--
-- An information condition can now ask for a brand-new field, not just the
-- built-in application/borrower columns. Admins create the field (label, type,
-- dropdown options, borrower wording) while authoring the condition; the
-- borrower's answer is stored per-application in application_field_values and
-- the field becomes available to the rule engine like any built-in field.
--
--   custom_fields              — the field definitions (registry extension)
--   application_field_values   — one value per (application, field)
--
-- Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS custom_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key             text UNIQUE NOT NULL,            -- cf_<slug>, stable, referenced by rules + conditions
  label           text NOT NULL,
  borrower_label  text,
  borrower_hint   text,
  type            text NOT NULL CHECK (type IN ('money','number','percent','text','enum','boolean','date')),
  options         jsonb,                           -- enum only: [{"v":"...","label":"..."}]
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS application_field_values (
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  field_key       text NOT NULL,
  value           jsonb,
  updated_by_kind text,                            -- borrower | staff | system
  updated_by_id   uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_app_field_values_key ON application_field_values(field_key);
