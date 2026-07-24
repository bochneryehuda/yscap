-- ============================================================================
-- 285 — Dedicated CONSTRUCTION FEASIBILITY REPORT condition template
--       (owner-directed: "if the investor needs a feasibility report and we have
--        no condition for it → pop up something big / FATAL").
--
-- The Blue Lake investor guideline (bluelake-rtl-spec.js cond 200) requires a
-- third-party construction feasibility report on GROUND-UP / HEAVY-REHAB files.
-- That guideline row previously crosswalked to `rtl_p3_sow1` (the borrower's
-- Scope-of-Work condition) — but a feasibility REPORT is a distinct third-party
-- document, not the SOW. Because almost every rehab file carries an open SOW
-- condition, the investor-guideline overlay read the feasibility requirement as
-- "already covered" and the FATAL coverage gap never fired.
--
-- This creates a DEDICATED template `rtl_cond_feasibility` so the overlay can tell
-- whether a real feasibility-report condition exists on the file. It is
-- auto_apply='manual' — the rules engine (which only auto-attaches 'always'/'rules'
-- templates) NEVER posts it on its own, and it is NOT part of the db/005 RTL phase
-- workflow, so it is never dumped onto unrelated files. It exists purely so that:
--   (a) the overlay's coverage-gap fatal (investor-guidelines/desk-sync.js) fires
--       on a ground-up/heavy file that has no feasibility-report condition, and
--   (b) the fatal's "attach condition" action (proposedAction.fields.code =
--       'rtl_cond_feasibility') resolves to a real template a human can post.
--
-- Staff-facing (audience='staff') document condition — the report is ordered from
-- an approved vendor and reviewed internally; it is NOT a borrower upload and its
-- capital-partner context is never shown to a borrower.
--
-- Idempotent: INSERT ... WHERE NOT EXISTS + an UPDATE re-assert of the definition.
-- No item backfill is needed — the overlay runs on every file view, so previous
-- AND future ground-up/heavy files are reached (the fatal drives the human to
-- attach the condition). bluelake-rtl-spec.js cond 200 is repointed to this code
-- in the same change; the note_buyer_conditions seed refreshes it on boot.
-- ============================================================================

INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active, auto_apply)
SELECT 'rtl_cond_feasibility',
       'Construction feasibility report (ground-up / heavy rehab)',
       'application', 'staff', 'document', 'rtl', 'underwriter', '3',
       440, 'prior_to_approval',
       'Third-party construction feasibility report from an approved vendor (site inspection + photos + budget assessment) for a ground-up or heavy-rehab deal. Budget line items within a 10% variance to the report.',
       NULL, NULL, NULL,
       false, NULL, true, 'manual'
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_cond_feasibility');

-- Re-assert the definition (idempotent; never touches instances already on files).
UPDATE checklist_templates
   SET label = 'Construction feasibility report (ground-up / heavy rehab)',
       audience = 'staff', item_kind = 'document', auto_apply = 'manual',
       is_active = true
 WHERE code = 'rtl_cond_feasibility';
