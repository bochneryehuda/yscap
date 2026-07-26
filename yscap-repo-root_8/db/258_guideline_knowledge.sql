-- 258 — Mortgage Knowledge Graph: investors + versioned guideline rules
--       (R5.32, owner-directed 2026-07-22 — "the single biggest competitive
--       advantage you can build … knowledge-driven underwriting").
--
-- Today `program-guidelines.js` composes a small live snapshot (beneficial-owner
-- threshold, statement months, SOW contingency). That is useful but not an
-- investor knowledge system. The owner wants the AI to move from "what does this
-- document say?" to "does this loan make sense?" — which requires a structured,
-- VERSIONED knowledge base of investor guidelines, state overlays, internal YS
-- policies, and exceptions, each rule carrying an effective date and a source
-- citation, so every eligibility/leverage/condition outcome is explainable and
-- reproducible against the exact rule version used at decision time.
--
-- This migration adds the base knowledge tables:
--   investors           note buyers / capital partners as first-class entities
--   guideline_documents  a source guideline file (per investor+program)
--   guideline_versions   a semantic version of a document, with effective dates
--   guideline_rules      the individual rules, each scoped + versioned + cited
--
-- Overlays / exceptions / decision snapshots land in R5.33 (db/259); the rule
-- compiler + precedence engine in R5.35; the frozen Gold/Standard numbers are
-- MODELED as rules in R5.36 WITHOUT changing any number (HARD RULE — frozen
-- pricing/guideline logic is never altered; this only DESCRIBES it in data).
--
-- CRITICAL: this schema stores knowledge; it does NOT change any pricing engine.
-- The frozen engines remain the source of truth for computation; these rows are
-- an explainability + versioning + investor-fit layer on top.
--
-- Additive + idempotent.

-- ---------------------------------------------------------------------------
-- investors — note buyers / capital partners as first-class entities.
-- label_norm matches applications.lender's normalization + sitewire_partner_links
-- (lowercase, strip non-alphanumerics) so "Blue Lake"/"bluelake" resolve as one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS investors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  label_norm        text UNIQUE NOT NULL,        -- lower(strip non-alphanumerics)
  channel           text,                        -- 'note_buyer' | 'capital_partner' | 'internal'
  active            boolean NOT NULL DEFAULT true,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- guideline_documents — a source guideline (per investor + program family).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guideline_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id       uuid REFERENCES investors(id) ON DELETE SET NULL,   -- NULL = a base YS program
  program           text,                        -- 'standard' | 'gold' | 'manual' | investor program name
  title             text NOT NULL,
  source_ref        text,                        -- storage ref / URL of the guideline PDF (if any)
  source_sha256     text,
  published_at      date,
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guideline_docs_investor ON guideline_documents (investor_id);
CREATE INDEX IF NOT EXISTS idx_guideline_docs_program ON guideline_documents (program);

-- ---------------------------------------------------------------------------
-- guideline_versions — a semantic version of a document, effective-dated.
-- Only ONE version per document may be 'active' at a time (partial unique).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guideline_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guideline_document_id uuid NOT NULL REFERENCES guideline_documents(id) ON DELETE CASCADE,
  version           text NOT NULL,               -- semantic version string, e.g. '2026.07.1'
  effective_from    date,
  effective_to      date,                         -- NULL = still effective
  -- draft / active / superseded
  approval_status   text NOT NULL DEFAULT 'draft',
  superseded_by     uuid REFERENCES guideline_versions(id) ON DELETE SET NULL,
  approved_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  notes             text,
  source_sha256     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guideline_versions_doc_ver
  ON guideline_versions (guideline_document_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guideline_versions_one_active
  ON guideline_versions (guideline_document_id)
  WHERE approval_status = 'active';

-- ---------------------------------------------------------------------------
-- guideline_rules — the individual rules of a version.
--   scope       — when the rule applies (loan type, transaction, state,
--                 property, occupancy, borrower/experience tier, …)
--   expression  — the deterministic condition (a decision-table / expression the
--                 R5.35 compiler evaluates — NOT model intuition)
--   outcome     — what happens when it matches (eligible / cap value / condition
--                 / manual-review / hard-stop)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guideline_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guideline_version_id uuid NOT NULL REFERENCES guideline_versions(id) ON DELETE CASCADE,
  rule_key          text NOT NULL,               -- stable key, e.g. 'max_ltv', 'min_fico', 'statement_months'
  scope             jsonb NOT NULL DEFAULT '{}'::jsonb,
  expression        jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- info / warning / material / hard_stop
  materiality       text NOT NULL DEFAULT 'material',
  exception_allowed boolean NOT NULL DEFAULT false,
  exception_authority text,                       -- who may grant an exception (role)
  effective_from    date,
  effective_to      date,
  source_evidence_span_id uuid REFERENCES evidence_spans(id) ON DELETE SET NULL,  -- page/paragraph citation
  meta              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guideline_rules_ver_key
  ON guideline_rules (guideline_version_id, rule_key);
CREATE INDEX IF NOT EXISTS idx_guideline_rules_key ON guideline_rules (rule_key);
