-- 283 — Note-buyer condition guidelines (Investor-Specific Soft Guidelines, ISG-2;
--       owner-directed 2026-07-23).
--
-- The THIRD underwriting layer's data foundation. Layer 1 = hard pricing/structure
-- guidelines (frozen engines). Layer 2 = document intelligence (twin/cure/findings).
-- Layer 3 (this) = per-NOTE-BUYER "soft" guidelines: for a given note buyer + product,
-- which conditions must be posted, how each is cleared (required evidence + checks/
-- limits), when in the lifecycle, and which existing PILOT condition it maps to.
--
-- Distinct from guideline_rules (db/258): those are eligibility/leverage PASS-FAIL
-- expressions; THIS is condition-CLEARING instructions + evidence requirements, seeded
-- from the owner's real condition spreadsheets (first: CorrFirst "Fix & Flip Purchase").
--
-- Applicability is governed by the ROW's scope + investor_id, NOT the source document's
-- investor: an "all note buyers" row inside CorrFirst's sheet applies to every note buyer.
--
-- ADVISORY / never blocks (governing rule #217). Touches NO frozen pricing number — it
-- only DESCRIBES how a note buyer wants conditions cleared. Additive + idempotent.

CREATE TABLE IF NOT EXISTS note_buyer_conditions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- provenance + versioning: which source guideline version this row came from
  -- (re-ingesting a newer sheet supersedes via a new version; guideline-diff can
  -- show what changed). Reuses the db/258 versioned knowledge store.
  guideline_version_id  uuid REFERENCES guideline_versions(id) ON DELETE CASCADE,
  product               text NOT NULL,              -- 'fix_and_flip_purchase'
  cond_no               integer NOT NULL,           -- canonical condition number (1015, 1017, …)
  name                  text NOT NULL,
  domain                text,                        -- credit/identity/assets_liquidity/title/…
  -- applicability
  scope                 text NOT NULL DEFAULT 'all_note_buyers',
                        -- 'all_note_buyers' | 'note_buyer' | 'all_but_note_buyer_limits'
  investor_id           uuid REFERENCES investors(id) ON DELETE SET NULL,  -- set for note_buyer / limits-owner scopes
  lifecycle             text NOT NULL DEFAULT 'active_now',
                        -- 'active_now' | 'hold_attorney_closing' | 'defer_post_closing' | 'closing_phase'
  trigger               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- rule_logic-shaped; '{}' = always applies
  -- clearing
  required_evidence     text,
  checks                jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{text, note_buyer_specific:bool}]
  clears_by             text,                        -- document_upload|internal_verification|third_party_order|attorney_closing|system_field_check
  -- crosswalk to PILOT's existing condition catalog (checklist_templates.code) or NULL = new
  pilot_template_code   text,
  match_quality         text,                        -- 'exact' | 'partial' | 'new'
  source_row            integer,
  active                boolean NOT NULL DEFAULT true,
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- one row per condition per source version.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nbc_version_cond
  ON note_buyer_conditions (guideline_version_id, cond_no);
CREATE INDEX IF NOT EXISTS idx_nbc_product_scope ON note_buyer_conditions (product, scope);
CREATE INDEX IF NOT EXISTS idx_nbc_investor ON note_buyer_conditions (investor_id);
CREATE INDEX IF NOT EXISTS idx_nbc_pilot_code ON note_buyer_conditions (pilot_template_code);

-- The row data itself is seeded idempotently at boot from the checked-in spec module
-- (src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec.js →
--  investor-guidelines/seed.js seedNoteBuyerConditions), NOT hand-written here, so the
-- 47 rich conditions stay in one reviewable, unit-tested source of truth.
