-- ============================================================================
-- LONG-TERM (LT) — db/553 — the pipeline foundation.
--
-- The THIRD Long-Term migration. db/547 brought the milestone catalog, db/549
-- the loan application (the URLA spine). This one adds everything the long-term
-- PIPELINE needs before a screen can exist:
--
--   lt_settings          the persistence the 44-setting layer has been missing
--   lt_encompass_users   the Encompass roster, mirrored
--   lt_staff_links       Encompass person  ->  PILOT person  (admin-confirmed)
--   lt_loan_contacts     who is on this loan, per role
--   lt_pipeline_views    a user's saved pipeline views
--   lt_locks             the current lock posture per loan
--   lt_lock_events       how it got there
--
-- plus the pipeline columns lt_loans was missing (milestone name, folder, our
-- own stage key, and the Encompass modification stamp the sync pages on).
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma. Keep the two
-- in step — the rule is that a model and its migration land in the same commit.
--
-- WHY SO FEW ENUMS. Anything that varies by lender is text plus a settings-driven
-- list. `lt_loan_contacts.role` is the case worth explaining: it looks like a
-- perfect enum, and it is not. A read-only probe of the live tenant on 2026-08-14
-- found this instance has NO role called "Loan Officer" (its loan-officer slot is
-- `Loan Coordinator`, roleId 1), and that `Loan Opener`, `Shipper` and `Insurer`
-- — all standard Encompass roles — do not exist here at all. Role names are a
-- TENANT configuration. An enum would be a migration every time a buyer of this
-- system spells their org chart differently, which is exactly what the
-- sellable-LOS rule forbids. So: text, with the list living in settings.
--
-- SEPARATION. Every table is lt_*; no RTL table is read or written; no function
-- and no trigger is defined here. The only cross-product reference is
-- `sql-ref staff_users`, authorized in writing 2026-08-03 and recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md. Every such FK is ON DELETE SET NULL:
-- deactivating a person must never delete a loan's history, only empty a pointer.
--
-- ENCOMPASS STAYS ONE-WAY. Every column here is filled by READING Encompass.
-- Nothing in this migration implies a write, and the override columns on
-- lt_loan_contacts are deliberately PILOT-side only — see the note there.
--
-- Idempotent (re-run safe on every boot): every CREATE is guarded, enum types are
-- created only when absent, every column add is IF NOT EXISTS, and every foreign
-- key is added only when it is not already there.
-- ============================================================================

-- Enum types ----------------------------------------------------------------
-- Exactly one, and only because its three states are true of the domain rather
-- than of us: a proposed mapping is either awaiting a human, accepted, or refused.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_link_status') THEN
    CREATE TYPE lt_link_status AS ENUM ('suggested', 'confirmed', 'rejected');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- lt_settings — the persistence behind src/longterm/settings/encompass-settings.js
--
-- That module already declares 44 settings in 10 groups with OUR values as the
-- defaults, and a resolve(overrides) that accepts overrides. It has never had a
-- table. This is it.
--
-- Reads start from the declared defaults and overlay this table, so a missing row,
-- a missing key, or an unreadable table all resolve to a concrete value — the
-- system degrades to OUR behaviour rather than to nothing.
--
-- `scope` is 'company' today. It exists so that selling this system to a second
-- lender is a new scope value rather than a schema change.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_settings (
    scope       TEXT NOT NULL DEFAULT 'company',
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    updated_by  UUID,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_settings_pkey PRIMARY KEY (scope, key)
);

-- ---------------------------------------------------------------------------
-- lt_encompass_users — the Encompass roster, mirrored.
--
-- `login_id` is the primary key because it is the only stable identity Encompass
-- exposes: it is what `LoanTeamMember.UserId.<role>` returns and what
-- /encompass/v1/company/users reports as `id`.
--
-- Do NOT key anything on email or full name. Measured on this tenant: 10 of the
-- 46 users share the placeholder address `change.me@email.com`, and names carry
-- double and trailing spaces.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_encompass_users (
    login_id            TEXT NOT NULL,
    full_name           TEXT,
    email               TEXT,
    phone               TEXT,
    personas            TEXT[] NOT NULL DEFAULT '{}',
    role_names          TEXT[] NOT NULL DEFAULT '{}',
    is_active           BOOLEAN NOT NULL DEFAULT true,
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_encompass_users_pkey PRIMARY KEY (login_id)
);

CREATE INDEX IF NOT EXISTS lt_encompass_users_email_idx ON lt_encompass_users (lower(email));

