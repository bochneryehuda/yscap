-- ============================================================================
-- 315 — CLOSING WORKFLOW expansion (owner-directed 2026-07-26).
--
-- Builds the closer's real working surface ON TOP of the existing workflow
-- scaffold (db/212): the closer role, closer_id pointer, and the closing_workflow
-- stage machine already exist. This adds the fields + tables the Closing workspace
-- needs — investor CTC, closing-date-confirmed, the warehouse line, collateral
-- tracking, the ACTUAL cash-to-close (off the ALTA), the funded date, TPR /
-- investor-delivery sign-offs, closer checklists, and closing document conditions.
--
-- No frozen pricing number is touched. Encompass stays read-only. Idempotent, and
-- every add is backfilled onto existing files (previous AND future).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) Our system's authoritative FUNDED DATE (the designed-but-unbuilt column
--     from docs/ENCOMPASS-DATA-MAPPING.md). Read by the Encompass reconciler and
--     the 3-system reconciliation gate. Distinct from actual_closing (ClickUp).
-- ----------------------------------------------------------------------------
ALTER TABLE applications ADD COLUMN IF NOT EXISTS funded_date date;

-- ----------------------------------------------------------------------------
-- (2) closing_workflow — the per-file closing detail the workspace edits.
-- ----------------------------------------------------------------------------
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS investor_ctc               boolean NOT NULL DEFAULT false;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS investor_ctc_at            timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS investor_ctc_by            uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS closing_date_confirmed     boolean NOT NULL DEFAULT false;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS closing_date_confirmed_at  timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS closing_date_confirmed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL;
-- The warehouse line the loan funds off (Stride / Bank of the Sierra / Banc of
-- California / Northpointe / Fidelis / CorrFirst). Free text validated against the
-- app-level WAREHOUSES constant (src/lib/closing.js) so adding one later is a
-- one-line code change, not a migration.
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS warehouse                  text;
-- The tracking for the COLLATERAL leg: from the closing table / our office to our
-- WAREHOUSE bank (NOT warehouse → investor). Labeled that way in the UI.
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS collateral_tracking_number text;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS collateral_tracking_carrier text;
-- The ACTUAL cash-to-close off the balanced final HUD / ALTA (dollars).
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS actual_cash_to_close       numeric(14,2);
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS actual_cash_to_close_doc_id uuid REFERENCES documents(id) ON DELETE SET NULL;
-- Result of the money gate: verified liquidity >= actual CTC + required reserves.
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS liquidity_ok              boolean;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS liquidity_shortfall       numeric(14,2);
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS liquidity_checked_at      timestamptz;
-- TPR (third-party review) + investor delivery sign-offs.
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS tpr_required             boolean NOT NULL DEFAULT false;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS tpr_uploaded_at          timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS tpr_uploaded_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS tpr_signed_off_at        timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS tpr_signed_off_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS investor_delivery_signed_off_at timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS investor_delivery_signed_off_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
-- Result of the 3-system funded-date reconciliation (advisory record of the gate).
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS reconciled_ok            boolean;
-- When the file was handed to purchasing / post-closing.
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS purchasing_at            timestamptz;

-- Widen the stage machine with 'in_purchasing' (after fully_reconciled →
-- ClickUp 'in purchase review'). Re-assert the FULL list so the constraint is exact.
ALTER TABLE closing_workflow DROP CONSTRAINT IF EXISTS closing_workflow_stage_check;
ALTER TABLE closing_workflow ADD  CONSTRAINT closing_workflow_stage_check
  CHECK (stage IN ('estimated','ready_for_docs','wire_sent','fully_closed','fully_reconciled','in_purchasing'));

-- ----------------------------------------------------------------------------
-- (3) closing_notes — threaded notes on a file's closing. Anyone on the file may
--     add one; append-only.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_notes_app ON closing_notes(application_id, created_at);

