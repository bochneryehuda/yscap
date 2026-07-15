-- #95: "Ground up" was wrongly selectable as a loan_type (it is a PROGRAM, not a
-- loan purpose). A loan_type is Purchase or Refinance; the pricing engine keys
-- Purchase-vs-Refinance leverage off loan_type, so a file created with
-- loan_type='Ground up' priced as NEITHER — a real regression from the New-File
-- form's option list. The option is removed there; this backfills PREVIOUS files
-- so they don't stay mis-configured.
--
-- Clear any ground-* loan_type to NULL (the value was never a valid loan type),
-- so the file shows loan_type as unset for staff to re-select Purchase/Refinance.
-- The economics-reopen trigger (db/071/072) fires on the loan_type change and
-- reopens product_pricing, so the file gets re-registered on a correct basis.
-- Idempotent: after the first run no row matches, so re-running is a no-op.
-- The program is untouched (a ground-up file's program stays Ground-Up).
UPDATE applications
   SET loan_type = NULL, updated_at = now()
 WHERE loan_type IS NOT NULL
   AND loan_type ILIKE 'ground%';
