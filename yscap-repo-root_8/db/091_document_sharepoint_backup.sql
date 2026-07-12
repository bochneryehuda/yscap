-- STATUS: RESEARCH SPIKE (2026-07-12). Additive, nullable columns only; inert
-- until the (currently OFF, unwired) SharePoint backup feature is finalized.
-- See docs/SHAREPOINT-INTEGRATION-RESEARCH.md.
--
-- SharePoint append-only backup tracking on `documents`.
-- Idempotent (safe to re-run on every boot). No data is deleted; these columns
-- only RECORD where each document was mirrored to SharePoint. The mirror itself
-- is append-only (see docs/SHAREPOINT-POLICY.md) and reaches BOTH previous and
-- future documents via the reconciler (src/lib/sharepoint-backup.js).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_backup_ref       text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_web_url          text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_backed_up_at     timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_backup_error     text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_backup_attempts  integer NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_backup_attempted_at timestamptz;

-- Reconciler scan: cheap lookup of documents not yet mirrored.
CREATE INDEX IF NOT EXISTS idx_documents_sp_backup_pending
  ON documents (created_at)
  WHERE sharepoint_backed_up_at IS NULL;
