-- SharePoint mirror INTEGRITY + version-churn fix (owner-directed 2026-07-15:
-- "most of the files going to SharePoint are getting corrupted… look for the
-- corrupted documents, re-sync everything… and the 47 versions is not true").
-- Idempotent; additive columns only. Nothing here deletes anything.
--
--  * sha256                      — content hash of the LOCAL bytes (hex). Stamped
--                                  lazily by the mirror/verify passes (covers
--                                  previous AND future documents without touching
--                                  every upload endpoint's INSERT).
--  * sharepoint_item_size        — the byte size SharePoint reported for the
--                                  mirrored driveItem at upload/verify time.
--  * sharepoint_verified_at      — when the mirror copy last passed (or was
--                                  stamped by) the integrity audit.
--  * sharepoint_integrity        — audit verdict: 'ok' | 'restored' |
--                                  'local-missing' | 'item-missing' |
--                                  'verify-error: …'
--  * sharepoint_skipped_reason   — why a document was deliberately NOT uploaded
--                                  (superseded autosave snapshot, duplicate
--                                  bytes). Distinguishes "skipped by design"
--                                  from "mirrored" even though both carry a
--                                  sharepoint_backed_up_at stamp.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS sha256                    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_item_size      bigint;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_verified_at    timestamptz;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_integrity      text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_skipped_reason text;

-- Integrity-audit scan: mirrored documents that still need (re-)verification.
CREATE INDEX IF NOT EXISTS idx_documents_sp_verify_pending
  ON documents (sharepoint_verified_at NULLS FIRST, created_at)
  WHERE sharepoint_backup_ref IS NOT NULL;

-- Byte-dedup lookup at mirror time (same bytes + same name + same scope never
-- upload twice).
CREATE INDEX IF NOT EXISTS idx_documents_sha256
  ON documents (sha256)
  WHERE sha256 IS NOT NULL;

-- Cross-process leases for the reconciler/verify passes: two server instances
-- (deploy overlap, scale-out) must never drain the same pending batch at the
-- same time — that is how duplicate mirror copies and double Version bumps
-- happen. A pass acquires its lease row (or skips), renews while running, and
-- releases on completion; a crashed holder's lease simply expires.
CREATE TABLE IF NOT EXISTS sync_locks (
  lock_key   text PRIMARY KEY,
  holder     text NOT NULL,
  expires_at timestamptz NOT NULL
);
