-- =====================================================================
-- 008_leads.sql — backend capture of marketing-site tool submissions.
-- Every public tool (loan application, rehab budget, term-sheet request,
-- deal analyzer, …) POSTs here instead of opening the visitor's email client.
-- The submission is stored, the assigned officer (or the admin desk) is
-- notified, and a confirmation is emailed to the visitor — all from the server.
-- No visitor login required. Idempotent.
-- =====================================================================

CREATE TABLE IF NOT EXISTS leads (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool               text NOT NULL,            -- 'loan_application' | 'rehab_budget' | 'term_sheet' | ...
    name               text,
    email              citext,
    phone              text,
    -- routing: the ?lo= officer code from the branded link, resolved to a staff row when it matches
    officer_code       text,
    officer_id         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
    subject            text,
    message            text,
    payload            jsonb,                     -- full tool state / form data (SSNs stripped)
    source             text NOT NULL DEFAULT 'marketing_site',
    status             text NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','contacted','working','converted','archived')),
    -- linkage once a lead becomes a real file
    application_id     uuid REFERENCES applications(id) ON DELETE SET NULL,
    borrower_id        uuid REFERENCES borrowers(id) ON DELETE SET NULL,
    emailed_officer    boolean NOT NULL DEFAULT false,
    emailed_submitter  boolean NOT NULL DEFAULT false,
    ip_address         inet,
    user_agent         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_officer ON leads(officer_id);
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_tool    ON leads(tool);
