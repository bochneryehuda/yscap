-- WO-B — per-file Encompass reconciliation RESOLUTIONS (READ-ONLY sync).
--
-- The per-file Encompass comparison itself is recomputed LIVE from the pulled
-- loan (applications.encompass_extra) + our own columns / current quote every
-- time it is read — so a finding is never stale. What we PERSIST is a staff
-- RESOLUTION of a specific field's mismatch: either the Encompass value was
-- pulled into our column ('replaced', WO-C) or the difference was reviewed and
-- accepted ('accepted'). A resolution carries a SNAPSHOT of the two values it
-- resolved; if either side later changes, the snapshot no longer matches and the
-- finding re-opens on its own (no stale "cleared" state). This is the only write
-- the Encompass sync makes — into OUR OWN table, never to Encompass.
--
-- Idempotent (IF NOT EXISTS) — safe to re-run on every boot.

CREATE TABLE IF NOT EXISTS encompass_sync_resolutions (
  application_id   uuid        NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  field_key        text        NOT NULL,                 -- encompass-field-map registry key
  resolution       text        NOT NULL,                 -- 'replaced' | 'accepted'
  ours_snapshot    text,                                 -- our value at resolution time
  theirs_snapshot  text,                                 -- Encompass value at resolution time
  resolved_by      uuid,                                 -- staff_users.id (who resolved)
  resolved_at      timestamptz NOT NULL DEFAULT now(),
  note             text,
  CONSTRAINT encompass_sync_resolutions_resolution_chk
    CHECK (resolution IN ('replaced', 'accepted')),
  PRIMARY KEY (application_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_encompass_resolutions_app
  ON encompass_sync_resolutions(application_id);