-- ---------------------------------------------------------------------------
-- lt_staff_links — Encompass person -> PILOT person.
--
-- Owner-directed 2026-08-14: auto-match by email, an ADMIN CONFIRMS.
--
-- `status` is the whole point. A 'suggested' link is displayed and never acted
-- on; only a 'confirmed' link decides whose pipeline a file appears in. A shared
-- or mistyped Encompass email must never silently hand somebody another officer's
-- book — and on this tenant that is not hypothetical, because ten users share one
-- placeholder address.
--
-- `staff_id` is the authorized `sql-ref staff_users`, ON DELETE SET NULL: a
-- deactivated staff member must leave the Encompass row and its history intact.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_staff_links (
    encompass_login_id TEXT NOT NULL,
    staff_id           UUID,
    status             lt_link_status NOT NULL DEFAULT 'suggested',
    match_method       TEXT,
    confirmed_by       UUID,
    confirmed_at       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_staff_links_pkey PRIMARY KEY (encompass_login_id)
);

-- One PILOT person may hold at most one CONFIRMED Encompass identity. A suggested
-- duplicate is allowed on purpose — that is precisely the ambiguity an admin is
-- being asked to resolve, and refusing to record it would hide the conflict.
CREATE UNIQUE INDEX IF NOT EXISTS lt_staff_links_confirmed_staff_uk
    ON lt_staff_links (staff_id) WHERE status = 'confirmed' AND staff_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lt_staff_links_status_idx ON lt_staff_links (status);

