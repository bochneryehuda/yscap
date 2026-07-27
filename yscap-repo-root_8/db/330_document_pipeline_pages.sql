-- 330_document_pipeline_pages.sql
-- Pipeline V2 (owner-directed 2026-07-26) — RS-3: the per-page disposition record.
--
-- The stage row in document_pipeline_stages says HOW MANY pages need a person. This table says
-- WHICH ones, and why. Without it "3 pages need review" is unactionable — nobody can open the
-- packet and know where to look, which is how a page ends up ignored again by a different route.
--
-- Every page of every V2-read document gets exactly one row: assigned (it belongs to a classified
-- segment), excluded (it is provably blank — a separator or trailing sheet), or manual_review (a
-- person has to place it). There is no fourth value and no NULL: a page with no row at all is the
-- defect this whole item exists to make impossible, so the absence of a row is meaningful.
--
-- ADVISORY / V2-ONLY, like every other table in this family: nothing here writes to, reads back
-- into, or gates a real loan file. It is an audit record for the shadow surface.
--
-- Idempotent + additive: safe to re-run on every boot, modifies no existing table.

CREATE TABLE IF NOT EXISTS document_pipeline_pages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid NOT NULL REFERENCES document_pipeline_jobs(id) ON DELETE CASCADE,
  page_number   int  NOT NULL,
  -- The CHECK is the contract. A status outside it is REJECTED, and because the writer swallows
  -- errors (a page-accounting failure must never fail a good read), a rejected row is simply never
  -- written — so every value the code can produce must be listed here. See the identical hard-won
  -- note on document_pipeline_stages: 'failed' was missing there and the rows vanished silently.
  disposition   text NOT NULL CHECK (disposition IN ('assigned', 'excluded', 'manual_review')),
  -- Why it landed there, as a stable code the UI can switch on (in_segment / blank_page /
  -- no_segment_claims_this_page / claimed_by_more_than_one_segment / segment_confidence_below_floor).
  reason        text,
  -- The classified type the page was assigned to, when it was assigned to one.
  assigned_type text,
  confidence    numeric,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per page per job. A re-run of the same job RE-STATES each page rather than appending a
-- second opinion — the current disposition is the only one that means anything, and duplicates
-- would make "how many pages need review" a lie the moment a job retried.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dpp_job_page
  ON document_pipeline_pages (job_id, page_number);

-- The queue this exists to serve: the pages a person still owes work on.
CREATE INDEX IF NOT EXISTS idx_dpp_manual
  ON document_pipeline_pages (job_id)
  WHERE disposition = 'manual_review';
