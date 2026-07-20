-- ============================================================================
-- 164 — Adverse-action party role (owner-directed 2026-07-19, compliance research)
--
-- The single most important AA gate for a business-purpose lender: under
-- ECOA/Reg B §1002.2(e) and FCRA §603(k), a GUARANTOR is not an "applicant," so
-- an adverse-action notice is generally NOT owed to a guarantor — the obligation
-- attaches only when the individual is the actual applicant (a natural-person
-- borrower on the note). Capture the role so the scaffold can flag when a notice
-- likely isn't required, and never auto-issue one for a guarantor. The legal
-- characterization per loan program is a compliance decision; this stores the
-- flag, it does not decide it. Idempotent.
-- ============================================================================
ALTER TABLE adverse_action_letters
  ADD COLUMN IF NOT EXISTS party_role text NOT NULL DEFAULT 'applicant';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adverse_action_party_role_check') THEN
    ALTER TABLE adverse_action_letters ADD CONSTRAINT adverse_action_party_role_check
      CHECK (party_role = ANY (ARRAY['applicant','co_applicant','guarantor']));
  END IF;
END $$;
