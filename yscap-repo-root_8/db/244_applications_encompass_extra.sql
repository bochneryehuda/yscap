-- 244_applications_encompass_extra.sql — Store the raw Encompass loan pull on the file
-- (owner-directed 2026-07-22, PILOT ↔ Encompass Phase 2 — READ-ONLY).
--
-- PILOT is now able to READ each active file's loan JSON from Encompass (pull only, per
-- the READ-ONLY freeze — src/lib/integrations/encompass.js). We stash the FULL raw payload
-- so staff can cross-check every field without PILOT ever silently "adopting" an Encompass
-- value into an authoritative PILOT column. Idempotent.
--
-- Columns added to `applications`:
--   encompass_loan_guid       text — the immutable Encompass side key (Loan.Guid); the
--                                    join key that lets subsequent pulls go GET-by-guid
--                                    instead of re-searching the pipeline every time.
--   encompass_extra           jsonb — the full raw loan pull, exactly as Encompass returned it.
--                                    STRIPPED of top-level PII sub-objects that duplicate what
--                                    borrowers already have on file (see reader.js `scrubForStorage`) —
--                                    we keep everything else verbatim for staff review.
--   encompass_last_pulled_at  timestamptz — when the raw payload was refreshed.
--   encompass_last_error      text — the last pull error (short), or NULL if the last try
--                                    succeeded. Surfaced in the staff panel so failures
--                                    are visible without digging in logs.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS encompass_loan_guid       text,
  ADD COLUMN IF NOT EXISTS encompass_extra           jsonb,
  ADD COLUMN IF NOT EXISTS encompass_last_pulled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS encompass_last_error      text;

CREATE INDEX IF NOT EXISTS idx_applications_encompass_guid
  ON applications(encompass_loan_guid)
  WHERE encompass_loan_guid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_applications_encompass_stale
  ON applications(encompass_last_pulled_at NULLS FIRST)
  WHERE ys_loan_number IS NOT NULL
    AND status NOT IN ('declined', 'withdrawn');
