-- ============================================================================
-- 137_appraisals.sql — store the imported appraisal (parsed from the MISMO XML),
-- its comparables / per-unit rents / photos, and the PILOT underwriting findings.
--
-- The parser (src/lib/appraisal) turns an uploaded appraisal XML into structured,
-- validated, confidence-stamped fields. This migration is where that lands. Design:
--   * one appraisals row per import (re-import supersedes; keep history).
--   * dedicated columns for the high-value fields (each with a *_confidence twin),
--     PLUS a `fields` jsonb catch-all so NOTHING is dropped, PLUS `warnings` jsonb.
--   * child tables for comps / units / photos / findings.
--   * two internal conditions: verify-As-Is (when we can't read it) and the
--     blocking "appraisal review cleared" (CTC gate while any fatal finding is open).
--
-- Additive + idempotent (safe to re-run on every boot). Nothing here overwrites the
-- loan file — the import populates applications.as_is_value/arv only from DEFINITE
-- values and only via the app layer's overwrite-shield.
-- ============================================================================

CREATE TABLE IF NOT EXISTS appraisals (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id         uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    source_xml_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
    pdf_document_id        uuid REFERENCES documents(id) ON DELETE SET NULL,
    -- form / provenance
    form_type              text,                      -- FNM1004 | FNM1025 | FNM1073
    form_version           text,
    software_vendor        text,
    effective_date         date,
    report_signed_date     date,
    inspection_date        date,
    appraisal_purpose      text,
    condition_of_appraisal text,                      -- AsIs | SubjectToRepairs | SubjectToCompletion | SubjectToInspection
    -- values (each paired with a confidence: definite | needs_verify | missing)
    appraised_value        numeric(14,2),
    as_is_value            numeric(14,2),
    as_is_confidence       text,
    arv_value              numeric(14,2),
    arv_confidence         text,
    value_sales_approach   numeric(14,2),
    value_cost_approach    numeric(14,2),
    value_income_approach  numeric(14,2),
    grm                    numeric(10,2),
    site_value             numeric(14,2),
    contract_price         numeric(14,2),
    contract_date          date,
    -- subject
    subject_address        text,
    subject_unit           text,
    subject_city           text,
    subject_county         text,
    subject_state          text,
    subject_zip            text,
    apn                    text,
    legal_description      text,
    census_tract           text,
    neighborhood           text,
    property_type          text,
    units                  integer,
    year_built             text,
    gla                    numeric(12,2),
    rooms                  integer,
    beds                   integer,
    baths_full             integer,
    baths_half             integer,
    stories                text,
    design_style           text,
    lot_area               text,
    zoning_id              text,
    zoning_desc            text,
    zoning_compliance      text,
    condition_uad          text,                      -- C1..C6 only (else null + warning)
    quality_uad            text,                      -- Q1..Q6 only
    flood_zone             text,
    -- appraiser
    appraiser_name         text,
    appraiser_company      text,
    license_id             text,
    license_state          text,
    license_type           text,
    license_exp            date,
    appraiser_phone        text,
    appraiser_email        text,
    supervisor_name        text,
    lender_name            text,
    amc_name               text,
    borrower_name          text,
    borrower_is_entity     boolean,
    -- condo (1073)
    condo_project_name     text,
    condo_project_type     text,
    condo_unit_identifier  text,
    condo_floor            text,
    hoa_fee_amount         numeric(12,2),
    hoa_fee_period         text,
    -- catch-all + quality
    fields                 jsonb NOT NULL DEFAULT '{}'::jsonb,   -- full extracted set as {key:{value,source,confidence}}
    warnings               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- tripwire/sanity flags
    -- housekeeping
    superseded             boolean NOT NULL DEFAULT false,
    imported_by            uuid,
    imported_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisals_app ON appraisals(application_id);
CREATE INDEX IF NOT EXISTS idx_appraisals_app_current ON appraisals(application_id) WHERE superseded = false;

CREATE TABLE IF NOT EXISTS appraisal_comparables (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraisal_id      uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    seq               text,
    is_subject        boolean NOT NULL DEFAULT false,   -- the seq-0 "subject as a comp" column
    address           text,
    city              text,
    state             text,
    zip               text,
    proximity         text,
    sale_price        numeric(14,2),
    adjusted_price    numeric(14,2),
    gla               numeric(12,2),
    sale_date         text,
    net_adjustment    numeric(14,2),
    net_adj_pct       numeric(8,2),
    gross_adj_pct     numeric(8,2),
    condition_uad     text,
    quality_uad       text,
    days_on_market    text,
    data_source       text,
    comp_set          text,                            -- arv | as_is | unknown
    adjustments       jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_appr_comps ON appraisal_comparables(appraisal_id);

CREATE TABLE IF NOT EXISTS appraisal_units (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraisal_id  uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    unit_seq      text,
    rooms         integer,
    beds          integer,
    baths         text,
    sqft          numeric(12,2),
    actual_rent   numeric(12,2),
    market_rent   numeric(12,2),
    lease_status  text
);
CREATE INDEX IF NOT EXISTS idx_appr_units ON appraisal_units(appraisal_id);

CREATE TABLE IF NOT EXISTS appraisal_photos (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraisal_id  uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    document_id   uuid REFERENCES documents(id) ON DELETE SET NULL,  -- extracted image (when wired)
    category      text,                                -- subject_front | subject_rear | subject_street | interior | comparable | sketch | map | exhibit
    caption       text,
    sequence      integer,
    width         integer,
    height        integer
);
CREATE INDEX IF NOT EXISTS idx_appr_photos ON appraisal_photos(appraisal_id);

CREATE TABLE IF NOT EXISTS appraisal_findings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appraisal_id     uuid NOT NULL REFERENCES appraisals(id) ON DELETE CASCADE,
    application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    source           text NOT NULL DEFAULT 'appraisal',  -- future: credit | title | ...
    code             text NOT NULL,
    severity         text NOT NULL,                    -- fatal | warning | info
    field            text,
    appraisal_value  text,
    file_value       text,
    title            text,
    how_to           text,
    blocks_ctc       boolean NOT NULL DEFAULT false,
    -- lifecycle: open -> resolved (with an action) / dismissed
    status           text NOT NULL DEFAULT 'open',      -- open | resolved | dismissed
    resolution       text,                             -- replace | keep | custom | dismiss | decline | acknowledge | grant_exception | request_revision
    resolution_value text,
    resolution_note  text,
    resolved_by      uuid,
    resolved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appr_findings_app ON appraisal_findings(application_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_appr_findings_appraisal ON appraisal_findings(appraisal_id);

-- ------------------------------------------------------------------------
-- Internal conditions (audience=staff, item_kind=condition), mirroring db/059.
--   * appraisal_as_is_verify  — opened by import when As-Is is not definite; the
--     officer reads it off the report (OCR may pre-fill a candidate to confirm).
--   * appraisal_review_cleared — the CTC gate; cannot be signed off while any
--     fatal PILOT finding is open (enforced in the app layer + a later trigger).
-- ------------------------------------------------------------------------
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, is_required, auto_apply)
SELECT 'appraisal_as_is_verify', 'Verify As-Is value on the appraisal', 'application', 'staff', 'condition', 'rtl', 'underwriter', '4', 452, 'prior_to_docs',
       'We could not read the As-Is value from the appraisal data. Open the report and enter the As-Is value.', true, 'manual'
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='appraisal_as_is_verify');

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase, sort_order, category, hint, is_required, auto_apply)
SELECT 'appraisal_review_cleared', 'Appraisal review cleared (all PILOT findings resolved)', 'application', 'staff', 'condition', 'rtl', 'underwriter', '4', 455, 'prior_to_docs',
       'Every fatal PILOT finding (appraisal vs file) must be resolved before clear-to-close.', true, 'manual'
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code='appraisal_review_cleared');
