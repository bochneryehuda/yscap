-- 017_service_contacts.sql — reusable title/insurance (and other) service
-- contacts on the borrower. Title company and insurance agent tasks become
-- structured FORMS (not PDF uploads): the borrower enters the contact once and
-- reuses it on future files via autocomplete. Idempotent.

CREATE TABLE IF NOT EXISTS service_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id   uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
  contact_type  text NOT NULL CHECK (contact_type IN ('title_company','insurance_agent','attorney','contractor','other')),
  company_name  text,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_service_contacts_borrower ON service_contacts(borrower_id, contact_type);

-- Which contact is attached to a given application (so staff see it on the file).
CREATE TABLE IF NOT EXISTS application_service_contacts (
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  service_contact_id uuid NOT NULL REFERENCES service_contacts(id) ON DELETE CASCADE,
  contact_type      text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, contact_type)
);

-- Turn the title/insurance checklist tasks into contact-FORM tasks. tool_key is
-- how the borrower portal decides to render an inline form instead of an upload.
UPDATE checklist_templates SET tool_key = 'title_contact'     WHERE code = 'rtl_p1_titlec';
UPDATE checklist_templates SET tool_key = 'insurance_contact' WHERE code = 'rtl_p1_insc';
UPDATE checklist_items SET tool_key = 'title_contact'
  WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_titlec');
UPDATE checklist_items SET tool_key = 'insurance_contact'
  WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_insc');
