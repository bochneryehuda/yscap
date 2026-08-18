-- ============================================================================
-- db/577 — lt ppe rule draft (authoring, not publishing)
--
-- WHAT THIS CHANGES, AND WHY. The rule-authoring editor needs somewhere to put a
-- rule a human is still working on. `lt_ppe_rule` (db/571) is the LIVE set —
-- `rule-store.rulesForProgram` selects `active AND effective_from <= now()`, and
-- that set is what every quote prices from. So writing an authored rule straight
-- into it makes it live the instant it is saved, and the boundary the owner asked
-- for ("authoring is not publishing") would exist only as a convention somebody
-- has to remember. This is that boundary, made structural: a draft lives in its
-- own table, nothing reads it when pricing, and it reaches `lt_ppe_rule` only
-- through one deliberate act that records who did it.
--
-- WHY NOT REUSE `lt_ppe_rule` WITH active=false. Three reasons, and the first is
-- decisive:
--   1. `lt_ppe_rule_code_uk` is UNIQUE on (scope, investor, program, code) with no
--      `active` term. Drafting an EDIT to a live rule means holding the live rule
--      and its proposed next version at the same time, under the same code — that
--      index makes it impossible. The editor's most ordinary operation could not
--      be stored.
--   2. `active=false` already means "retired / switched off". Overloading it with
--      "never published" leaves nobody able to tell the two apart, and makes
--      publish ambiguous: does it promote a draft, or re-arm a rule somebody
--      deliberately turned off?
--   3. There is nowhere to record the publish ACT. `created_by`/`created_at`
--      describe when the row was written, not who decided it should start pricing
--      loans, which is the fact worth keeping.
--
-- WHY THE RULE IS ONE jsonb AND NOT SHREDDED INTO COLUMNS the way lt_ppe_rule
-- shreds it. `rule-builder.validateRule` is the ONE definition of a valid rule.
-- Shredding a draft into per-kind columns would create a SECOND representation of
-- the same thing, plus a second re-assembly on the way out, and the two could
-- drift — at which point what publishes is not what a human reviewed. Storing the
-- canonical rule verbatim means the bytes that were validated are the bytes that
-- publish. `code`/`kind` are duplicated out as plain columns for listing and for
-- the uniqueness rule below; they are a projection of the jsonb, never a second
-- source of truth.
--
-- BACKFILL: none, and deliberately. The table starts empty. Every row in
-- `lt_ppe_rule` today arrived through the suggestion-accept path (db/571) or by
-- hand; inventing a retrospective "draft" for each would be a record of a review
-- that never happened.
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
-- RE-ASSERTING A CHECK. This file asserts no constraint an earlier file also
-- asserts — `lt_ppe_rule_draft` is new here, so its CHECKs are its own.
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. Everything below is
-- `lt_*` and references only `lt_*` / `lt_ppe_*`; nothing reaches into RTL.
-- `check-product-separation.js` is the gate.
-- ============================================================================

-- ── lt_ppe_rule_draft — a rule being authored, which prices nothing ──────────
-- One row per rule a human is working on. NOTHING in the pricing path reads this
-- table: `rule-store.rulesForProgram` (the set an engine evaluates) selects from
-- `lt_ppe_rule` alone, so a draft cannot move a priced number no matter what it
-- says or how wrong it is. That is the whole point of the table existing.
--
-- `based_on_rule_id` is the live rule this draft proposes to replace, when there
-- is one — it is what makes "edit the live rule" expressible without touching the
-- live rule. `published_rule_id` is the row it became; the two are separate
-- because a draft may edit rule A and, if A were deleted meanwhile, publish as a
-- new row.
CREATE TABLE IF NOT EXISTS lt_ppe_rule_draft (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope             text        NOT NULL DEFAULT 'company',
  investor_id       uuid        REFERENCES lt_ppe_investor(id) ON DELETE CASCADE,
  program_id        uuid        REFERENCES lt_ppe_program(id) ON DELETE CASCADE,
  code              text        NOT NULL,   -- projection of rule->>'code' (see header)
  kind              text        NOT NULL,   -- projection of rule->>'kind'
  rule              jsonb       NOT NULL,   -- THE canonical rule, exactly as validateRule accepts it
  status            text        NOT NULL DEFAULT 'draft',   -- draft | published | discarded
  based_on_rule_id  bigint      REFERENCES lt_ppe_rule(id) ON DELETE SET NULL,
  note              text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- the publish ACT, recorded. NULL on every unpublished draft.
  published_rule_id bigint      REFERENCES lt_ppe_rule(id) ON DELETE SET NULL,
  published_by      text,
  published_at      timestamptz,
  publish_note      text
);

-- ONE OPEN DRAFT PER CODE, and only while it is open. Two people drafting the same
-- rule at once is a collision worth refusing at the database rather than resolving
-- by whoever saved last; a PUBLISHED or DISCARDED draft is history and must not
-- stop the next one being written, which is why the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS lt_ppe_rule_draft_open_uk
  ON lt_ppe_rule_draft (scope,
                        COALESCE(investor_id, '00000000-0000-0000-0000-000000000000'::uuid),
                        COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid), code)
  WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS lt_ppe_rule_draft_lookup_idx
  ON lt_ppe_rule_draft (scope, investor_id, program_id, status);

ALTER TABLE lt_ppe_rule_draft DROP CONSTRAINT IF EXISTS lt_ppe_rule_draft_status_chk;
ALTER TABLE lt_ppe_rule_draft ADD CONSTRAINT lt_ppe_rule_draft_status_chk
  CHECK (status IN ('draft', 'published', 'discarded'));
ALTER TABLE lt_ppe_rule_draft DROP CONSTRAINT IF EXISTS lt_ppe_rule_draft_kind_chk;
ALTER TABLE lt_ppe_rule_draft ADD CONSTRAINT lt_ppe_rule_draft_kind_chk
  CHECK (kind IN ('eligibility', 'bound', 'pricing'));

-- A PUBLISHED DRAFT MUST NAME WHO PUBLISHED IT. The recording is the authorization
-- (the same discipline db/576 applies to a rate-sheet publish override), so the
-- database refuses the state where a draft went live and nothing says who decided
-- it. Written as a table CHECK rather than a trigger because it is a statement
-- about one row and needs no other row to judge it.
ALTER TABLE lt_ppe_rule_draft DROP CONSTRAINT IF EXISTS lt_ppe_rule_draft_published_chk;
ALTER TABLE lt_ppe_rule_draft ADD CONSTRAINT lt_ppe_rule_draft_published_chk
  CHECK (status <> 'published'
         OR (published_at IS NOT NULL AND published_by IS NOT NULL AND published_rule_id IS NOT NULL));


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
