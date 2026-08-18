-- ============================================================================
-- db/575 — payoff free and clear and good through
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-18). Two gaps on the
-- refinance payoff:
--
-- (1) "PROPERTY IS FREE AND CLEAR." A refinance with no existing lien had no
--     way to say so — both payoff conditions (db/464) demanded a payoff that
--     does not exist. `applications.property_free_and_clear` is the recorded
--     answer (confirmed by a staffer behind a confirm popup, stamped who/when).
--     The two payoff templates' rules gain `property_free_and_clear is_false`,
--     so the conditions engine RETRACTS both conditions (untouched only) the
--     moment the flag is set and re-attaches them if it is cleared. A WORKED
--     condition is waived by the route that sets the flag (src/routes/staff.js
--     payoff/free-and-clear), never silently deleted. db/464 re-asserts the
--     OLD rule on every boot; this file is numbered above it and re-asserts
--     the WIDENED rule, so the converged state is always the new one (the
--     db/374 ordering mechanism). The added row keeps the grammar at root +
--     one level (rules.validateRule's limit).
--
-- (2) THE PAYOFF'S GOOD-THROUGH DATE. A payoff letter is only good through a
--     stated date; the team had nowhere to record it. `payoff_good_through`
--     joins the three existing payoff columns (db/032 amount, db/386 lender +
--     loan number) and prints on the verify-payoff condition's fillable form
--     and the attorney closing-prep email.
--
-- BACKFILL: none — the flag defaults false (every existing refinance keeps
-- both conditions exactly as it has them), and the date starts blank.
--
-- RTL only. No lt_* table is touched.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS property_free_and_clear boolean NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS free_and_clear_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS free_and_clear_at timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS payoff_good_through date;

-- The widened rules. Re-asserted here on EVERY boot, after db/464 re-asserts
-- the narrow ones — numbering is the mechanism, do not "fix" db/464.
UPDATE checklist_templates
   SET rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]},{"field":"property_free_and_clear","operator":"is_false"}]}'::jsonb
 WHERE code = 'cond_payoff_external'
   AND rule_logic IS DISTINCT FROM '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]},{"field":"property_free_and_clear","operator":"is_false"}]}'::jsonb;

UPDATE checklist_templates
   SET rule_logic = '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]},{"field":"property_free_and_clear","operator":"is_false"}]}'::jsonb
 WHERE code = 'cond_payoff_internal'
   AND rule_logic IS DISTINCT FROM '{"combinator":"and","rules":[{"field":"loan_purpose","operator":"in","value":["refinance_rate_term","refinance_cash_out"]},{"field":"property_free_and_clear","operator":"is_false"}]}'::jsonb;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
