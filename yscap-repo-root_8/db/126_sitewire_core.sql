-- 126_sitewire_core.sql — Sitewire construction-draw-management integration (core schema).
--
-- Idempotent (safe to re-run every boot). PILOT manages ONLY the properties it created
-- (the owner "only-ours" rule): a property enters draw management when WE push it on the
-- funded + Request-a-draw click, recording its Sitewire ids here. The pre-existing hand-
-- entered Sitewire properties are never adopted, mirrored, or overwritten.
--
-- Design + full field mapping + guards: docs/SITEWIRE-DRAW-MANAGEMENT-RESEARCH.md.

-- ---- reuse sync_queue as the outbound OUTBOX: widen target to carry Sitewire pushes ----
ALTER TABLE sync_queue DROP CONSTRAINT IF EXISTS sync_queue_target_check;
ALTER TABLE sync_queue ADD  CONSTRAINT sync_queue_target_check
  CHECK (target IN ('clickup','encompass','graph','sitewire'));

-- ---- staff <-> Sitewire lender-user map (email-matched) for the draw-coordinator persona ----
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS sitewire_user_id bigint;

-- ---- property link: the PILOT file <-> the Sitewire property/budget WE created ----
CREATE TABLE IF NOT EXISTS sitewire_property_links (
  id                     bigserial PRIMARY KEY,
  application_id         uuid NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_property_id   bigint UNIQUE,
  sitewire_budget_id     bigint,
  capital_partner_id     bigint,
  matched_by             text NOT NULL DEFAULT 'created' CHECK (matched_by IN ('created','manual')),
  budget_version         integer NOT NULL DEFAULT 1,
  state                  text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','live','error')),
  pushed_at              timestamptz,
  last_reconciled_at     timestamptz,
  raw                    jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- ---- THE per-unit budget crosswalk (linchpin): one row per exploded Sitewire job item ----
-- section_token: all | u1..uN | common | exterior | project | media
-- sow_line_key : "catId:index" | "x:<id>" | "__contingency__" | "__gc__" | "__media__:<slug>"
CREATE TABLE IF NOT EXISTS sitewire_job_item_links (
  id                     bigserial PRIMARY KEY,
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_budget_id     bigint NOT NULL,
  sow_line_key           text NOT NULL,
  section_token          text NOT NULL,
  unit_index             integer,
  sitewire_job_item_id   bigint,                    -- captured from PATCH response; durable identity once set
  name                   text NOT NULL,
  budgeted_cents         bigint NOT NULL DEFAULT 0,
  is_media_item          boolean NOT NULL DEFAULT false,
  state                  text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','live','orphan_review','deleted')),
  last_response_hash     text,
  last_pushed_at         timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_swji_cell ON sitewire_job_item_links (application_id, sow_line_key, section_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_swji_jid  ON sitewire_job_item_links (sitewire_budget_id, sitewire_job_item_id) WHERE sitewire_job_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swji_jid ON sitewire_job_item_links (sitewire_job_item_id);
CREATE INDEX IF NOT EXISTS idx_swji_app ON sitewire_job_item_links (application_id);

-- ---- draw mirror (read-only reflection of Sitewire draws for OUR properties) ----
CREATE TABLE IF NOT EXISTS sitewire_draws (
  id                     bigserial PRIMARY KEY,
  application_id         uuid REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id       bigint NOT NULL UNIQUE,
  sitewire_property_id   bigint,
  number                 integer,
  name                   text,
  status                 text,
  historical             boolean NOT NULL DEFAULT false,
  total_requested_cents  bigint NOT NULL DEFAULT 0,
  total_approved_cents   bigint NOT NULL DEFAULT 0,
  coordinator_id         bigint,
  quick_notify_status_id bigint,
  pdf_src                text,
  submitted_at           timestamptz,
  approved_at            timestamptz,
  budget_version_at_draw integer,
  last_sequence          bigint NOT NULL DEFAULT 0,
  events                 jsonb,
  sitewire_updated_at    timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sw_draws_app ON sitewire_draws (application_id);

-- ---- per-line request mirror ----
CREATE TABLE IF NOT EXISTS sitewire_draw_requests (
  id                     bigserial PRIMARY KEY,
  sitewire_draw_id       bigint NOT NULL,
  sitewire_request_id    bigint NOT NULL UNIQUE,
  sitewire_job_item_id   bigint,
  job_item_name          text,
  requested_cents        bigint NOT NULL DEFAULT 0,
  approved_cents         bigint,
  lender_comments        text,
  inspector_comments     text,
  inspection_count       integer NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sw_reqs_draw ON sitewire_draw_requests (sitewire_draw_id);
CREATE INDEX IF NOT EXISTS idx_sw_reqs_jid  ON sitewire_draw_requests (sitewire_job_item_id);

-- ---- OUR money ledger (Sitewire models no fee / net / release / dates) ----
CREATE TABLE IF NOT EXISTS draw_disbursements (
  id                     bigserial PRIMARY KEY,
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id       bigint,
  approved_cents         bigint NOT NULL DEFAULT 0,
  fee_cents              bigint NOT NULL DEFAULT 0,
  fee_kind               text CHECK (fee_kind IN ('virtual','physical')),
  net_release_cents      bigint NOT NULL DEFAULT 0,
  release_date           date,
  funded_status          text NOT NULL DEFAULT 'pending' CHECK (funded_status IN ('pending','released','held')),
  note                   text,
  created_by             uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_disb_app ON draw_disbursements (application_id);
CREATE INDEX IF NOT EXISTS idx_disb_draw ON draw_disbursements (sitewire_draw_id);

-- ---- cached Sitewire capital-partner directory ----
CREATE TABLE IF NOT EXISTS sitewire_capital_partners (
  sitewire_id            bigint PRIMARY KEY,
  name                   text NOT NULL,
  on_our_lender          boolean NOT NULL DEFAULT false,
  synced_at              timestamptz NOT NULL DEFAULT now()
);

-- ---- per-capital-partner inspection + fee rules (admin-editable). NULL partner = global default ----
CREATE TABLE IF NOT EXISTS sitewire_inspection_rules (
  id                     bigserial PRIMARY KEY,
  capital_partner_id     bigint,
  program                text,
  inspection_method      text NOT NULL DEFAULT 'mobile' CHECK (inspection_method IN ('mobile','traditional')),
  require_sitewire_inspector       boolean NOT NULL DEFAULT true,
  require_capital_partner_approval boolean NOT NULL DEFAULT false,
  allow_reallocation     boolean NOT NULL DEFAULT false,
  fee_cents_virtual      bigint NOT NULL DEFAULT 29900,
  fee_cents_physical     bigint,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_swrule ON sitewire_inspection_rules (COALESCE(capital_partner_id,-1), COALESCE(program,''));
INSERT INTO sitewire_inspection_rules (capital_partner_id, program, inspection_method, require_sitewire_inspector, fee_cents_virtual, fee_cents_physical)
  SELECT NULL, NULL, 'mobile', true, 29900, 49900
  WHERE NOT EXISTS (SELECT 1 FROM sitewire_inspection_rules WHERE capital_partner_id IS NULL AND program IS NULL);

-- ---- outbound write journal (before/after every Sitewire write) ----
CREATE TABLE IF NOT EXISTS sitewire_write_log (
  id                     bigserial PRIMARY KEY,
  application_id         uuid,
  sitewire_property_id   bigint,
  sitewire_budget_id     bigint,
  entity                 text,                      -- property | budget | job_item | borrower | request | draw
  entity_id              bigint,
  idempotency_key        text,
  field                  text,
  old_value              jsonb,
  new_value              jsonb,
  changed                boolean NOT NULL DEFAULT true,
  blocked                boolean NOT NULL DEFAULT false,
  source                 text,                      -- create | push | reallocation | dispute | reconcile | review_resolve
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_swlog_app ON sitewire_write_log (application_id, created_at);

-- ---- key/value settings (wire turnaround hours, variance policy, …) ----
CREATE TABLE IF NOT EXISTS sitewire_settings (
  key                    text PRIMARY KEY,
  value                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sitewire_settings (key, value) VALUES ('wire_turnaround_hours', '48'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO sitewire_settings (key, value) VALUES ('variance_pct', '10'::jsonb) ON CONFLICT (key) DO NOTHING;

-- ---- findings (per-draw inspector results) delivered to the borrower ----
CREATE TABLE IF NOT EXISTS draw_findings (
  id                     bigserial PRIMARY KEY,
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  sitewire_draw_id       bigint NOT NULL,
  status                 text NOT NULL DEFAULT 'delivered' CHECK (status IN ('delivered','accepted','disputed','resolved')),
  total_requested_cents  bigint NOT NULL DEFAULT 0,
  total_approved_cents   bigint NOT NULL DEFAULT 0,
  reply_token            text UNIQUE,
  delivered_at           timestamptz NOT NULL DEFAULT now(),
  accepted_at            timestamptz,
  accepted_via           text CHECK (accepted_via IN ('portal','email')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_draw ON draw_findings (sitewire_draw_id);

CREATE TABLE IF NOT EXISTS draw_finding_lines (
  id                     bigserial PRIMARY KEY,
  finding_id             bigint NOT NULL REFERENCES draw_findings(id) ON DELETE CASCADE,
  sitewire_request_id    bigint,
  sitewire_job_item_id   bigint,
  sow_line_key           text,
  unit_index             integer,
  name                   text,
  requested_cents        bigint NOT NULL DEFAULT 0,
  approved_cents         bigint NOT NULL DEFAULT 0,
  not_approved_cents     bigint NOT NULL DEFAULT 0,
  inspector_comments     text,
  lender_comments        text,
  photo_count            integer NOT NULL DEFAULT 0,
  video_count            integer NOT NULL DEFAULT 0,
  media                  jsonb,                     -- [{src,thumbnail,type,lat,lng,captured_at}]
  dispute_desired_cents  bigint,
  dispute_note           text,
  dispute_status         text CHECK (dispute_status IN ('open','approved','rejected')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finding_lines ON draw_finding_lines (finding_id);

-- ---- SOW change-request detail (reuses change_requests; holds proposed SOW + per-line deltas) ----
CREATE TABLE IF NOT EXISTS sow_change_request_details (
  id                     bigserial PRIMARY KEY,
  change_request_id      uuid REFERENCES change_requests(id) ON DELETE CASCADE,
  application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  proposed_payload       jsonb,
  deltas                 jsonb,                     -- [{sow_line_key,unit,old_cents,new_cents}]
  net_zero               boolean,
  after_ctc              boolean NOT NULL DEFAULT false,
  needs_capital_partner  boolean NOT NULL DEFAULT false,
  capital_partner_status text CHECK (capital_partner_status IN ('pending','approved','rejected')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sowcrd_app ON sow_change_request_details (application_id);
