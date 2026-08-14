-- ============================================================================
-- LONG-TERM (LT) — db/548 — the loan application, laid out like a standard LOS.
--
-- The SECOND Long-Term migration, and the one that turns the Encompass research
-- into a data model. Creates 12 lt_* tables and 11 lt_* enum types covering the
-- URLA / Form 1003 (MISMO 3.4 ULAD) spine:
--
--   1a        Personal information .......... lt_parties
--   1b-1d     Employment .................... lt_employments   (OFF for DSCR)
--   1e        Other income .................. lt_other_incomes
--   2a/2b     Assets ........................ lt_assets
--   2c/2d     Liabilities ................... lt_liabilities
--   3a        Property you own (REO) ........ lt_reo_properties
--   4a        Loan and property ............. lt_loans + lt_properties
--   4b/4c     Rental income ................. lt_properties.gross_monthly_rent
--   5a/5b     Declarations .................. lt_declarations
--
-- plus lt_borrower_pairs (Encompass `applications[]` - a LIST, because the tenant
-- is configured for six pairs) and lt_loan_investors (the investor identity chain
-- whose loan number the owner said must "survive like crazy").
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma. This file was
-- generated from that schema with `prisma migrate diff --from-empty` and then made
-- idempotent by hand. Keep the two in step - the Prisma file carries the Encompass
-- field id and the reasoning behind every column.
--
-- SEPARATION. Every table is lt_*; no RTL table is read or written; no function and
-- no trigger is defined here. The only cross-product references are the two the
-- owner authorized in writing on 2026-08-03 and recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md - `sql-ref borrowers` (a long-term file knows
-- its borrower) and `sql-ref staff_users` (it knows its officer). Both are declared
-- ON DELETE SET NULL: removing a person must never delete a loan file, it must only
-- leave the pointer empty. Long-Term still never WRITES either table.
--
-- Idempotent (re-run safe on every boot): every CREATE is guarded, the enum types
-- are created only when absent (Postgres has no CREATE TYPE IF NOT EXISTS), and
-- every foreign key is added only when it is not already there.
-- ============================================================================

