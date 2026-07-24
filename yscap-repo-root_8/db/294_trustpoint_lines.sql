-- 294_trustpoint_lines.sql
-- Idempotent. Physical-draw workflow phase 3 (blueprint §5A/§6): per-line approved
-- amounts for TrustPoint-administered draws + the Sitewire write-back state.
--
-- TrustPoint's API exposes NO per-line draw data. The per-line approved figures come
-- from (in preference order, §6): the milestone-progress DIFF (snapshots below —
-- accepted ONLY when the per-line deltas sum to the approved total to the cent),
-- else the coordinator's manual entry (she has TrustPoint's console open anyway),
-- else nothing (aggregates only — the write-back then waits).

CREATE TABLE IF NOT EXISTS trustpoint_draw_lines (
  id                    bigserial PRIMARY KEY,
  application_id        uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  tp_draw_id            text NOT NULL,
  sitewire_job_item_id  bigint,          -- the operative per-line ledger key (crosswalk)
  sow_line_key          text,
  name                  text,
  approved_cents        bigint NOT NULL CHECK (approved_cents >= 0),
  source                text NOT NULL CHECK (source IN ('derived','manual')),
  entered_by            uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tp_draw_id, sitewire_job_item_id)
);
CREATE INDEX IF NOT EXISTS idx_tpdl_app ON trustpoint_draw_lines (application_id);

-- Raw milestone snapshots around draw transitions — the derivation's evidence. The
-- 'post' snapshot minus the latest earlier snapshot per milestone = that draw's
-- per-line movement (sandbox item Q-C: whether TrustPoint milestone reads expose
-- completed/remaining amounts at all; the differ is field-name-agnostic and accepts
-- only cent-exact totals, so absent fields simply mean "no derivation").
CREATE TABLE IF NOT EXISTS trustpoint_milestone_snapshots (
  id              bigserial PRIMARY KEY,
  application_id  uuid REFERENCES applications(id) ON DELETE CASCADE,
  tp_project_id   text NOT NULL,
  tp_draw_id      text,
  phase           text NOT NULL CHECK (phase IN ('pre','post','event')),
  lines           jsonb NOT NULL,
  taken_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tpms_draw ON trustpoint_milestone_snapshots (tp_draw_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_tpms_project ON trustpoint_milestone_snapshots (tp_project_id, taken_at);

-- Write-back state on the mirror row: when PILOT mirrored this draw's approval into
-- the live Sitewire intake draw (per-line amounts + approve transition).
ALTER TABLE trustpoint_draws ADD COLUMN IF NOT EXISTS writeback_at timestamptz;
ALTER TABLE trustpoint_draws ADD COLUMN IF NOT EXISTS writeback_note text;
