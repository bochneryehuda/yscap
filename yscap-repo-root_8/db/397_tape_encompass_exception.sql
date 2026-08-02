-- Data-tape export before Encompass matches — the super-admin exception
-- (owner-directed 2026-08-02).
--
-- A capital-provider data tape can no longer be exported before the loan is in
-- Encompass AND every field matches — not even by an admin. The ONLY way past a
-- blocked tape is a SUPER-ADMIN-approved exception. This adds the register type
-- `tape_encompass_override` (a real request → super-admin decision, and the
-- record of a super-admin's inline allow). See src/lib/loan-exceptions.js
-- EXCEPTION_TYPES.
--
-- Idempotent (DROP … IF EXISTS + re-ADD). Numbered LAST so it re-asserts the FULL
-- type list AND the status CHECK verbatim — mirroring db/388/370's note: an
-- earlier file (306 / 344 / 370 / 388) that re-adds a NARROWER type CHECK on boot
-- would otherwise roll back once a tape_encompass_override row exists, taking its
-- status-CHECK re-assertion with it. Keep this numbered above every other
-- loan_exceptions CHECK migration.

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab','tape_encompass_override'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
