-- SharePoint one-way sync (owner-directed 2026-07-13): folder-resolution cache
-- and per-condition version state for the Pipeline Drive mirror. Idempotent.
-- Nothing here deletes data; these tables/columns only RECORD where each
-- document's mirror copy lives in SharePoint and which Version-N folder a
-- condition is currently on.

-- Which Version folder each mirrored copy went into (0 = condition-folder root,
-- before the condition was ever versioned) and its current SharePoint parent
-- folder id (needed for the one legal move: root -> "Version 1" on first
-- supersede, moving ONLY our own mirror copies).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_version   integer;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS sharepoint_parent_id text;

-- Resolved "YS portal syncing" folder per scope ('app:<uuid>' / 'borrower:<uuid>'
-- / 'unfiled:<uuid>'). details carries the matched officer/borrower/address
-- folder names + ids and any fuzzy-match notes for manual review.
CREATE TABLE IF NOT EXISTS sharepoint_folder_cache (
  scope_key      text PRIMARY KEY,
  sync_folder_id text NOT NULL,
  web_url        text,
  full_path      text,
  details        jsonb,
  resolved_at    timestamptz NOT NULL DEFAULT now()
);

-- Per-condition version state. state_key is 'item:<checklist_item_id>' for
-- condition-attached documents, or 'kind:<scope_key>:<category-slug>' for
-- kind-based categories (Term Sheet, Track Record, Chat Attachments, ...).
CREATE TABLE IF NOT EXISTS sharepoint_condition_state (
  state_key       text PRIMARY KEY,
  scope_key       text NOT NULL,
  folder_id       text NOT NULL,
  folder_name     text,
  current_version integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sp_condition_state_scope ON sharepoint_condition_state (scope_key);
