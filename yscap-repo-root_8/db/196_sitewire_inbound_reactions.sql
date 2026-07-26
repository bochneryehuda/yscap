-- Bidirectional Phase 1 — PILOT reacts to inbound Sitewire changes (owner-directed 2026-07-20).
--
-- Until now the 5-minute reconcile poll silently OVERWROTE the draw mirror and told no one: a draw
-- approved or newly submitted directly in Sitewire produced zero notification and zero action. This
-- adds (1) a go-forward watermark so PILOT can tell a genuine inbound status TRANSITION from a value
-- it has already reacted to, and (2) an append-only inbound field-change audit (the Sitewire analog
-- of clickup_pull_field_change) so the two-way history is finally visible. Idempotent.

-- The last draw status PILOT has already reacted to (notified on). On the FIRST reconcile of a file
-- it is baselined to the current status WITHOUT notifying (no burst for pre-existing draws); on a
-- later poll a status != status_synced is a real inbound transition → react once, then advance it.
ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS status_synced text;

-- Append-only audit of every value the reconcile poll observed CHANGING on the Sitewire side, so the
-- cross-system history never goes dark (mirrors ClickUp's clickup_pull_field_change). `reacted` marks
-- whether a notification was fired for that change (status transitions react; amount changes are
-- recorded for Phase 2 drift detection but don't notify here).
CREATE TABLE IF NOT EXISTS sitewire_pull_field_change (
  id                bigserial PRIMARY KEY,
  application_id    uuid REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id  bigint,
  entity            text NOT NULL,               -- 'draw' | 'request'
  entity_id         bigint,                       -- the sitewire draw/request id
  field             text NOT NULL,                -- 'status' | 'total_approved_cents' | 'approved_cents' | 'new_draw'
  old_value         text,
  new_value         text,
  reacted           boolean NOT NULL DEFAULT false,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sw_pull_change_app ON sitewire_pull_field_change (application_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sw_pull_change_draw ON sitewire_pull_field_change (sitewire_draw_id, occurred_at DESC);
