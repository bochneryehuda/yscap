-- 245_encompass_field_catalog.sql — The tenant's Encompass field metadata, cached in PILOT
-- (owner-directed 2026-07-22, PILOT ↔ Encompass Phase 2 — READ-ONLY).
--
-- Encompass exposes every custom field, picklist enum, milestone, and folder as its own
-- resource (`/encompass/v3/settings/loan/customFields`, `.../enums`, `.../milestones`,
-- `.../folders`). PILOT pulls them once (nightly refresh) into this table so:
--   (a) the mapping doc `docs/ENCOMPASS-DATA-MAPPING.md` `⚠︎ verify against instance`
--       rows can be confirmed against real tenant metadata instead of guessed;
--   (b) `src/encompass/crosswalk.js` (future) has an authoritative picklist source;
--   (c) staff have a visible "here are the fields your Encompass has" table on the
--       admin panel (no more emailing screenshots).
-- Idempotent. Never touches Encompass (this is a PILOT-side cache table).
--
-- (kind, key) is the natural key:
--   kind  ∈ {'customField','enum','milestone','folder','standardField','loanTemplate'}
--   key    the canonical name (custom fields: 'CX.ARV'; enums: 'Loan.LoanPurpose:Purchase';
--          milestones: 'Approval'; folders: 'Active Loans'; etc.)

CREATE TABLE IF NOT EXISTS encompass_field_catalog (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN
                 ('customField', 'enum', 'milestone', 'folder', 'standardField', 'loanTemplate')),
  key          text NOT NULL,
  label        text,
  data_type    text,             -- 'string' | 'number' | 'currency' | 'date' | 'boolean' | ...
  options      jsonb,            -- for enum: the option list (label/value); NULL otherwise
  raw          jsonb NOT NULL,   -- the source object exactly as Encompass returned it (forensics)
  pulled_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_encompass_field_catalog UNIQUE (kind, key)
);

CREATE INDEX IF NOT EXISTS idx_encompass_field_catalog_kind ON encompass_field_catalog(kind);
CREATE INDEX IF NOT EXISTS idx_encompass_field_catalog_pulled_at ON encompass_field_catalog(pulled_at);
