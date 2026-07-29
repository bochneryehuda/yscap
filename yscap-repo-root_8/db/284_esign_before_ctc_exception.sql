-- Send the term-sheet package BEFORE clear-to-close, via a super-admin exception
-- (owner-directed 2026-07-23).
--
-- A DocuSign term-sheet package may be sent only once the file is ready for
-- clear-to-close (the e-sign send-gate — src/lib/esign/gate.js). When it is NOT
-- ready, staff may now REQUEST a super-admin exception to send it early. The four
-- term-sheet-CORRECTNESS prerequisites remain a HARD FLOOR that the exception can
-- never waive (they make the signed term sheet itself correct):
--     • the appraisal is back and signed off,
--     • product & pricing was re-registered on the appraised value,
--     • the estimated closing date is on file, and
--     • the registration is current (not stale / not awaiting manual approval).
-- The exception waives only the remaining clear-to-close readiness (today: the
-- internal appraisal-review sign-off) — and it can be requested ONLY after the
-- floor above is met, never before.
--
-- This reuses the existing loan_exceptions queue + super-admin review box (the
-- table was built general, with an exception_type discriminator — db/268). The
-- ONLY schema change is widening that discriminator's CHECK to accept the new
-- 'esign_before_ctc' type. No new column: an APPROVED loan_exceptions row of this
-- type IS the signal the send-gate reads to allow the early send; the floor is
-- always re-checked server-side, so a stale/changed deal is still blocked.
--
-- Additive + idempotent (drop + re-add the CHECK; go-forward only — existing rows
-- keep their 'guaranty_waiver' type and are unaffected).

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check
  CHECK (exception_type IN ('guaranty_waiver','esign_before_ctc'));
