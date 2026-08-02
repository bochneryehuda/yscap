-- db/403 — record WHICH stamp a stored term sheet PDF actually prints
-- (owner-directed 2026-08-02).
--
-- The INITIAL/FINAL wording is drawn INTO the term-sheet PDF by the static tool
-- at generation time (web/v2/tools/termsheet.js `provFinal`), so once the bytes
-- are stored nothing downstream can tell what they say. The DocuSign package
-- attaches the stored `term_sheet` document verbatim, which is how sheets
-- reading "INITIAL TERM SHEET — NOT FINAL" were going out for signature.
--
-- This column records what the PDF PRINTS — it is a description of the bytes,
-- not an authority claim. The send gate (src/lib/esign/gate.js) remains the only
-- thing that decides whether a package MAY send; orchestrate.js reads this
-- column purely to refuse mailing a sheet whose own face says it is not final.
--
-- NULL = unknown (every document stored before this shipped). Treated as NOT
-- final everywhere, which is the truthful reading: those sheets were generated
-- under the old rule and almost all of them do print the initial wording. A file
-- in that state is one re-registration away from a final sheet, and the e-sign
-- section says so before anyone tries to send.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS term_sheet_final boolean;

COMMENT ON COLUMN documents.term_sheet_final IS
  'term_sheet documents only: true when the stored PDF prints the FINAL stamp, false when it prints "INITIAL TERM SHEET - NOT FINAL", NULL when unknown (pre-db/403). Describes the bytes; never an authorization.';
