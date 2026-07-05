-- =====================================================================
-- 002 — Backend expansion
--   * Checklists gain an AUDIENCE (borrower vs staff) and an ITEM KIND
--     (document request vs officer-posted condition vs task).
--   * NOTIFICATIONS (in-app) + delivery status for email fan-out.
--   * INVITE tokens (admin adds staff; borrower invited/self-serve).
--   * token_version for instant session revocation (logout-everywhere).
-- Idempotent: safe to run repeatedly.
-- =====================================================================

-- ---- Checklists: audience + kind ------------------------------------
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS audience  text NOT NULL DEFAULT 'borrower'
      CHECK (audience IN ('borrower','staff','both')),
  ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'document'
      CHECK (item_kind IN ('document','condition','task'));

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS audience        text NOT NULL DEFAULT 'borrower'
      CHECK (audience IN ('borrower','staff','both')),
  ADD COLUMN IF NOT EXISTS item_kind       text NOT NULL DEFAULT 'document'
      CHECK (item_kind IN ('document','condition','task')),
  ADD COLUMN IF NOT EXISTS created_by_kind text CHECK (created_by_kind IN ('borrower','staff','system')),
  ADD COLUMN IF NOT EXISTS created_by_id   uuid,
  ADD COLUMN IF NOT EXISTS is_required     boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_checklist_audience ON checklist_items(audience);

-- ---- Notifications (in-app; email fan-out tracked per row) -----------
CREATE TABLE IF NOT EXISTS notifications (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- recipient is EITHER a staff user OR a borrower
    recipient_kind    text NOT NULL CHECK (recipient_kind IN ('staff','borrower')),
    staff_id          uuid REFERENCES staff_users(id) ON DELETE CASCADE,
    borrower_id       uuid REFERENCES borrowers(id)   ON DELETE CASCADE,
    -- context
    type              text NOT NULL,       -- new_application / unassigned_application / doc_uploaded /
                                           -- condition_added / status_change / message / assignment
    title             text NOT NULL,
    body              text,
    application_id    uuid REFERENCES applications(id) ON DELETE CASCADE,
    link              text,                -- deep link into the portal
    -- lifecycle
    read_at           timestamptz,
    -- email fan-out
    email_status      text NOT NULL DEFAULT 'pending'
                      CHECK (email_status IN ('pending','sent','skipped','error')),
    email_error       text,
    emailed_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_notif_recipient CHECK (
        (staff_id IS NOT NULL)::int + (borrower_id IS NOT NULL)::int = 1
    )
);
CREATE INDEX IF NOT EXISTS idx_notif_staff    ON notifications(staff_id)    WHERE staff_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_borrower ON notifications(borrower_id) WHERE borrower_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notif_unread   ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_email    ON notifications(email_status) WHERE email_status = 'pending';

-- ---- Invite / provisioning tokens -----------------------------------
CREATE TABLE IF NOT EXISTS invite_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash    text NOT NULL,                 -- sha256 of the emailed token
    kind          text NOT NULL CHECK (kind IN ('staff','borrower')),
    email         citext NOT NULL,
    role          text,                          -- for staff invites
    created_by    uuid REFERENCES staff_users(id),
    expires_at    timestamptz NOT NULL,
    accepted_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invite_email ON invite_tokens(email);

-- ---- Session revocation ---------------------------------------------
ALTER TABLE staff_users  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
ALTER TABLE borrower_auth ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

-- ---- Seed the default document checklist (borrower + staff scopes) ---
INSERT INTO checklist_templates (code,label,scope,audience,item_kind,sort_order) VALUES
  ('gov_id',            'Government-issued photo ID',        'borrower_profile','borrower','document',10),
  ('purchase_contract', 'Fully executed purchase contract', 'application','borrower','document',20),
  ('scope_of_work',     'Scope of work / rehab budget',     'application','borrower','document',30),
  ('insurance_binder',  'Insurance binder',                 'application','borrower','document',40),
  ('title_commitment',  'Title commitment',                 'application','staff','document',50),
  ('bank_statements',   'Two months bank statements',       'application','borrower','document',60),
  ('llc_docs',          'LLC formation docs + EIN letter',  'llc','borrower','document',70),
  ('operating_agmt',    'LLC operating agreement',          'llc','borrower','document',80),
  ('voided_check',      'Voided check / wire instructions', 'application','borrower','document',90)
ON CONFLICT (code) DO NOTHING;
