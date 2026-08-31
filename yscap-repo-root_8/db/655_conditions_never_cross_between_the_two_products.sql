-- ============================================================================
-- db/655 — conditions never cross between the two products
--
-- WHAT THIS CHANGES, AND WHY.
--
-- Owner-directed 2026-08-31, in their own words: *"it should understand deeper
-- that this is a short-term file and this is a long-term file. It should not
-- populate conditions from long term to short term or the opposite. Make sure"*
--
-- db/653 moved the Long-Term conditions INTO the shared `checklist_items` /
-- `checklist_templates` tables. That was right — one Condition Center, one
-- definition — but it put both products' conditions in one drawer, and the only
-- thing keeping them apart was that each engine REMEMBERS to filter:
--
--     src/lib/conditions/engine.js               WHERE scope = 'application'
--     src/longterm/conditions-center/engine.js   WHERE scope = 'lt_loan'
--
-- Two `WHERE` clauses in two files is a convention, not a guarantee. A third
-- writer — a migration, a repair script, a route added next year — does not
-- know about it, and the failure is SILENT: a long-term condition simply
-- appears on a short-term loan file and nothing anywhere says why.
--
-- MEASURED BEFORE THIS FILE WAS WRITTEN: `checklist_items` carried NO constraint
-- and NO trigger tying an item to the right product. `chk_one_owner` (db/653)
-- already guarantees that exactly ONE owner column is set, so an item cannot be
-- on an application AND a long-term loan at once — but nothing said the owner
-- column that IS set has to be the one the item's own scope and its template's
-- scope call for. That is the hole this closes.
--
-- ── WHAT THE RULE IS ────────────────────────────────────────────────────────
--
--   1. An item's `scope` must agree with the owner column that is set.
--        application      ⇒ application_id
--        lt_loan          ⇒ lt_loan_id
--        borrower_profile ⇒ borrower_id
--        llc              ⇒ llc_id
--
--   2. An item made FROM a template must have that template's scope. This is
--      the owner's rule literally: a long-term template can only ever produce a
--      long-term condition, and a short-term template a short-term one.
--
-- ── WHY A TRIGGER AND NOT A CHECK ───────────────────────────────────────────
--
-- Rule 2 has to read `checklist_templates`, and a CHECK constraint may not look
-- at another table. Rule 1 could be a CHECK, but it is put in the SAME trigger
-- deliberately, for two reasons: one rule about product identity should live in
-- one place, and a CHECK is VALIDATED AGAINST EVERY EXISTING ROW the moment it
-- is added — so a single bad row anywhere in the back book would make this file
-- throw on every boot forever, which migrate-boot logs and then quietly
-- continues past. A trigger governs WRITES only, so the back book is untouched
-- and the rule starts holding from this deploy forward. See the report query at
-- the foot of this file for finding any row that predates it.
--
-- ── WHAT IS DELIBERATELY STILL ALLOWED ──────────────────────────────────────
--
-- `borrower_profile` and `llc` conditions are PRODUCT-NEUTRAL and must stay
-- that way. They belong to a PERSON or a COMPANY, not to a loan — the photo ID,
-- the appraisal card, the entity documents — and both products are supposed to
-- read and answer them. That is not a crossing; it is the shared identity zone
-- working as designed, and it is the mechanism behind the owner's other
-- instruction in the same message: *"If he uploads it on the long term, it
-- should share it to the short term. If it's uploaded to the short term, it
-- should share it to the long term. It's on the profiles and the borrower
-- profile."* Blocking those would break the sharing they asked for.
--
-- A hand-typed condition (`template_id IS NULL`) is allowed by rule 2 — there
-- is no template to disagree with — and still governed by rule 1.
--
-- BACKFILL: NONE, and that is a decision rather than an omission. The trigger
-- governs writes from here on. Rewriting an existing row's owner would MOVE a
-- condition from one loan file to another, which is the very thing this file
-- exists to prevent, and there is no way to know after the fact which side a
-- mis-filed row was meant for. The report query below names any such row for a
-- human instead.
-- ============================================================================

