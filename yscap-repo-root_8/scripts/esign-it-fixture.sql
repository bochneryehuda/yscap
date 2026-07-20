-- Minimal but faithful fixture for the esign orchestrate/webhook integration
-- test. Mirrors ONLY the columns the code under test touches (the full schema
-- lives across db/001..134; the pre-merge audit verifies those columns exist).
-- Loaded into a throwaway database by scripts/test-esign-orchestrate.js.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE borrowers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL, last_name text NOT NULL, email text NOT NULL
);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ys_loan_number text,
  borrower_id uuid REFERENCES borrowers(id),
  co_borrower_id uuid REFERENCES borrowers(id),
  property_address jsonb,
  loan_amount numeric(14,2),
  purchase_price numeric(14,2),
  submitted_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL
);
CREATE TABLE checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES applications(id),
  template_id uuid REFERENCES checklist_templates(id),
  status text NOT NULL DEFAULT 'open',
  signed_off_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- CHECK constraints mirror the REAL schema (schema.sql + db/012/013/014) so this
-- fixture catches constraint-violation bugs the code would hit in production.
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid,
  checklist_item_id uuid,
  borrower_id uuid,
  filename text NOT NULL,
  content_type text,
  size_bytes bigint,
  storage_provider text,
  storage_ref text,
  uploaded_by_kind text CHECK (uploaded_by_kind IN ('borrower','staff')),
  uploaded_by_id uuid,
  doc_kind text,
  source_type text,
  visibility text NOT NULL DEFAULT 'borrower' CHECK (visibility IN ('borrower','staff_only','internal')),
  slot_label text,
  is_current boolean DEFAULT true,
  review_status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_documents_esign_signed ON documents(application_id, doc_kind, filename) WHERE doc_kind IN ('term_sheet_signed','application_signed','bp_disclosure_signed','heter_iska_signed','esign_certificate');

CREATE TABLE staff_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text);

-- esign_envelopes: the db/037 stub grown by db/138/139/140 (only touched cols).
CREATE TABLE esign_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid REFERENCES applications(id),
  envelope_id text,
  status text NOT NULL DEFAULT 'not_sent',
  purpose text,
  send_claimed_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  completed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  is_test boolean NOT NULL DEFAULT false,
  test_label text,
  idempotency_key text,
  embedded boolean NOT NULL DEFAULT false,
  recipients jsonb,
  product_version integer,
  last_event_at timestamptz,
  created_by uuid,
  countersign_required boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_esign_inflight ON esign_envelopes(application_id, purpose)
  WHERE purpose IS NOT NULL AND status IN ('not_sent','sent','delivered');

CREATE TABLE esign_envelope_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_row_id uuid NOT NULL REFERENCES esign_envelopes(id) ON DELETE CASCADE,
  document_id integer NOT NULL,
  doc_kind text NOT NULL,
  checklist_item_id uuid,
  completed_document_id uuid,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_esign_env_doc ON esign_envelope_docs(envelope_row_id, document_id);

CREATE TABLE esign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_row_id uuid NOT NULL REFERENCES esign_envelopes(id) ON DELETE CASCADE,
  role text NOT NULL,
  routing_order integer NOT NULL DEFAULT 1,
  is_countersigner boolean NOT NULL DEFAULT false,
  recipient_id_ds text,
  borrower_id uuid,
  name text NOT NULL,
  email text NOT NULL,
  embedded boolean NOT NULL DEFAULT false,
  client_user_id text,
  status text NOT NULL DEFAULT 'created',
  sent_at timestamptz, delivered_at timestamptz, signed_at timestamptz,
  declined_at timestamptz, decline_reason text, last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_esign_recipient_ds ON esign_recipients(envelope_row_id, recipient_id_ds)
  WHERE recipient_id_ds IS NOT NULL;

CREATE TABLE docusign_event_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body_sha256 text NOT NULL UNIQUE,
  envelope_id text, event_type text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, process_error text,
  attempts integer NOT NULL DEFAULT 0, raw jsonb
);
