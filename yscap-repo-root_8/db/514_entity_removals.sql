-- ============================================================================
-- 514 — A SUPER-ADMIN CAN REMOVE AN ENTITY FROM A BORROWER PROFILE, and every
--       removal is recorded so nothing is unrecoverable.
--
-- The owner (2026-08-10): "Super-admin: remove entities from any borrower
-- profile — to clean up entities that were added by error." There was NO remove
-- path for an entity anywhere in the system; this table is the recovery net for
-- the one that src/lib/entity-remove.js adds.
--
-- Removing an entity is the most destructive entity action there is: on a
-- sole-owner entity it deletes the llcs row, which CASCADE-removes its document
-- SLOTS + non-borrower members + borrower-owner links + vendor-match rows and
-- SET-NULLs every vesting/track-record/candidate reference. So — exactly like
-- borrower_merges (db/323) does for a profile merge — the WHOLE entity is
-- snapshotted here BEFORE it is touched (the row + its members + its slots +
-- the metadata of its documents + the files/track-records that referenced it),
-- alongside who removed it and the reason they gave.
--
-- `action` records which shape ran:
--   'deleted'     — the borrower was the entity's only owner; the entity is gone.
--   'transferred' — the entity had other owners (llc_borrowers), so it stayed
--                   and its primary pointer moved to a remaining owner; it left
--                   THIS profile only.
--
-- Idempotent, additive. References nothing that cascades INTO it — the snapshot
-- must outlive the entity and the borrower it hung off, so borrower_id/llc_id are
-- recorded as plain uuids, NOT foreign keys.
-- ============================================================================

CREATE TABLE IF NOT EXISTS entity_removals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  llc_id            uuid NOT NULL,               -- the removed entity (no FK: it may be gone)
  borrower_id       uuid NOT NULL,               -- the profile it was removed from
  entity_name       text,
  action            text NOT NULL CHECK (action IN ('deleted','transferred')),
  transferred_to    uuid,                        -- on 'transferred': the owner it moved to
  reason            text NOT NULL,
  entity_snapshot   jsonb NOT NULL,              -- row + members + slots + document metadata
  affected          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- files/track-records that referenced it
  removed_by        uuid REFERENCES staff_users(id),
  removed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entity_removals_borrower ON entity_removals(borrower_id);
CREATE INDEX IF NOT EXISTS idx_entity_removals_llc ON entity_removals(llc_id);
