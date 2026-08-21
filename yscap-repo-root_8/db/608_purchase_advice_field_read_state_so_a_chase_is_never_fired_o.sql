-- ============================================================================
-- db/608 — purchase advice field read state so a chase is never fired on a value nobody read
--
-- WHAT THIS CHANGES, AND WHY. Owner-reported 2026-08-21: file YSCAP258134650
-- received the monthly "No purchase advice 64 days after funding" email — and
-- the loan HAS a purchase advice date in Encompass. *"There are a lot of files
-- that receive an email that are missing a PA date, but most of the files
-- already have it."*
--
-- THE CHASE ASKED THE WRONG QUESTION. `notification-digests.purchaseAdviceMissingOnce`
-- fired on `applications.purchase_advice_date IS NULL` — a column that is only
-- ever written when a per-file Encompass pull actually reads field 2370 back.
-- Three ordinary things leave that column NULL on a loan that plainly HAS an
-- advice date, and the chase could not tell any of them from "not sold":
--   · the file has not come round on the pull rota yet (one file per 15 minutes,
--     round-robin by staleness across the whole book);
--   · the file has no cached Encompass loan link at all, so no field was read;
--   · the field read ran and Encompass did not return that id — which is what
--     happens when an id is invalid or unpermitted for the tenant, because
--     `client.readFields` splits the batch on a 400 and merges what SUCCEEDED,
--     so a bad id goes MISSING from the map rather than raising.
-- In all three PILOT had never once asked about this loan, and said "it has not
-- been sold" anyway. A confident answer built on a value nobody read is exactly
-- the failure this codebase forbids.
--
-- SO THE READ ITSELF IS NOW RECORDED. `release-party.syncPurchaseAdviceDate`
-- stamps what happened every time it looks, and the chase fires only on
-- `blank` — we asked Encompass about this loan and Encompass answered empty.
-- Every other state is reported to super admins as "PILOT cannot tell", which
-- is a different sentence and a different piece of work.
--
--   value        a purchase advice date came back — the loan is sold
--   blank        the field was returned and is empty — the only chaseable state
--   not_returned the read ran and this id was not in the answer (see above)
--   no_field_id  no field id is configured on this deployment at all
--   no_loan_link PILOT holds no Encompass loan guid for this file, so nothing
--                could be read (stamped by the sweep, never by a pull — a pull
--                cannot happen without a loan)
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS, and the CHECK is dropped before it is
-- re-added.
--
-- BACKFILL: NONE, DELIBERATELY. Every existing file is left unstamped (NULL),
-- which reads as "we have never asked" — the truth. Guessing a state here would
-- re-arm the very false alarm this file exists to stop, in the other direction:
-- stamping `blank` would chase the whole back book on the next sweep. The
-- back book is stamped by `refreshPurchaseAdviceOnce`, one cheap single-field
-- read per file, which is the owner's *"refresh your entire system and make
-- sure it's looking at the correct field."*
--
-- PRODUCT SEPARATION: RTL only. `applications` IS the RTL product's table; the
-- Long-Term side has its own `lt_*` tables and does not appear here.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS purchase_advice_read_at    timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS purchase_advice_read_state text;
-- The field id the answer above came from. Recorded per file rather than read
-- from the environment at display time, so a deployment that CHANGES the id can
-- still tell which files were judged under the old one — and so an operator can
-- see, on the file, exactly which Encompass field PILOT asked about.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS purchase_advice_field_id   text;

ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_pa_read_state_chk;
ALTER TABLE applications ADD CONSTRAINT applications_pa_read_state_chk
  CHECK (purchase_advice_read_state IS NULL
         OR purchase_advice_read_state IN ('value','blank','not_returned','no_field_id','no_loan_link'));

-- The sweep takes funded files that have never been asked, oldest first, so it
-- drains predictably and a partial pass always resumes where it stopped.
CREATE INDEX IF NOT EXISTS idx_applications_pa_read_state
  ON applications (purchase_advice_read_at NULLS FIRST)
  WHERE deleted_at IS NULL AND status = 'funded';
