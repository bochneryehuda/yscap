-- Personal-guarantor default + co-borrower guaranty-waiver exception (owner-directed 2026-07-22).
--
-- By DEFAULT every term sheet is FULL RECOURSE and lists BOTH the borrower and the
-- co-borrower as personal guarantors (jointly & severally). In rare, super-admin
-- APPROVED cases the co-borrower's personal guaranty is waived — they remain a
-- member/owner of the borrowing entity (LLC) but are not a personal guarantor.
--
-- Two pieces:
--   1. applications.co_borrower_pg_waived — the EFFECTIVE display flag the term
--      sheet reads. false (default) = both guarantee, full recourse; true = the
--      co-borrower's personal guaranty is waived (a non-guarantor member). It is
--      set ONLY by an approved guaranty-waiver exception (never a free studio
--      toggle) and never touches a frozen engine number — display/record only.
--   2. loan_exceptions — a clean, purpose-built exception record with its own
--      lifecycle (requested → approved | denied | withdrawn), the requester's
--      structured reason, and the super-admin's decision. This is the "single
--      source of truth" for an exception so the workflow is auditable and the
--      term sheet and the exception can never disagree. Built general (an
--      exception_type discriminator) so future exception kinds reuse the queue.
--
-- Additive + idempotent. Every existing file defaults to co_borrower_pg_waived
-- = false (both guarantee) on the next boot.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS co_borrower_pg_waived boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS loan_exceptions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id      uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The kind of policy exception. Only 'guaranty_waiver' today; the discriminator
  -- lets the same queue + review UI host future exception types.
  exception_type      text NOT NULL DEFAULT 'guaranty_waiver'
                        CHECK (exception_type IN ('guaranty_waiver')),
  -- Whose personal guaranty is affected (the co-borrower, for a guaranty waiver).
  subject_borrower_id uuid REFERENCES borrowers(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','approved','denied','withdrawn')),
  reason_code         text,          -- a structured reason (see loan-exceptions.js REASON_CODES)
  reason_note         text,          -- the requester's free-text justification
  requested_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  decided_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at          timestamptz,
  decision_note       text,          -- the super-admin's required decision comment
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loan_exc_app    ON loan_exceptions(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_exc_status ON loan_exceptions(status, created_at DESC);
-- At most ONE open (requested) exception of a given type per file — a new request
-- supersedes any prior open one in code (mirrors uq_manual_esc_openish_per_app).
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_exc_open_per_app
  ON loan_exceptions(application_id, exception_type) WHERE status = 'requested';
