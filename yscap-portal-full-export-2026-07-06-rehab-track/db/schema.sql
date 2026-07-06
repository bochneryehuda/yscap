-- =====================================================================
-- YS Capital Borrower Portal — PostgreSQL schema
-- System of record for the borrower-facing portal.
-- Syncs bidirectionally to ClickUp (now) and Encompass (later) via sync_*.
--
-- Design rules honored:
--   * Borrower is the BASE entity; each mortgage = a new application row.
--   * LLCs + Track Records live on the BORROWER, not the application.
--   * An application links to ONE LLC; a track-record entry links to ONE LLC.
--   * Checklist items are scoped: application | borrower_profile | llc.
--   * SSN is encrypted at rest (pgcrypto). PII access is audit-logged (GLBA).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), pgp_sym_encrypt()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email uniqueness

-- ---------------------------------------------------------------------
-- ENUM-style reference (kept as CHECK constraints for easy migration)
-- ---------------------------------------------------------------------

-- =====================================================================
-- STAFF (loan officers, processors, underwriters, admins)
-- Admin creates these; borrowers never appear here.
-- =====================================================================
CREATE TABLE staff_users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               citext UNIQUE NOT NULL,
    full_name           text NOT NULL,
    role                text NOT NULL CHECK (role IN ('admin','loan_officer','processor','underwriter')),
    -- ClickUp linkage
    clickup_user_id     bigint,                    -- ClickUp member id (for "users" fields)
    crm_folder_id       bigint,                    -- CRM & SALES folder (loan officers only)
    pipeline_folder_id  bigint,                    -- Loan Pipeline folder
    is_active           boolean NOT NULL DEFAULT true,
    site_selectable     boolean NOT NULL DEFAULT true,  -- appears in site officer dropdown
    -- Auth
    password_hash       text,                      -- argon2id
    mfa_secret          text,                      -- TOTP secret (encrypted app-side)
    mfa_enabled         boolean NOT NULL DEFAULT false,
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- BORROWERS — the base contact/profile. One row per human.
-- Their PII flows to the CRM contact AND the Pipeline file (shared field IDs).
-- =====================================================================
CREATE TABLE borrowers (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Identity
    first_name          text NOT NULL,
    last_name           text NOT NULL,
    email               citext UNIQUE NOT NULL,
    cell_phone          text,
    date_of_birth       date,
    ssn_encrypted       bytea,                     -- pgp_sym_encrypt(ssn, key); never plaintext
    ssn_last4           char(4),                   -- for display/search only
    fico                integer CHECK (fico IS NULL OR (fico BETWEEN 300 AND 850)),
    -- Residence
    current_address     jsonb,                     -- {line1,line2,city,state,zip}
    years_at_residence  numeric(4,1),
    prior_address       jsonb,
    citizenship         text,
    marital_status      text,
    dependents_count    integer,
    -- Employment
    employment_type     text,                      -- W-2 / 1099 / K1 / C CORP / Self employed
    employer            text,
    -- Book-keeping
    contact_type        text,                      -- INVESTOR / PRIMARY / FIRST TIME INVESTOR
    primary_officer_id  uuid REFERENCES staff_users(id),  -- resolved officer FK
    source_officer      text,                             -- raw officer name from site dropdown (pre-resolution)
    tier                integer NOT NULL DEFAULT 0,        -- derived from verified track records
    -- ClickUp linkage (the borrower's CONTACT card in the officer's CRM folder)
    clickup_crm_task_id text,
    -- Sync
    sync_status         text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','error')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_borrowers_officer ON borrowers(primary_officer_id);

-- Borrower login is SEPARATE from the PII table (blast-radius reduction).
CREATE TABLE borrower_auth (
    borrower_id         uuid PRIMARY KEY REFERENCES borrowers(id) ON DELETE CASCADE,
    password_hash       text NOT NULL,             -- argon2id
    mfa_secret          text,                      -- TOTP secret (encrypted app-side)
    mfa_enabled         boolean NOT NULL DEFAULT false,
    email_verified      boolean NOT NULL DEFAULT false,
    failed_attempts     integer NOT NULL DEFAULT 0,
    locked_until        timestamptz,
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- LLCs — entities owned by a borrower. Verified docs live here.
-- Link an LLC to an application to auto-fill LLC document requirements.
-- =====================================================================
CREATE TABLE llcs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id         uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    llc_name            text NOT NULL,
    ein                 text,
    formation_state     text,
    formation_date      date,
    -- ownership: >25% may be borrower; >=50% must be borrower (business rule enforced app-side)
    ownership_pct       numeric(5,2),
    is_verified         boolean NOT NULL DEFAULT false,
    verified_at         timestamptz,
    verified_by         uuid REFERENCES staff_users(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_llcs_borrower ON llcs(borrower_id);

-- =====================================================================
-- TRACK RECORDS — completed deals PER BORROWER (not per application).
-- Count of verified rows drives borrower.tier. Optionally tied to an LLC.
-- =====================================================================
CREATE TABLE track_records (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id         uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    llc_id              uuid REFERENCES llcs(id) ON DELETE SET NULL,  -- experience under this entity
    property_address    jsonb,
    deal_type           text,                      -- flip / fix-and-hold / ground-up / rental
    purchase_price      numeric(14,2),
    sale_price          numeric(14,2),
    rehab_amount        numeric(14,2),
    purchase_date       date,
    sale_date           date,
    rent_amount         numeric(14,2),
    rent_date           date,
    refi_amount         numeric(14,2),
    refi_date           date,
    current_value       numeric(14,2),
    notes               text,
    is_verified         boolean NOT NULL DEFAULT false,
    verified_at         timestamptz,
    verified_by         uuid REFERENCES staff_users(id),
    docs_status         text NOT NULL DEFAULT 'outstanding'
                        CHECK (docs_status IN ('outstanding','requested','received','satisfied','issue')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_track_records_borrower ON track_records(borrower_id);
CREATE INDEX idx_track_records_llc ON track_records(llc_id);

-- =====================================================================
-- APPLICATIONS — a loan file. One borrower : many applications.
-- Routes to a loan officer's Pipeline folder, or Lead Capture if none.
-- =====================================================================
CREATE TABLE applications (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id         uuid NOT NULL REFERENCES borrowers(id) ON DELETE RESTRICT,
    co_borrower_id      uuid REFERENCES borrowers(id),           -- optional 2nd borrower
    llc_id              uuid REFERENCES llcs(id) ON DELETE SET NULL,  -- vesting entity
    loan_officer_id     uuid REFERENCES staff_users(id),         -- resolved officer FK; NULL => Lead Capture
    loan_officer_name   text,                                    -- raw officer name from site dropdown
    processor_id        uuid REFERENCES staff_users(id),
    -- Identity / natural keys
    ys_loan_number      text UNIQUE,
    investor_loan_number text,
    -- Product
    program             text,     -- Fix & Flip w/ Construction / Bridge / DSCR / etc.
    loan_type           text,     -- Purchase / Refi R&T / Refi Cash-Out / Ground up / HELOC
    lender              text,
    channel             text,     -- Wholesale / Delegate Corr / Non-Del Corr / Table funding
    occupancy           text,     -- Primary / Investment / Secondary
    -- Property
    property_address    jsonb,
    property_type       text,     -- SFR / Multi 2-4 / Multi 5+ / Mixed Use / etc.
    units               integer,
    -- Economics (snapshot from the app; pricing ENGINE stays external & frozen)
    purchase_price      numeric(14,2),
    as_is_value         numeric(14,2),
    arv                 numeric(14,2),
    rehab_budget        numeric(14,2),
    rehab_type          text,     -- Cosmetic / Moderate / Heavy / Adding SF / Ground-up
    sqft_pre            integer,
    sqft_post           integer,
    requested_exp_flips integer NOT NULL DEFAULT 0,
    requested_exp_holds integer NOT NULL DEFAULT 0,
    requested_exp_ground integer NOT NULL DEFAULT 0,
    loan_amount         numeric(14,2),
    ltv                 numeric(6,3),
    dscr_ratio          numeric(6,3),
    rate_pct            numeric(6,3),
    term                text,
    ppp                 text,     -- prepayment penalty type & term
    -- Lifecycle
    status              text NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new','in_review','processing','underwriting',
                                          'approved','clear_to_close','funded','declined','withdrawn')),
    status_changed_at   timestamptz,
    submitted_at        timestamptz,
    expected_closing    date,
    actual_closing      date,
    -- ClickUp linkage (the loan file task in the Pipeline folder)
    clickup_pipeline_task_id text,
    clickup_folder_id   bigint,                    -- which folder it landed in
    -- Origin
    source              text NOT NULL DEFAULT 'portal',  -- portal / website_form / termsheet / manual
    raw_intake          jsonb,                     -- full original payload from the site
    sync_status         text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','synced','error')),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_applications_borrower ON applications(borrower_id);
CREATE INDEX idx_applications_officer ON applications(loan_officer_id);
CREATE INDEX idx_applications_status ON applications(status);

-- =====================================================================
-- CHECKLIST — auto-generated document requirements.
-- scope tells us where it lives: the application, the borrower's profile,
-- or an LLC. LLC-scoped items auto-satisfy when a verified LLC is linked.
-- =====================================================================
CREATE TABLE checklist_templates (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                text UNIQUE NOT NULL,      -- e.g. 'purchase_contract'
    label               text NOT NULL,
    scope               text NOT NULL CHECK (scope IN ('application','borrower_profile','llc')),
    -- applicability filters (NULL = always)
    applies_program     text,                      -- restrict to a program, else all
    applies_loan_type   text,
    clickup_field_id    text,                      -- maps to the ClickUp checklist dropdown
    sort_order          integer NOT NULL DEFAULT 100,
    is_active           boolean NOT NULL DEFAULT true
);

CREATE TABLE checklist_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id         uuid REFERENCES checklist_templates(id),
    scope               text NOT NULL CHECK (scope IN ('application','borrower_profile','llc')),
    -- exactly one owner depending on scope
    application_id      uuid REFERENCES applications(id) ON DELETE CASCADE,
    borrower_id         uuid REFERENCES borrowers(id) ON DELETE CASCADE,
    llc_id              uuid REFERENCES llcs(id) ON DELETE CASCADE,
    label               text NOT NULL,
    status              text NOT NULL DEFAULT 'outstanding'
                        CHECK (status IN ('outstanding','requested','received','satisfied','issue')),
    clickup_field_id    text,
    clickup_option_id   text,                      -- current status option in ClickUp
    due_date            date,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_one_owner CHECK (
        (application_id IS NOT NULL)::int
      + (borrower_id    IS NOT NULL)::int
      + (llc_id         IS NOT NULL)::int = 1
    )
);
CREATE INDEX idx_checklist_app ON checklist_items(application_id);
CREATE INDEX idx_checklist_borrower ON checklist_items(borrower_id);
CREATE INDEX idx_checklist_llc ON checklist_items(llc_id);

-- =====================================================================
-- DOCUMENTS — uploaded files. Stored in SharePoint via Graph; row holds ref.
-- =====================================================================
CREATE TABLE documents (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checklist_item_id   uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
    -- denormalized owner for direct queries
    application_id      uuid REFERENCES applications(id) ON DELETE CASCADE,
    borrower_id         uuid REFERENCES borrowers(id) ON DELETE CASCADE,
    llc_id              uuid REFERENCES llcs(id) ON DELETE CASCADE,
    filename            text NOT NULL,
    content_type        text,
    size_bytes          bigint,
    storage_provider    text NOT NULL DEFAULT 'sharepoint',
    storage_ref         text,                      -- Graph driveItem id / path
    uploaded_by_kind    text CHECK (uploaded_by_kind IN ('borrower','staff')),
    uploaded_by_id      uuid,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_documents_app ON documents(application_id);
CREATE INDEX idx_documents_borrower ON documents(borrower_id);

-- =====================================================================
-- MESSAGES — in-portal chat / requests, per application (or borrower).
-- =====================================================================
CREATE TABLE messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id      uuid REFERENCES applications(id) ON DELETE CASCADE,
    borrower_id         uuid REFERENCES borrowers(id) ON DELETE CASCADE,
    sender_kind         text NOT NULL CHECK (sender_kind IN ('borrower','staff','system')),
    sender_id           uuid,
    body                text NOT NULL,
    is_task_request     boolean NOT NULL DEFAULT false,  -- borrower requesting something
    clickup_comment_id  text,
    read_at             timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_app ON messages(application_id);

-- =====================================================================
-- SYNC — reconciliation queue + log across Portal / ClickUp / Encompass.
-- =====================================================================
CREATE TABLE sync_queue (
    id                  bigserial PRIMARY KEY,
    entity_type         text NOT NULL,             -- borrower / application / checklist_item / document / message
    entity_id           uuid NOT NULL,
    target              text NOT NULL CHECK (target IN ('clickup','encompass','graph')),
    direction           text NOT NULL CHECK (direction IN ('push','pull')),
    op                  text NOT NULL,             -- create / update / link
    payload             jsonb,
    status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','error')),
    attempts            integer NOT NULL DEFAULT 0,
    last_error          text,
    run_after           timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sync_queue_status ON sync_queue(status, run_after);

-- =====================================================================
-- AUDIT — every read/write of PII (GLBA Safeguards).
-- =====================================================================
CREATE TABLE audit_log (
    id                  bigserial PRIMARY KEY,
    actor_kind          text NOT NULL CHECK (actor_kind IN ('borrower','staff','system')),
    actor_id            uuid,
    action              text NOT NULL,             -- view_ssn / update_borrower / login / etc.
    entity_type         text,
    entity_id           uuid,
    ip_address          inet,
    user_agent          text,
    detail              jsonb,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_actor ON audit_log(actor_kind, actor_id);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