-- ----------------------------------------------------------------------------
-- (4) closer-built CHECKLISTS — custom, and one per capital provider. Reusable
--     templates the closer instantiates onto a file, plus the per-file instances.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS closing_checklist_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    text,                       -- capital provider / note buyer (NULL = general)
  title       text NOT NULL,
  items       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- array of step labels
  created_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS closing_checklists (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  template_id    uuid REFERENCES closing_checklist_templates(id) ON DELETE SET NULL,
  provider       text,                    -- copied from the template / free text
  title          text NOT NULL,
  created_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_checklists_app ON closing_checklists(application_id, created_at);

CREATE TABLE IF NOT EXISTS closing_checklist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES closing_checklists(id) ON DELETE CASCADE,
  label        text NOT NULL,
  checked      boolean NOT NULL DEFAULT false,
  checked_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  checked_at   timestamptz,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_closing_checklist_items ON closing_checklist_items(checklist_id, sort_order);

-- A starter general closing checklist template (idempotent).
INSERT INTO closing_checklist_templates (provider, title, items)
SELECT NULL, 'General closing checklist',
  '["Confirm clear-to-close and investor CTC","Confirm closing date with all parties",
    "Review balanced final HUD / ALTA","Verify cash to close vs verified liquidity + reserves",
    "Confirm insurance binder + paid invoice","Confirm title clear to close",
    "Send wire / fund off warehouse line","Ship collateral to warehouse (record tracking)",
    "Reconcile funded date across PILOT / Encompass / ClickUp","Upload closed loan package",
    "TPR upload + sign-off (if applicable)","Investor delivery sign-off"]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM closing_checklist_templates WHERE provider IS NULL AND title='General closing checklist');

-- ----------------------------------------------------------------------------
-- (5) Closing DOCUMENT conditions (checklist_templates). Staff-only, closer-run,
--     category at_closing/post_closing so they gate FUNDING not CTC. auto_apply
--     'manual' — attached programmatically when a file is submitted to closing
--     (src/lib/closing.js ensureClosingConditions) + backfilled below onto files
--     already in the closing workflow. Not is_required (closer-managed in the
--     workspace, never a generic borrower/CTC blocker). role_scope 'any' (the
--     role_scope CHECK predates the closer role).
-- ----------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, role_scope, phase, sort_order, category, hint, is_required, tpr_exclude, auto_apply)
SELECT v.code, v.label, 'application', 'staff', 'document', 'any', 'closing', v.sort_order, v.category, v.hint, false, true, 'manual'
FROM (VALUES
  ('closing_hud_final',     'Balanced final HUD / ALTA settlement statement', 810, 'at_closing',
     'Upload the balanced final HUD / ALTA. The actual cash-to-close is read from this and checked against verified liquidity + reserves.'),
  ('closing_pkg_signed',    'Closed loan package (signed closing documents)', 820, 'post_closing',
     'Upload the full signed closing package after the loan closes.'),
  ('closing_tracking_label','Collateral shipping label / tracking (to warehouse)', 830, 'post_closing',
     'Upload the shipping label / proof of tracking for the collateral sent to our warehouse bank.')
) AS v(code, label, sort_order, category, hint)
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates t WHERE t.code = v.code);

-- Re-assert the definitions (never touches on-file instances).
UPDATE checklist_templates SET audience='staff', item_kind='document', auto_apply='manual',
       role_scope='any', phase='closing', is_required=false, tpr_exclude=true, is_active=true
 WHERE code IN ('closing_hud_final','closing_pkg_signed','closing_tracking_label');

-- Backfill onto every file that is ALREADY in the closing workflow (previous files),
-- as engine-neutral manual items. Idempotent via NOT EXISTS.
INSERT INTO checklist_items
  (template_id, scope, application_id, label, audience, item_kind, role_scope, phase, category, hint,
   is_required, status, sort_order, origin_kind, created_by_kind)
SELECT t.id, 'application', cw.application_id, t.label, t.audience, t.item_kind, t.role_scope, t.phase,
       t.category, t.hint, false, 'outstanding', t.sort_order, 'auto', 'staff'
  FROM closing_workflow cw
  CROSS JOIN checklist_templates t
  JOIN applications a ON a.id = cw.application_id AND a.deleted_at IS NULL
 WHERE t.code IN ('closing_hud_final','closing_pkg_signed','closing_tracking_label')
   AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                    WHERE ci.application_id = cw.application_id AND ci.template_id = t.id);
