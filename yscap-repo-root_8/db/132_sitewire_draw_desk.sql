-- 132_sitewire_draw_desk.sql — Sitewire draw-desk batch 2 (per-file draw management).
--
-- Idempotent (safe to re-run every boot). Adds the advisory draw-risk snapshot, the
-- findings accept/dispute SLA timestamps, and the risk-engine + reallocation settings.
-- No adoption of pre-existing Sitewire data (only-ours rule). See docs/SITEWIRE-DRAW-
-- MANAGEMENT-RESEARCH.md §12 (unified rollup), §13 (reallocation), §15 (risk engine).

-- ---- advisory draw-risk snapshot (Built "Draw Agent" audit mode — flags, never blocks) ----
ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS risk_level text;
ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS risk_flags jsonb;
ALTER TABLE sitewire_draws ADD COLUMN IF NOT EXISTS risk_assessed_at timestamptz;

-- ---- findings accept/dispute lifecycle timestamps + the wire SLA deadline ----
-- accepted_at / accepted_via already exist (db/131). Add the dispute + resolution stamps
-- and the wire-due deadline computed from wire_turnaround_hours on borrower acceptance.
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS disputed_at timestamptz;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS wire_due_at timestamptz;
ALTER TABLE draw_findings ADD COLUMN IF NOT EXISTS delivered_to jsonb;   -- {borrower,lo,coordinator emails} for audit

-- borrower dispute evidence media on a finding line (photos/notes the borrower attaches)
ALTER TABLE draw_finding_lines ADD COLUMN IF NOT EXISTS dispute_media jsonb;
ALTER TABLE draw_finding_lines ADD COLUMN IF NOT EXISTS dispute_decided_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE draw_finding_lines ADD COLUMN IF NOT EXISTS dispute_decided_at timestamptz;

-- ---- per-file draw-coordinator override (persona defaults to Lisa Katz; admin-overridable) ----
ALTER TABLE sitewire_property_links ADD COLUMN IF NOT EXISTS coordinator_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---- risk-engine + reallocation thresholds (admin-tunable; never guessed at call time) ----
INSERT INTO sitewire_settings (key, value) VALUES ('front_load_pct', '40'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO sitewire_settings (key, value) VALUES ('first_draw_max_pct', '30'::jsonb) ON CONFLICT (key) DO NOTHING;

-- ---- change-request reuse: mark SOW change requests with a stable field key ----
-- change_requests.field carries a machine key; SOW reallocations use 'sow_reallocation' so
-- the desk can list them without scanning payloads.
CREATE INDEX IF NOT EXISTS idx_change_requests_sow ON change_requests (application_id) WHERE field = 'sow_reallocation';

-- ---- helpful indexes for the desk ----
CREATE INDEX IF NOT EXISTS idx_sw_draws_risk ON sitewire_draws (risk_level) WHERE risk_level IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_app ON draw_findings (application_id);
