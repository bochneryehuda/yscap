-- ============================================================================
-- db/571 — lt ppe rule and suggestion store
--
-- WHAT THIS CHANGES, AND WHY. The LT PPE rules engine (rules.js) evaluates
-- eligibility/bound/pricing rules, and ratesheet.js produces PRICING rules from
-- lt_ppe_adjustment rows — but eligibility/bound rules had NO persistent home
-- (ratesheet.js itself says "eligibility/bound rules live in a later rule
-- table"). This is that table (lt_ppe_rule), the home for an accepted overlay
-- rule per investor/program. Alongside it, lt_ppe_rule_suggestion is the
-- proposal store: the manual-review engine reads Lender Price's declines and
-- SUGGESTS per-investor rules (disqualify-analysis / crosswalk); a human accepts
-- a suggestion, which writes an lt_ppe_rule and links back. Nothing here prices
-- or blocks anything by itself; a suggestion is a proposal, never auto-applied.
--
-- BACKFILL: none. Both tables start empty; rules are authored/accepted going
-- forward. LT-only (lt_* tables, scope-based multi-tenancy), no RTL reference.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly. The four shapes the
-- hygiene gate enforces:
--
--   CREATE TABLE IF NOT EXISTS t (...);
--   CREATE INDEX IF NOT EXISTS t_col_idx ON t (col);
--   ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;
--   ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;   -- always drop first,
--   ALTER TABLE t ADD CONSTRAINT t_chk CHECK (...);  -- then re-add
--
-- RE-ASSERTING A CHECK. If this file widens a CHECK constraint that an earlier
-- migration also asserts, name EVERY value the earlier files added, not just
-- the new one — the older file replays too, and a narrower re-assert would roll
-- this one back the moment a row uses the new value.
--
-- BACKFILL. State the decision explicitly, even when it is "none". Silence
-- reads as "not considered".
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. If this touches
-- `lt_*`, it is Long-Term's and must not reach into RTL's; if it touches RTL's,
-- the reverse. `check-product-separation.js` is the gate.
-- ============================================================================

-- ── lt_ppe_rule — the persistent home for eligibility/bound/pricing rules ────
-- One row per rule, scoped by tenant (`scope`), optionally to an investor and/or
-- a program. `source='overlay'` rules can only tighten (rules.js enforces that at
-- evaluation). `predicate` is the `when` tree; a bound carries target/op/value; a
-- pricing rule carries `adjustment`. Provenance: `origin` says how the rule got
-- here (manual authoring, an accepted suggestion, or an imported sheet), and
-- `lp_decline_reason` keeps Lender Price's verbatim key when it came from a
-- disqualification suggestion.
-- NOTE: lt_ppe_investor.id and lt_ppe_program.id are UUID (db/558) and lt_ppe_program(id) is UUID
-- (db/560), so investor_id/program_id here MUST be UUID — a bigint column cannot reference a UUID key.
CREATE TABLE IF NOT EXISTS lt_ppe_rule (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope             text        NOT NULL DEFAULT 'company',
  investor_id       uuid        REFERENCES lt_ppe_investor(id) ON DELETE CASCADE,
  program_id        uuid        REFERENCES lt_ppe_program(id) ON DELETE CASCADE,
  code              text        NOT NULL,
  kind              text        NOT NULL DEFAULT 'eligibility',
  source            text        NOT NULL DEFAULT 'overlay',
  predicate         jsonb,                    -- the `when` tree
  decline_reason    text,                     -- eligibility: the human decline reason
  bound_target      text,                     -- bound: the target fact
  bound_op          text,                     -- bound: 'max' | 'min'
  bound_value       numeric,                  -- bound: the value
  adjustment        jsonb,                    -- pricing: { code, category, adjMilli, ... }
  priority          integer     NOT NULL DEFAULT 0,
  description       text,
  active            boolean     NOT NULL DEFAULT true,
  origin            text        NOT NULL DEFAULT 'manual',   -- manual | suggested | imported
  lp_decline_reason text,                     -- the verbatim Lender Price key, when suggested
  effective_from    timestamptz NOT NULL DEFAULT now(),
  effective_to      timestamptz,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- One rule per code within a (scope, investor, program). COALESCE the nullable
-- anchors so a house rule (investor_id/program_id NULL) still dedupes cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS lt_ppe_rule_code_uk
  ON lt_ppe_rule (scope,
                  COALESCE(investor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                  COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX IF NOT EXISTS lt_ppe_rule_lookup_idx
  ON lt_ppe_rule (scope, investor_id, program_id) WHERE active;

ALTER TABLE lt_ppe_rule DROP CONSTRAINT IF EXISTS lt_ppe_rule_kind_chk;
ALTER TABLE lt_ppe_rule ADD CONSTRAINT lt_ppe_rule_kind_chk
  CHECK (kind IN ('eligibility', 'bound', 'pricing'));
ALTER TABLE lt_ppe_rule DROP CONSTRAINT IF EXISTS lt_ppe_rule_source_chk;
ALTER TABLE lt_ppe_rule ADD CONSTRAINT lt_ppe_rule_source_chk
  CHECK (source IN ('base', 'overlay'));
ALTER TABLE lt_ppe_rule DROP CONSTRAINT IF EXISTS lt_ppe_rule_origin_chk;
ALTER TABLE lt_ppe_rule ADD CONSTRAINT lt_ppe_rule_origin_chk
  CHECK (origin IN ('manual', 'suggested', 'imported'));

-- ── lt_ppe_rule_suggestion — the proposal store (never auto-applied) ─────────
-- One row per DISTINCT disqualification the review engine mined from Lender
-- Price, per investor. `dedupe_key` is the analysis distinct identity
-- (adjType|reasonText) so re-running never duplicates a proposal. A human
-- decides: accept → writes an lt_ppe_rule and links it in `created_rule_id`;
-- dismiss → stays for the record. `predicate` is the crosswalk's suggested
-- `when`; an UNMAPPABLE reason is stored with predicate NULL + needs_human=true
-- so it is surfaced, never guessed.
CREATE TABLE IF NOT EXISTS lt_ppe_rule_suggestion (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope             text        NOT NULL DEFAULT 'company',
  investor_id       uuid        REFERENCES lt_ppe_investor(id) ON DELETE SET NULL,
  investor_label    text        NOT NULL,               -- the verbatim investor name/key
  dedupe_key        text        NOT NULL,               -- adjType|reasonText (the distinct identity)
  code              text        NOT NULL,               -- the deterministic suggested rule code
  kind              text        NOT NULL DEFAULT 'eligibility',
  source            text        NOT NULL DEFAULT 'overlay',
  predicate         jsonb,                              -- the suggested `when` (NULL if unmappable)
  decline_reason    text        NOT NULL,               -- the verbatim Lender Price key
  adj_type          text,                               -- the Lender Price adjType
  fact              text,                               -- the mapped fact/dimension
  confidence        text,                               -- strong | possible
  matched_by        text,                               -- adjType | text
  needs_human       boolean     NOT NULL DEFAULT false, -- true = unmappable, a human must map it
  programs          jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- the programs it was seen on
  occurrences       integer     NOT NULL DEFAULT 1,
  status            text        NOT NULL DEFAULT 'open',       -- open | accepted | dismissed | superseded
  created_rule_id   bigint      REFERENCES lt_ppe_rule(id) ON DELETE SET NULL,
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- One suggestion per distinct disqualification per investor (the dedup identity).
CREATE UNIQUE INDEX IF NOT EXISTS lt_ppe_rule_suggestion_uk
  ON lt_ppe_rule_suggestion (scope, investor_label, dedupe_key);
CREATE INDEX IF NOT EXISTS lt_ppe_rule_suggestion_open_idx
  ON lt_ppe_rule_suggestion (scope, status) WHERE status = 'open';

ALTER TABLE lt_ppe_rule_suggestion DROP CONSTRAINT IF EXISTS lt_ppe_rule_suggestion_status_chk;
ALTER TABLE lt_ppe_rule_suggestion ADD CONSTRAINT lt_ppe_rule_suggestion_status_chk
  CHECK (status IN ('open', 'accepted', 'dismissed', 'superseded'));


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
