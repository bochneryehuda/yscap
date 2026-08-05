-- db/469 — a super-admin OVERRIDE of the "term sheet still prints NOT FINAL"
-- send refusal (owner-directed 2026-08-04).
--
-- THE BACKGROUND. The DocuSign term-sheet package refuses to mail a term sheet
-- whose stored bytes are not recorded as FINAL (documents.term_sheet_final,
-- db/404), because the INITIAL/FINAL wording is drawn INTO the PDF and cannot be
-- flipped after the fact. The normal fix is to (re-)generate the sheet as FINAL —
-- which the send now does on its own (the studio finalize). But the owner asked
-- for an escape hatch on top of it: "since the system is a new system there may be
-- bugs — for something like this the super admin should always be able to override
-- anything and send if he wants, with a warning." So a super-admin may force the
-- send past this one refusal, with a reason, and it is RECORDED here on the
-- envelope so the send engine honors it across retries and the file answers "who
-- forced this, and why?" long after.
--
-- This is an AUTHORITY stamp on ONE envelope, not a change to what any PDF prints
-- (the bytes may still read "NOT FINAL" — the warning says so). It never widens
-- any other gate: the appraisal/P&P send-gate still governs whether the package
-- may send at all; this only lets a super-admin past the wording refusal.
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS ts_final_override_by uuid;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS ts_final_override_reason text;
ALTER TABLE esign_envelopes ADD COLUMN IF NOT EXISTS ts_final_override_at timestamptz;

COMMENT ON COLUMN esign_envelopes.ts_final_override_by IS
  'super_admin who forced this term-sheet package past the "not final" refusal (db/469). NULL = no override; the send refuses a non-final sheet as usual.';
COMMENT ON COLUMN esign_envelopes.ts_final_override_reason IS
  'the reason the super-admin gave for sending a sheet not recorded as FINAL. Shown on the file; travels with the envelope across send retries.';
