-- SharePoint metadata ID-stamping tracking (roadmap R1, owner-directed
-- 2026-07-16). Idempotent; additive. Records when a mirrored driveItem last
-- had its Pilot identity columns (PilotDocumentId/FileId/Borrower/SyncedAt)
-- stamped, so a backfill/verify pass can find mirrored-but-unstamped items
-- without re-stamping everything. Stamping is best-effort and gated
-- (SHAREPOINT_STAMP_METADATA); this column is NULL when unstamped.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_stamped_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_documents_sp_stamp_pending
  ON documents (created_at)
  WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_stamped_at IS NULL;
