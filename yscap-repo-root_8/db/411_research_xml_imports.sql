-- 411 — STANDALONE XML IMPORTS INTO THE RESEARCH WAREHOUSE
--
-- db/409 files an appraisal into the warehouse by reading the per-loan-file tables
-- the appraisal desk already wrote (`appraisals` + `appraisal_comparables`). That
-- covers every report that arrived on a loan file — but the owner also wants to
-- feed the warehouse REPORTS THAT ARE NOT ON A FILE: an old export folder, an
-- appraisal on a deal we never wrote, a bulk drop of a hundred XMLs. Those have no
-- application, and `appraisals.application_id` is NOT NULL for good reason (that
-- row drives the loan file's appraisal desk, its findings and its conditions — a
-- row with no file would be picked up by half a dozen sweeps that assume one).
--
-- So a standalone import gets its OWN header row here, and writes the SAME
-- observations through the SAME code. `property_observations` now carries EITHER
-- an `appraisal_id` (it came from a loan file) OR an `import_id` (it was uploaded
-- straight into the research database) — never both, never neither.
--
-- ONE REPORT IS ONE REPORT, WHICHEVER DOOR IT CAME THROUGH. The same appraisal can
-- plausibly arrive both ways (uploaded here today, imported onto a loan file next
-- month). Counting it twice would double every comp count and let one appraiser's
-- single opinion out-vote the rest of the market, so the ingest reconciles them on
-- the report's own identity — same property, same effective date, same appraiser —
-- and keeps ONE of them: the loan-file copy always wins, because it is the one
-- with the photos, the findings and a file behind it.

-- ---------------------------------------------------------------------------
-- 1. the import header — one row per uploaded XML
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS research_imports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The sha256 of the XML bytes. This is what makes an upload IDEMPOTENT: dropping
  -- the same folder in twice re-uses the row and refreshes it, instead of storing
  -- every property a second time.
  sha256                text NOT NULL,
  filename              text,
  byte_size             integer,
  uploaded_by           uuid REFERENCES staff_users(id) ON DELETE SET NULL,

  -- 'ok'        — folded into the warehouse
  -- 'skipped'   — deliberately not folded in (already here from a loan file, or a
  --               newer import of the same report replaced it)
  -- 'error'     — could not be read; the reason is in `error`
  status                text NOT NULL DEFAULT 'pending',
  error                 text,

  -- When this exact report is ALSO on a loan file, the file's copy is the one the
  -- warehouse keeps and this points at it — so the screen can say where it went
  -- rather than just "skipped".
  appraisal_id          uuid REFERENCES appraisals(id) ON DELETE SET NULL,

  -- What the report says about itself, kept here so the import list is readable
  -- without re-parsing the XML.
  form_type             text,
  effective_date        date,
  subject_address       text,
  subject_city          text,
  subject_state         text,
  subject_zip           text,
  subject_property_id   uuid REFERENCES properties(id) ON DELETE SET NULL,
  appraiser_id          uuid REFERENCES appraisers(id) ON DELETE SET NULL,

  comparables_seen      integer NOT NULL DEFAULT 0,
  properties_written    integer NOT NULL DEFAULT 0,
  observations_written  integer NOT NULL DEFAULT 0,
  sales_written         integer NOT NULL DEFAULT 0,
  rows_skipped          integer NOT NULL DEFAULT 0,
  skip_reasons          jsonb   NOT NULL DEFAULT '[]'::jsonb,

  created_at            timestamptz NOT NULL DEFAULT now(),
  ran_at                timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_imports_sha ON research_imports(sha256);
CREATE INDEX IF NOT EXISTS ix_research_imports_created ON research_imports(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_research_imports_status  ON research_imports(status);
CREATE INDEX IF NOT EXISTS ix_research_imports_appr    ON research_imports(appraiser_id);

-- ---------------------------------------------------------------------------
-- 2. an observation may come from an upload instead of a loan file
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, never CASCADE — for exactly the reason db/409 gives for the
-- appraisal link. Deleting the paperwork must never delete what it taught us about
-- the market; the observation outlives the import record.
ALTER TABLE property_observations
  ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES research_imports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_prop_obs_import ON property_observations(import_id)
  WHERE import_id IS NOT NULL;

-- The two pivots that make an upload re-runnable, mirroring the appraisal-side
-- pair in db/409. An uploaded report has no `appraisal_comparables` row to key a
-- comparable on, so its comps are keyed on (import, grid position) instead — the
-- position IS the identity within one report's grid.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_obs_import_subject
  ON property_observations(import_id)
  WHERE role = 'subject' AND import_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_obs_import_comp
  ON property_observations(import_id, comp_seq)
  WHERE role = 'comparable' AND import_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. a sale can be sourced from an upload too
-- ---------------------------------------------------------------------------
ALTER TABLE property_sales
  ADD COLUMN IF NOT EXISTS source_import_id uuid REFERENCES research_imports(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4. AN APPRAISER'S BODY OF WORK INCLUDES THE REPORTS THAT ARE NOT ON A FILE
-- ---------------------------------------------------------------------------
-- `appraisal_count` counts the reports that came in on a loan file, and it must
-- keep meaning exactly that — the profile shows it beside `file_count`. An
-- UPLOADED report is a report they wrote too, so it gets its own counter rather
-- than being folded into a number that already has a meaning.
ALTER TABLE appraisers ADD COLUMN IF NOT EXISTS import_count integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. THE REPORT IDENTITY — how the two doors recognise the same report
-- ---------------------------------------------------------------------------
-- A subject observation IS the report's fingerprint: this property, on this
-- effective date, by this appraiser. The index makes the reconciliation lookup
-- (and the duplicate check the upload runs before it writes anything) cheap.
CREATE INDEX IF NOT EXISTS ix_prop_obs_report_identity
  ON property_observations(property_id, observed_on, appraiser_id)
  WHERE role = 'subject';
