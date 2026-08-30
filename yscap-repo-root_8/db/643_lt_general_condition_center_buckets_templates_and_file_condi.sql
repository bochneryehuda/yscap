-- ============================================================================
-- db/643 — LONG-TERM: the GENERAL Condition Center — buckets, the template
--          library, the per-file conditions, and PILOT's own documents on them.
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-30).
--
-- The long-term side already has a Condition Center: db/612's MIRROR of
-- Encompass's Enhanced Conditions and its eFolder. That centre is READ-ONLY and
-- stays exactly as it is. It answers one question — "what has the investor's
-- underwriter raised on this loan?" — and the sweep behind db/612 measured why
-- that is not the day-to-day work: every Encompass condition in this tenant sits
-- on a loan that is already CLOSED AND SOLD. Not one active long-term loan
-- carries a single one. So the mirror is a post-purchase artifact.
--
-- What the owner asked for here is a DIFFERENT centre, for the work that happens
-- BEFORE any of that: the things WE need on a file to get it submitted, cleared
-- to close, docked, funded and sold. Their words:
--
--   "the pre submission / Prior to submission / Prior to clear to close /
--    Prior to docks / Prior to funding / And prior to purchase"
--
--   "everything should be setup with not setting it on a hard level everything
--    should be able to be configured differently in settings. The system is only
--    prefilled with the rules of the system."
--
-- THE SECOND SENTENCE IS WHY THIS IS FOUR TABLES AND NOT A CONSTANT FILE. Every
-- bucket, every condition, every piece of wording and every rule below is a ROW
-- that ships pre-filled with our own answer and can be changed by a buyer in
-- settings without a deploy. A hard-coded list would have been half the work and
-- would have made "sell this system to somebody whose workflow is spelled
-- differently" a code change every time.
--
-- ── THE FIVE BUCKETS, AND THE ONE JUDGEMENT CALL THAT IS FLAGGED ────────────
--
-- The owner named six things and two of them are the same operational gate:
-- "the pre submission" is them naming the concept and "Prior to submission" is
-- the formal name for it, exactly as "Prior to docks" is speech-to-text for
-- "Prior to Docs". So FIVE buckets are seeded.
--
-- THAT IS AN ASSUMPTION, and it is recorded here rather than buried, because it
-- is a workflow question and workflow questions are the owner's. It is seeded in
-- the SAFE direction: if they really are two gates, adding the sixth is one click
-- in settings and nothing has to move. Seeding six when they are one would have
-- left a duplicate bucket with conditions split across it, which is the expensive
-- direction to unwind.
--
-- ── HOW THIS RELATES TO THE MIRROR, WHICH IT MUST NEVER BECOME ──────────────
--
-- db/612's `lt_conditions` is ENCOMPASS'S and is written only by reading them.
-- These tables are OURS and Encompass never sees them. They are deliberately
-- separate tables rather than a flag on one:
--
--   * a mirror row must be safe to DELETE AND RE-READ at any time, and ours
--     carry a human's sign-off, their note and their uploaded documents;
--   * `status_open` on a mirror row is Encompass's own answer and is never
--     derived (db/612's rule 4), while ours is decided here;
--   * and one table would make "is this ours or theirs?" a column somebody has
--     to remember to filter on. It is the table instead.
--
-- ── PRODUCT SEPARATION ──────────────────────────────────────────────────────
--
-- Every object here is lt_*. No RTL table is read, written or referenced. Not
-- one line, column, template or default is copied from RTL's `checklist_items`,
-- `checklist_templates` or `conditions` — CLAUDE.md rule 6 requires this to be a
-- brand-new build and it is one. The FILTER GRAMMAR is deliberately the same
-- SHAPE the short-term rule builder uses (`{combinator, rules:[…]}`, one level of
-- nesting) so the two read the same to a person moving between them; the grammar
-- is a design convention, the engine and every table here are Long-Term's own.
--
-- The only cross-product reference is `staff_users`, the shared identity roster
-- authorized in writing on 2026-08-03 and recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md. Every one of them is ON DELETE SET NULL:
-- deactivating a person must empty a pointer, never delete a loan's history.
--
-- ── ENCOMPASS STAYS ONE-WAY ─────────────────────────────────────────────────
--
-- Nothing here implies a write to Encompass. A document uploaded against one of
-- these conditions is stored in PILOT's own storage; pushing it into the eFolder
-- is a WRITE and stays blocked on docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.
--
-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- NONE onto existing loans, deliberately. The seeds below fill the LIBRARY (the
-- buckets and the templates); not one file condition is created by this file.
-- Attaching conditions to the whole live book in one migration would put a fresh
-- outstanding list on every loan an officer is working, at once, unannounced —
-- and the engine cannot know which of them are already satisfied. A file gains
-- its conditions from the engine, on its own next pass, where the rules and the
-- notifications apply.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
--
-- Every CREATE is guarded, every index is IF NOT EXISTS, every column add is
-- IF NOT EXISTS, and every CHECK is dropped before it is re-added. The seeds are
-- ON CONFLICT DO NOTHING so a buyer's own edit always survives a redeploy — this
-- file must never rewrite a row a human has changed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lt_condition_buckets — the gates a condition can block, in order.
--
-- A BUCKET IS A ROW, NOT AN ENUM, for the reason in the header: a buyer spells
-- their own workflow differently and must be able to add, rename or retire a
-- gate without a migration. `position` is what orders them on every screen, so
-- reordering is an UPDATE rather than a deploy.
--
-- `key` is what a template and a file condition point at, and it is TEXT rather
-- than a foreign key ON PURPOSE: retiring a bucket must not cascade away the
-- conditions filed under it. A file condition whose bucket has been retired
-- still shows, under its own stored label, which is the honest answer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_condition_buckets (
    id          uuid NOT NULL DEFAULT gen_random_uuid(),
    key         text NOT NULL,
    label       text NOT NULL,
    -- What this gate means, in the words a person reads on the screen. Held here
    -- rather than in the code so a buyer's own description travels with their
    -- own bucket.
    blurb       text,
    position    integer NOT NULL DEFAULT 100,
    is_active   boolean NOT NULL DEFAULT true,
    -- TRUE for a row this migration seeded. It is what lets a later reseed tell
    -- "our default, untouched" from "a buyer's own gate", so neither can ever
    -- overwrite the other.
    is_seeded   boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_condition_buckets_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_condition_buckets_key_uk
    ON lt_condition_buckets (key);
CREATE INDEX IF NOT EXISTS lt_condition_buckets_order_idx
    ON lt_condition_buckets (position, key) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 2. lt_condition_templates — THE LIBRARY.
--
-- One row per condition this company can ask for. A file gets a COPY (table 3),
-- never a pointer, for the same reason a loan's terms are snapshotted: editing a
-- template must not silently rewrite what a borrower was already told on a file
-- somebody is working.
--
-- WHY EACH DESCRIPTIVE COLUMN IS TEXT AND NOT AN ENUM: db/612's own reasoning,
-- and it applies here twice over. `kind`, `audience` and `auto_apply` DO carry
-- CHECK constraints, because those three are read by the engine and by the
-- screen — a value outside the list is not a buyer's wording, it is a bug that
-- would render as a blank control.
--
-- `kind` is the owner's own taxonomy, from their request for the write-up: *"If
-- it's an informational condition, a form, an order, a docu-sum, or a document
-- upload"*:
--   informational — a fact to record or acknowledge; nothing is collected.
--   form          — something filled in inside PILOT.
--   order         — something ordered from an outside party.
--   esign         — something signed (the owner's "docu-sum" is DocuSign).
--   document      — a document somebody uploads.
--
-- `audience` is the owner's internal / external split. It is deliberately THREE
-- values rather than a boolean: a condition can be BOTH — the team works it and
-- the borrower can see it — and collapsing that into "external or not" is how a
-- condition ends up either invisible to the person who has to satisfy it or
-- exposed to a borrower it was never written for.
--
-- `rule_logic` is the same `{combinator, rules:[…]}` shape the short-term rule
-- builder uses. NOTHING IN IT IS EVER EVALUATED AS CODE: it names FIELD KEYS the
-- engine's own registry carries, and a key the registry does not carry makes the
-- rule refuse rather than match.
--
-- `slots` describes the named places a document goes ("Binder", "Invoice"), as
-- jsonb rather than rows — a slot has no life of its own and is never queried
-- across files.
--
-- `config` is the per-condition settings the owner asked for by name (which
-- appraisal form for which property type, which vendors an order may go to, and
-- so on). jsonb, because every condition's own settings are its own shape.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_condition_templates (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    code            text NOT NULL,
    bucket_key      text NOT NULL,

    -- The team's wording, and the borrower's. A borrower-facing condition with
    -- no borrower wording is applied STAFF-ONLY by the engine rather than shown
    -- to a client under an internal label.
    label           text NOT NULL,
    hint            text,
    borrower_label  text,
    borrower_hint   text,

    audience        text NOT NULL DEFAULT 'internal',
    kind            text NOT NULL DEFAULT 'document',
    auto_apply      text NOT NULL DEFAULT 'manual',
    rule_logic      jsonb,

    is_required     boolean NOT NULL DEFAULT true,
    slots           jsonb NOT NULL DEFAULT '[]'::jsonb,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- A condition that is BUILT but deliberately not switched on yet. Distinct
    -- from `is_active = false`, which is a buyer retiring one: this one shows on
    -- the file, greyed, WITH ITS REASON, so nobody thinks a feature vanished.
    is_enabled      boolean NOT NULL DEFAULT true,
    disabled_reason text,

    is_active       boolean NOT NULL DEFAULT true,
    sort_order      integer NOT NULL DEFAULT 100,
    is_seeded       boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_condition_templates_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_condition_templates_code_uk
    ON lt_condition_templates (code);
CREATE INDEX IF NOT EXISTS lt_condition_templates_bucket_idx
    ON lt_condition_templates (bucket_key, sort_order) WHERE is_active;
CREATE INDEX IF NOT EXISTS lt_condition_templates_auto_idx
    ON lt_condition_templates (auto_apply) WHERE is_active AND is_enabled;

ALTER TABLE lt_condition_templates DROP CONSTRAINT IF EXISTS lt_condition_templates_audience_check;
ALTER TABLE lt_condition_templates
  ADD CONSTRAINT lt_condition_templates_audience_check
  CHECK (audience IN ('internal', 'external', 'both'));

ALTER TABLE lt_condition_templates DROP CONSTRAINT IF EXISTS lt_condition_templates_kind_check;
ALTER TABLE lt_condition_templates
  ADD CONSTRAINT lt_condition_templates_kind_check
  CHECK (kind IN ('informational', 'form', 'order', 'esign', 'document'));

ALTER TABLE lt_condition_templates DROP CONSTRAINT IF EXISTS lt_condition_templates_auto_check;
ALTER TABLE lt_condition_templates
  ADD CONSTRAINT lt_condition_templates_auto_check
  CHECK (auto_apply IN ('always', 'rules', 'manual'));

-- ---------------------------------------------------------------------------
-- 3. lt_file_conditions — one loan's own conditions.
--
-- THE WORDING IS A SNAPSHOT, not a join. `label`, `hint`, `borrower_label`,
-- `borrower_hint`, `audience`, `kind` and `slots` are COPIED from the template
-- at creation. Editing the library must not silently change what a borrower was
-- already asked for on a live file, and a template retired next year must not
-- blank the condition a file was cleared on.
--
-- `field_key` exists so ONE template can legitimately appear twice on a file —
-- one condition per borrower, one per property — told apart by a key rather than
-- by two look-alike rows. It is part of the uniqueness, with COALESCE so a NULL
-- is one value rather than a hole every duplicate falls through.
--
-- THREE WAYS A CONDITION IS FINISHED, and they are three different facts that
-- must never be collapsed:
--   satisfied — the thing was provided and somebody accepted it.
--   waived    — somebody with the authority decided it is not needed HERE.
--   n/a       — the rules say it never applied to this file.
-- A screen that shows one number for "done" is fine; a table that stores one is
-- not, because "who waived this and why" is the question asked a year later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_file_conditions (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    loan_id         uuid NOT NULL,
    template_id     uuid,
    code            text,
    bucket_key      text NOT NULL,
    field_key       text,

    label           text NOT NULL,
    hint            text,
    borrower_label  text,
    borrower_hint   text,
    audience        text NOT NULL DEFAULT 'internal',
    kind            text NOT NULL DEFAULT 'document',
    is_required     boolean NOT NULL DEFAULT true,
    slots           jsonb NOT NULL DEFAULT '[]'::jsonb,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- What the file has actually answered — a form's fields, an order's chosen
    -- vendor, an informational acknowledgement. Its shape is the condition's own,
    -- which is why it is jsonb and not columns.
    answer          jsonb NOT NULL DEFAULT '{}'::jsonb,

    status          text NOT NULL DEFAULT 'outstanding',
    -- WHY it is on the file: 'auto' is the engine's (and only the engine may
    -- retract one), 'manual' is a person's and is never removed automatically.
    origin          text NOT NULL DEFAULT 'auto',
    sort_order      integer NOT NULL DEFAULT 100,

    notes           text,

    satisfied_at    timestamptz,
    satisfied_by    uuid,
    waived_at       timestamptz,
    waived_by       uuid,
    waived_reason   text,

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_file_conditions_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS lt_file_conditions_loan_idx
    ON lt_file_conditions (loan_id, bucket_key, sort_order);
CREATE INDEX IF NOT EXISTS lt_file_conditions_open_idx
    ON lt_file_conditions (loan_id) WHERE status = 'outstanding';
CREATE INDEX IF NOT EXISTS lt_file_conditions_template_idx
    ON lt_file_conditions (template_id);

-- ONE CONDITION PER TEMPLATE PER FILE PER KEY. The short-term side learned this
-- the expensive way (db/401): its engine suppressed duplicates by READING the
-- file, deciding a template had no instance and THEN inserting, with nothing in
-- between — so two passes at the same instant both read "not there" and both
-- inserted, and ordinary traffic (a save while a webhook lands) produced two of
-- the same condition on one file. A unique index makes that impossible rather
-- than unlikely, and the engine takes a per-file advisory lock as well.
--
-- COALESCE on field_key is load-bearing: two NULLs are DISTINCT in a unique
-- index, so without it every no-key duplicate would sail straight through.
CREATE UNIQUE INDEX IF NOT EXISTS lt_file_conditions_one_per_template_uk
    ON lt_file_conditions (loan_id, template_id, COALESCE(field_key, ''))
    WHERE template_id IS NOT NULL;

ALTER TABLE lt_file_conditions DROP CONSTRAINT IF EXISTS lt_file_conditions_status_check;
ALTER TABLE lt_file_conditions
  ADD CONSTRAINT lt_file_conditions_status_check
  CHECK (status IN ('outstanding', 'in_progress', 'received', 'satisfied', 'waived', 'not_applicable'));

ALTER TABLE lt_file_conditions DROP CONSTRAINT IF EXISTS lt_file_conditions_audience_check;
ALTER TABLE lt_file_conditions
  ADD CONSTRAINT lt_file_conditions_audience_check
  CHECK (audience IN ('internal', 'external', 'both'));

ALTER TABLE lt_file_conditions DROP CONSTRAINT IF EXISTS lt_file_conditions_kind_check;
ALTER TABLE lt_file_conditions
  ADD CONSTRAINT lt_file_conditions_kind_check
  CHECK (kind IN ('informational', 'form', 'order', 'esign', 'document'));

ALTER TABLE lt_file_conditions DROP CONSTRAINT IF EXISTS lt_file_conditions_origin_check;
ALTER TABLE lt_file_conditions
  ADD CONSTRAINT lt_file_conditions_origin_check
  CHECK (origin IN ('auto', 'manual'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_file_conditions_loan_fk'
  ) THEN
    ALTER TABLE lt_file_conditions
      ADD CONSTRAINT lt_file_conditions_loan_fk
      FOREIGN KEY (loan_id) REFERENCES lt_loans (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_file_conditions_satisfied_by_fk'
  ) THEN
    ALTER TABLE lt_file_conditions
      ADD CONSTRAINT lt_file_conditions_satisfied_by_fk
      FOREIGN KEY (satisfied_by) REFERENCES staff_users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_file_conditions_waived_by_fk'
  ) THEN
    ALTER TABLE lt_file_conditions
      ADD CONSTRAINT lt_file_conditions_waived_by_fk
      FOREIGN KEY (waived_by) REFERENCES staff_users (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. lt_condition_files — PILOT's OWN documents against one of these conditions.
--
-- DELIBERATELY NOT db/612's `lt_documents`. That table is Encompass's eFolder,
-- mirrored: its rows are keyed on Encompass's ids, carry `is_removed` because
-- everything upstream is soft-deleted, and must be safe to re-read at any time.
-- A document somebody uploaded HERE has none of those properties and would be
-- destroyed by the next mirror pass.
--
-- `storage_ref` is PILOT's own storage. `sha256` is stored so a re-upload of the
-- same bytes can be recognised rather than filed twice, and so an integrity check
-- has something to compare against.
--
-- NOTHING IS EVER DELETED. A superseded document is `is_current = false` — the
-- record of what was once provided is part of the story of the loan, and a
-- rejected document's reason is what tells the borrower what to send instead.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lt_condition_files (
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    condition_id    uuid NOT NULL,
    loan_id         uuid NOT NULL,
    -- Which named place on the condition this document fills, when it has slots.
    slot_key        text,

    filename        text NOT NULL,
    content_type    text,
    byte_size       bigint,
    sha256          text,
    storage_ref     text NOT NULL,

    uploaded_by     uuid,
    -- 'staff' or 'borrower' — who put it there, which decides whether it is born
    -- awaiting review. Text rather than a CHECK on purpose: a third door (a
    -- vendor returning an order by email) is coming and must not need a
    -- migration to file its first document.
    uploaded_by_kind text NOT NULL DEFAULT 'staff',

    -- Nothing un-reviewed is ever treated as fulfilment. The short-term side
    -- learned this in db/424: `<> 'rejected'` is a test for "nobody threw this
    -- away", not for "somebody checked this", and a never-reviewed document is
    -- 'pending'.
    review_status   text NOT NULL DEFAULT 'pending',
    reviewed_at     timestamptz,
    reviewed_by     uuid,
    review_reason   text,

    is_current      boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_condition_files_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS lt_condition_files_condition_idx
    ON lt_condition_files (condition_id, created_at DESC) WHERE is_current;
CREATE INDEX IF NOT EXISTS lt_condition_files_loan_idx
    ON lt_condition_files (loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lt_condition_files_hash_idx
    ON lt_condition_files (loan_id, sha256) WHERE sha256 IS NOT NULL;

ALTER TABLE lt_condition_files DROP CONSTRAINT IF EXISTS lt_condition_files_review_check;
ALTER TABLE lt_condition_files
  ADD CONSTRAINT lt_condition_files_review_check
  CHECK (review_status IN ('pending', 'accepted', 'rejected', 'superseded'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_condition_files_condition_fk'
  ) THEN
    ALTER TABLE lt_condition_files
      ADD CONSTRAINT lt_condition_files_condition_fk
      FOREIGN KEY (condition_id) REFERENCES lt_file_conditions (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_condition_files_loan_fk'
  ) THEN
    ALTER TABLE lt_condition_files
      ADD CONSTRAINT lt_condition_files_loan_fk
      FOREIGN KEY (loan_id) REFERENCES lt_loans (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_condition_files_uploaded_by_fk'
  ) THEN
    ALTER TABLE lt_condition_files
      ADD CONSTRAINT lt_condition_files_uploaded_by_fk
      FOREIGN KEY (uploaded_by) REFERENCES staff_users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lt_condition_files_reviewed_by_fk'
  ) THEN
    ALTER TABLE lt_condition_files
      ADD CONSTRAINT lt_condition_files_reviewed_by_fk
      FOREIGN KEY (reviewed_by) REFERENCES staff_users (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. THE SEED — the five buckets.
--
-- ON CONFLICT DO NOTHING, so a buyer who renames "Prior to submission" keeps
-- their name through every redeploy. This file fills the library once; it never
-- rewrites it.
-- ---------------------------------------------------------------------------
INSERT INTO lt_condition_buckets (key, label, blurb, position, is_seeded)
VALUES
  ('prior_to_submission', 'Prior to submission',
   'Everything the file needs before it goes to underwriting.', 10, true),
  ('prior_to_ctc', 'Prior to clear to close',
   'What underwriting needs back before the loan is cleared to close.', 20, true),
  ('prior_to_docs', 'Prior to docs',
   'What has to be settled before closing documents are drawn.', 30, true),
  ('prior_to_funding', 'Prior to funding',
   'The last things before the money moves.', 40, true),
  ('prior_to_purchase', 'Prior to purchase',
   'What the investor needs before they buy the loan.', 50, true)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. THE SEED — the condition library.
--
-- DELIBERATELY EMPTY IN THIS FILE. The conditions themselves are a long,
-- carefully-worded list the owner dictated one by one, and each carries a rule,
-- its own settings and, for several of them, wording a borrower reads. Putting
-- them here would mean maintaining that wording in SQL, where the rule engine's
-- own field registry cannot check that the keys a rule names actually exist.
--
-- They are seeded from `src/longterm/conditions-center/library.js` instead — one
-- definition, in the language that can validate it, applied at boot the same way
-- the buckets are here, with the same never-overwrite-a-human rule.
-- ---------------------------------------------------------------------------


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
