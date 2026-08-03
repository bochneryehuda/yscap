-- 422_dashboards.sql — the Dashboards section: saved dashboards, their cards, sharing,
-- and user-defined ratio KPIs (owner-directed 2026-08-03: "go ahead build it all").
--
-- THE ONE DESIGN DECISION THIS SCHEMA ENCODES: the dashboard every person lands on is
-- ITSELF a row in this table. There is no separate hardcoded path for the "standard"
-- dashboard and an authoring path for custom ones — the shipped defaults are ordinary
-- dashboards flagged `is_system`, built out of the same cards, answered by the same
-- endpoint. That is what makes the owner's actual request possible on day one: "you can
-- see the settings in the back end which filters is using to populate this, you can
-- actually play around with the filters". You cannot inspect or fork a screen that is
-- welded into the code; you can inspect and fork a row.
--
-- A system dashboard is never edited in place and never deleted. Editing one FORKS it to
-- the editing staffer (owner_staff_id set, is_system false, forked_from pointing back), so
-- "reset to the company default" is always available and one person's edit can never
-- change what a colleague sees.
--
-- NOTHING HERE STORES A NUMBER. A card stores the QUESTION (a measure key, a filter tree,
-- a date field, a period) and the answer is computed live, scoped to the viewer. A shared
-- dashboard therefore re-runs under the VIEWER's permissions, never the author's — the
-- filter travels, the data does not.
--
-- RTL only: ordinary RTL table names, no lt_* reference, no cross-product foreign key
-- (scripts/check-product-separation.js). Idempotent — replays on every boot.