-- The words a PERSON reads. A refusal that says "a lt_loan condition cannot be
-- put on a application file" is written for the database, not for the staffer
-- who hits it, and this one is reachable from a screen.
CREATE OR REPLACE FUNCTION pilot_condition_scope_name(s text) RETURNS text AS $$
  SELECT CASE s
    WHEN 'application'      THEN 'short-term'
    WHEN 'lt_loan'          THEN 'long-term'
    WHEN 'borrower_profile' THEN 'borrower-profile'
    WHEN 'llc'              THEN 'entity'
    ELSE COALESCE(s, 'unknown')
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION pilot_condition_product_guard() RETURNS trigger AS $$
DECLARE
  tpl_scope text;
  owners    int;
BEGIN
  -- RULE 1 — the item's scope must name the owner column that is actually set.
  -- `chk_one_owner` already guarantees exactly one is set; this says WHICH.
  owners :=
      (NEW.application_id IS NOT NULL)::int
    + (NEW.borrower_id    IS NOT NULL)::int
    + (NEW.llc_id         IS NOT NULL)::int
    + (NEW.lt_loan_id     IS NOT NULL)::int;

  IF owners <> 1 THEN
    -- Left to chk_one_owner to report, so the two never disagree about wording.
    RETURN NEW;
  END IF;

  IF    NEW.scope = 'application'      AND NEW.application_id IS NULL THEN
    RAISE EXCEPTION 'a short-term condition must sit on a short-term file (scope=application with no application_id)';
  ELSIF NEW.scope = 'lt_loan'          AND NEW.lt_loan_id     IS NULL THEN
    RAISE EXCEPTION 'a long-term condition must sit on a long-term loan (scope=lt_loan with no lt_loan_id)';
  ELSIF NEW.scope = 'borrower_profile' AND NEW.borrower_id    IS NULL THEN
    RAISE EXCEPTION 'a profile condition must sit on a borrower (scope=borrower_profile with no borrower_id)';
  ELSIF NEW.scope = 'llc'              AND NEW.llc_id         IS NULL THEN
    RAISE EXCEPTION 'an entity condition must sit on an entity (scope=llc with no llc_id)';
  END IF;

  -- RULE 2 — THE OWNER'S RULE. A condition made from a template belongs to that
  -- template's product, always. This is what stops a long-term condition
  -- appearing on a short-term file and the other way round.
  IF NEW.template_id IS NOT NULL THEN
    SELECT scope INTO tpl_scope FROM checklist_templates WHERE id = NEW.template_id;
    IF tpl_scope IS NOT NULL AND tpl_scope <> NEW.scope THEN
      RAISE EXCEPTION
        'a % condition cannot be put on a % file — the two products do not share condition sets (template %)',
        pilot_condition_scope_name(tpl_scope), pilot_condition_scope_name(NEW.scope), NEW.template_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_condition_product_guard ON checklist_items;
CREATE TRIGGER trg_condition_product_guard
  BEFORE INSERT OR UPDATE ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION pilot_condition_product_guard();

-- ── FINDING A ROW THAT PREDATES THIS GUARD ──────────────────────────────────
-- Not run here (see BACKFILL above). Run it by hand to see whether the back
-- book holds anything the guard would now refuse:
--
--   SELECT ci.id, ci.scope AS item_scope, t.scope AS template_scope,
--          ci.application_id, ci.lt_loan_id, ci.borrower_id, ci.llc_id
--     FROM checklist_items ci
--     LEFT JOIN checklist_templates t ON t.id = ci.template_id
--    WHERE (t.scope IS NOT NULL AND t.scope <> ci.scope)
--       OR (ci.scope = 'application'      AND ci.application_id IS NULL)
--       OR (ci.scope = 'lt_loan'          AND ci.lt_loan_id     IS NULL)
--       OR (ci.scope = 'borrower_profile' AND ci.borrower_id    IS NULL)
--       OR (ci.scope = 'llc'              AND ci.llc_id         IS NULL);
