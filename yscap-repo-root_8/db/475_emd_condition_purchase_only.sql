-- ============================================================================
-- 475 — The EMD (earnest money deposit) condition is a PURCHASE concept — it is
--       NEVER relevant on a REFINANCE (owner-directed 2026-08-05).
--
-- Owner: "For certain refinances we still have an EMD condition. The EMD
-- condition is not relevant when it comes to a refinance, either rate and term
-- or cash-out. There is no EMD. There is no deposit for a refinance."
--
-- The EMD verification condition (cond_emd_corrfirst, db/191) is rule-driven and
-- was gated ONLY on the note buyer being CorrFirst — so it attached to CorrFirst
-- REFINANCES too, asking a refinancing borrower to prove an earnest-money deposit
-- that does not exist on a refinance. This teaches the rule the missing half: the
-- file must ALSO be a PURCHASE (loan_purpose = 'purchase', which
-- field-registry.normLoanPurpose derives from applications.loan_type — reading a
-- "Delayed Purchase Financing" as a purchase exactly like the frozen pricing
-- engine does, and a rate-&-term or cash-out refinance as a refinance). A blank
-- loan type never attaches it either (rules.evalRow treats a blank actual as
-- false), which is the safe direction — no EMD unless we know it is a purchase.
--
-- ORDERING: db/398 re-asserts this template's rule_logic on every boot (to the
-- CorrFirst-only form) under an IS DISTINCT FROM guard; this migration is numbered
-- ABOVE it so it runs LAST each boot and is the final word — the same ordering
-- mechanism db/375 uses over db/334. Idempotent.
--
-- PREVIOUS AND FUTURE: the conditions engine (src/lib/conditions/engine.js)
-- retracts an untouched auto/rules condition whose rule no longer matches on the
-- next evaluate, so future files and any re-evaluated file self-correct. The
-- backfill below retracts the now-irrelevant EMD condition from existing
-- REFINANCE files immediately — but ONLY when it is untouched (no document
-- uploaded, not signed off, not satisfied, no human note), so a deposit proof
-- somebody already filed on a mis-classified file is never destroyed; a human
-- handles that one.
-- ============================================================================

-- (1) Rule: note buyer is CorrFirst AND the loan is a purchase.
UPDATE checklist_templates
   SET rule_logic = '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"},{"field":"loan_purpose","operator":"eq","value":"purchase"}]}'::jsonb,
       updated_at = now()
 WHERE code = 'cond_emd_corrfirst'
   AND rule_logic IS DISTINCT FROM '{"combinator":"and","rules":[{"field":"note_buyer","operator":"eq","value":"corrfirst"},{"field":"loan_purpose","operator":"eq","value":"purchase"}]}'::jsonb;

-- (2) Backfill — retract the EMD condition from existing REFINANCE files that
--     wrongly carry it, untouched-only. "Refinance" mirrors normLoanPurpose's two
--     refinance branches (cash-out / refi / rate & term) while EXCLUDING a
--     "delayed purchase" (which normalizes to a purchase). Untouched = no
--     document on the item, not signed off, not satisfied, and no human note
--     (blank or an [auto] note only).
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'cond_emd_corrfirst'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND COALESCE(a.loan_type, '') !~* 'delayed\s+purchase'
   AND COALESCE(a.loan_type, '') ~* 'cash[-\s]?out|refi|rate\s*(&|and)?\s*term'
   AND ci.signed_off_at IS NULL
   AND ci.status <> 'satisfied'
   AND (ci.notes IS NULL OR ci.notes LIKE '[auto]%')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
