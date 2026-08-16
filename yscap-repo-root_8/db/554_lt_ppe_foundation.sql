-- ============================================================================
-- LONG-TERM (LT) — db/554 — PPE foundation (investors, programs, settings store).
--
-- The FIRST migration of the MEGA Product & Pricing Engine (docs/longterm/
-- PPE-MEGA-PLAN.md). It lays the two long-lived anchors the whole engine hangs
-- off — INVESTOR and PROGRAM — plus the investor-alias table (an investor is
-- "spelled 151 ways") and the PPE settings OVERRIDE store. The heavier price-
-- bearing tables (rate-sheet versions, base-price grids, LLPA adjustment rows,
-- rules) land in a later migration on top of these anchors.
--
-- MULTI-TENANCY follows the established LT convention (see lt_settings, db/553):
-- a `scope` TEXT column defaulting to 'company'. Selling this engine to a second
-- lender is a NEW SCOPE VALUE, never a schema change. Every configurable row
-- carries it; every unique key is scoped.
--
-- SELLABLE (Rule #1): nothing here encodes a value specific to us. The setting
-- DEFINITIONS (types, option sets, and OUR pre-filled defaults) live in code
-- (src/longterm/ppe/settings.js — the single source of truth); this table stores
-- only the OVERRIDES a tenant sets on top of those defaults. A missing row, a
-- missing key, or an unreadable table all resolve to the coded default — the
-- system degrades to the industry-standard default, never to nothing.
--
-- SEPARATION. Every table is lt_ppe_*; no RTL table is read or written; no
-- function and no trigger is defined here. `updated_by`/`created_by` are plain
-- UUID columns (no FK) so this migration references no other product's tables.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma (the LtPpe*
-- models). Model and migration land in the same commit.
-- ---------------------------------------------------------------------------

-- lt_ppe_investor — a note buyer / capital provider. The stable anchor.
--   `code`  — a stable, tenant-unique short code (never renamed).
--   `name`  — the human name. INTERNAL-ONLY: an investor name may never reach a
--             borrower/TPO surface (the standing hard rule).
CREATE TABLE IF NOT EXISTS lt_ppe_investor (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       TEXT NOT NULL DEFAULT 'company',
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT true,
    created_by  UUID,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_investor_scope_code_uk UNIQUE (scope, code)
);

-- lt_ppe_investor_alias — every recorded spelling of an investor, so a hand-typed
-- or vendor-supplied name resolves to the one canonical investor. `alias_norm` is
-- the lowercased, punctuation-stripped match key; `alias` keeps the original.
CREATE TABLE IF NOT EXISTS lt_ppe_investor_alias (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope        TEXT NOT NULL DEFAULT 'company',
    investor_id  UUID NOT NULL REFERENCES lt_ppe_investor(id) ON DELETE CASCADE,
    alias_norm   TEXT NOT NULL,
    alias        TEXT NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_investor_alias_scope_norm_uk UNIQUE (scope, alias_norm)
);
CREATE INDEX IF NOT EXISTS lt_ppe_investor_alias_investor_idx
    ON lt_ppe_investor_alias (investor_id);

-- lt_ppe_program — a product family under an investor (several per investor).
--   `channel`     — correspondent / wholesale / retail (default correspondent).
--   Eligibility-domain fields are first-class so the program's outer bounds are
--   queryable without opening a rule set; the fine-grained rules live in a later
--   table. `investor_id` NULL = a house/base program not tied to one investor.
--   `status` — draft | shadow | live | retired (the per-investor lifecycle; the
--   engine prices a program for the business only when it is shadow or live, and
--   Lender Price stays authoritative until it is live).
CREATE TABLE IF NOT EXISTS lt_ppe_program (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope             TEXT NOT NULL DEFAULT 'company',
    investor_id       UUID REFERENCES lt_ppe_investor(id) ON DELETE CASCADE,
    code              TEXT NOT NULL,
    name              TEXT NOT NULL,
    channel           TEXT NOT NULL DEFAULT 'correspondent',
    status            TEXT NOT NULL DEFAULT 'draft',
    -- Outer eligibility domain (fine rules live in the rule table). NULL = unset.
    max_loan_amount   NUMERIC(14,2),
    max_ltv           NUMERIC(6,3),
    min_fico          INTEGER,
    min_dscr          NUMERIC(6,3),
    cash_out_allowed  BOOLEAN,
    property_types    JSONB,           -- the eligible property-type set
    meta              JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by        UUID,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_program_scope_investor_code_uk UNIQUE (scope, investor_id, code),
    CONSTRAINT lt_ppe_program_channel_chk CHECK (channel IN ('correspondent','wholesale','retail')),
    CONSTRAINT lt_ppe_program_status_chk  CHECK (status IN ('draft','shadow','live','retired'))
);
CREATE INDEX IF NOT EXISTS lt_ppe_program_investor_idx ON lt_ppe_program (investor_id);

-- lt_ppe_setting_value — the OVERRIDE store for the coded setting definitions.
-- Mirrors lt_settings exactly (scope + key + jsonb). The definitions and OUR
-- defaults are code (settings.js); this holds only what a tenant changed. A key
-- not present in the code definitions is refused at the app layer before it is
-- written, so this can never become a junk drawer.
CREATE TABLE IF NOT EXISTS lt_ppe_setting_value (
    scope       TEXT NOT NULL DEFAULT 'company',
    key         TEXT NOT NULL,
    value       JSONB NOT NULL,
    updated_by  UUID,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_setting_value_pkey PRIMARY KEY (scope, key)
);
