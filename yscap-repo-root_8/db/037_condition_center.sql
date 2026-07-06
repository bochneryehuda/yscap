-- ============================================================================
-- 037_condition_center.sql — The Condition Center
--
-- Turns checklist_templates into an admin-authorable condition library with a
-- rule engine, so conditions no longer require a developer:
--
--   * checklist_templates grows authoring metadata (who/when/version/origin),
--     a condition rule tree (rule_logic jsonb, evaluated by
--     src/lib/conditions/rules.js), an auto_apply mode, an info-field mapping
--     (field_key — "this condition asks the borrower to fill in field X"),
--     a category ("prior to docs/closing/funding…") and an e-sign descriptor.
--
--   * auto_apply semantics:
--       NULL      → legacy template, instantiated once at application creation
--                   by generateChecklist() (applies_program/applies_loan_type).
--       'always'  → the condition engine keeps it on every open file.
--       'rules'   → the engine attaches it while rule_logic matches the file.
--       'manual'  → library-only; staff attach it to individual files by hand.
--
--   * checklist_items grows the mirrored per-instance columns plus origin
--     tracking (origin_kind/origin_detail) so the engine can tell which items
--     it created (and may safely retract while untouched) vs. staff-created.
--
--   * esign_envelopes is the DocuSign-ready stub: one row per "sign this
--     document" condition; the future webhook flips status and links the
--     completed PDF back into documents.
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ---- checklist_templates: authoring + rules ----
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS rule_logic jsonb;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS auto_apply text;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS field_key text;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS esign_doc text;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'system';
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE checklist_templates ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  ALTER TABLE checklist_templates
    ADD CONSTRAINT chk_templates_auto_apply CHECK (auto_apply IS NULL OR auto_apply IN ('always','rules','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE checklist_templates
    ADD CONSTRAINT chk_templates_origin CHECK (origin IN ('system','admin'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE checklist_templates
    ADD CONSTRAINT chk_templates_category CHECK (category IS NULL OR category IN
      ('prior_to_approval','prior_to_docs','prior_to_closing','prior_to_funding','at_closing','post_closing'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_templates_auto_apply ON checklist_templates(auto_apply) WHERE auto_apply IS NOT NULL;

-- ---- checklist_items: per-instance mirrors + engine origin tracking ----
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS field_key text;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS origin_kind text;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS origin_detail jsonb;
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS esign_doc text;

DO $$ BEGIN
  ALTER TABLE checklist_items
    ADD CONSTRAINT chk_items_origin_kind CHECK (origin_kind IS NULL OR origin_kind IN
      ('auto','manual_library','manual_custom'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_checklist_items_template_app ON checklist_items(template_id, application_id)
  WHERE template_id IS NOT NULL AND application_id IS NOT NULL;

-- ---- e-sign stub (DocuSign-ready) ----
CREATE TABLE IF NOT EXISTS esign_envelopes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  checklist_item_id      uuid REFERENCES checklist_items(id) ON DELETE CASCADE,
  provider               text NOT NULL DEFAULT 'docusign',
  envelope_id            text,
  status                 text NOT NULL DEFAULT 'not_sent'
                         CHECK (status IN ('not_sent','sent','delivered','completed','declined','voided','error')),
  completed_document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  detail                 jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_esign_envelopes_app ON esign_envelopes(application_id);