-- Enum types ----------------------------------------------------------------
-- Deliberately few. Anything that varies by lender (a program name, an investor,
-- a document type) is text plus a settings-driven list, never an enum - an enum is
-- a migration every time the buyer of this system wants a different word.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_product_kind') THEN
    CREATE TYPE lt_product_kind AS ENUM ('dscr', 'full_doc', 'bank_statement', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_loan_purpose') THEN
    CREATE TYPE lt_loan_purpose AS ENUM ('purchase', 'rate_term_refinance', 'cash_out_refinance');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_lien_position') THEN
    CREATE TYPE lt_lien_position AS ENUM ('first', 'second');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_amortization_type') THEN
    CREATE TYPE lt_amortization_type AS ENUM ('fixed', 'adjustable');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_party_role') THEN
    CREATE TYPE lt_party_role AS ENUM ('borrower', 'coborrower');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_party_type') THEN
    CREATE TYPE lt_party_type AS ENUM ('individual', 'entity');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_residency_type') THEN
    CREATE TYPE lt_residency_type AS ENUM ('current', 'prior');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_residency_basis') THEN
    CREATE TYPE lt_residency_basis AS ENUM ('own', 'rent', 'no_primary_housing_expense');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_employment_type') THEN
    CREATE TYPE lt_employment_type AS ENUM ('current', 'previous', 'additional');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_asset_section') THEN
    CREATE TYPE lt_asset_section AS ENUM ('accounts', 'credits');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lt_liability_section') THEN
    CREATE TYPE lt_liability_section AS ENUM ('debts', 'obligations');
  END IF;
END $$;

-- Tables --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_loans (
    id UUID NOT NULL,
    loan_number TEXT,
    encompass_loan_guid TEXT,
    borrower_id UUID,
    loan_officer_id UUID,
    program_name TEXT,
    product_kind lt_product_kind NOT NULL DEFAULT 'dscr',
    loan_purpose lt_loan_purpose,
    lien_position lt_lien_position NOT NULL DEFAULT 'first',
    loan_amount DECIMAL(14,2),
    note_rate_pct DECIMAL(9,5),
    term_months INTEGER,
    interest_only_months INTEGER,
    amortization_type lt_amortization_type NOT NULL DEFAULT 'fixed',
    arm_index_name TEXT,
    arm_margin_pct DECIMAL(9,5),
    arm_first_adjustment_months INTEGER,
    arm_adjustment_frequency_months INTEGER,
    arm_initial_cap_pct DECIMAL(9,5),
    arm_periodic_cap_pct DECIMAL(9,5),
    arm_lifetime_cap_pct DECIMAL(9,5),
    arm_floor_pct DECIMAL(9,5),
    prepayment_penalty_months INTEGER,
    prepayment_penalty_structure TEXT,
    housing_expense_total DECIMAL(14,2),
    expense_first_mortgage_pi DECIMAL(14,2),
    expense_other_financing_pi DECIMAL(14,2),
    expense_hazard_insurance DECIMAL(14,2),
    expense_real_estate_taxes DECIMAL(14,2),
    expense_association_dues DECIMAL(14,2),
    expense_other DECIMAL(14,2),
    expense_supplemental_insurance DECIMAL(14,2),
    dscr_ratio DECIMAL(12,4),
    employment_applies BOOLEAN NOT NULL DEFAULT false,
    milestone_id TEXT,
    encompass_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_loans_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_loan_investors (
    loan_id UUID NOT NULL,
    shorthand_name TEXT,
    accurate_name TEXT,
    canonical_key TEXT,
    investor_loan_number TEXT,
    investor_email TEXT,
    funding_channel TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_loan_investors_pkey PRIMARY KEY (loan_id)
);

CREATE TABLE IF NOT EXISTS lt_borrower_pairs (
    id UUID NOT NULL,
    loan_id UUID NOT NULL,
    pair_number INTEGER NOT NULL,
    encompass_application_id TEXT,
    property_usage_type TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_borrower_pairs_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_parties (
    id UUID NOT NULL,
    pair_id UUID NOT NULL,
    role lt_party_role NOT NULL,
    party_type lt_party_type NOT NULL DEFAULT 'individual',
    borrower_id UUID,
    first_name TEXT,
    middle_name TEXT,
    last_name TEXT,
    name_suffix TEXT,
    date_of_birth DATE,
    ssn_encrypted BYTEA,
    ssn_last4 TEXT,
    citizenship TEXT,
    marital_status TEXT,
    dependent_count INTEGER,
    email TEXT,
    home_phone TEXT,
    mobile_phone TEXT,
    fico_experian INTEGER,
    fico_transunion INTEGER,
    fico_equifax INTEGER,
    fico_representative INTEGER,
    entity_legal_name TEXT,
    entity_type TEXT,
    entity_state_of_formation TEXT,
    entity_formation_date DATE,
    entity_ein_encrypted BYTEA,
    entity_title TEXT,
    entity_ownership_pct DECIMAL(6,3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_parties_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_residences (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    residency_type lt_residency_type NOT NULL,
    residency_basis lt_residency_basis NOT NULL,
    street TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    country TEXT DEFAULT 'US',
    duration_months INTEGER,
    monthly_rent DECIMAL(14,2),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_residences_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_employments (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    employer_name TEXT,
    position TEXT,
    employment_type lt_employment_type NOT NULL DEFAULT 'current',
    is_self_employed BOOLEAN NOT NULL DEFAULT false,
    ownership_pct DECIMAL(6,3),
    start_date DATE,
    end_date DATE,
    monthly_base_income DECIMAL(14,2),
    monthly_overtime_income DECIMAL(14,2),
    monthly_bonus_income DECIMAL(14,2),
    monthly_commission_income DECIMAL(14,2),
    monthly_other_income DECIMAL(14,2),
    employer_street TEXT,
    employer_city TEXT,
    employer_state TEXT,
    employer_zip TEXT,
    employer_phone TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_employments_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_other_incomes (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    income_type TEXT NOT NULL,
    monthly_amount DECIMAL(14,2) NOT NULL,
    description TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_other_incomes_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_assets (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    section lt_asset_section NOT NULL DEFAULT 'accounts',
    asset_type TEXT NOT NULL,
    institution_name TEXT,
    account_last4 TEXT,
    value DECIMAL(14,2),
    is_verified BOOLEAN NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_assets_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_liabilities (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    section lt_liability_section NOT NULL DEFAULT 'debts',
    liability_type TEXT NOT NULL,
    creditor_name TEXT,
    account_last4 TEXT,
    unpaid_balance DECIMAL(14,2),
    monthly_payment DECIMAL(14,2),
    months_remaining INTEGER,
    to_be_paid_off BOOLEAN NOT NULL DEFAULT false,
    reo_property_id UUID,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_liabilities_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_reo_properties (
    id UUID NOT NULL,
    party_id UUID NOT NULL,
    street TEXT,
    city TEXT,
    state TEXT,
    zip TEXT,
    property_type TEXT,
    occupancy_type TEXT,
    disposition_status TEXT,
    present_value DECIMAL(14,2),
    mortgage_balance DECIMAL(14,2),
    monthly_mortgage_payment DECIMAL(14,2),
    monthly_expenses DECIMAL(14,2),
    gross_monthly_rent DECIMAL(14,2),
    net_monthly_rental_income DECIMAL(14,2),
    acquired_date DATE,
    is_verified BOOLEAN NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_reo_properties_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS lt_properties (
    loan_id UUID NOT NULL,
    street TEXT,
    city TEXT,
    county TEXT,
    state TEXT,
    zip TEXT,
    unit_count INTEGER,
    gse_property_type TEXT,
    occupancy_type TEXT,
    occupancy_rate_pct DECIMAL(6,3),
    appraised_value DECIMAL(14,2),
    estimated_value DECIMAL(14,2),
    purchase_price DECIMAL(14,2),
    original_cost DECIMAL(14,2),
    gross_monthly_rent DECIMAL(14,2),
    actual_monthly_rent DECIMAL(14,2),
    ltv_pct DECIMAL(6,3),
    cltv_pct DECIMAL(6,3),
    in_flood_zone BOOLEAN,
    flood_zone TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_properties_pkey PRIMARY KEY (loan_id)
);

CREATE TABLE IF NOT EXISTS lt_declarations (
    party_id UUID NOT NULL,
    will_occupy_as_primary BOOLEAN,
    had_ownership_last_3_years BOOLEAN,
    family_relationship_to_seller BOOLEAN,
    borrowing_other_money BOOLEAN,
    applying_other_mortgage BOOLEAN,
    applying_new_credit BOOLEAN,
    property_subject_to_lien BOOLEAN,
    is_co_signer_or_guarantor BOOLEAN,
    has_outstanding_judgments BOOLEAN,
    is_delinquent_on_federal_debt BOOLEAN,
    is_party_to_lawsuit BOOLEAN,
    had_title_conveyed_in_lieu BOOLEAN,
    had_pre_foreclosure_sale BOOLEAN,
    had_property_foreclosed BOOLEAN,
    has_declared_bankruptcy BOOLEAN,
    bankruptcy_chapters TEXT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_declarations_pkey PRIMARY KEY (party_id)
);

-- Indexes -------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS lt_loans_loan_number_key ON lt_loans (loan_number);
CREATE UNIQUE INDEX IF NOT EXISTS lt_loans_encompass_loan_guid_key ON lt_loans (encompass_loan_guid);
CREATE INDEX IF NOT EXISTS lt_loans_borrower_id_idx ON lt_loans (borrower_id);
CREATE INDEX IF NOT EXISTS lt_loans_loan_officer_id_idx ON lt_loans (loan_officer_id);
CREATE INDEX IF NOT EXISTS lt_loans_milestone_id_idx ON lt_loans (milestone_id);
CREATE INDEX IF NOT EXISTS lt_loans_product_kind_idx ON lt_loans (product_kind);
CREATE INDEX IF NOT EXISTS lt_loan_investors_canonical_key_idx ON lt_loan_investors (canonical_key);
CREATE INDEX IF NOT EXISTS lt_loan_investors_investor_loan_number_idx ON lt_loan_investors (investor_loan_number);
CREATE UNIQUE INDEX IF NOT EXISTS lt_borrower_pairs_loan_id_pair_number_key ON lt_borrower_pairs (loan_id, pair_number);
CREATE INDEX IF NOT EXISTS lt_parties_borrower_id_idx ON lt_parties (borrower_id);
CREATE UNIQUE INDEX IF NOT EXISTS lt_parties_pair_id_role_key ON lt_parties (pair_id, role);
CREATE INDEX IF NOT EXISTS lt_residences_party_id_residency_type_idx ON lt_residences (party_id, residency_type);
CREATE INDEX IF NOT EXISTS lt_employments_party_id_employment_type_idx ON lt_employments (party_id, employment_type);
CREATE INDEX IF NOT EXISTS lt_other_incomes_party_id_idx ON lt_other_incomes (party_id);
CREATE INDEX IF NOT EXISTS lt_assets_party_id_section_idx ON lt_assets (party_id, section);
CREATE INDEX IF NOT EXISTS lt_liabilities_party_id_section_idx ON lt_liabilities (party_id, section);
CREATE INDEX IF NOT EXISTS lt_liabilities_reo_property_id_idx ON lt_liabilities (reo_property_id);
CREATE INDEX IF NOT EXISTS lt_reo_properties_party_id_idx ON lt_reo_properties (party_id);

-- Foreign keys --------------------------------------------------------------
-- Guarded so a re-run is a no-op. Every LT->LT link cascades from its parent; the
-- two authorized identity links (borrowers, staff_users) SET NULL instead, so a
-- person record disappearing can never take a loan file with it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loans_milestone_id_fkey') THEN
    ALTER TABLE lt_loans ADD CONSTRAINT lt_loans_milestone_id_fkey
      FOREIGN KEY (milestone_id) REFERENCES lt_encompass_milestones(milestone_id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loan_investors_loan_id_fkey') THEN
    ALTER TABLE lt_loan_investors ADD CONSTRAINT lt_loan_investors_loan_id_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_borrower_pairs_loan_id_fkey') THEN
    ALTER TABLE lt_borrower_pairs ADD CONSTRAINT lt_borrower_pairs_loan_id_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_parties_pair_id_fkey') THEN
    ALTER TABLE lt_parties ADD CONSTRAINT lt_parties_pair_id_fkey
      FOREIGN KEY (pair_id) REFERENCES lt_borrower_pairs(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_residences_party_id_fkey') THEN
    ALTER TABLE lt_residences ADD CONSTRAINT lt_residences_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_employments_party_id_fkey') THEN
    ALTER TABLE lt_employments ADD CONSTRAINT lt_employments_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_other_incomes_party_id_fkey') THEN
    ALTER TABLE lt_other_incomes ADD CONSTRAINT lt_other_incomes_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_assets_party_id_fkey') THEN
    ALTER TABLE lt_assets ADD CONSTRAINT lt_assets_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_liabilities_party_id_fkey') THEN
    ALTER TABLE lt_liabilities ADD CONSTRAINT lt_liabilities_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_liabilities_reo_property_id_fkey') THEN
    ALTER TABLE lt_liabilities ADD CONSTRAINT lt_liabilities_reo_property_id_fkey
      FOREIGN KEY (reo_property_id) REFERENCES lt_reo_properties(id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_reo_properties_party_id_fkey') THEN
    ALTER TABLE lt_reo_properties ADD CONSTRAINT lt_reo_properties_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_properties_loan_id_fkey') THEN
    ALTER TABLE lt_properties ADD CONSTRAINT lt_properties_loan_id_fkey
      FOREIGN KEY (loan_id) REFERENCES lt_loans(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_declarations_party_id_fkey') THEN
    ALTER TABLE lt_declarations ADD CONSTRAINT lt_declarations_party_id_fkey
      FOREIGN KEY (party_id) REFERENCES lt_parties(id) ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  -- authorized identity reference: sql-ref borrowers (ledger, 2026-08-03)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loans_borrower_id_fkey') THEN
    ALTER TABLE lt_loans ADD CONSTRAINT lt_loans_borrower_id_fkey
      FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE SET NULL;
  END IF;
  -- authorized identity reference: sql-ref staff_users (ledger, 2026-08-03)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_loans_loan_officer_id_fkey') THEN
    ALTER TABLE lt_loans ADD CONSTRAINT lt_loans_loan_officer_id_fkey
      FOREIGN KEY (loan_officer_id) REFERENCES staff_users(id) ON DELETE SET NULL;
  END IF;
  -- authorized identity reference: sql-ref borrowers (ledger, 2026-08-03)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lt_parties_borrower_id_fkey') THEN
    ALTER TABLE lt_parties ADD CONSTRAINT lt_parties_borrower_id_fkey
      FOREIGN KEY (borrower_id) REFERENCES borrowers(id) ON DELETE SET NULL;
  END IF;
END $$;
