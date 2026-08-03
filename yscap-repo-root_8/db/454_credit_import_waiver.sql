-- ============================================================================
-- 454 — CREDIT REPORT: upload the PDF, then WAIVE the import by exception
--       (owner-directed 2026-08-03).
--
-- "On the credit report condition we only have an Import button. We should also
--  have a button to upload a PDF, and after they upload a PDF they can request
--  an exception to waive — and the admin should sign off the condition even if
--  they didn't reissue the credit. Say they got a credit report from somewhere
--  else and they don't want to reissue: first we need the PDF upload slot on the
--  document, then they can request an exception to get the condition signed off
--  without importing credit. And the PDF, if it's accepted, should be included
--  in the TPR export as well and in the SharePoint syncing."
--
-- The credit condition's sign-off gate (routes/staff.js, the isCredit branch)
-- requires a real IMPORTED credit report for every borrower it covers — "a bare
-- PDF upload is not enough" (owner-directed 2026-07-23). That rule is UNCHANGED
-- and is still the default for every file: a report we pulled ourselves is the
-- only thing that files the PDF + the data file AND reads the scores. This adds
-- the ONE recorded way through it, for the case the owner described — a current
-- report obtained elsewhere, which nobody wants to re-pull (a second hard
-- inquiry on the borrower, at cost, for a report we already hold).
--
-- ONE waiver per credit CONDITION, not per file: a file can carry TWO credit
-- conditions — the file-level one and a co-borrower's own (field_key
-- 'cob_credit', db/286 + lib/credit/co-condition.js) — and waiving the import
-- for one borrower must never quietly waive it for the other. So the primary key
-- is checklist_item_id; application_id rides along for scoping + reporting and
-- the row dies with the file.
--
-- Unlike the appraisal no-XML waiver (db/370), there is NO auto-waiving reason
-- here: EVERY credit waiver needs an admin's approval on the Exceptions screen
-- before the condition can be signed off ("the admin should sign off"). The
-- waiver row alone grants nothing — lib/credit/waiver.js reads the exception's
-- status and fails CLOSED.
--
-- Additive + idempotent. No backfill: no waiver = the normal import-required
-- rule, which is the truth for every previous file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS credit_import_waivers (
  -- The credit CONDITION this waives (file-level, or a co-borrower's own).
  checklist_item_id uuid PRIMARY KEY REFERENCES checklist_items(id) ON DELETE CASCADE,
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- Why the report is not being pulled here (a code from
  -- loan-exceptions.CREDIT_IMPORT_WAIVER_REASONS) + the requester's own words.
  reason            text NOT NULL,
  note              text,
  -- The policy exception an admin approves. The waiver only counts once this row
  -- is 'approved' — there is no reason that skips it.
  exception_id      uuid REFERENCES loan_exceptions(id) ON DELETE SET NULL,
  requested_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The file's waivers, for the per-file reads (the condition surface asks by item;
-- the file view asks by application).
CREATE INDEX IF NOT EXISTS credit_import_waivers_app_idx
  ON credit_import_waivers (application_id);

-- ── loan_exceptions register: the new 'credit_import_waiver' type ────────────
-- IDEMPOTENCY (per db/344 / db/370 / db/388 / db/397 / db/402): this file is
-- numbered ABOVE every prior widening, and it re-asserts BOTH the exception_type
-- CHECK (the FULL list plus the new value) AND the status CHECK verbatim —
-- because an older migration's NARROWER re-ADD replays on every boot and would
-- otherwise roll our new value back the moment a credit_import_waiver row exists,
-- taking that file's status-CHECK re-assertion down with it. The list below MUST
-- name every type any lower-numbered file added.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab','tape_encompass_override',
     'encompass_mismatch','credit_import_waiver'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
