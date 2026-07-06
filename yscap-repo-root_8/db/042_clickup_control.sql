-- ============================================================================
-- 042_clickup_control.sql — admin-editable mapping + durable webhook inbox
--
-- Two tables backing the ClickUp Control Center (see the blueprint §12):
--   * clickup_field_mappings — runtime-editable overrides for the field /
--     option / folder / user crosswalk. The hardcoded constants in
--     src/clickup/* remain the fallback default; a row here overrides one.
--     This is the app's first runtime-editable config store.
--   * clickup_webhook_inbox — every inbound ClickUp webhook, deduped by the
--     provider event id, processed asynchronously by the sync worker.
--
-- Idempotent: safe to re-run on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clickup_field_mappings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    portal_key       text UNIQUE NOT NULL,          -- e.g. 'application.program', 'checklist.title'
    kind             text NOT NULL DEFAULT 'field'
                       CHECK (kind IN ('field','option','folder','user','status')),
    ext_field_id     text,                          -- ClickUp custom_field id (fields) / folder id / etc.
    ext_type         text,                          -- ClickUp field type (drop_down, users, date, …)
    direction        text NOT NULL DEFAULT 'both'
                       CHECK (direction IN ('both','push','pull')),
    source_of_record text NOT NULL DEFAULT 'portal'
                       CHECK (source_of_record IN ('portal','clickup','either')),
    option_map       jsonb,                          -- [{portal, ext_id, orderindex, label}] for dropdowns
    transform        text,                           -- named transform (e.g. 'name_split','card_split')
    is_active        boolean NOT NULL DEFAULT true,
    notes            text,
    created_by       uuid REFERENCES staff_users(id),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clickup_webhook_inbox (
    id               bigserial PRIMARY KEY,
    event_id         text UNIQUE,                    -- ClickUp delivery id (dedupe key)
    event            text,                           -- taskUpdated / taskStatusUpdated / …
    task_id          text,
    payload          jsonb,
    status           text NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','processing','done','error','ignored')),
    attempts         integer NOT NULL DEFAULT 0,
    last_error       text,
    received_at      timestamptz NOT NULL DEFAULT now(),
    processed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_clickup_inbox_status ON clickup_webhook_inbox(status, received_at);
CREATE INDEX IF NOT EXISTS idx_clickup_inbox_task ON clickup_webhook_inbox(task_id);
