-- 227 — Loan Digital Twin: canonical facts, observations, event ledger.
--
-- Owner-directed 2026-07-21 (Sovereign 1/4). PILOT no longer stores just "what
-- one document said." Every underwriting value becomes a CANONICAL FACT with:
--   * `loan_facts`         — one row per (application, fact_key) — the currently
--                            accepted value the underwriting side computes on.
--   * `fact_observations`  — append-only, one row per (source, fact_key) — WHAT
--                            each source (document / LOS field / user entry /
--                            API) claimed for that fact.
--   * `fact_events`        — append-only, one row per state change on either
--                            table so the whole history of a fact is
--                            reconstructible from events (event sourcing).
--
-- Design ideas:
--   1. Every material underwriting value has provenance — no bare string. A
--      finding raised against a fact can point at the observations that
--      produced it, and the underwriter can see which source won and why.
--   2. Multiple observations of the same fact can disagree — we don't force
--      one wins immediately. `status` on loan_facts records where we are
--      (observed / corroborated / verified / disputed / human_confirmed / …).
--   3. Human confirmations are FIRST-CLASS and outrank automated inference.
--   4. `effective_from` / `effective_to` are temporal — an old canonical is
--      superseded but never DELETED, so a decision certificate issued
--      yesterday can be reconstructed against yesterday's canonical facts.
--   5. Idempotent (safe to re-run every boot).

-- ---- CANONICAL FACTS ------------------------------------------------------
CREATE TABLE IF NOT EXISTS loan_facts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Dotted namespace (e.g. 'loan.amount', 'borrower.name', 'property.address',
  -- 'property.units', 'entity.formation_date', 'appraisal.as_is_value'). The
  -- fact-key vocabulary lives in src/lib/underwriting/twin.js FACT_KEYS.
  fact_key                 text NOT NULL,
  -- Full structured value (a string / number / object). JSON keeps room for
  -- addresses (multiple parts), party lists, calculations with basis, etc.
  value_json               jsonb,
  -- A denormalized, canonicalized text form — used for indexing + fast
  -- cross-observation comparison (address normalization, currency in cents,
  -- ISO date). Sourced from the value_json by NORMALIZERS.
  value_normalized         text,
  -- The observation that CURRENTLY wins reconciliation (source hierarchy +
  -- confidence + human confirmation). NULL for a computed / derived fact.
  authoritative_observation_id uuid,
  -- Lifecycle:
  --   observed          — one source says X; not yet corroborated
  --   corroborated      — 2+ agreeing sources
  --   verified          — a high-authority source (title / bureau / API / carrier) confirmed
  --   disputed          — sources disagree and none is authoritative alone
  --   superseded        — a newer observation obsoleted this canonical
  --   human_confirmed   — a human explicitly signed off on this value
  --   unable_to_determine — no observation is trustworthy enough to accept
  status                   text NOT NULL DEFAULT 'observed'
                           CHECK (status IN ('observed','corroborated','verified',
                                             'disputed','superseded','human_confirmed',
                                             'unable_to_determine')),
  consensus_score          numeric,           -- 0-1: agreement across current observations
  human_confirmed_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  human_confirmed_at       timestamptz,
  effective_from           timestamptz NOT NULL DEFAULT now(),
  effective_to             timestamptz,       -- NULL = still current
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
-- Exactly one CURRENT canonical per (application, fact_key). A supersede sets
-- effective_to on the old row before inserting the new one, so the partial
-- unique index enforces "at most one live canonical per fact per file."
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_facts_current
  ON loan_facts (application_id, fact_key) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_loan_facts_app ON loan_facts (application_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_loan_facts_status ON loan_facts (status) WHERE effective_to IS NULL;

-- ---- OBSERVATIONS (append-only per source) -------------------------------
CREATE TABLE IF NOT EXISTS fact_observations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  fact_key                 text NOT NULL,
  -- Where the observation came from. Keeps four cleanly separated so a source
  -- hierarchy (title > appraisal > application, etc.) can rank them.
  source_type              text NOT NULL
                           CHECK (source_type IN ('document','los_field','user_entry',
                                                  'api_verification','derivation','ai_extraction')),
  source_id                text,              -- doc-type / LOS field name / user id / API name
  document_id              uuid REFERENCES documents(id) ON DELETE SET NULL,
  extraction_id            uuid REFERENCES document_extractions(id) ON DELETE SET NULL,
  page_number              integer,
  -- What the source said (exact) + a canonical form (comparable across sources).
  raw_value                text,
  normalized_value         text,
  value_json               jsonb,
  -- Provenance the router / analyzer produced so a proof-of-record has the
  -- engine + confidence stamped alongside the value.
  ocr_engine               text,
  extraction_engine        text,
  ocr_confidence           numeric,
  extraction_confidence    numeric,
  agrees_with_canonical    boolean,
  superseded_at            timestamptz,       -- NULL = live; set when the source doc is replaced
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_factobs_app_key ON fact_observations (application_id, fact_key)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_factobs_document ON fact_observations (document_id)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_factobs_extraction ON fact_observations (extraction_id)
  WHERE superseded_at IS NULL;

-- ---- EVENT LEDGER (append-only) ------------------------------------------
CREATE TABLE IF NOT EXISTS fact_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  fact_key                 text NOT NULL,
  event_type               text NOT NULL
                           CHECK (event_type IN ('observation_added','observation_superseded',
                                                 'canonical_created','canonical_changed',
                                                 'status_changed','human_confirmed','rejected')),
  prior_value_json         jsonb,
  new_value_json           jsonb,
  prior_status             text,
  new_status               text,
  observation_id           uuid REFERENCES fact_observations(id) ON DELETE SET NULL,
  fact_id                  uuid REFERENCES loan_facts(id) ON DELETE SET NULL,
  actor_kind               text NOT NULL DEFAULT 'system'
                           CHECK (actor_kind IN ('system','staff','borrower')),
  actor_id                 uuid,
  reason                   text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_factevents_app_key ON fact_events (application_id, fact_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_factevents_app_created ON fact_events (application_id, created_at DESC);
