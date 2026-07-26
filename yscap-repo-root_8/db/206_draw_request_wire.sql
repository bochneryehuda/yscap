-- ============================================================================
-- 200 — Draw Request & Wire Instructions form via DocuSign (owner-directed
--       2026-07-20). The draw coordinator sends the borrower a PILOT-branded
--       "Draw Request & Wire Instructions" form through the existing DocuSign
--       e-sign integration; MOST of it auto-fills from the file, and the borrower
--       types their WIRE INSTRUCTIONS into fillable boxes. On completion PILOT
--       (a) saves the signed PDF back to a draw CONDITION, and (b) CAPTURES the
--       typed wire values into its own file (draw_wire_instructions).
--
--       Fatal rule: if the wire ACCOUNT NAME is neither the borrower's personal
--       name NOR the subject/vesting LLC, the money is going to a NEW entity — a
--       FATAL condition is raised for the draw manager to collect that entity's
--       operating agreement before any wire goes out.
--
-- This migration is schema-only + template seeds; the send/capture logic lives in
-- src/lib/esign/{draw-request-pdf,draw-wire}.js + orchestrate/webhook. Go-forward
-- only (draw requests are created on demand once a file is in the draw process) —
-- no backfill of conditions onto old files.
-- ============================================================================

-- (1) A NEW e-sign package purpose. Extend the envelope purpose allow-list.
ALTER TABLE esign_envelopes DROP CONSTRAINT IF EXISTS chk_esign_purpose;
ALTER TABLE esign_envelopes ADD CONSTRAINT chk_esign_purpose CHECK (
  purpose IS NULL OR purpose IN ('term_sheet_package', 'heter_iska', 'test', 'draw_request'));

-- (2) A NEW condition category for draw-phase (servicing) conditions.
DO $$ BEGIN
  ALTER TABLE checklist_templates DROP CONSTRAINT IF EXISTS chk_templates_category;
  ALTER TABLE checklist_templates ADD CONSTRAINT chk_templates_category CHECK (category IS NULL OR category IN
    ('prior_to_approval','prior_to_docs','prior_to_closing','prior_to_funding','at_closing','post_closing','draw'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- (3) The signed draw-request PDF is stored under the deterministic esign filename
--     <doc_kind>_<envelopeId>.pdf — add its kinds to the idempotency index (db/142).
DROP INDEX IF EXISTS uq_documents_esign_signed;
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_esign_signed
  ON documents(application_id, doc_kind, filename)
  WHERE doc_kind IN ('term_sheet_signed','application_signed','bp_disclosure_signed',
                     'heter_iska_signed','esign_certificate','draw_request_signed');

-- (4) Captured WIRE INSTRUCTIONS — one CURRENT row per file (latest capture wins;
--     re-sending a corrected form upserts on application_id). The bank ACCOUNT
--     NUMBER is sensitive PII → encrypted at rest (AES-256-GCM via crypto.encryptSSN,
--     the same at-rest cipher the SSN uses); only its last-4 is kept in clear for
--     display. ABA ROUTING numbers are public bank identifiers → stored in clear.
CREATE TABLE IF NOT EXISTS draw_wire_instructions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id              uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  envelope_row_id             uuid REFERENCES esign_envelopes(id) ON DELETE SET NULL,   -- the DocuSign envelope the values came from
  account_name                text,                 -- the wire beneficiary / account holder name (drives the fatal name check)
  bank_name                   text,
  account_number_enc          bytea,                -- AES-256-GCM ciphertext — NEVER the raw account number
  account_last4               text,                 -- last 4 digits, for masked display (***1234)
  routing_number              text,                 -- ABA routing (public) — stored in clear
  bank_address                text,
  account_address             text,
  name_kind                   text CHECK (name_kind IS NULL OR name_kind IN
                                ('borrower_personal','subject_llc','new_entity','unknown')),
  name_matches                boolean,              -- true when the account name is the borrower OR the subject LLC (no OA needed)
  operating_agreement_item_id uuid REFERENCES checklist_items(id) ON DELETE SET NULL,   -- the fatal OA condition, when a new entity
  captured_at                 timestamptz NOT NULL DEFAULT now(),
  raw                         jsonb,                -- the full label→value map as captured (account # redacted)
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_draw_wire_app ON draw_wire_instructions (application_id);
CREATE INDEX IF NOT EXISTS idx_draw_wire_env ON draw_wire_instructions (envelope_row_id);

-- (5) The DRAW-REQUEST condition templates. Both are auto_apply='manual' (the
--     conditions engine only manages 'always'/'rules' templates, so it never
--     auto-attaches or auto-retracts these) — they are created on demand:
--       * draw_cond_signed_request — created when the coordinator SENDS the form;
--         the signed PDF is filed back to it on completion (esign_envelope_docs).
--       * draw_cond_operating_agreement — raised (fatal) only when the captured
--         wire account name is a NEW entity (neither borrower nor subject LLC).
--     Both are audience='both' (staff + borrower see them) document conditions.
INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required, auto_apply)
SELECT
  'draw_cond_signed_request',
  'Signed draw request & wire instructions form',
  'Signed draw request & wire instructions form',
  'application', 'both', 'document', 'processor', '5',
  900, 'draw',
  'The borrower''s signed Draw Request & Wire Instructions form (sent via DocuSign). The signed PDF files back here automatically once they sign.',
  'Your signed Draw Request & Wire Instructions form — this is filed here automatically once you finish signing.',
  true, true, 'manual'
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'draw_cond_signed_request');

INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required, auto_apply)
SELECT
  'draw_cond_operating_agreement',
  'Operating agreement for the wire recipient entity',
  'Operating agreement for the receiving company',
  'application', 'both', 'document', 'processor', '5',
  901, 'draw',
  'FATAL: the wire account name on the draw request is a NEW entity — neither the borrower nor the subject LLC. Collect that entity''s operating agreement (and confirm authority to receive funds) before releasing any wire.',
  'The bank account on your draw request is in a company name that isn''t you personally or the property''s LLC. Please upload that company''s operating agreement so we can send funds to it.',
  true, true, 'manual'
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'draw_cond_operating_agreement');

-- Keep the definitions in lock-step if a prior boot seeded earlier text (idempotent;
-- never touches instances already on files).
UPDATE checklist_templates SET audience='both', item_kind='document', auto_apply='manual', category='draw', is_active=true
 WHERE code IN ('draw_cond_signed_request','draw_cond_operating_agreement');
