-- 512_doclab.sql — DOCLAB (Private Lender Law) loan-document drafting. FOUNDATIONS.
--
-- DocLab drafts the loan documents. It is the API form of a step this repo already
-- automates by email: `lib/closing-prep.js` sends the closing package to
-- TeamAG@privatelenderlaw.com and waits for a human at that firm to draft. Private
-- Lender Law is the same firm that runs DocLab, so this is the same step with a
-- structured payload instead of an attachment — see docs/doclab/.
--
-- FOUR TABLES, AND THE SPLIT IS DELIBERATE:
--   doclab_requests            one row per loan-document request we own
--   doclab_request_events      every status it has ever been in — append-only
--   doclab_templates           the cached lender → category → state hierarchy
--   doclab_prepayment_options  the cached per-state option list
--
-- WHY THE EVENT LOG IS ITS OWN TABLE. The request's status is the ONLY signal that
-- a law firm is waiting on us for something ("moreInfo") or that documents exist
-- ("completed"), it moves asynchronously, and it can move BACKWARDS — a request
-- that reached `submitted` returns to `moreInfo` the moment a reviewer asks a
-- question. A single mutable status column answers "where is it now?" and can never
-- answer "how long did it sit in moreInfo?" or "did anybody notice it went back?".
-- Both are questions a closing desk asks.
--
-- NOTHING HERE IS WIRED TO A ROUTE YET. This shift builds the foundations: the
-- catalogue, the scope gate, the field map, the payload builder, the transport and
-- this schema. Ordering from a file, the desk surface and the poller come next,
-- once PLL has given us credentials, our template names and the environmental-
-- options list. The tables are created now so that work has somewhere to land and
-- so the migration numbering is settled.

-- ─────────────────────────────── the requests ───────────────────────────────

CREATE TABLE IF NOT EXISTS doclab_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

  -- DocLab's own id for the request. NULL until the first submission comes back.
  -- Everything after that keys on it: an update carries it, and LOSING it means the
  -- next submission silently creates a SECOND request for a loan that already has
  -- one — which is the single most expensive mistake available on this integration.
  doclab_request_id   text,

  -- The three fields that chose the template, stored as SENT. A template selection
  -- is not reconstructable later: the category names are mid-rename at PLL and our
  -- own file can be re-registered onto a different programme afterwards.
  template_lender_name text,
  loan_category        text,
  template_state       text,

  -- Sandbox and production share one base URL and are told apart ONLY by the
  -- credential (their API Setup page). So the environment is recorded per request:
  -- without it a file cannot answer whether its documents were drafted for real.
  environment         text NOT NULL DEFAULT 'unknown',

  -- The life-cycle, in DocLab's own vocabulary (see src/doclab/catalog.js STATUS).
  -- Free text on purpose: pinning a CHECK to today's nine names would turn a status
  -- PLL adds next year into a failed sync instead of an unrecognised status.
  status              text,
  response_code       integer,

  -- What we sent and what came back, for the audit trail and for re-submission.
  -- No borrower SSN or password ever enters this payload — DocLab has no field for
  -- one — but it does carry names and addresses, so it is staff-visible only.
  last_payload        jsonb,
  last_response       jsonb,

  -- What was still missing when we last built the package. This is the honest
  -- record of an incomplete submission; see src/doclab/payload.js.
  missing             jsonb,

  submitted_at        timestamptz,
  approved_at         timestamptz,
  word_generated_at   timestamptz,
  completed_at        timestamptz,
  -- The documents we pulled back and filed, so a re-poll never re-files them.
  pdf_document_id     uuid REFERENCES documents(id) ON DELETE SET NULL,
  word_document_id    uuid REFERENCES documents(id) ON DELETE SET NULL,

  -- A request PLL rejected or that errored. Kept, never deleted — a rejection is
  -- part of the file's history.
  error_detail        text,

  created_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doclab_requests_app ON doclab_requests (application_id);

-- DocLab's id is globally unique on their side, so it is unique here too. This is
-- the guard that makes a retried submission safe: a create whose reply we never saw
-- cannot be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_doclab_requests_remote
  ON doclab_requests (doclab_request_id)
  WHERE doclab_request_id IS NOT NULL;

-- ONE LIVE REQUEST PER FILE. A second live request means two sets of loan documents
-- drafted for one closing, and nothing downstream could tell which set is real. A
-- request that ended (completed / rejected) is outside the index, so a file can be
-- re-drafted after a rejection, and history is kept.
CREATE UNIQUE INDEX IF NOT EXISTS uq_doclab_requests_one_live
  ON doclab_requests (application_id)
  WHERE completed_at IS NULL AND lower(COALESCE(status,'')) <> 'rejected';

-- ─────────────────────────────── the event log ───────────────────────────────

CREATE TABLE IF NOT EXISTS doclab_request_events (
  id                  bigserial PRIMARY KEY,
  doclab_request_id   uuid NOT NULL REFERENCES doclab_requests(id) ON DELETE CASCADE,
  status              text,
  response_code       integer,
  -- 'submit' | 'poll' | 'notification' | 'approve' | 'generate_pdf' | 'download'
  source              text,
  detail              text,
  payload             jsonb,
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doclab_events_request
  ON doclab_request_events (doclab_request_id, occurred_at DESC);

-- ───────────────────────── the cached configuration ─────────────────────────
--
-- `GET getLenderCategory` returns lender → category → state → {licenseNeeded,
-- prepayment options}. Their own guidance is to cache it: it is configuration, it
-- changes when PLL changes it, and it is the ONLY authority on which lender name +
-- category + state combinations exist for us. It is also how we find out that a
-- template we expected is missing from the sandbox — their API Setup page warns
-- sandbox and production templates are NOT shared.

CREATE TABLE IF NOT EXISTS doclab_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_id           integer,
  lender_name         text NOT NULL,
  category_id         integer,
  category_name       text NOT NULL,
  state_id            integer,
  state_name          text NOT NULL,
  license_needed      boolean,
  environment         text NOT NULL DEFAULT 'unknown',
  raw                 jsonb,
  refreshed_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per (environment, lender, category, state). The environment is part of
-- the key because the two environments genuinely hold different template sets —
-- their own API Setup page warns that sandbox and production templates are NOT
-- shared, so a combination that exists in one may simply not exist in the other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_doclab_templates
  ON doclab_templates (environment, lower(lender_name), lower(category_name), lower(state_name));

CREATE TABLE IF NOT EXISTS doclab_prepayment_options (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_name          text NOT NULL,
  option_code         text NOT NULL,
  option_name         text,
  option_description  text,
  environment         text NOT NULL DEFAULT 'unknown',
  refreshed_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doclab_prepay
  ON doclab_prepayment_options (environment, lower(state_name), option_code);

-- ─────────────────────────────── housekeeping ───────────────────────────────
-- The repo's standard updated_at trigger, guarded so re-running the file is safe.

CREATE OR REPLACE FUNCTION doclab_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_doclab_requests_touch ON doclab_requests;
CREATE TRIGGER trg_doclab_requests_touch
  BEFORE UPDATE ON doclab_requests
  FOR EACH ROW EXECUTE FUNCTION doclab_touch_updated_at();
