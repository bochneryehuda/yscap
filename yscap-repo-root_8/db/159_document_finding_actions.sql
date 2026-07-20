-- 159_document_finding_actions.sql
-- Persist the underwriter action menu a finding suggests, so the GET reload of a finding
-- offers the SAME finding-tailored actions the analyze response did — instead of falling back
-- to the severity default and drifting between the two endpoints (pre-merge audit MN2).
--   * suggested_actions — the check's own suggested action verbs (jsonb array of text)
--   * opens_condition   — the checklist condition this finding opens when a condition is posted
-- Idempotent (safe to re-run every boot). Existing rows keep NULL and fall back to the
-- severity-default menu exactly as before, so this is behavior-identical until a new analysis
-- writes the column.
ALTER TABLE document_findings
  ADD COLUMN IF NOT EXISTS suggested_actions jsonb,
  ADD COLUMN IF NOT EXISTS opens_condition   text;
