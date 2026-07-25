-- Exception workflow REDESIGN (owner-directed 2026-07-24) — one register, richer governance.
--
-- Research: docs/EXCEPTION-WORKFLOW-REDESIGN.md. The platform had SIX parallel
-- "exception" mechanisms; the worst gap was the pricing "Request an exception"
-- button, which created NO reviewable record at all (a workflow hand-off + a
-- notification that deep-linked to a queue structurally unable to show it).
-- This migration turns loan_exceptions into the single POLICY-EXCEPTION REGISTER:
--
--   1. Two new exception types:
--        pricing_exception — the pricing/guideline "Request an exception" ask
--                            (finance more of an assignment fee, leverage, a
--                            guideline deviation…). The request is now a
--                            first-class record; the GRANT remains the existing
--                            studio action (admin override + re-register) —
--                            nothing here touches a frozen engine number.
--        issuance_override — an after-the-fact RECORD of a super-admin pushing a
--                            status/issuance past a fatal hard-warning (the R6.18
--                            backstop). Born approved (it documents an in-the-
--                            moment authority action, never sits open).
--   2. Governance columns (all additive; NULL on legacy rows = old behavior):
--        severity              advisory | standard | material (reporting + SLA).
--        compensating_factors  jsonb [{code, note}] — what offsets the risk.
--        deal_snapshot         jsonb — the deal economics at REQUEST time, so the
--                              review box shows the picture the requester saw
--                              (the live joins can drift before the decision).
--        expires_at/expired_at approval validity (super-admin sets it on types
--                              that gate a send/action; NEVER on guaranty_waiver
--                              — that flag only moves by human decision).
--        due_at                review SLA target for the open request.
--        re_request_of         link from a fresh request to the prior denied/
--                              withdrawn attempt (the re-request chain).
--        withdrawn_by/_at      the withdrawer, recorded in their OWN columns —
--                              decided_by is no longer overloaded on withdraw
--                              (legacy withdrawn rows keep decided_* populated;
--                              readers COALESCE across both).
--        requested_by_kind     staff | borrower | system — the borrower pricing
--                              "request an exception" path is now recorded too.
--        requested_by_borrower_id  who, when a borrower asked.
--        exception_seq         a stable human reference (shown as EX-<n>) for
--                              loan-sale / diligence conversations.
--   3. New status 'expired' — an approved, time-boxed exception past its
--      expires_at no longer grants anything (the e-sign gate only honors
--      status='approved', so the flip fails CLOSED by construction).
--   4. updated_at trigger — every write path keeps updated_at fresh without
--      hand-setting it (previously hand-maintained; a missed SET drifted).
--
-- Idempotent: IF NOT EXISTS / DROP+re-ADD constraint / CREATE OR REPLACE.
-- No destructive change; existing rows are untouched (new columns NULL or
-- defaulted). Previous files need no backfill — a NULL governance column reads
-- as the legacy behavior everywhere.

-- (1) Widen the type CHECK to the full registry.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override'));

-- (3) Widen the status CHECK with the terminal 'expired'.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));

-- (2) Governance columns — all additive.
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'standard';
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_severity_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_severity_check CHECK (severity IN ('advisory','standard','material'));

ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS compensating_factors jsonb;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS deal_snapshot jsonb;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS expired_at timestamptz;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS re_request_of uuid REFERENCES loan_exceptions(id) ON DELETE SET NULL;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS withdrawn_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS requested_by_kind text NOT NULL DEFAULT 'staff';
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_requested_by_kind_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_requested_by_kind_check CHECK (requested_by_kind IN ('staff','borrower','system'));
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS requested_by_borrower_id uuid REFERENCES borrowers(id) ON DELETE SET NULL;

-- The human reference number (EX-<n>). GENERATED BY DEFAULT (not ALWAYS) so a
-- restore/copy can carry explicit values; new rows draw from the sequence.
ALTER TABLE loan_exceptions ADD COLUMN IF NOT EXISTS exception_seq bigint GENERATED BY DEFAULT AS IDENTITY;

-- Indexes for the new read patterns.
CREATE INDEX IF NOT EXISTS idx_loan_exc_type_status ON loan_exceptions(exception_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_exc_expiring ON loan_exceptions(expires_at)
  WHERE status = 'approved' AND expires_at IS NOT NULL;

-- (4) updated_at trigger — replaces hand-maintenance (a forgotten SET drifted).
CREATE OR REPLACE FUNCTION loan_exceptions_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_loan_exc_touch_updated ON loan_exceptions;
CREATE TRIGGER trg_loan_exc_touch_updated
  BEFORE UPDATE ON loan_exceptions
  FOR EACH ROW EXECUTE FUNCTION loan_exceptions_touch_updated_at();
