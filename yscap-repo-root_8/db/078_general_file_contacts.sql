-- 078 — General file contacts (owner-directed 2026-07-12).
--
-- Turn the narrow title/insurance contact store into a full file-wide contacts
-- directory that anyone (borrower / LO / processor / admin) can add to, with any
-- kind of vendor (realtor, attorney, title, insurance, flood insurance,
-- contractor, appraiser, lender, escrow, … + a free-text "Other"), MANY per
-- file. Every contact still lives in service_contacts, so it is automatically
-- part of the company-wide vendor management. Two schema changes:
--
--  (1) Drop the restrictive contact_type CHECK so new vendor kinds don't each
--      need a migration; add custom_type for the "Other" free-text label.
--  (2) The application<->contact link was PK (application_id, contact_type) — only
--      ONE contact per type per file. Switch it to allow MANY: a surrogate id +
--      a UNIQUE (application_id, service_contact_id). The title/insurance
--      checklist forms keep "one per type" in their own endpoints (they delete
--      the prior link of that type before adding).

ALTER TABLE service_contacts DROP CONSTRAINT IF EXISTS service_contacts_contact_type_check;
ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS custom_type text;   -- shown when contact_type='other'
ALTER TABLE service_contacts ADD COLUMN IF NOT EXISTS added_by_borrower_id uuid REFERENCES borrowers(id) ON DELETE SET NULL;

-- Rebuild the link table's key to allow many contacts per file.
ALTER TABLE application_service_contacts ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
ALTER TABLE application_service_contacts ADD COLUMN IF NOT EXISTS added_by_kind text;   -- 'borrower' | 'staff'
ALTER TABLE application_service_contacts ADD COLUMN IF NOT EXISTS added_by_id uuid;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_service_contacts_pkey') THEN
    ALTER TABLE application_service_contacts DROP CONSTRAINT application_service_contacts_pkey;
  END IF;
  -- backfill the surrogate id for any pre-existing rows
  UPDATE application_service_contacts SET id = gen_random_uuid() WHERE id IS NULL;
  ALTER TABLE application_service_contacts ALTER COLUMN id SET NOT NULL;
  ALTER TABLE application_service_contacts ADD PRIMARY KEY (id);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_service_contacts_app_contact_uq') THEN
    ALTER TABLE application_service_contacts
      ADD CONSTRAINT application_service_contacts_app_contact_uq UNIQUE (application_id, service_contact_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_asc_application ON application_service_contacts(application_id);
