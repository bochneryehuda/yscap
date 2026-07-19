-- ============================================================================
-- 132 — Bracket-aware FICO reopen (owner-directed 2026-07-19)
--
-- Reconciles the credit-report feature with main's db/126 §C. db/126 added
-- trg_reopen_pricing_on_fico_change, which reopens Products & Pricing + the
-- signed term sheet whenever a borrower's `fico` changes to ANY different value
-- than the product was priced with. The owner's rule for the verified-FICO
-- import is narrower and explicit:
--
--   "register the new FICO, freeze everything, and open up the registration +
--    pricing condition ONLY if it changes BRACKETS — even if the price wouldn't
--    change. If it stays in the same bracket (e.g. 718 -> 700, both 700-719),
--    do NOT reopen. A human re-registers on a bracket change."
--
-- So a 1-point drift that keeps the same 20-point mortgage-credit bracket must
-- NOT churn a cleared, signed registration; a move across a bracket boundary
-- MUST. This migration:
--   A. Adds fico_bracket(numeric) — the SQL twin of scoring.js BRACKETS (the
--      standard 20-point grid + the 760-779 / 780+ split the owner added).
--   B. CREATE OR REPLACEs reopen_pricing_on_fico_change() so the per-registration
--      comparison is bracket(new) IS DISTINCT FROM bracket(priced), not raw value.
--      Everything else about db/126's function (which conditions reopen, the
--      notes, the co-borrower reach) is unchanged. The trigger wiring from 126
--      stays; only the function body is superseded.
-- ============================================================================

-- ---- A. bracket function (mirror of src/lib/credit/scoring.js BRACKETS) -----
-- Returns the bracket LABEL for a score, or NULL when the score is absent or
-- outside the valid FICO band [300,850]. Labels (not indexes) so the value is
-- self-describing in audits and identical to what the app shows.
CREATE OR REPLACE FUNCTION fico_bracket(score numeric) RETURNS text AS $$
DECLARE s int;
BEGIN
  IF score IS NULL THEN RETURN NULL; END IF;
  s := floor(score)::int;                 -- scores are integers; floor a stray decimal
  IF s < 300 OR s > 850 THEN RETURN NULL; END IF;   -- out of band → no bracket
  RETURN CASE
    WHEN s < 620 THEN '<620'
    WHEN s < 640 THEN '620-639'
    WHEN s < 660 THEN '640-659'
    WHEN s < 680 THEN '660-679'
    WHEN s < 700 THEN '680-699'
    WHEN s < 720 THEN '700-719'
    WHEN s < 740 THEN '720-739'
    WHEN s < 760 THEN '740-759'
    WHEN s < 780 THEN '760-779'
    ELSE '780+'
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Safe extractor: the FICO a registration was priced with lives in
-- pr.inputs->>'fico' (written by the pricing engine as a clean integer). Guard
-- the cast so a hand-edited / malformed inputs blob can never throw inside the
-- trigger — an unparseable value reads as "no priced FICO" (NULL).
CREATE OR REPLACE FUNCTION fico_bracket_of_inputs(inputs jsonb) RETURNS text AS $$
DECLARE raw text;
BEGIN
  raw := NULLIF(inputs->>'fico', '');
  IF raw IS NULL OR raw !~ '^[0-9]+(\.[0-9]+)?$' THEN RETURN NULL; END IF;
  RETURN fico_bracket(raw::numeric);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---- B. bracket-aware reopen (supersedes db/126 §C body) --------------------
-- Representative-aware: the product is priced on the LOAN's representative FICO =
-- NULLIF(GREATEST(primary.fico, co.fico),0) (the exact expression the pricing
-- query and pr.inputs->>'fico' use), NOT an individual borrower's score. So a
-- co-borrower's score dropping BELOW an unchanged, higher representative must not
-- reopen anything — only a move of the representative across a bracket boundary
-- does. This also corrects db/126's per-borrower over-firing on the normal manual
-- edit path. In an AFTER-UPDATE trigger `borrowers` already reflects NEW, so the
-- pb/cb join reads the just-updated score for the representative.
CREATE OR REPLACE FUNCTION reopen_pricing_on_fico_change() RETURNS trigger AS $$
BEGIN
  IF NEW.fico IS DISTINCT FROM OLD.fico THEN
    -- Flag only registrations whose priced BRACKET differs from the current
    -- REPRESENTATIVE score's bracket (same-bracket drift leaves a cleared,
    -- signed registration alone).
    UPDATE product_registrations pr
       SET stale = true,
           stale_reason = 'representative FICO moved to a different credit-score bracket since the product was priced — re-register the product and issue a new term sheet'
      FROM applications a
      JOIN borrowers pb ON pb.id = a.borrower_id
      LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
     WHERE pr.application_id = a.id
       AND pr.is_current AND NOT pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND fico_bracket_of_inputs(pr.inputs)
             IS DISTINCT FROM fico_bracket(NULLIF(GREATEST(COALESCE(pb.fico,0), COALESCE(cb.fico,0)), 0));

    UPDATE checklist_items ci
       SET status = 'received', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The representative FICO changed to a different credit-score bracket — re-register the product so the rate and eligibility match the new score.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM applications a, product_registrations pr
     WHERE ci.application_id = a.id
       AND pr.application_id = a.id AND pr.is_current AND pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND ci.tool_key = 'product_pricing'
       AND (ci.status = 'satisfied' OR ci.signed_off_at IS NOT NULL);

    UPDATE checklist_items ci
       SET status = 'outstanding', signed_off_at = NULL, signed_off_by = NULL,
           reviewed_at = NULL, reviewed_by = NULL,
           notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                        THEN '[auto] The representative FICO changed brackets — the signed term sheet no longer matches. Generate the new term sheet and collect a fresh signature.'
                        ELSE ci.notes END,
           updated_at = now()
      FROM checklist_templates t, applications a, product_registrations pr
     WHERE t.id = ci.template_id AND t.code = 'rtl_cond_signedts'
       AND ci.application_id = a.id
       AND pr.application_id = a.id AND pr.is_current AND pr.stale
       AND (a.borrower_id = NEW.id OR a.co_borrower_id = NEW.id)
       AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger trg_reopen_pricing_on_fico_change (db/126) already points here; the
-- CREATE OR REPLACE above swapped the body it runs. No re-create needed.