-- ---------------------------------------------------------------------------
-- lt_loan_contacts — who is on this loan.
--
-- Encompass fills it; PILOT may override locally (owner-directed 2026-08-14).
-- That is deliberately two sources of truth, so the columns keep them apart:
--
--   encompass_*        always stored, always shown, refreshed by every sync
--   override_staff_id  a PILOT-side routing decision, stamped with who and why
--
-- A sync NEVER clears an override, and an override NEVER overwrites the Encompass
-- columns. When the two disagree the screen says so, with both names visible —
-- silent divergence is the failure mode of every two-source design, and naming it
-- is the fix. NOTHING here is ever written back to Encompass.
--
-- `role` is TEXT, not an enum — see the header note.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_loan_contacts (
    id                  UUID NOT NULL,
    loan_id             UUID NOT NULL,
    role                TEXT NOT NULL,
    encompass_name      TEXT,
    encompass_email     TEXT,
    encompass_phone     TEXT,
    encompass_login_id  TEXT,
    staff_id            UUID,
    override_staff_id   UUID,
    override_by         UUID,
    override_at         timestamptz,
    override_reason     TEXT,
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_loan_contacts_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lt_loan_contacts_loan_role_uk ON lt_loan_contacts (loan_id, role);
CREATE INDEX IF NOT EXISTS lt_loan_contacts_staff_idx ON lt_loan_contacts (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lt_loan_contacts_override_idx ON lt_loan_contacts (override_staff_id) WHERE override_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lt_loan_contacts_login_idx ON lt_loan_contacts (encompass_login_id);

-- ---------------------------------------------------------------------------
-- lt_pipeline_views — a user's saved pipeline views.
-- A saved view is a row, never a code change.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_pipeline_views (
    id          UUID NOT NULL,
    staff_id    UUID,
    name        TEXT NOT NULL,
    filters     JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_default  BOOLEAN NOT NULL DEFAULT false,
    sort_order  INTEGER NOT NULL DEFAULT 100,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_pipeline_views_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS lt_pipeline_views_staff_idx ON lt_pipeline_views (staff_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS lt_pipeline_views_default_uk
    ON lt_pipeline_views (staff_id) WHERE is_default AND staff_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- lt_locks — the current lock posture, mirrored. READ-ONLY from Encompass.
--
-- HARD RULE, from the API research and repeated here because getting it wrong is
-- silent: TRUST `expiration_date`. Never recompute it from lock date plus days.
-- Extensions and re-locks move it, and a recomputed date will quietly disagree
-- with the investor's.
--
-- Measured 2026-08-14: every lock-SPECIFIC endpoint on this tenant answers 403,
-- so this table is filled from the loan itself (`?entities=rateLock`, fields
-- 761/762, the Loan.Lock* canonicals) rather than from the lock request history.
-- Field 2148 is EMPTY on this tenant despite being widely documented as the lock
-- date — do not reach for it.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_locks (
    loan_id             UUID NOT NULL,
    lock_status         TEXT,
    note_rate_pct       DECIMAL(9,5),
    price               DECIMAL(12,5),
    lock_date           DATE,
    expiration_date     DATE,
    lock_days           INTEGER,
    product_name        TEXT,
    commitment_type     TEXT,
    raw                 JSONB,
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_locks_pkey PRIMARY KEY (loan_id)
);

CREATE INDEX IF NOT EXISTS lt_locks_expiration_idx ON lt_locks (expiration_date) WHERE expiration_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- lt_lock_events — how the lock got where it is.
--
-- Append-only history beside a snapshot-replaced posture. A lock can be rolled
-- back exactly as a milestone can, so the current state is replaced wholesale on
-- each sync while the history is only ever added to.
--
-- This table will be THIN until the 403s are lifted — the request history is not
-- readable on this client registration today. That is recorded rather than hidden.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_lock_events (
    id                  UUID NOT NULL,
    loan_id             UUID NOT NULL,
    event_type          TEXT NOT NULL,
    event_at            timestamptz,
    note_rate_pct       DECIMAL(9,5),
    price               DECIMAL(12,5),
    expiration_date     DATE,
    actor_name          TEXT,
    raw                 JSONB,
    encompass_synced_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_lock_events_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS lt_lock_events_loan_idx ON lt_lock_events (loan_id, event_at DESC);

-- ---------------------------------------------------------------------------
-- lt_loans — the pipeline columns it was missing.
--
-- `milestone_name` is mirrored verbatim from MS.STATUS. Read it from there: the
-- pipeline's own Loan.CurrentMilestone column is BLANK on every loan in this
-- tenant.
--
-- `stage_key` is OUR stage — the second of the three layers the owner directed on
-- 2026-08-14 ("use the Encompass stages, but map those Encompass stages to our own
-- stages"). It is stored rather than derived on read so the pipeline can group and
-- sort on it in SQL. A milestone with no mapping leaves it NULL, and an unmapped
-- loan is SHOWN under its raw Encompass name rather than hidden — losing a loan
-- off a screen is the worse error.
--
-- The borrower's stage is deliberately NOT stored here. It comes from the
-- milestone's own consumer_status (db/547), so our internal renaming can never
-- leak into what a borrower reads.
-- ---------------------------------------------------------------------------

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS milestone_name           TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS stage_key                TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS loan_folder              TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_last_modified  timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS encompass_sync_error     TEXT;

CREATE INDEX IF NOT EXISTS lt_loans_stage_idx  ON lt_loans (stage_key);
CREATE INDEX IF NOT EXISTS lt_loans_folder_idx ON lt_loans (loan_folder);
CREATE INDEX IF NOT EXISTS lt_loans_synced_idx ON lt_loans (encompass_synced_at NULLS FIRST);

-- Foreign keys ---------------------------------------------------------------
-- LT -> LT cascades (a loan's own rows die with it). The authorized identity link
-- (staff_users) is SET NULL instead, so a person record disappearing can never
-- take a loan file, an override, or a saved view with it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_staff_links_login_fkey') THEN
    ALTER TABLE lt_staff_links ADD CONSTRAINT lt_staff_links_login_fkey
      FOREIGN KEY (encompass_login_id) REFERENCES lt_encompass_users(login_id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_staff_links_staff_fkey') THEN
    ALTER TABLE lt_staff_links ADD CONSTRAINT lt_staff_links_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_staff_links_confirmed_by_fkey') THEN
    ALTER TABLE lt_staff_links ADD CONSTRAINT lt_staff_links_confirmed_by_fkey
      FOREIGN KEY (confirmed_by) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_settings_updated_by_fkey') THEN
    ALTER TABLE lt_settings ADD CONSTRAINT lt_settings_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loan_contacts_loan_fkey') THEN
    ALTER TABLE lt_loan_contacts ADD CONSTRAINT lt_loan_contacts_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loan_contacts_staff_fkey') THEN
    ALTER TABLE lt_loan_contacts ADD CONSTRAINT lt_loan_contacts_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loan_contacts_override_fkey') THEN
    ALTER TABLE lt_loan_contacts ADD CONSTRAINT lt_loan_contacts_override_fkey
      FOREIGN KEY (override_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loan_contacts_override_by_fkey') THEN
    ALTER TABLE lt_loan_contacts ADD CONSTRAINT lt_loan_contacts_override_by_fkey
      FOREIGN KEY (override_by) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- SET NULL, like every other identity link here — NOT the CASCADE a personal
  -- saved view seems to invite. The invariant "no delete in the identity zone ever
  -- removes a long-term row" is worth more than tidying away one dead preference
  -- row: it is simple, auditable, asserted against the database itself by
  -- test-lt-loan-schema-db, and an invariant with one convenience exception is how
  -- invariants stop being believed. A view whose owner is gone belongs to nobody,
  -- and every read is scoped to `staff_id = <me>`, so it simply stops appearing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_pipeline_views_staff_fkey') THEN
    ALTER TABLE lt_pipeline_views ADD CONSTRAINT lt_pipeline_views_staff_fkey
      FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_locks_loan_fkey') THEN
    ALTER TABLE lt_locks ADD CONSTRAINT lt_locks_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_lock_events_loan_fkey') THEN
    ALTER TABLE lt_lock_events ADD CONSTRAINT lt_lock_events_loan_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