-- ---------------------------------------------------------------------------
-- The dashboard
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL owner = a system default that belongs to the company, not a person.
  owner_staff_id  uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  -- Stable identity for the shipped defaults so the boot seeder is idempotent and an
  -- admin's edits to a system dashboard survive the next deploy. NULL for user dashboards.
  slug            text,
  -- When set, this system dashboard is the landing page for that role.
  role_default    text,
  is_system       boolean NOT NULL DEFAULT false,
  -- Where a forked copy came from, so "reset to the company default" knows the way back.
  forked_from     uuid REFERENCES dashboards(id) ON DELETE SET NULL,
  -- Product lens. RTL is the only product with data today; the column exists so adding
  -- Long-Term later is a front-end merge with a stamp, never a schema change or a SQL
  -- join across products (CLAUDE.md rule 6).
  product         text NOT NULL DEFAULT 'rtl',
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE dashboards ADD CONSTRAINT chk_dashboards_product
    CHECK (product IN ('rtl'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A system dashboard is identified by its slug and there is exactly one of each.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboards_slug
  ON dashboards (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dashboards_owner
  ON dashboards (owner_staff_id) WHERE archived_at IS NULL;
-- One landing dashboard per role.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboards_role_default
  ON dashboards (role_default) WHERE role_default IS NOT NULL AND is_system;

-- ---------------------------------------------------------------------------
-- The cards
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  position      integer NOT NULL DEFAULT 0,
  -- Visual weight. 'hero' is the top row the 5-second read depends on; the research is
  -- firm that an executive screen stops working past ~5 headline numbers, so the seeder
  -- ships exactly four and the UI keeps them visually dominant.
  band          text NOT NULL DEFAULT 'body',
  width         text NOT NULL DEFAULT 'one',
  title         text NOT NULL,
  subtitle      text,
  -- How it draws: a big number, a trend over time, a breakdown by a dimension,
  -- a ranked table, or two periods side by side.
  viz           text NOT NULL DEFAULT 'number',
  -- What it measures — a key in the measure registry (src/lib/dashboards/registry.js),
  -- or a user-defined ratio in dashboard_metrics.
  metric_key    text NOT NULL,
  -- The condition tree, in the SAME shape the Condition Center already uses
  -- ({combinator, rules:[…]}), validated by the same rules.validateRule against a
  -- dashboard field map. NULL = no filter beyond the measure's own definition.
  filter        jsonb,
  -- Which date drives the period, e.g. actual_closing for funded volume.
  date_field    text,
  -- {kind:'mtd'|'qtd'|'ytd'|'last_days'|'last_months'|'fixed'|'all', n, from, to}
  period        jsonb,
  -- {kind:'none'|'prior_period'|'prior_year'}
  compare       jsonb,
  -- Dimension key to break down / group by (state, program, officer, …).
  group_by      text,
  -- Time grain for a trend card (month | quarter | year | week). Mutually exclusive with
  -- group_by in practice — a card breaks its number down one way or the other.
  grain         text,
  -- {good, warn, direction:'lower_is_better'|'higher_is_better', unit} — the red lines.
  -- Every threshold is a setting on the card, never a number in the code.
  target        jsonb,
  options       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE dashboard_cards ADD CONSTRAINT chk_dashboard_cards_viz
    CHECK (viz IN ('number','trend','breakdown','table','compare','list'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE dashboard_cards ADD CONSTRAINT chk_dashboard_cards_band
    CHECK (band IN ('hero','body'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE dashboard_cards ADD CONSTRAINT chk_dashboard_cards_width
    CHECK (width IN ('one','two','full'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The table pre-dates this column in no deployment, but ADD COLUMN IF NOT EXISTS keeps the
-- file replay-safe alongside the CREATE TABLE above (migrations run on every boot).
ALTER TABLE dashboard_cards ADD COLUMN IF NOT EXISTS grain text;

CREATE INDEX IF NOT EXISTS idx_dashboard_cards_dash
  ON dashboard_cards (dashboard_id, band, position);

-- ---------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_shares (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id  uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  -- 'staff' → one person; 'role' → everyone holding that role; 'everyone' → all staff.
  share_kind    text NOT NULL,
  staff_id      uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  role          text,
  can_edit      boolean NOT NULL DEFAULT false,
  shared_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE dashboard_shares ADD CONSTRAINT chk_dashboard_shares_kind
    CHECK (
      (share_kind = 'staff'    AND staff_id IS NOT NULL AND role IS NULL) OR
      (share_kind = 'role'     AND role     IS NOT NULL AND staff_id IS NULL) OR
      (share_kind = 'everyone' AND role IS NULL AND staff_id IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One share row per target. COALESCE, not the bare columns — two NULLs are DISTINCT in a
-- unique index, so a bare (dashboard_id, share_kind, staff_id, role) key would happily
-- store 'everyone' a hundred times.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_shares_target
  ON dashboard_shares (dashboard_id, share_kind,
                       COALESCE(staff_id::text, ''), COALESCE(role, ''));
CREATE INDEX IF NOT EXISTS idx_dashboard_shares_staff ON dashboard_shares (staff_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_shares_role  ON dashboard_shares (role);

-- ---------------------------------------------------------------------------
-- User-defined KPIs (a ratio of two measures, each with its own filter)
-- This is what makes "my own pull-through", "my own fallout rate", "cost per file"
-- something a person defines rather than something we hardcode.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_metrics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_staff_id  uuid REFERENCES staff_users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  label           text NOT NULL,
  description     text,
  -- {kind:'ratio', numerator:{metric, filter}, denominator:{metric, filter},
  --  as:'percent'|'ratio', dateField}
  definition      jsonb NOT NULL,
  unit            text,
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- A key is unique per owner; a system metric (owner NULL) is unique globally.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_metrics_key
  ON dashboard_metrics (COALESCE(owner_staff_id::text, ''), key);

COMMENT ON TABLE dashboards IS
  'A saved dashboard. The shipped role defaults are rows here too (is_system) — editing one forks it to the editor rather than changing what everyone else sees.';
COMMENT ON TABLE dashboard_cards IS
  'One question per card: a measure, a filter tree, a date field and a period. Never a stored number — every answer is computed live under the VIEWER''s file permissions.';
COMMENT ON TABLE dashboard_metrics IS
  'User-defined KPIs — a ratio of two measures, each with its own filter. Pull-through, fallout and any other rate are defined here rather than hardcoded.';
