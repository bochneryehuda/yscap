-- Out-of-pocket rehab exception (owner-authorized 2026-07-31).
--
-- Adds the loan_exceptions type `oop_rehab` — the first-class, tracked register
-- entry (EX-n) for the out-of-pocket rehab exception, alongside the manual-program
-- escalation the register route already opens. See src/lib/loan-exceptions.js
-- EXCEPTION_TYPES and docs/OOP-REHAB-EXCEPTION-RESEARCH.md.
--
-- Idempotent (DROP … IF EXISTS + re-ADD). Numbered LAST so it re-asserts the FULL
-- type list AND the status CHECK verbatim — mirroring db/370's note: an earlier
-- file (306 / 344 / 370) that re-adds a NARROWER type CHECK on boot would otherwise
-- roll this back once an oop_rehab row exists, taking its status-CHECK re-assertion
-- with it. Keep this numbered above every other loan_exceptions CHECK migration.

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
