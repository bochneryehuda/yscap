-- db/468 — a REQUESTABLE "waive this condition" exception (owner-directed
-- 2026-08-04).
--
-- The owner: "any user should be able to request from the admin or super admin an
-- exception to waive any condition. And after the exception is being approved,
-- that condition should be marked as waived."
--
-- Until now the only way past an unfulfilled condition was the super-admin's OWN
-- immediate override (db/344, condition_override — record-only, super-admin only)
-- or a handful of type-specific gate unlocks (credit / appraisal-XML). There was
-- no path where an ordinary staffer REQUESTS a waiver of a SPECIFIC condition and
-- an admin/super-admin APPROVES it, with the approval itself marking that
-- condition waived. This adds that type:
--
--   condition_waiver  — a real request → decision (not record-only). It names the
--                       target checklist_item (target_checklist_item_id). On
--                       APPROVE, admin-exceptions.js marks that one condition
--                       waived (status='satisfied' + waived stamps), exactly the
--                       way an approved guaranty_waiver flips its file flag. On
--                       DENY nothing changes.
--
-- SCOPE: it clears the checklist_items condition it names and NOTHING else — never
-- another condition, never a frozen number. Any staffer on the file may request;
-- an admin/super-admin decides (the register's default `manage_pricing` gate),
-- with requester != approver enforced for everyone except a super-admin.

-- The target condition. NULL for every other exception type (they are file- or
-- co-borrower-scoped). ON DELETE SET NULL: if the condition is deleted the
-- historical exception row survives as an audit record, just no longer pointing.
ALTER TABLE loan_exceptions
  ADD COLUMN IF NOT EXISTS target_checklist_item_id uuid
    REFERENCES checklist_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN loan_exceptions.target_checklist_item_id IS
  'condition_waiver only: the checklist_items condition this exception waives on approval (db/468). NULL for every other type.';

-- ── the exception_type CHECK: the FULL list + the new value ──────────────────
-- IDEMPOTENCY (per db/344 / db/370 / db/388 / db/397 / db/402 / db/455): numbered
-- ABOVE every prior widening and re-asserts BOTH CHECKs verbatim, because a
-- lower-numbered file's narrower re-ADD replays on every boot and would otherwise
-- roll our new value back. The list below MUST name every type any lower file added.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab','tape_encompass_override',
     'encompass_mismatch','credit_import_waiver','condition_waiver'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));

-- ── one-open rules ───────────────────────────────────────────────────────────
-- A file may carry SEVERAL open condition_waiver requests at once — one per
-- condition — so condition_waiver is EXCLUDED from the one-open-per-TYPE rule and
-- gets its own one-open-per-CONDITION rule instead. db/268 re-creates the base
-- index every boot with IF NOT EXISTS (a no-op once ours exists); this file runs
-- last and re-asserts the exclusion, so the converged state each boot is ours.
DROP INDEX IF EXISTS uq_loan_exc_open_per_app;
CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_exc_open_per_app
  ON loan_exceptions(application_id, exception_type)
  WHERE status = 'requested' AND exception_type <> 'condition_waiver';

CREATE UNIQUE INDEX IF NOT EXISTS uq_loan_exc_open_condition_waiver
  ON loan_exceptions(application_id, target_checklist_item_id)
  WHERE status = 'requested' AND exception_type = 'condition_waiver';
