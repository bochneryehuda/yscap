-- 150_document_underwriting.sql
-- The document-underwriting spine: store what the OCR reader + AI analyzer extracted
-- from EACH document, and the findings raised from it — the same proven shape as the
-- appraisal engine (db/137), widened from "appraisal vs file" to "any document vs the
-- file, and document vs document". Idempotent (safe to re-run every boot).
--
-- Design mirrors db/137 deliberately so the two engines never drift:
--   * document_extractions  ≈  appraisals            (one row per read+analyzed doc)
--   * document_findings     ≈  appraisal_findings    (generic {source,field,doc_value,file_value})
-- Appraisals keep their own tables/flow untouched; this covers every OTHER document
-- type (purchase contract, government ID, bank statement, title, insurance, LLC docs…).

-- ------------------------------------------------------------------------
-- What the reader + analyzer got out of one document.
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_extractions (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id      uuid REFERENCES documents(id) ON DELETE CASCADE,
    -- A document attaches to a loan file and/or a borrower profile (IDs file at the
    -- borrower level). At least one is set; both are indexed for the two roll-up views.
    application_id   uuid REFERENCES applications(id) ON DELETE CASCADE,
    borrower_id      uuid REFERENCES borrowers(id) ON DELETE CASCADE,
    doc_type         text NOT NULL,               -- purchase_contract | government_id | bank_statement | title | insurance | llc_operating_agreement | ...
    fields           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the structured facts pulled out
    -- Provenance so a re-read never silently loses the audit trail:
    ocr_engine       text,                         -- 'document_ai' | 'ocr_space' | null (text-layer only)
    ai_model         text,                         -- e.g. 'claude-opus-4-8'
    page_count       integer,
    confidence       text,                         -- 'definite' | 'partial' | 'unreadable' (never guess onto the file)
    status           text NOT NULL DEFAULT 'analyzed',  -- analyzed | read_only | error
    reason           text,                         -- when status='error', the plain-language why
    -- Supersede chain (a re-uploaded/replaced document re-reads; the old row is kept
    -- for history but marked not-current), mirroring appraisals.superseded.
    is_current       boolean NOT NULL DEFAULT true,
    superseded       boolean NOT NULL DEFAULT false,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docextract_app ON document_extractions(application_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_docextract_borrower ON document_extractions(borrower_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_docextract_doc ON document_extractions(document_id);
CREATE INDEX IF NOT EXISTS idx_docextract_type ON document_extractions(application_id, doc_type) WHERE is_current;

-- ------------------------------------------------------------------------
-- Findings — every mismatch/flag an underwriter must resolve. Same columns and
-- lifecycle as appraisal_findings so the UI + roll-up logic generalize 1:1.
--   * source        the doc_type that raised it, OR 'cross_document' for doc-vs-doc checks
--   * doc_value     what the document says   (was appraisal_value)
--   * file_value    what our loan file says
-- A finding may tie to a specific document (document_id) or span several (null).
-- ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_findings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id   uuid REFERENCES applications(id) ON DELETE CASCADE,
    borrower_id      uuid REFERENCES borrowers(id) ON DELETE CASCADE,
    document_id      uuid REFERENCES documents(id) ON DELETE SET NULL,   -- null for cross-document findings
    extraction_id    uuid REFERENCES document_extractions(id) ON DELETE SET NULL,
    source           text NOT NULL,               -- doc_type | 'cross_document'
    code             text NOT NULL,
    severity         text NOT NULL,               -- fatal | warning | info
    field            text,
    doc_value        text,
    file_value       text,
    title            text,
    how_to           text,
    blocks_ctc       boolean NOT NULL DEFAULT false,
    -- lifecycle: open -> resolved (with an action) / dismissed / superseded
    status           text NOT NULL DEFAULT 'open',  -- open | resolved | dismissed | superseded
    resolution       text,                         -- replace | keep | custom | dismiss | decline | acknowledge | grant_exception | request_revision | open_condition
    resolution_value text,
    resolution_note  text,
    resolved_by      uuid,
    resolved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docfindings_app ON document_findings(application_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_docfindings_borrower ON document_findings(borrower_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_docfindings_doc ON document_findings(document_id);

-- ------------------------------------------------------------------------
-- Internal clear-to-close gate, mirroring db/137's appraisal_review_cleared.
-- Cannot be signed off while any fatal document finding is open (enforced in the
-- app layer + a later trigger, exactly like the appraisal gate).
-- ------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, is_required, auto_apply)
SELECT 'underwriting_review_cleared', 'Document underwriting cleared (all PILOT findings resolved)', 'application', 'staff', 'condition', 'rtl', 'underwriter', '4', 458, 'prior_to_docs',
       'Every fatal PILOT finding across the file''s documents (ID, purchase contract, title, bank statements, etc.) must be resolved before clear-to-close.', true, 'manual'
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='underwriting_review_cleared');
